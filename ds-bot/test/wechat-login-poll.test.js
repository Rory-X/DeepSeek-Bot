import assert from 'node:assert/strict'
import { test } from 'node:test'
import { POLL_GAP_MS, POLL_LIMIT_MS, pollLoginSerially } from '../src/client/wechat-login.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('one status request is in flight at a time', async () => {
  let inFlight = 0
  let most = 0
  const waiting = []
  const poll = () => {
    inFlight += 1
    most = Math.max(most, inFlight)
    return new Promise((resolve) => { waiting.push(() => { inFlight -= 1; resolve({ ok: true }) }) })
  }
  let clock = 0
  let cancelled = false
  const running = pollLoginSerially({
    poll,
    cancelled: () => cancelled,
    now: () => clock,
    sleep: async ms => { clock += ms },
    startedAt: 0,
    limitMs: 60_000,
    gapMs: 500,
  })
  await tick()
  assert.equal(waiting.length, 1, 'the first request starts on its own')
  assert.equal(most, 1, 'only one request may be in flight')
  waiting.shift()()
  await tick()
  await tick()
  assert.equal(waiting.length, 1, 'the next request waits for the answer')
  assert.equal(most, 1)
  cancelled = true
  waiting.shift()?.()
  await running
  assert.equal(most, 1, 'never more than one at a time')
})

test('the wait stops at the five minute limit', async () => {
  let clock = 0
  let calls = 0
  const poll = async () => { calls += 1; clock += 120_000; return {} }
  const slept = []
  const total = await pollLoginSerially({
    poll,
    now: () => clock,
    sleep: async ms => { slept.push(ms); clock += ms },
    startedAt: 0,
    limitMs: POLL_LIMIT_MS,
    gapMs: POLL_GAP_MS,
  })
  // 0 < 5min: poll (2min), 2min<5min: poll (4min), 4min<5min: poll (6min), then the limit stops it.
  assert.equal(total, 3)
  assert.equal(calls, 3)
  assert.deepEqual(slept, [POLL_GAP_MS, POLL_GAP_MS, POLL_GAP_MS])
})

test('a cancelled wait sends nothing more', async () => {
  let calls = 0
  const poll = async () => { calls += 1; return {} }
  const total = await pollLoginSerially({
    poll,
    cancelled: () => calls >= 1,
    now: () => 0,
    sleep: async () => {},
    startedAt: 0,
    limitMs: POLL_LIMIT_MS,
    gapMs: POLL_GAP_MS,
  })
  assert.equal(total, 1)
  assert.equal(calls, 1)
})

test('a failed status call does not stop the wait', async () => {
  let calls = 0
  let clock = 0
  const poll = async () => { calls += 1; if (calls === 1) throw new Error('iLink answered 503'); clock += 1000; return {} }
  const total = await pollLoginSerially({
    poll,
    now: () => clock,
    sleep: async ms => { clock += ms },
    startedAt: 0,
    limitMs: 5000,
    gapMs: POLL_GAP_MS,
  })
  assert.ok(total > 1, `kept asking after a failure: ${total}`)
  assert.ok(calls > 1)
})
