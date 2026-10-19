// Connector write approvals: the plugin's own card, not DSH's approval service. A Bot's
// Session can run with approvals turned off, where DSH would reject an `ask` outright and
// the write would never happen, so a connector that changes something outside DS Bot asks
// here instead. The card is the same question dock `ask_user` uses (`state.questions`,
// rendered by QuestionDock): the acting Bot, the target tool, one line of impact, and
// Allow once / Deny. One card per conversation at a time; parallel writes queue behind it.
// A refusal, a dismissal and a five-minute silence all leave the call unrun and are
// written to diagnostics, without arguments or credentials.
import { randomUUID } from 'node:crypto'

export const APPROVAL_KIND = 'connector-approval'
export const APPROVAL_ALLOW = 'Allow once'
export const APPROVAL_DENY = 'Deny'
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const SLOT_STEP_MS = 250

// A wait that does not keep the process alive.
const pause = ms => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

export function createApprovalDesk({ rt, timeoutMs = APPROVAL_TIMEOUT_MS }) {
  const state = rt.state
  const waiting = new Map()
  const queues = new Map()
  let stopped = false

  const botNameOf = (sessionId) => {
    const botId = rt.selfOf?.(sessionId)
    return rt.botOf?.(botId)?.name ?? 'A Bot'
  }
  const record = (text) => {
    try {
      rt.diagnostics?.record?.({ source: 'connector-approval', text: rt.redactSecrets?.(text) ?? text })
    } catch {
      // An audit line must never change the outcome of an approval.
    }
  }

  function detach(questionId) {
    const entry = waiting.get(questionId)
    if (entry === undefined) return undefined
    waiting.delete(questionId)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (state.questions?.[entry.sessionId]?.id === questionId) delete state.questions[entry.sessionId]
    return entry
  }

  // Takes the card away, records what happened, saves, then lets the tool call continue.
  async function finish(questionId, outcome, note) {
    const entry = detach(questionId)
    if (entry === undefined) return undefined
    record(`${note}: ${entry.connector}'s ${entry.tool} for ${entry.bot}`)
    await rt.save().catch(() => {})
    entry.resolve(outcome)
    return outcome
  }

  function ask({ sessionId, connector, tool, signal }) {
    return new Promise((resolve) => {
      const question = {
        id: randomUUID(),
        kind: APPROVAL_KIND,
        question: `Allow ${botNameOf(sessionId)} to run ${connector}'s ${tool}?`,
        detail: 'It changes something outside DS Bot. Nothing is sent unless you allow it.',
        options: [
          { label: APPROVAL_ALLOW, description: 'Run this one call' },
          { label: APPROVAL_DENY, description: 'Do not run it' },
        ],
        askedAt: Date.now(),
      }
      const entry = { questionId: question.id, sessionId, connector, tool, bot: botNameOf(sessionId), resolve, timer: undefined }
      state.questions = state.questions ?? {}
      state.questions[sessionId] = question
      waiting.set(question.id, entry)
      // A pending approval holds the process open like any other in-flight tool call.
      entry.timer = setTimeout(() => { void finish(question.id, 'timeout', 'timed out') }, timeoutMs)
      signal?.addEventListener('abort', () => { void finish(question.id, 'cancelled', 'cancelled') }, { once: true })
      void rt.save().catch(() => {})
    })
  }

  // A model's own question card keeps the dock until it is answered; a write waits for
  // the slot rather than replacing the user's card.
  async function waitForSlot(sessionId, deadline, signal) {
    while (state.questions?.[sessionId] !== undefined) {
      if (stopped) return 'unavailable'
      if (signal?.aborted === true) return 'cancelled'
      if (Date.now() >= deadline) return 'timeout'
      await pause(SLOT_STEP_MS)
    }
    if (stopped) return 'unavailable'
    return signal?.aborted === true ? 'cancelled' : 'free'
  }

  // One decision for one tool call: 'allow', 'deny', 'timeout' or 'unavailable'.
  async function approve({ sessionId, connector, tool, signal }) {
    if (typeof sessionId !== 'string' || sessionId === '') return 'unavailable'
    const deadline = Date.now() + timeoutMs
    const run = (queues.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        const slot = await waitForSlot(sessionId, deadline, signal)
        return slot === 'free' ? await ask({ sessionId, connector, tool, signal }) : slot
      })
    const tail = run.then(() => undefined, () => undefined)
    queues.set(sessionId, tail)
    void tail.then(() => { if (queues.get(sessionId) === tail) queues.delete(sessionId) })
    return await run
  }

  // The answer from /api/bot, where `selected` holds the card's option labels.
  async function answer(sessionId, questionId, body) {
    const question = state.questions?.[sessionId]
    if (question === undefined || question.id !== questionId || question.kind !== APPROVAL_KIND) return 'stale'
    const selected = Array.isArray(body?.selected) ? body.selected : []
    const allowed = selected.includes(APPROVAL_ALLOW) && !selected.includes(APPROVAL_DENY)
    return (await finish(questionId, allowed ? 'allow' : 'deny', allowed ? 'allowed' : 'denied')) ?? 'stale'
  }

  // A dismissed card is a refusal: nothing is sent.
  async function dismiss(sessionId, questionId) {
    return (await finish(questionId, 'deny', 'dismissed')) ?? 'stale'
  }

  // The conversation or the card is gone (a typed message, a deleted Bot or room): the
  // call stops waiting. `outcome` says what the model hears.
  async function cancel(sessionId, outcome = 'unavailable') {
    const failed = [...waiting.values()].filter(entry => entry.sessionId === sessionId)
    if (failed.length === 0) return
    for (const entry of failed) {
      detach(entry.questionId)
      record(`cancelled: ${entry.connector}'s ${entry.tool} for ${entry.bot}`)
      entry.resolve(outcome)
    }
    await rt.save().catch(() => {})
  }

  function dispose() {
    stopped = true
    const failed = [...waiting.values()]
    for (const entry of failed) {
      detach(entry.questionId)
      entry.resolve('unavailable')
    }
    if (failed.length > 0) void rt.save().catch(() => {})
  }

  return { approve, answer, dismiss, cancel, dispose }
}
