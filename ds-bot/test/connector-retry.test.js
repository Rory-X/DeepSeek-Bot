import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMountRetryScheduler, MOUNT_RETRY_DELAYS } from '../src/host/connector-retry.js'

// A scheduler driven by hand: the test decides when a timer fires.
function fakeTimers() {
  let next = 1
  const timers = new Map()
  const handles = []
  return {
    handles,
    setTimer: (fn, ms) => {
      const handle = { id: next++, ms, unref() {} }
      timers.set(handle.id, { fn, ms })
      handles.push(handle)
      return handle
    },
    clearTimer: (handle) => { if (handle?.id !== undefined) timers.delete(handle.id) },
    fire: (handle) => {
      const timer = timers.get(handle.id)
      assert.ok(timer, `timer ${handle.id} is not pending`)
      timers.delete(handle.id)
      timer.fn()
    },
    pending: () => [...timers.values()].map(timer => timer.ms),
  }
}

const setup = ({ isStopped } = {}) => {
  const timers = fakeTimers()
  const runs = []
  const scheduler = createMountRetryScheduler({
    run: id => { runs.push(id) },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...(isStopped === undefined ? {} : { isStopped }),
  })
  return { timers, runs, scheduler }
}

test('the three retry delays are 15s, 45s and 120s', () => {
  assert.deepEqual(MOUNT_RETRY_DELAYS, [15_000, 45_000, 120_000])
})

test('a retry that fails again keeps its count and moves to the next delay', async () => {
  const { timers, runs, scheduler } = setup()
  assert.equal(scheduler.schedule('cf'), true)
  assert.deepEqual(timers.pending(), [15_000])

  timers.fire(timers.handles[0])
  await Promise.resolve()
  assert.deepEqual(runs, ['cf'])
  // The mount failed again: the caller schedules the next attempt.
  assert.equal(scheduler.schedule('cf'), true)
  assert.deepEqual(timers.pending(), [45_000])

  timers.fire(timers.handles[1])
  await Promise.resolve()
  assert.equal(scheduler.schedule('cf'), true)
  assert.deepEqual(timers.pending(), [120_000])

  timers.fire(timers.handles[2])
  await Promise.resolve()
  // Third failure ends the chain: no fourth retry and nothing left pending.
  assert.equal(scheduler.schedule('cf'), false)
  assert.deepEqual(timers.pending(), [])
  assert.equal(scheduler.pending('cf'), false)
})

test('a success clears the chain, so a later timeout starts at 15s again', async () => {
  const { timers, scheduler } = setup()
  assert.equal(scheduler.schedule('cf'), true)
  timers.fire(timers.handles[0])
  await Promise.resolve()
  assert.equal(scheduler.schedule('cf'), true)
  scheduler.clear('cf')
  assert.equal(scheduler.pending('cf'), false)
  assert.deepEqual(timers.pending(), [])

  assert.equal(scheduler.schedule('cf'), true)
  assert.deepEqual(timers.pending(), [15_000])
})

test('scheduling twice before firing keeps one timer', () => {
  const { timers, scheduler } = setup()
  scheduler.schedule('cf')
  scheduler.schedule('cf')
  assert.deepEqual(timers.pending(), [15_000])
})

test('a stopping plugin does not schedule, and a pending chain is cleared', () => {
  let stopped = false
  const { timers, scheduler } = setup({ isStopped: () => stopped })
  assert.equal(scheduler.schedule('cf'), true)
  stopped = true
  assert.equal(scheduler.schedule('cf'), false)
  scheduler.clear('cf')
  assert.deepEqual(timers.pending(), [])
})
