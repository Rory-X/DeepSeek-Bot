// Request identities: a request a Bot names itself is sent once, however often it repeats it.
//
// message_bot merges what the recipient has not read yet, but a request that was read and
// whose answer was lost could be sent again, and the work would be done twice. A caller
// that names its request (`request_id`) gets that guarantee: the name belongs to the
// caller and to the conversation the request was made from, what the request stands for
// is remembered with a fingerprint of what was asked, and the receipt of the first call
// is given back instead of a second delivery. The receipt is written before the message
// goes out, so a restart cannot turn a lost answer into a second delivery either; when
// the outcome of an admission is not known, the request is not sent again.
//
// Accepted identities stay with the team: expiring one would permit an old retry to
// repeat side effects. A delivered request's receipt is the only part that may go, and only
// under the retention below: the record stays as a name-taking tombstone without it, so a
// late retry of that name is answered `expired` instead of being delivered a second time.
// A request whose outcome is not known (`uncertain`) is never touched.
import { createHash, randomUUID } from 'node:crypto'

// A request name this long is a mistake, not an identity.
export const NAME_MAX = 200
// How long a delivered receipt is kept: at most this many of them and this old, whichever goes
// first. Both are internal: a bigger team file is not a user-visible setting.
export const REQUESTS_RECEIPTS_KEPT = 200
export const REQUESTS_RECEIPTS_KEEP_MS = 7 * 24 * 60 * 60 * 1000
// A tombstone is one tiny record per delivered request whose receipt went; the names have to
// stay taken, but the table still needs a bound. Past this many the oldest tombstones are
// dropped completely, which is the one case where a very old retry could be delivered again:
// that takes more than this many requests before it with the same request_id still in hand,
// which does not happen in practice.
export const REQUESTS_TOMBSTONES = 2_000

// The by-time order both passes use: newest first, so the first `kept` entries survive.
const byTimeDesc = table => Object.entries(table).sort((left, right) => (right[1].at ?? 0) - (left[1].at ?? 0))

// One pass over the request table. Delivered receipts beyond the retention lose only their
// receipt; tombstones beyond their bound lose the whole record. A key still in flight is
// skipped in both passes. Returns how many of each were pruned.
export function pruneRequests(table, { now = Date.now(), inflight } = {}) {
  const busy = inflight ?? new Set()
  let receiptsPruned = 0
  let tombstonesPruned = 0
  const receipts = byTimeDesc(table).filter(([key, record]) => record?.outcome === 'delivered' && record.receipt !== undefined && !busy.has(key))
  for (const [index, [, record]] of receipts.entries()) {
    if (index < REQUESTS_RECEIPTS_KEPT && now - (record.at ?? 0) <= REQUESTS_RECEIPTS_KEEP_MS) continue
    delete record.receipt
    receiptsPruned += 1
  }
  const tombstones = byTimeDesc(table).filter(([key, record]) => record?.outcome === 'delivered' && record.receipt === undefined && !busy.has(key))
  for (const [index, [key]] of tombstones.entries()) {
    if (index < REQUESTS_TOMBSTONES) continue
    delete table[key]
    tombstonesPruned += 1
  }
  return { receipts: receiptsPruned, tombstones: tombstonesPruned }
}

export function install(rt) {
  const { state } = rt
  // This run's name: a receipt left pending by another run has an unknown outcome.
  const run = randomUUID()
  const receipts = () => (state.requests ??= {})
  // Requests being admitted now, so that two at once admit one.
  const inflight = new Map()


  // What the request asked for, as a short hash: the same name with the same content is
  // the same request, and the same name with other content is a mistake.
  const print = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex')

  // The name of a request in the caller's own space: its Bot, the conversation the request
  // was made from, and the name the caller gave it. The Bot, not its Session: a Bot that
  // moves to a fresh part of its conversation keeps its name.
  const identity = ({ caller, context, name, payload }) => ({
    key: `${caller}\u0000${context}\u0000${name}`,
    print: print(payload),
  })

  // What a request that was admitted before means for the caller now: its receipt, a
  // conflict, or an outcome that is not known. Undefined when it was never admitted.
  const verdict = (request, record) => {
    if (record.fingerprint !== request.print) return { status: 'conflict' }
    if (record.outcome === 'delivered') {
      // The receipt is gone, but the name stays taken: it is not used again by accident.
      return record.receipt === undefined ? { status: 'expired' } : { status: 'replay', receipt: record.receipt }
    }
    if (record.outcome === 'uncertain') return { status: 'uncertain' }
    // Admitted, not settled: the call is still going, or it was cut short.
    return undefined
  }

  // What is known about a request that was admitted before. Undefined when the request
  // was never admitted.
  const known = async (request) => {
    const record = rt.own(receipts(), request.key)
    if (record === undefined) return undefined
    const seen = verdict(request, record)
    if (seen !== undefined) return seen
    // Admitted, not settled: the call is still going in this run, or another run left it
    // in the air, and then its outcome is not known.
    if (record.run !== run) return { status: 'uncertain' }
    const promise = inflight.get(request.key)
    if (promise === undefined) return { status: 'uncertain' }
    await promise.catch(() => {})
    const settled = rt.own(receipts(), request.key)
    if (settled === undefined) return undefined
    return verdict(request, settled) ?? { status: 'uncertain' }
  }

  // Admits the request once and runs it. `work` sends the message and gives the receipt
  // the caller gets. The receipt is written before the message goes out, so that a restart
  // knows the request was admitted.
  const admit = async (request, work) => {
    // The receipt is looked for and written without an await in between, so that two
    // calls at once cannot both admit the same request.
    const record = rt.own(receipts(), request.key)
    if (record !== undefined) {
      const seen = verdict(request, record)
      if (seen !== undefined) return seen
      if (record.run !== run) return { status: 'uncertain' }
      const promise = inflight.get(request.key)
      if (promise === undefined) return { status: 'uncertain' }
      await promise.catch(() => {})
      // The attempt that was going on gave up before it sent anything (its receipt could
      // not be saved), so the request is free to be admitted again.
      if (rt.own(receipts(), request.key) === undefined) return admit(request, work)
      return known(request)
    }
    // A receipt that cannot be saved cannot stop a second delivery later.
    if (rt.readOnly() !== undefined) return { status: 'readonly' }
    const fresh = { fingerprint: request.print, outcome: 'pending', at: Date.now(), run }
    receipts()[request.key] = fresh
    const promise = (async () => {
      try {
        // Ordinary saves may be skipped when this host closes or loses the lock.
        await rt.save({ required: true })
      } catch (error) {
        delete receipts()[request.key]
        rt.warn('ds-bot: the receipt of the request was not saved: %s', error)
        throw error
      }
      try {
        const receipt = await work()
        if (request.unsent === true) {
          // The work decided before anything went out: it is not a delivered
          // receipt, so the request is free to be admitted again. The removal has
          // to be saved before that is true: a leftover pending record stays.
          delete receipts()[request.key]
          try {
            await rt.save({ required: true })
          } catch (error) {
            fresh.outcome = 'uncertain'
            fresh.at = Date.now()
            receipts()[request.key] = fresh
            rt.warn('ds-bot: the removal of the request receipt was not saved: %s', error)
          }
          return receipt
        }
        fresh.outcome = 'delivered'
        fresh.receipt = receipt
        fresh.at = Date.now()
        await rt.save().catch(() => {})
        return receipt
      } catch (error) {
        // The message may have gone out; it is not sent again.
        fresh.outcome = 'uncertain'
        fresh.at = Date.now()
        await rt.save().catch(() => {})
        throw error
      }
    })()
    inflight.set(request.key, promise)
    try {
      return { status: 'sent', receipt: await promise }
    } finally {
      inflight.delete(request.key)
    }
  }

  Object.assign(rt, { requestIdentity: identity, knownRequest: known, admitRequest: admit })

  // One pass after the team file loads, never on a normal save: what was pruned has to reach
  // the file, so the smaller table is saved once here.
  if (typeof rt.load === 'function') {
    void rt.load().then(() => {
      const pruned = pruneRequests(receipts(), { inflight: new Set(inflight.keys()) })
      if (pruned.receipts > 0) rt.diagnostics?.record?.({ source: 'requests', text: `receipts pruned: ${pruned.receipts}` })
      if (pruned.tombstones > 0) rt.diagnostics?.record?.({ source: 'requests', text: `tombstones pruned: ${pruned.tombstones}` })
      if (pruned.receipts + pruned.tombstones === 0) return undefined
      return rt.save().catch(() => {})
    }).catch(() => {})
  }
}
