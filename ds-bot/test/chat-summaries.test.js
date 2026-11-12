import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, projectionSummary } from '../src/host/chat-summaries.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t, { count = 3, saved, stat } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-summary-'))
  if (saved) await writeFile(join(home, 'chat-summaries.json'), JSON.stringify(saved))
  const listeners = {}, effects = [], errors = []
  const state = { bots: Object.fromEntries(Array.from({ length: count }, (_, i) => [`b${i}`, { id: `b${i}` }])), rooms: {}, exchangeTurns: {} }
  const services = {
    sessionPersistence: { stat: stat ?? (async id => ({ header: { id } })) },
    sessionProjectionCache: { cachedSnapshot: header => ({ asOfSeq: 5, values: { turnOutline: [{ turn: 1, start: 100, response: `reply ${header.id}` }] } }) },
  }
  const rt = {
    home, state, chatOf: id => id, sessionOfRoom: room => room.id,
    load: async () => {}, readOnly: () => undefined,
    warn: (...args) => errors.push(args),
    onSaved: listener => { listeners.saved = listener; return () => {} },
    displayItems: (_id, events) => events.flatMap(event => event.data.hidden ? [] : [{ kind: 'bot', text: event.data.text }]),
    ctx: { get: name => services[name], sessions: { get: () => undefined }, on: (name, listener) => { listeners[name] = listener }, effect: execute => effects.push(execute()) },
  }
  install(rt)
  const stop = async () => { for (const dispose of effects.splice(0)) await dispose() }
  t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }) })
  await rt.chatSummariesReady()
  return { rt, home, listeners, errors, stop }
}

test('a summary is bounded and ignores hidden exchange turns', () => {
  const summary = projectionSummary({ asOfSeq: 9, values: { turnOutline: [{ turn: 1, start: 3, response: 'visible '.repeat(200) }, { turn: 2, response: 'internal' }] } }, [2])
  assert.equal(summary.preview.length, 240)
  assert.equal(summary.seq, 9)
  assert.equal(summary.updatedAt, 3)
})

test('a cold start seeds cached checkpoints with at most two reads and never activates an Agent', async t => {
  let active = 0, maximum = 0
  const release = []
  const { rt } = await fixture(t, { count: 29, stat: id => new Promise(resolve => {
    maximum = Math.max(maximum, ++active)
    release.push(() => { active--; resolve({ header: { id } }) })
  }) })
  assert.deepEqual(rt.chatSummariesView(), {})
  await tick()
  assert.equal(active, 2)
  for (let i = 0; i < 29; i++) { release.shift()(); await tick() }
  assert.equal(maximum, 2)
  assert.equal(Object.keys(rt.chatSummariesView()).length, 29)
})

test('persisted summaries are available before checkpoint seeding finishes', async t => {
  const { rt } = await fixture(t, { saved: { version: 1, entries: { b0: { preview: 'saved', updatedAt: 200, seq: 8 } } } })
  assert.equal(rt.chatSummariesView().b0.preview, 'saved')
  await tick()
  assert.equal(rt.chatSummariesView().b0.preview, 'saved')
})

test('a turn hidden after caching is withheld and reseeded without replaying its log', async t => {
  const { rt, listeners } = await fixture(t, { count: 1 })
  rt.chatSummariesView()
  await tick()
  assert.equal(rt.chatSummariesView().b0.preview, 'reply b0')
  rt.state.exchangeTurns.b0 = [1]
  listeners.saved()
  assert.equal(rt.chatSummariesView().b0, undefined)
  await tick()
  assert.equal(rt.chatSummariesView().b0, undefined)
})

test('live messages supersede an in-flight older checkpoint; hidden messages stay hidden', async t => {
  let finish
  const { rt, listeners } = await fixture(t, { count: 1, stat: () => new Promise(resolve => { finish = resolve }) })
  rt.chatSummariesView()
  await tick()
  listeners['session/event']({ id: 'b0' }, { type: 'assistant/message', seq: 12, time: 300, data: { text: 'new reply' } })
  finish({ header: { id: 'b0' } })
  await tick()
  assert.equal(rt.chatSummariesView().b0.preview, 'new reply')
  listeners['session/event']({ id: 'b0' }, { type: 'assistant/message', seq: 13, time: 400, data: { text: 'secret exchange', hidden: true } })
  assert.equal(rt.chatSummariesView().b0.preview, 'new reply')
})

test('deleted conversations are excluded and the cache survives a restart', async t => {
  const { rt, listeners } = await fixture(t, { count: 1 })
  rt.chatSummariesView()
  await tick()
  const initial = rt.chatSummariesView().b0
  assert.equal(initial.preview, 'reply b0')
  const disk = await fixture(t, { count: 1, saved: { version: 1, entries: { b0: initial } } })
  await disk.stop()
  const saved = JSON.parse(await readFile(join(disk.home, 'chat-summaries.json'), 'utf8'))
  const other = await fixture(t, { count: 1, saved })
  assert.equal(other.rt.chatSummariesView().b0.preview, initial.preview)
  delete rt.state.bots.b0
  listeners.saved()
  await tick()
  assert.deepEqual(rt.chatSummariesView(), {})
})
