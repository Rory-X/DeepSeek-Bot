// Delivered request receipts are pruned once after the team file loads: old ones lose the
// receipt but keep their name, so a late retry is answered `expired` instead of delivered a
// second time. A request whose outcome is unknown is never touched.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { REQUESTS_RECEIPTS_KEEP_MS, REQUESTS_RECEIPTS_KEPT, REQUESTS_TOMBSTONES, pruneRequests } from '../src/host/requests.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const key = name => `m1\u0000own\u0000${name}`
// The fingerprint the module itself computes for a payload.
const fingerprintOf = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex')
const delivered = (at, receipt = `answer for ${at}`, fingerprint = 'f'.repeat(64)) => ({ fingerprint, outcome: 'delivered', at, run: 'an earlier run', receipt })

async function start(requests) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-requests-retention-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, requests }))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  // The prune runs on the load's own turn; one macrotask later it is done.
  await new Promise(resolve => setTimeout(resolve, 30))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, home, stop }
}

const saved = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))

test('an old delivered receipt is pruned and the name stays taken', async (t) => {
  const now = Date.now()
  const host = await start({
    [key('old')]: delivered(now - REQUESTS_RECEIPTS_KEEP_MS - 60_000, 'the first answer', fingerprintOf({ text: 'hi' })),
    [key('fresh')]: delivered(now - 60_000),
    [key('unknown')]: { fingerprint: 'f'.repeat(64), outcome: 'uncertain', at: now - REQUESTS_RECEIPTS_KEEP_MS - 60_000, run: 'an earlier run' },
    [key('pending')]: { fingerprint: 'f'.repeat(64), outcome: 'pending', at: now - REQUESTS_RECEIPTS_KEEP_MS - 60_000, run: 'another run' },
  })
  t.after(host.stop)

  assert.equal(host.rt.state.requests[key('old')].receipt, undefined)
  assert.equal(host.rt.state.requests[key('fresh')].receipt, `answer for ${now - 60_000}`)
  // Nothing whose outcome is unknown or still in the air is touched.
  assert.equal(host.rt.state.requests[key('unknown')].outcome, 'uncertain')
  assert.equal(host.rt.state.requests[key('unknown')].at, now - REQUESTS_RECEIPTS_KEEP_MS - 60_000)
  assert.equal(host.rt.state.requests[key('pending')].outcome, 'pending')
  // Only the receipt goes: the rest of the team file is untouched, and the shrink is saved.
  assert.equal(host.rt.state.bots.m1.name, 'Chief')
  assert.equal(saved(host.home).requests[key('old')].receipt, undefined)

  // A late retry of the pruned name is answered `expired`, never delivered again.
  const request = host.rt.requestIdentity({ caller: 'm1', context: 'own', name: 'old', payload: { text: 'hi' } })
  assert.equal(request.key, key('old'))
  assert.deepEqual(await host.rt.knownRequest(request), { status: 'expired' })
  let sent = false
  const verdict = await host.rt.admitRequest(request, async () => { sent = true; return 'again' })
  assert.equal(verdict.status, 'expired')
  assert.equal(sent, false)

  const entries = await host.rt.diagnostics.entries()
  assert.ok(entries.some(entry => entry.source === 'requests' && entry.text === 'receipts pruned: 1'))
})

test('the count limit prunes the oldest receipts and keeps the newest ones', async (t) => {
  const now = Date.now()
  const requests = {}
  for (let index = 0; index < REQUESTS_RECEIPTS_KEPT + 3; index += 1) requests[key(`r${index}`)] = delivered(now - index * 1_000)
  const host = await start(requests)
  t.after(host.stop)

  const kept = Object.entries(host.rt.state.requests).filter(([, record]) => record.receipt !== undefined)
  assert.equal(kept.length, REQUESTS_RECEIPTS_KEPT)
  // The three oldest lost their receipt; the newest did not.
  assert.equal(host.rt.state.requests[key(`r${REQUESTS_RECEIPTS_KEPT + 2}`)].receipt, undefined)
  assert.equal(host.rt.state.requests[key('r0')].receipt, `answer for ${now}`)
  const entries = await host.rt.diagnostics.entries()
  assert.ok(entries.some(entry => entry.source === 'requests' && entry.text === 'receipts pruned: 3'))
})

test('pruning runs once after the load, not on every save', async (t) => {
  const host = await start({})
  t.after(host.stop)

  // A receipt that would be old enough, added after the boot pass: the next save keeps it.
  const now = Date.now()
  host.rt.state.requests[key('late')] = delivered(Date.now() - REQUESTS_RECEIPTS_KEEP_MS - 60_000)
  await host.rt.save()
  assert.equal(host.rt.state.requests[key('late')].receipt, `answer for ${now - REQUESTS_RECEIPTS_KEEP_MS - 60_000}`)
  assert.equal(saved(host.home).requests[key('late')].receipt !== undefined, true)
})

const tombstone = at => ({ fingerprint: 'f'.repeat(64), outcome: 'delivered', at, run: 'an earlier run' })

test('tombstones have their own bound, and the oldest ones go first', () => {
  const now = Date.now()
  const table = {}
  for (let index = 0; index < REQUESTS_TOMBSTONES + 5; index += 1) table[key(`t${index}`)] = tombstone(now - index * 1_000)
  const pruned = pruneRequests(table, { now })
  assert.deepEqual(pruned, { receipts: 0, tombstones: 5 })
  assert.equal(Object.keys(table).length, REQUESTS_TOMBSTONES)
  // The five oldest went completely; the newest ones stay.
  for (const index of [REQUESTS_TOMBSTONES, REQUESTS_TOMBSTONES + 1, REQUESTS_TOMBSTONES + 4]) assert.equal(table[key(`t${index}`)], undefined)
  assert.equal(table[key('t0')].at, now)
})

test('a request still in flight is skipped by both passes', () => {
  const now = Date.now()
  const table = {}
  for (let index = 0; index < REQUESTS_TOMBSTONES + 2; index += 1) table[key(`t${index}`)] = tombstone(now - index * 1_000)
  // The oldest tombstone and one old receipt belong to requests being admitted right now.
  table[key('busyTombstone')] = tombstone(now - 10_000_000)
  table[key('busyReceipt')] = delivered(now - REQUESTS_RECEIPTS_KEEP_MS - 60_000)
  const inflight = new Set([key('busyTombstone'), key('busyReceipt')])
  const pruned = pruneRequests(table, { now, inflight })
  // Only the two tombstones past the bound lose their record; the busy ones are untouched.
  assert.deepEqual(pruned, { receipts: 0, tombstones: 2 })
  assert.equal(table[key('busyTombstone')].outcome, 'delivered')
  assert.equal(table[key('busyReceipt')].receipt !== undefined, true)
})

test('a boot prunes excess tombstones and logs that separately', async (t) => {
  const now = Date.now()
  const requests = {}
  for (let index = 0; index < REQUESTS_TOMBSTONES + 4; index += 1) requests[key(`t${index}`)] = tombstone(now - index * 1_000)
  const host = await start(requests)
  t.after(host.stop)

  assert.equal(Object.keys(host.rt.state.requests).length, REQUESTS_TOMBSTONES)
  const entries = await host.rt.diagnostics.entries()
  assert.ok(entries.some(entry => entry.source === 'requests' && entry.text === 'tombstones pruned: 4'))
  assert.equal(saved(host.home).requests[key(`t${REQUESTS_TOMBSTONES}`)], undefined)
  assert.equal(saved(host.home).requests[key('t0')].outcome, 'delivered')
})
