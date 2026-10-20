import assert from 'node:assert/strict'
import { test } from 'node:test'
import { queueRosterPull, watchRosterChanges } from '../src/client/roster-sync.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('a save during an earlier read gets a fresh response without parallel reads or starvation', async () => {
  let revision = 0, active = 0, maximum = 0
  const reads = []
  const refresh = queueRosterPull(async () => {
    const request = deferred()
    const snapshot = revision
    active++
    maximum = Math.max(maximum, active)
    reads.push(request)
    await request.promise
    active--
    return snapshot
  })
  const older = refresh()
  await tick()
  revision = 1
  const saved = refresh(), duplicate = refresh()
  assert.equal(saved, duplicate)
  reads[0].resolve()
  assert.equal(await older, 0)
  await tick()
  assert.equal(reads.length, 2)
  revision = 2
  const later = refresh()
  reads[1].resolve()
  assert.equal(await saved, 1)
  await tick()
  reads[2].resolve()
  assert.equal(await later, 2)
  assert.equal(maximum, 1)
})

test('a failed read does not discard a queued refresh', async () => {
  const first = deferred()
  let calls = 0
  const refresh = queueRosterPull(() => (++calls === 1 ? first.promise : Promise.resolve('fresh')))
  const failed = refresh()
  const caught = assert.rejects(failed, /offline/)
  await tick()
  const saved = refresh()
  first.reject(new Error('offline'))
  await caught
  assert.equal(await saved, 'fresh')
})

function feed() {
  let controller, cancelled = false
  const body = new ReadableStream({ start(value) { controller = value }, cancel() { cancelled = true } })
  return { response: new Response(body), send: text => controller.enqueue(new TextEncoder().encode(text)), close: () => controller.close(), get cancelled() { return cancelled } }
}

test('roster notifications survive split frames and ignore chat content and malformed events', async t => {
  const source = feed(), revisions = [], requests = []
  const stop = watchRosterChanges(value => revisions.push(value), { fetcher: async (url, init) => { requests.push({ url, init }); return source.response } })
  t.after(stop)
  await tick()
  source.send('event: hello\r')
  source.send('\ndata: {"revision":1}\r\n\r\nevent: rev')
  source.send('ision\ndata: {"revision":2}\n\n: keepalive\n\n')
  source.send('event: message\ndata: {"text":"private chat","revision":99}\n\nevent: revision\ndata: invalid\n\n')
  source.send('event: revision\ndata: {"revision":3}\n\n')
  await tick()
  assert.deepEqual(revisions, [1, 2, 3])
  assert.equal(requests[0].url, 'api/bot/feed?scope=roster')
  assert.equal(requests[0].init.credentials, 'same-origin')
  stop()
  await tick()
  assert.equal(source.cancelled, true)
  assert.equal(requests[0].init.signal.aborted, true)
})

test('disconnect reconnects and hello catches up; disposal cancels pending retry', async () => {
  const first = feed(), second = feed(), timers = [], cancelled = [], seen = []
  let attempts = 0
  const stop = watchRosterChanges(value => seen.push(value), {
    fetcher: async () => (++attempts === 1 ? first.response : second.response),
    schedule: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer },
    cancel: timer => cancelled.push(timer),
  })
  await tick()
  first.send('event: hello\ndata: {"revision":4}\n\n')
  first.close()
  await tick()
  assert.equal(timers[0].ms, 500)
  timers[0].callback()
  await tick()
  second.send('event: hello\ndata: {"revision":7}\n\n')
  second.close()
  await tick()
  assert.deepEqual(seen, [4, 7])
  stop()
  await tick()
  assert.equal(cancelled.at(-1), timers.at(-1))
  assert.equal(attempts, 2)
})

test('closing before headers arrive cancels the late stream without updating the roster', async () => {
  const pending = deferred(), source = feed(), revisions = []
  const stop = watchRosterChanges(value => revisions.push(value), { fetcher: () => pending.promise })
  stop()
  pending.resolve(source.response)
  await tick()
  assert.equal(source.cancelled, true)
  assert.deepEqual(revisions, [])
})
