import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHoverLinger, HOVER_LINGER_MS } from '../src/client/hover-linger.js'

// A controllable clock: the linger's grace period is what keeps a tool strip alive
// while the pointer crosses the gap to it, so the tests drive the timer by hand.
const clock = () => {
  let next = 1
  const timers = new Map()
  return {
    setTimer: (run, delay) => { const id = next++; timers.set(id, { run, delay }); return id },
    clearTimer: id => { timers.delete(id) },
    pending: () => timers.size,
    advance: () => { const live = [...timers.values()]; timers.clear(); for (const timer of live) timer.run() },
    delays: () => [...timers.values()].map(timer => timer.delay),
  }
}

const track = () => {
  const values = []
  return { values, onShown: value => values.push(value) }
}

test('hovering shows the strip once, however often the pointer reports it', () => {
  const time = clock()
  const seen = track()
  const linger = createHoverLinger(seen.onShown, { setTimer: time.setTimer, clearTimer: time.clearTimer })
  linger.hold()
  linger.hold()
  linger.hold()
  assert.deepEqual(seen.values, [true])
})

test('leaving hides it only after the grace period', () => {
  const time = clock()
  const seen = track()
  const linger = createHoverLinger(seen.onShown, { setTimer: time.setTimer, clearTimer: time.clearTimer })
  linger.hold()
  linger.release()
  assert.deepEqual(seen.values, [true], 'the strip is still there while the pointer crosses the gap')
  assert.deepEqual(time.delays(), [HOVER_LINGER_MS])
  time.advance()
  assert.deepEqual(seen.values, [true, false])
})

test('reaching the strip between the bubble and the tools cancels the hide', () => {
  const time = clock()
  const seen = track()
  const linger = createHoverLinger(seen.onShown, { setTimer: time.setTimer, clearTimer: time.clearTimer })
  linger.hold()
  linger.release()
  linger.hold()
  assert.equal(time.pending(), 0, 'the pending hide is dropped')
  time.advance()
  assert.deepEqual(seen.values, [true], 'the strip stays while a tool is under the pointer')
})

test('a second leave re-arms the grace instead of stacking timers', () => {
  const time = clock()
  const seen = track()
  const linger = createHoverLinger(seen.onShown, { setTimer: time.setTimer, clearTimer: time.clearTimer })
  linger.hold()
  linger.release()
  linger.release()
  assert.equal(time.pending(), 1)
  time.advance()
  assert.deepEqual(seen.values, [true, false])
})

test('leaving the row for good hides the strip and nothing is left scheduled', () => {
  const time = clock()
  const seen = track()
  const linger = createHoverLinger(seen.onShown, { setTimer: time.setTimer, clearTimer: time.clearTimer })
  linger.hold()
  linger.release()
  time.advance()
  assert.equal(time.pending(), 0)
  assert.equal(linger.shown, false)
})

test('a disposed row drops its pending hide', () => {
  const time = clock()
  const seen = track()
  const linger = createHoverLinger(seen.onShown, { setTimer: time.setTimer, clearTimer: time.clearTimer })
  linger.hold()
  linger.release()
  linger.dispose()
  assert.equal(time.pending(), 0)
  time.advance()
  assert.deepEqual(seen.values, [true], 'a row that is gone does not publish a hide')
})
