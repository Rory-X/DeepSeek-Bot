// WeChat connector tests. P1 is red first: these cases are written against the design's
// contract and the module has to make them pass. P2 cases (inbound listener, sessions,
// isolation) stay todos until P2 starts.
//
// Checklist and the ID -> test -> status table live in
// docs/plans/2026-10-21-wechat-test-checklist.md. P1-14 is folded into P1-13; P2-25 is
// covered by P2-13a/13b. Tests marked (F5) wait for the host view/test hooks.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { normalizeWechatSettings, wechatReadiness } from '../src/host/connectors/wechat.js'
import { postInbound, startWebhookReceiver, wechatHeaders } from './wechat-fakes.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', instructions: '', createdAt: 1 },
    b1: { id: 'b1', sessionId: 'b1', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Editor', role: 'Editor', instructions: '', createdAt: 3 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const teamHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-wechat-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  return home
}

function setup({ config = {}, home = teamHome(), session = false } = {}) {
  const registered = []
  const disposed = []
  const created = []
  const archived = []
  const sessionAgents = new Map()
  const ctx = fakeContext()
  if (session) {
    // A stand-in for the Session services the inbound half drives: the channel Session is
    // created through the fake controller and the fake agent records what `deliver` hands it.
    const agentOf = (sessionId) => {
      if (!sessionAgents.has(sessionId)) {
        sessionAgents.set(sessionId, {
          session: { id: sessionId },
          restricted: [],
          calls: [],
          followup(message) { this.calls.push(message) },
          ctx: { tools: { restrict(filter) { this.owner.restricted.push(filter) }, owner: undefined } },
        })
        sessionAgents.get(sessionId).ctx.tools.owner = sessionAgents.get(sessionId)
      }
      return sessionAgents.get(sessionId)
    }
    ctx.tools.schemas = () => []
    Object.assign(ctx, {
      llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
      workspaceRegistry: {
        get: () => undefined,
        resolveByPath: async () => undefined,
        create: async () => ({}),
        archiveSession: async (sessionId, options) => { archived.push([sessionId, options]) },
      },
      sessionController: {
        create: async (options) => { created.push(options); return { sessionId: `s${created.length}` } },
        resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
        selectModel: async () => {},
      },
      sessionTitle: { rename: async () => {} },
      sessions: { flush: async () => {} },
    })
  }
  const register = ctx.tools.register
  ctx.tools.register = (tool) => {
    registered.push(tool.name)
    const undo = register(tool)
    return () => { disposed.push(tool.name); ctx.registeredTools.delete(tool.name); undo() }
  }
  const route = ctx.connection.fetch.register
  ctx.connection.fetch.register = (handled) => { ctx.route = handled; return route(handled) }
  // Every test host gets an ephemeral inbound port: two hosts must never race for a fixed
  // one, and a developer machine may already serve the production port.
  const rt = createRuntime(ctx, { home, wechat: { listenPort: 0 }, ...config })
  registered.length = 0
  disposed.length = 0
  const emitSession = (sessionId, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, { type, data })
  }
  return { ctx, rt, home, registered, disposed, created, archived, sessionAgents, emitSession }
}

async function call(ctx, endpoint, payload) {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}
async function until(check, label) {
  for (let index = 0; index < 300; index += 1) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out: ${label}`)
}
const rowsOf = async (ctx) => (await call(ctx, 'state', {})).value.connectors.filter(row => row.id === 'wechat' || row.id.startsWith('wechat-'))
const rowOf = async (ctx, id = 'wechat') => (await rowsOf(ctx)).find(row => row.id === id)
const card = async (ctx) => (await call(ctx, 'state', {})).value.questions.m1
// The inbound address the card draws once the shared listener serves this channel.
// A port the test may expect to be reused, taken and released before the host starts.
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})
const inboundUrl = async (ctx, id = 'wechat') => {
  const inbound = await until(async () => (await rowOf(ctx, id))?.inbound, `the inbound address of ${id}`)
  return inbound.url
}
const answerCard = (ctx, questionId, selected) => call(ctx, 'answer-question', { sessionId: 'm1', questionId, answer: { selected } })

// Connect a webhook channel bound to b1; the callback receiver is the fake.
async function connectChannel(ctx, receiver, { id = 'wechat', settings = {} } = {}) {
  const values = { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic', ...settings }
  const saved = await call(ctx, 'connector-set-settings', { id, values })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const connected = await call(ctx, 'connector-connect', { id, values: { WECHAT_WEBHOOK_SECRET: 'test-secret' } })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  await until(async () => ((await rowOf(ctx, id))?.state === 'ready' ? true : undefined), `${id} ready`)
  return await rowOf(ctx, id)
}

const notifyNameOf = (id) => (id === 'wechat' ? 'wechat_notify' : `${id.replace('-', '_')}_notify`)
const toWrite = async (ctx, id = 'wechat') => {
  assert.equal((await call(ctx, 'connector-set-level', { id, level: 'write' })).ok, true)
  return until(async () => (ctx.registeredTools.has(notifyNameOf(id)) ? true : undefined), `the write tool of ${id}`)
}
const notifyToolOf = (ctx, id = 'wechat') => ctx.registeredTools.get(notifyNameOf(id))

// ---- test doubles (kept from the skeleton) ----
test('fakes: signed request verifies', async (t) => {
  const receiver = await startWebhookReceiver({ secret: 'test-secret' })
  t.after(() => receiver.close())
  const body = JSON.stringify({ text: 'a notice' })
  await fetch(receiver.url, { method: 'POST', headers: wechatHeaders({ secret: 'test-secret', body }), body })
  assert.equal(receiver.requests.length, 1)
  assert.equal(receiver.requests[0].signatureOk, true)
  assert.deepEqual(receiver.requests[0].json, { text: 'a notice' })
})

test('fakes: one signature both directions', async () => {
  const receiver = await startWebhookReceiver({ secret: 's' })
  try {
    await postInbound({ url: receiver.url, secret: 's', msgId: 'm1', timestamp: 1_700_000_000, nonce: 'fixed' })
    assert.equal(receiver.requests[0].signatureOk, true)
  } finally {
    await receiver.close()
  }
})

// ---- P1-01: one instance per channel ----
test('P1-01 a channel is one instance: create adds wechat-2, delete removes it, the ninth is refused', async (t) => {
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual((await rowsOf(ctx)).map(row => row.id), ['wechat'])
  for (let index = 2; index <= 8; index += 1) {
    assert.equal((await call(ctx, 'connector-create-instance', { base: 'wechat' })).ok, true)
  }
  assert.deepEqual((await rowsOf(ctx)).map(row => row.id), ['wechat', 'wechat-2', 'wechat-3', 'wechat-4', 'wechat-5', 'wechat-6', 'wechat-7', 'wechat-8'])
  const ninth = await call(ctx, 'connector-create-instance', { base: 'wechat' })
  assert.equal(ninth.ok, false)
  assert.match(ninth.error.message, /at most 8 instances/)
  assert.equal((await call(ctx, 'connector-delete-instance', { id: 'wechat-2' })).ok, true)
  assert.deepEqual((await rowsOf(ctx)).map(row => row.id), ['wechat', 'wechat-3', 'wechat-4', 'wechat-5', 'wechat-6', 'wechat-7', 'wechat-8'])
})

// ---- P1-02: the settings the card draws ----
test('P1-02 the row carries the channel settings and never a secret value', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const row = await connectChannel(ctx, receiver)
  assert.equal(row.level, 'read')
  assert.deepEqual(row.levels.map(level => level.id), ['read', 'write'])
  assert.deepEqual(row.settings.map(field => field.name), ['label', 'transport', 'botId', 'webhookUrl', 'webhookFormat', 'allowReadTools', 'webhookSecret'])
  const json = JSON.stringify(await call(ctx, 'state', {}))
  assert.equal(json.includes('test-secret'), false)
})

// ---- P1-03: readiness and mount failures ----
test('P1-03 readiness names the missing field and a deleted Bot before Connect', async (t) => {
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const row = await rowOf(ctx)
  assert.match(JSON.stringify(row.levelNotes ?? row.levelNote), /Choose a Bot/)
  const missingUrl = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'b1' } })
  assert.equal(missingUrl.ok, true)
  // P2 stores the URL as a credential and readiness runs before the store may be loaded, so
  // "unknown" is not "missing": the mount names the missing URL once it can tell.
  assert.equal(JSON.stringify((await rowOf(ctx)).levelNotes ?? (await rowOf(ctx)).levelNote ?? '').includes('webhook URL'), false)
  const noUrl = await until(async () => ((await rowOf(ctx))?.state === 'error' ? await rowOf(ctx) : undefined), 'the missing URL mount error')
  assert.match(noUrl.error, /Add the push webhook URL/)
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const ghost = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'deleted-bot', webhookUrl: receiver.url } })
  assert.equal(ghost.ok, true)
  // The binding is checked by readiness now, so the row stays off with the reason instead
  // of mounting and failing.
  await until(async () => ((await rowOf(ctx))?.levelNotes !== undefined ? true : undefined), 'the deleted Bot note')
  const missingBot = await rowOf(ctx)
  assert.equal(missingBot.state, 'off')
  assert.match(missingBot.levelNotes.read, /bound to no longer exists/)
})

// ---- P1-04: connect; P1-05: the notify tool and its approval ----
test('P1-04 connect turns the channel ready; P2 serves it a loopback inbound address', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const row = await connectChannel(ctx, receiver)
  assert.deepEqual([row.state, row.level], ['ready', 'read'])
  const inbound = await until(async () => (await rowOf(ctx))?.inbound, 'the inbound address')
  assert.match(inbound.url, /^http:\/\/127\.0\.0\.1:\d+\/wechat\/wechat\/inbound$/)
  assert.equal(row.login, undefined)
})

test('P1-05 wechat_notify asks first, runs once on allow and never on deny', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, registered } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  assert.equal(registered.includes('wechat_notify'), false, 'no notify tool at read level')
  await toWrite(ctx)
  assert.ok(registered.includes('wechat_notify'))

  const approved = notifyToolOf(ctx).execute({ text: 'deploy done' }, { agent: { id: 'm1' } })
  const shown = await until(() => card(ctx), 'the approval card')
  assert.match(shown.detail, /webhook/i)
  assert.ok(!shown.detail.includes('http://') && !shown.detail.includes('/webhook'), 'the card names the host, not the full URL')
  assert.equal(receiver.requests.length, 0)
  await answerCard(ctx, shown.id, ['Allow once'])
  assert.equal(await approved, 'Sent.')
  assert.equal(receiver.requests.length, 1)
  assert.deepEqual(receiver.requests[0].json, { text: 'deploy done' })

  const denied = notifyToolOf(ctx).execute({ text: 'again' }, { agent: { id: 'm1' } })
  const second = await until(() => card(ctx), 'the second card')
  await answerCard(ctx, second.id, ['Deny'])
  await assert.rejects(denied, /denied/)
  assert.equal(receiver.requests.length, 1)
})

// ---- P1-06: outbound errors and text limits ----
test('P1-06 outbound errors map to the fixed sentences and over-long text fails first', async (t) => {
  const receiver = await startWebhookReceiver({ reply: () => ({ status: 401, body: '{}' }) })
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  await toWrite(ctx)
  const send = async (text) => {
    const pending = notifyToolOf(ctx).execute({ text }, { agent: { id: 'm1' } })
    const shown = await until(() => card(ctx), 'the card')
    await answerCard(ctx, shown.id, ['Allow once'])
    return pending
  }
  await assert.rejects(send('hello'), /refused the credential/)
  assert.equal(receiver.requests.length, 1)

  receiver.setReply(() => ({ status: 429, body: '{"retry_after":9}' }))
  await assert.rejects(send('hello'), /rate-limited; try again in 9s/)

  const before = receiver.requests.length
  await assert.rejects(notifyToolOf(ctx).execute({ text: 'x'.repeat(4_001) }, { agent: { id: 'm1' } }), /limited to 4000 characters/)
  // set-settings replaces the form: send the whole channel, not one field.
  await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'wecom' } })
  // A settings change remounts the channel; the tool exists again after the mount.
  await until(() => (notifyToolOf(ctx) === undefined ? undefined : true), 'the remounted notify tool')
  await assert.rejects(notifyToolOf(ctx).execute({ text: 'x'.repeat(2_049) }, { agent: { id: 'm1' } }), /limited to 2048 characters/)
  assert.equal(receiver.requests.length, before)
})

// ---- P1 remaining ----
test('P1-07 a connected channel refuses a transport change until it is disconnected', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const full = { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' }
  await connectChannel(ctx, receiver)
  const refused = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { ...full, transport: 'clawbot' } })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.message, 'Disconnect this channel before changing the transport.')
  const row = await rowOf(ctx)
  assert.deepEqual([row.state, row.transport], ['ready', 'webhook'])
  // Other fields still save on a connected channel.
  const relabeled = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { ...full, label: 'Desk' } })
  assert.equal(relabeled.ok, true, JSON.stringify(relabeled))
  assert.equal((await rowOf(ctx)).settings.find(field => field.name === 'label').value, 'Desk')

  // A real disconnect turns it off and keeps it off: the secret is gone, the settings stay.
  assert.equal((await call(ctx, 'connector-disconnect', { id: 'wechat' })).ok, true)
  await until(async () => ((await rowOf(ctx))?.state === 'off' ? true : undefined), 'the channel to turn off')
  assert.equal((await call(ctx, 'connector-retry', { id: 'wechat' })).ok, true)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal((await rowOf(ctx)).state, 'off', 'a retry does not mount a disconnected channel')
  // The transport may change while off, and the save does not turn it back on.
  const switchedWhileOff = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { ...full, transport: 'clawbot' } })
  assert.equal(switchedWhileOff.ok, true, JSON.stringify(switchedWhileOff))
  assert.deepEqual([(await rowOf(ctx)).state, (await rowOf(ctx)).transport], ['off', 'clawbot'])
  // Back to webhook while still off, then connecting again clears the mark and mounts it.
  assert.equal((await call(ctx, 'connector-set-settings', { id: 'wechat', values: full })).ok, true)
  assert.deepEqual([(await rowOf(ctx)).state, (await rowOf(ctx)).transport], ['off', 'webhook'])
  const reconnected = await call(ctx, 'connector-connect', { id: 'wechat', values: { WECHAT_WEBHOOK_SECRET: 'test-secret' } })
  assert.equal(reconnected.ok, true, JSON.stringify(reconnected))
  await until(async () => ((await rowOf(ctx))?.state === 'ready' ? true : undefined), 'the channel to reconnect')
})

test('P1-07b an error channel also refuses the switch, and a never connected one may switch', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  // An error row is not reachable from the card in P1 (a broken binding is readiness and
  // keeps the row off), so the module rule is checked against the context the host passes.
  assert.throws(
    () => normalizeWechatSettings({ transport: 'clawbot' }, { state: 'error', settings: { transport: 'webhook' } }),
    /Disconnect this channel before changing the transport\./,
  )
  // A one-argument normalizeSettings call still works (modules that ignore the context).
  assert.deepEqual(normalizeWechatSettings({ transport: 'webhook' }), { transport: 'webhook' })
})
test('P1-10 deleting one channel unmounts only it; the other stays ready', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  assert.equal((await call(ctx, 'connector-create-instance', { base: 'wechat' })).ok, true)
  await call(ctx, 'connector-set-settings', { id: 'wechat-2', values: { transport: 'webhook', botId: 'b2', webhookUrl: receiver.url, webhookFormat: 'generic' } })
  assert.equal((await call(ctx, 'connector-connect', { id: 'wechat-2', values: { WECHAT_WEBHOOK_SECRET: 'second-secret' } })).ok, true)
  await until(async () => ((await rowOf(ctx, 'wechat-2'))?.state === 'ready' ? true : undefined), 'wechat-2 ready')
  await toWrite(ctx, 'wechat')
  await toWrite(ctx, 'wechat-2')
  assert.ok(ctx.registeredTools.has('wechat_notify') && ctx.registeredTools.has('wechat_2_notify'))
  assert.equal((await call(ctx, 'connector-delete-instance', { id: 'wechat-2' })).ok, true)
  assert.deepEqual((await rowsOf(ctx)).map(row => row.id), ['wechat'])
  assert.equal(ctx.registeredTools.has('wechat_2_notify'), false)
  assert.equal(ctx.registeredTools.has('wechat_notify'), true)
  assert.equal((await rowOf(ctx)).state, 'ready')
})

test('P1-11 the connector turned off in the profile has no row and registers nothing', async (t) => {
  const { ctx, home } = setup({ config: { wechat: false } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual(await rowsOf(ctx), [])
  assert.equal(ctx.registeredTools.has('wechat_notify'), false)
  assert.equal((await call(ctx, 'connector-connect', { id: 'wechat', values: {} })).ok, false)
})
test('P1-12 an empty text field clears its stored value', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver, { settings: { label: 'Desk' } })
  assert.equal((await rowOf(ctx)).settings.find(field => field.name === 'label').value, 'Desk')
  const cleared = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic', label: '' } })
  assert.equal(cleared.ok, true, JSON.stringify(cleared))
  assert.equal((await rowOf(ctx)).settings.find(field => field.name === 'label').value, undefined)
})

test('P1-08 connector-test posts the fixed notice and a failure stays on the row', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const tested = await call(ctx, 'connector-test', { id: 'wechat' })
  assert.equal(tested.ok, true, JSON.stringify(tested))
  assert.equal(receiver.requests.length, 1)
  assert.deepEqual(receiver.requests[0].json, { text: 'DS Bot: the WeChat channel works.' })
  assert.equal(tested.value.find(row => row.id === 'wechat').error, undefined)

  receiver.setReply(() => ({ status: 401, body: '{}' }))
  const failed = await call(ctx, 'connector-test', { id: 'wechat' })
  assert.equal(failed.ok, true, JSON.stringify(failed))
  const row = failed.value.find(item => item.id === 'wechat')
  assert.equal(row.state, 'ready')
  assert.match(row.error, /refused the credential/)
  receiver.setReply(() => ({ status: 200 }))
  const cleared = await call(ctx, 'connector-test', { id: 'wechat' })
  assert.equal(cleared.value.find(item => item.id === 'wechat').error, undefined)
})

test('P1-09 a secret saved on the card shows saved, never a value, and clearSecrets removes it', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const full = { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' }
  const saved = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { ...full, webhookSecret: 'rotated-secret' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const field = (await rowOf(ctx)).fields.find(item => item.name === 'webhookSecret')
  assert.equal(field.kind, 'secret')
  assert.equal(field.saved, true)
  assert.equal(JSON.stringify(await call(ctx, 'state', {})).includes('rotated-secret'), false)
  const cleared = await call(ctx, 'connector-set-settings', { id: 'wechat', values: full, clearSecrets: ['webhookSecret'] })
  assert.equal(cleared.ok, true, JSON.stringify(cleared))
  assert.equal((await rowOf(ctx)).fields.find(item => item.name === 'webhookSecret').saved, false)
})

test('P1-14 F2b naming invariants: bare first, _2 second, coexist, delete only its own', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const secretNames = async () => (await call(ctx, 'state', {})).value.secrets.map(secret => secret.name)
  assert.ok((await secretNames()).includes('WECHAT_WEBHOOK_SECRET'))
  assert.equal((await secretNames()).some(name => name.endsWith('_1')), false)
  assert.equal((await call(ctx, 'connector-create-instance', { base: 'wechat' })).ok, true)
  await call(ctx, 'connector-set-settings', { id: 'wechat-2', values: { transport: 'webhook', botId: 'b2', webhookUrl: receiver.url, webhookFormat: 'generic' } })
  assert.equal((await call(ctx, 'connector-connect', { id: 'wechat-2', values: { WECHAT_WEBHOOK_SECRET: 'second-secret' } })).ok, true)
  await until(async () => ((await rowOf(ctx, 'wechat-2'))?.state === 'ready' ? true : undefined), 'wechat-2 ready')
  const both = await secretNames()
  assert.ok(both.includes('WECHAT_WEBHOOK_SECRET') && both.includes('WECHAT_WEBHOOK_SECRET_2'))
  assert.equal((await rowOf(ctx)).state, 'ready')
  assert.equal((await call(ctx, 'connector-delete-instance', { id: 'wechat-2' })).ok, true)
  const after = await secretNames()
  assert.equal(after.includes('WECHAT_WEBHOOK_SECRET_2'), false)
  assert.ok(after.includes('WECHAT_WEBHOOK_SECRET'))
  assert.equal((await rowOf(ctx)).state, 'ready')
})

test('P1-15 the F5 card shape: field kinds, level descriptions, canTest and instance.max', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const row = await rowOf(ctx)
  assert.equal(row.instance.max, 8)
  assert.equal(row.transport, 'webhook')
  assert.equal(row.canTest, true)
  assert.ok(row.levels.every(level => typeof level === 'object' && level.id && level.description))
  const byName = Object.fromEntries(row.fields.map(field => [field.name, field]))
  assert.equal(byName.botId.kind, 'bot')
  assert.equal(byName.botId.required, true)
  assert.deepEqual(byName.transport.options.map(option => option.value), ['webhook']) // P1: ClawBot option comes with P3.
  assert.equal(byName.webhookSecret.kind, 'secret')
  assert.equal(byName.webhookSecret.saved, true)
  assert.equal('value' in byName.webhookSecret, false)
})
test('P1-13 two channels keep separate secrets: wechat-2 writes _2 and deleting it touches only its own', async (t) => {
  const receiver = await startWebhookReceiver({ secret: 'second-secret' })
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  assert.equal((await call(ctx, 'connector-create-instance', { base: 'wechat' })).ok, true)
  const saved = await call(ctx, 'connector-set-settings', { id: 'wechat-2', values: { transport: 'webhook', botId: 'b2', webhookUrl: receiver.url, webhookFormat: 'generic' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const connected = await call(ctx, 'connector-connect', { id: 'wechat-2', values: { WECHAT_WEBHOOK_SECRET: 'second-secret' } })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  await until(async () => ((await rowOf(ctx, 'wechat-2'))?.state === 'ready' ? true : undefined), 'wechat-2 ready')
  const names = () => ((call(ctx, 'state', {})).then(view => view.value.secrets.map(secret => secret.name).sort()))
  assert.ok((await names()).includes('WECHAT_WEBHOOK_SECRET'))
  assert.ok((await names()).includes('WECHAT_WEBHOOK_SECRET_2'))
  const json = JSON.stringify(await call(ctx, 'state', {}))
  assert.equal(json.includes('second-secret'), false)
  for (const row of await rowsOf(ctx)) {
    assert.deepEqual(row.inputs.map(field => field.name), ['WECHAT_WEBHOOK_SECRET', 'WECHAT_WEBHOOK_URL'])
  }
  await toWrite(ctx, 'wechat')
  await toWrite(ctx, 'wechat-2')
  assert.ok(ctx.registeredTools.has('wechat_notify') && ctx.registeredTools.has('wechat_2_notify'))
  // Each channel signs with its own secret: the framework resolved secrets per instance.
  await toWrite(ctx, 'wechat-2')
  const pending = notifyToolOf(ctx, 'wechat-2').execute({ text: 'from the second channel' }, { agent: { id: 'm1' } })
  const shown = await until(() => card(ctx), 'the wechat-2 approval card')
  await answerCard(ctx, shown.id, ['Allow once'])
  assert.equal(await pending, 'Sent.')
  const last = receiver.requests.at(-1)
  assert.equal(last.signatureOk, true, 'wechat-2 signed with its own secret')
  assert.equal((await call(ctx, 'connector-delete-instance', { id: 'wechat-2' })).ok, true)
  assert.equal((await names()).includes('WECHAT_WEBHOOK_SECRET_2'), false)
  assert.ok((await names()).includes('WECHAT_WEBHOOK_SECRET'))
  assert.equal(ctx.registeredTools.has('wechat_2_notify'), false)
})

// ---- P2: inbound listener and its gate ----
test('P2-01 the inbound listener binds 127.0.0.1 only', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup({ config: { wechat: { listenPort: 0, bindAddress: '0.0.0.0' } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  // A bind address is not a knob the profile owns: the address is loopback, whatever it says.
  const url = await inboundUrl(ctx)
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/wechat\/wechat\/inbound$/)
  const accepted = await postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'hello' })
  assert.deepEqual([accepted.status, accepted.json.accepted], [202, true])
})

test('P2-02 a taken port leaves only that channel error with the port and the fix', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  // The port is busy before the channel asks for it.
  const blocker = createServer()
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve) })
  const port = blocker.address().port
  t.after(() => new Promise(resolve => blocker.close(resolve)))
  const { ctx, home } = setup({ config: { wechat: { listenPort: port } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const full = { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' }
  assert.equal((await call(ctx, 'connector-set-settings', { id: 'wechat', values: full })).ok, true)
  await until(async () => ((await rowOf(ctx))?.state === 'ready' ? true : undefined), 'the outbound channel')
  const saved = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { ...full, webhookSecret: 'test-secret' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const row = await until(async () => ((await rowOf(ctx))?.state === 'error' ? await rowOf(ctx) : undefined), 'the port error row')
  assert.match(row.error, new RegExp(`port ${port}`))
  assert.match(row.error, /wechat\.listenPort/)
  // The plugin itself is healthy: the other connectors keep their own state.
  const state = (await call(ctx, 'state', {})).value
  assert.equal(state.connectors.find(item => item.id === 'wechat').state, 'error')
  assert.equal(state.connectors.find(item => item.id === 'vercel').state, 'off')
})

test('P2-02a inbound waits for the webhook secret: a URL alone opens no port', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const port = await freePort()
  const { ctx, home } = setup({ config: { wechat: { listenPort: port } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const full = { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' }
  assert.equal((await call(ctx, 'connector-set-settings', { id: 'wechat', values: full })).ok, true)
  await until(async () => ((await rowOf(ctx))?.state === 'ready' ? true : undefined), 'ready without a secret')
  // The outbound half works, the inbound half waits and the card says so.
  assert.equal((await rowOf(ctx)).inbound, undefined)
  assert.equal((await rowOf(ctx)).status?.inbound, 'needs-secret')
  await assert.rejects(fetch(`http://127.0.0.1:${port}/wechat/wechat/inbound`, { method: 'POST' }))
  // Saving the secret attaches the same channel on the configured port.
  const saved = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { ...full, webhookSecret: 'test-secret' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const inbound = await until(async () => (await rowOf(ctx))?.inbound, 'the inbound address')
  assert.match(inbound.url, new RegExp(`:${port}/wechat/wechat/inbound$`))
  const accepted = await postInbound({ url: inbound.url, secret: 'test-secret', msgId: 'm-1', sender: 'creator' })
  assert.equal(accepted.status, 202)
})

test('P2-02b removing the last channel and adding one at once keeps the port', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const port = await freePort()
  const { ctx, home } = setup({ config: { wechat: { listenPort: port } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  assert.match(await inboundUrl(ctx), new RegExp(`:${port}/wechat/wechat/inbound$`))
  assert.equal((await call(ctx, 'connector-disconnect', { id: 'wechat' })).ok, true)
  // No waiting: the next channel must reuse the listener, not race a closing port.
  assert.equal((await call(ctx, 'connector-create-instance', { base: 'wechat' })).ok, true)
  const saved = await call(ctx, 'connector-set-settings', { id: 'wechat-2', values: { transport: 'webhook', botId: 'b2', webhookUrl: receiver.url, webhookFormat: 'generic' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const connected = await call(ctx, 'connector-connect', { id: 'wechat-2', values: { WECHAT_WEBHOOK_SECRET: 'second-secret' } })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  const second = await inboundUrl(ctx, 'wechat-2')
  assert.match(second, new RegExp(`:${port}/wechat/wechat-2/inbound$`))
  const row = (await rowsOf(ctx)).find(item => item.id === 'wechat-2')
  assert.deepEqual([row.state, row.error], ['ready', undefined])
  const accepted = await postInbound({ url: second, secret: 'second-secret', msgId: 'm-2', sender: 'creator' })
  assert.equal(accepted.status, 202)
})

test('P2-03 dispose closes the inbound listener', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  await ctx.dispose()
  // The port refuses connections once the plugin is gone.
  await until(async () => {
    try {
      await fetch(url, { method: 'POST' })
      return undefined
    } catch {
      return true
    }
  }, 'the inbound listener to close')
})

test('P2-04 a missing or wrong signature answers 401 bad-signature and starts 0 turns', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const unsigned = await postInbound({ url, msgId: 'm-1', sender: 'creator' })
  assert.deepEqual([unsigned.status, unsigned.json.code], [401, 'bad-signature'])
  const wrong = await postInbound({ url, secret: 'another-secret', msgId: 'm-2', sender: 'creator' })
  assert.deepEqual([wrong.status, wrong.json.code], [401, 'bad-signature'])
  // Nothing was written for a refused message: no channel state, no Session.
  const state = (await call(ctx, 'state', {})).value
  assert.equal(state.channels === undefined || Object.keys(state.channels).length === 0, true)
})

test('P2-05 a timestamp outside ±300s answers 401 stale-timestamp and starts 0 turns', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const now = Math.floor(Date.now() / 1000)
  const old = await postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', timestamp: now - 301 })
  assert.deepEqual([old.status, old.json.code], [401, 'stale-timestamp'])
  const future = await postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', timestamp: now + 301 })
  assert.deepEqual([future.status, future.json.code], [401, 'stale-timestamp'])
  const fresh = await postInbound({ url, secret: 'test-secret', msgId: 'm-3', sender: 'creator', timestamp: now })
  assert.equal(fresh.status, 202)
})

test('P2-06 a replayed nonce answers 401 replayed-nonce and starts 0 turns', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const first = await postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', nonce: 'fixed-nonce' })
  assert.equal(first.status, 202)
  const replay = await postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', nonce: 'fixed-nonce' })
  assert.deepEqual([replay.status, replay.json.code], [401, 'replayed-nonce'])
})

test('P2-09 over the per-channel rate limit answers 429 with retry_after and starts 0 turns', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  for (let index = 1; index <= 10; index += 1) {
    const accepted = await postInbound({ url, secret: 'test-secret', msgId: `m-${index}`, sender: 'creator', text: 'hello' })
    assert.equal(accepted.status, 202, `request ${index}`)
  }
  const limited = await postInbound({ url, secret: 'test-secret', msgId: 'm-11', sender: 'creator', text: 'hello' })
  assert.equal(limited.status, 429)
  assert.equal(limited.json.code, 'rate-limited')
  assert.ok(Number.isInteger(limited.json.retry_after) && limited.json.retry_after >= 1, JSON.stringify(limited.json))
})

test('P2-10 a sender outside the allowlist answers 403 sender-not-allowed and starts 0 turns', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  // The first sender owns the channel conversation; a different sender is refused.
  const creator = await postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'hello' })
  assert.equal(creator.status, 202)
  const other = await postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'someone-else', text: 'hello' })
  assert.deepEqual([other.status, other.json.code], [403, 'sender-not-allowed'])
})

test('P2-19 body over 64KB is refused while streaming and callbackUrl outside loopback is refused', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)

  // A plain oversized body is stopped while it is being read, not after it is in memory.
  const big = JSON.stringify({ msgId: 'big', sender_id: 'creator', text: 'x'.repeat(70_000) })
  const bigResponse = await fetch(url, { method: 'POST', headers: wechatHeaders({ secret: 'test-secret', body: big }), body: big })
  assert.equal(bigResponse.status, 413)
  assert.equal((await bigResponse.json()).code, 'too-large')

  // A chunked body has no Content-Length to trust; the streaming cap still catches it.
  const stream = new ReadableStream({
    start(controller) {
      for (let index = 0; index < 14; index += 1) controller.enqueue(new TextEncoder().encode(big.slice(index * 5_000, (index + 1) * 5_000)))
      controller.close()
    },
  })
  const chunked = await fetch(url, { method: 'POST', headers: wechatHeaders({ secret: 'test-secret', body: big }), body: stream, duplex: 'half' })
  assert.equal(chunked.status, 413)

  const outside = await postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', callbackUrl: 'http://example.com/callback' })
  assert.equal(outside.status, 400)
  const loopback = await postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', callbackUrl: 'http://127.0.0.1:9/callback' })
  assert.equal(loopback.status, 202)
  const secure = await postInbound({ url, secret: 'test-secret', msgId: 'm-3', sender: 'creator', callbackUrl: 'https://example.com/callback' })
  assert.equal(secure.status, 202)
})

test('P2-21 HMAC is mandatory and Bearer optional (default off); with Bearer on, a missing one answers 401', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  // Default: HMAC alone is enough.
  const noToken = await postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator' })
  assert.equal(noToken.status, 202)

  const second = setup({ config: { wechat: { listenPort: 0, bearerRequired: true } } })
  t.after(async () => { await second.ctx.dispose(); rmSync(second.home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(second.ctx, receiver)
  const inbound = await until(async () => (await rowOf(second.ctx))?.inbound, 'the bearer inbound address')
  assert.equal(typeof inbound.token, 'string')
  const missing = await postInbound({ url: inbound.url, secret: 'test-secret', msgId: 'm-2', sender: 'creator' })
  assert.deepEqual([missing.status, missing.json.code], [401, 'bad-token'])
  const wrong = await postInbound({ url: inbound.url, secret: 'test-secret', token: 'not-it', msgId: 'm-3', sender: 'creator' })
  assert.deepEqual([wrong.status, wrong.json.code], [401, 'bad-token'])
  const right = await postInbound({ url: inbound.url, secret: 'test-secret', token: inbound.token, msgId: 'm-4', sender: 'creator' })
  assert.equal(right.status, 202)
})
test('P2-07 a replayed msgId answers 200 duplicate and starts 0 turns; after a restart it is still swallowed', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const first = setup()
  t.after(() => rmSync(first.home, { recursive: true, force: true, maxRetries: 5 }))
  await connectChannel(first.ctx, receiver)
  const sent = await postInbound({ url: await inboundUrl(first.ctx), secret: 'test-secret', msgId: 'm-restart', sender: 'creator', text: 'hello' })
  assert.equal(sent.status, 202)
  const again = await postInbound({ url: await inboundUrl(first.ctx), secret: 'test-secret', msgId: 'm-restart', sender: 'creator', text: 'hello' })
  assert.deepEqual([again.status, again.json.duplicate], [200, true])

  // The idempotency ring is persisted, so a restart still knows this msgId. The state file
  // is flushed on unmount, not only by the five-second merge timer.
  await first.ctx.dispose()
  await until(() => (readFileSync(join(first.home, 'state.json'), 'utf8').includes('m-restart') ? true : undefined), 'the seen msgId to be saved')
  const second = setup({ home: first.home })
  t.after(async () => { await second.ctx.dispose() })
  await connectChannel(second.ctx, receiver)
  const replay = await postInbound({ url: await inboundUrl(second.ctx), secret: 'test-secret', msgId: 'm-restart', sender: 'creator', text: 'hello' })
  assert.deepEqual([replay.status, replay.json.duplicate], [200, true])
  // Neither copy reached a channel Session.
  const state = (await call(second.ctx, 'state', {})).value
  assert.equal(state.channels?.wechat?.conversations === undefined || Object.keys(state.channels.wechat.conversations).length === 0, true)
})

test('P2-08 the same text under a new msgId starts a turn (no content-hash swallowing)', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, sessionAgents, emitSession } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const first = await postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'same words' })
  assert.equal(first.status, 202)
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the first turn')
  const message = agent.calls[0]
  emitSession(agent.session.id, 'user/message', { source: { exchangeId: message.source.exchangeId } })
  emitSession(agent.session.id, 'turn/start', { turn: 1 })
  emitSession(agent.session.id, 'assistant/message', { message: { content: [{ type: 'text', text: 'first' }] } })
  emitSession(agent.session.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // The same words under a new msgId are a new message, not a duplicate by content.
  const second = await postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', text: 'same words' })
  assert.equal(second.status, 202)
  await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 2), 'the second turn for a new msgId')
  // One channel conversation for both messages, and the read level registers no notify.
  assert.equal(sessionAgents.size, 1)
  assert.equal(ctx.registeredTools.has('wechat_notify'), false, 'read level registers no notify tool')
})

test('P2-12 two inbound messages are serialized: each reply answers its own msgId', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, sessionAgents, emitSession } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const reply = (sessionId, turn, text, message) => {
    emitSession(sessionId, 'user/message', { source: { exchangeId: message.source.exchangeId } })
    emitSession(sessionId, 'turn/start', { turn })
    emitSession(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
    emitSession(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
  const firstPost = postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'one', wait: 5_000 })
  const secondPost = postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', text: 'two', wait: 5_000 })
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the first delivery')
  // The second message waits for the first turn; only one message is in the Session so far.
  assert.equal([...sessionAgents.values()].reduce((count, entry) => count + entry.calls.length, 0), 1)
  reply(agent.session.id, 1, 'answer one', agent.calls[0])
  const first = await firstPost
  assert.deepEqual([first.status, first.json.msgId, first.json.reply], [200, 'm-1', 'answer one'])
  await until(() => [...sessionAgents.values()].map(entry => entry.calls[1]).find(Boolean), 'the second delivery')
  reply(agent.session.id, 2, 'answer two', agent.calls[1])
  const second = await secondPost
  assert.deepEqual([second.status, second.json.msgId, second.json.reply], [200, 'm-2', 'answer two'])
})

test('P2-13a a synchronous wait over its limit answers 504 timeout without wedging the channel', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, sessionAgents, emitSession } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const late = await postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'slow', wait: 60 })
  assert.deepEqual([late.status, late.json.code], [504, 'timeout'])
  // The turn kept running; the next message is not stuck behind the timed-out wait.
  await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the slow turn')
  const agent = [...sessionAgents.values()][0]
  const message = agent.calls[0]
  emitSession(agent.session.id, 'user/message', { source: { exchangeId: message.source.exchangeId } })
  emitSession(agent.session.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const nextPost = postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', text: 'next', wait: 5_000 })
  const second = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 2), 'the next delivery')
  emitSession(second.session.id, 'user/message', { source: { exchangeId: second.calls[1].source.exchangeId } })
  emitSession(second.session.id, 'turn/start', { turn: 2 })
  emitSession(second.session.id, 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })
  emitSession(second.session.id, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  const answered = await nextPost
  assert.deepEqual([answered.status, answered.json.reply], [200, 'ok'])
})
test('P2-11 a Bot that disappears mid-channel answers 502 or the bot-unavailable callback', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const callback = await startWebhookReceiver({ secret: 'test-secret' })
  t.after(() => callback.close())
  const { ctx, rt, home, sessionAgents, emitSession } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  // A first message holds the serial queue, so the Bot can vanish before the next delivery.
  const holding = postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'hold', wait: 5_000 })
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the holding turn')
  const queued = postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', callbackUrl: callback.url })
  assert.equal((await queued).status, 202)
  delete rt.state.bots.b1
  emitSession(agent.session.id, 'user/message', { source: { exchangeId: agent.calls[0].source.exchangeId } })
  emitSession(agent.session.id, 'turn/start', { turn: 1 })
  emitSession(agent.session.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal((await holding).status, 200)
  // The queued async message cannot reach the Bot any more: a signed failure callback.
  const failed = await until(() => callback.requests[0], 'the bot-unavailable callback')
  assert.deepEqual([failed.json.ok, failed.json.code], [false, 'bot-unavailable'])
  // A failure callback is delivered once, not retried like a network flake.
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(callback.requests.length, 1)
  // The synchronous path answers the same reason as a 502.
  const sync = await postInbound({ url, secret: 'test-secret', msgId: 'm-3', sender: 'creator', text: 'now', wait: 5_000 })
  assert.deepEqual([sync.status, sync.json.code], [502, 'bot-unavailable'])
})
test('P2-13b an async turn that misses its deadline sends a signed failure callback', async (t) => {
  const receiver = await startWebhookReceiver({ secret: 'test-secret' })
  t.after(() => receiver.close())
  const callback = await startWebhookReceiver({ secret: 'test-secret' })
  t.after(() => callback.close())
  const { ctx, home } = setup({ session: true, config: { wechat: { listenPort: 0, turnTimeoutMs: 80 } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const accepted = await postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', callbackUrl: callback.url })
  assert.equal(accepted.status, 202)
  const sent = await until(() => callback.requests[0], 'the failure callback')
  assert.equal(sent.signatureOk, true, 'the callback is signed like an inbound request')
  assert.deepEqual([sent.json.ok, sent.json.code, sent.json.msgId], [false, 'timeout', 'm-1'])
})
test('P2-14 rebinding A to B archives the A Session and answers the in-flight message 503', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, sessionAgents, archived } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const inFlight = postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'one', wait: 5_000 })
  await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the first Bot turn')
  // Rebinding through settings: the waiting message hears the rebound code, the old Session
  // is archived with the reason, and the queue belongs to the new Bot afterwards.
  const full = { transport: 'webhook', botId: 'b2', webhookUrl: receiver.url, webhookFormat: 'generic' }
  assert.equal((await call(ctx, 'connector-set-settings', { id: 'wechat', values: full })).ok, true)
  const answered = await inFlight
  assert.deepEqual([answered.status, answered.json.code], [503, 'channel-rebound'])
  assert.equal(archived.length >= 1, true, 'the old Session was archived')
})
test('P2-15 an approval releases the channel queue and the next message is answered', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, sessionAgents, emitSession } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const waiting = postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'needs approval', wait: 400 })
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the approval turn')
  // The host asks the user: the channel hears it and does not answer the card itself.
  const request = { agent: { session: { id: agent.session.id } }, toolName: 'demo_write', reason: 'write' }
  for (const listener of ctx.listeners.get('approval/request') ?? []) listener(request, () => undefined)
  const next = postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', text: 'after', wait: 5_000 })
  const second = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 2), 'the next delivery after approval')
  emitSession(second.session.id, 'user/message', { source: { exchangeId: second.calls[1].source.exchangeId } })
  emitSession(second.session.id, 'turn/start', { turn: 2 })
  emitSession(second.session.id, 'assistant/message', { message: { content: [{ type: 'text', text: 'answered' }] } })
  emitSession(second.session.id, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  const answered = await next
  assert.deepEqual([answered.status, answered.json.reply], [200, 'answered'])
  const timedOut = await waiting
  assert.deepEqual([timedOut.status, timedOut.json.code], [504, 'timeout'])
})
test('P2-16 logs, diagnostics and state.json carry no sender text, no message body and no secret', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  await connectChannel(ctx, receiver)
  const marker = 'BODY-MARKER-6f3a'
  const sender = 'raw-sender-9c1'
  const sent = await postInbound({ url: await inboundUrl(ctx), secret: 'test-secret', msgId: 'm-1', sender, text: marker })
  assert.equal(sent.status, 202)
  // The live view carries the sender hash and the id, never the sender text or the body.
  const live = JSON.stringify((await call(ctx, 'state', {})).value)
  assert.equal(live.includes(marker), false)
  assert.equal(live.includes(sender), false)
  assert.equal(live.includes('test-secret'), false)
  await ctx.dispose()
  const saved = readFileSync(join(home, 'state.json'), 'utf8')
  assert.equal(saved.includes(marker), false)
  assert.equal(saved.includes(sender), false)
  assert.equal(saved.includes('test-secret'), false)
})
test('P2-17 the read level answers inbound while wechat_notify stays unregistered', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, sessionAgents, emitSession } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const row = await connectChannel(ctx, receiver)
  assert.equal(row.level, 'read')
  assert.equal(ctx.registeredTools.has('wechat_notify'), false)
  const url = await inboundUrl(ctx)
  const waiting = postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'hello', wait: 5_000 })
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the read turn')
  emitSession(agent.session.id, 'user/message', { source: { exchangeId: agent.calls[0].source.exchangeId } })
  emitSession(agent.session.id, 'turn/start', { turn: 1 })
  emitSession(agent.session.id, 'assistant/message', { message: { content: [{ type: 'text', text: 'hi' }] } })
  emitSession(agent.session.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const answered = await waiting
  assert.deepEqual([answered.status, answered.json.reply], [200, 'hi'])
  assert.equal(ctx.registeredTools.has('wechat_notify'), false)
})
test('P2-18 the module declares no commands, so connector-command refuses every action', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  for (const action of ['login-start', 'login-refresh', 'anything']) {
    const refused = await call(ctx, 'connector-command', { id: 'wechat', action })
    assert.equal(refused.ok, false, action)
    assert.match(refused.error.message, /has no commands/)
  }
  // The P3 login actions stay unclaimed until the ClawBot transport has something to run.
  assert.equal((await call(ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { token: 'x' } })).ok, false)
})
test.todo('P2-20 visibility: channel sessions never appear in search, read_own_chat, the index, the sidebar or another session')
test.todo('P2-22a memory: no review enumeration, no memory prompt injection and no MEMORY.md entry for channel sessions')
test.todo('P2-22b parts: channel sessions are excluded from checkpoints and segments')
test('P2-23 v1 keeps exactly one conversation session and pre-creates no group session', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, sessionAgents, emitSession } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const reply = (agent, turn) => {
    emitSession(agent.session.id, 'user/message', { source: { exchangeId: agent.calls.at(-1).source.exchangeId } })
    emitSession(agent.session.id, 'turn/start', { turn })
    emitSession(agent.session.id, 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })
    emitSession(agent.session.id, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
  const first = postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'one', wait: 5_000 })
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the first message')
  reply(agent, 1)
  await first
  const second = postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', text: 'two', wait: 5_000 })
  await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 2), 'the second message')
  assert.equal(sessionAgents.size, 1, 'both messages answer in the same conversation Session')
  reply(agent, 2)
  await second
})
test('P2-11 a Bot that disappears mid-channel answers 502 or the bot-unavailable callback', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const callback = await startWebhookReceiver({ secret: 'test-secret' })
  t.after(() => callback.close())
  const { ctx, rt, home, sessionAgents, emitSession } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  // A first message holds the serial queue, so the Bot can vanish before the next delivery.
  const holding = postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'hold', wait: 5_000 })
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the holding turn')
  const queued = postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', callbackUrl: callback.url })
  assert.equal((await queued).status, 202)
  delete rt.state.bots.b1
  emitSession(agent.session.id, 'user/message', { source: { exchangeId: agent.calls[0].source.exchangeId } })
  emitSession(agent.session.id, 'turn/start', { turn: 1 })
  emitSession(agent.session.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal((await holding).status, 200)
  // The queued async message cannot reach the Bot any more: a signed failure callback.
  const failed = await until(() => callback.requests[0], 'the bot-unavailable callback')
  assert.deepEqual([failed.json.ok, failed.json.code], [false, 'bot-unavailable'])
  // A failure callback is delivered once, not retried like a network flake.
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(callback.requests.length, 1)
  // The synchronous path answers the same reason as a 502.
  const sync = await postInbound({ url, secret: 'test-secret', msgId: 'm-3', sender: 'creator', text: 'now', wait: 5_000 })
  assert.deepEqual([sync.status, sync.json.code], [502, 'bot-unavailable'])
})
test('P2-24b a tools switch change narrows in place, widens by a fresh Session, and never rebinds during mount', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, rt, home, sessionAgents, archived, emitSession } = setup({ session: true })
  ctx.tools.schemas = () => [{ name: 'web_search' }, { name: 'bash' }]
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const base = { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' }
  await connectChannel(ctx, receiver)
  const url = await inboundUrl(ctx)
  const totalCalls = () => [...sessionAgents.values()].reduce((count, entry) => count + entry.calls.length, 0)
  let turn = 0
  // One delivery plus the turn it opens: the queue only moves on when the turn ends.
  const send = async (msgId) => {
    const before = totalCalls()
    await postInbound({ url, secret: 'test-secret', msgId, sender: 'creator', text: msgId })
    const agent = await until(() => (totalCalls() > before ? [...sessionAgents.values()].filter(entry => entry.calls.length > 0).at(-1) : undefined), `the ${msgId} delivery`)
    const message = agent.calls.at(-1)
    turn += 1
    emitSession(agent.session.id, 'user/message', { source: { exchangeId: message.source.exchangeId } })
    emitSession(agent.session.id, 'turn/start', { turn })
    emitSession(agent.session.id, 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })
    emitSession(agent.session.id, 'turn/end', { turn, reason: { kind: 'completed' } })
    return agent
  }
  const first = await send('m-1')
  assert.deepEqual(first.restricted.at(-1), { allow: [] })
  // Same Session, next turn: the restriction is applied again, so the second turn is safe.
  const firstAgain = await send('m-1b')
  assert.equal(firstAgain, first, 'the same conversation Session answers both turns')
  assert.deepEqual(firstAgain.restricted.at(-1), { allow: [] })
  assert.equal(firstAgain.restricted.some(filter => filter.allow?.includes('bash')), false)

  // Off -> on cannot widen a restriction in place, so the next message starts a fresh
  // Session; the archive happens then, not during the settings save.
  assert.equal((await call(ctx, 'connector-set-settings', { id: 'wechat', values: { ...base, allowReadTools: 'on' } })).ok, true)
  assert.equal(archived.length, 0, 'the settings save does not rebind during the mount')
  const second = await send('m-2')
  assert.notEqual(second, first, 'a fresh Session carries the wider allow-list')
  assert.deepEqual(second.restricted.at(-1), { allow: ['web_search'] })
  assert.equal(archived.length, 1)
  assert.equal(rt.state.channels.wechat.history.at(0).reason, 'tools-changed')

  // On -> off narrows the live Session in place and archives nothing.
  assert.equal((await call(ctx, 'connector-set-settings', { id: 'wechat', values: { ...base, allowReadTools: 'off' } })).ok, true)
  const third = await send('m-3')
  assert.equal(third, second, 'the conversation Session is kept')
  assert.deepEqual(third.restricted.at(-1), { allow: [] })
  assert.equal(third.restricted.some(filter => filter.allow?.includes('bash')), false)
  assert.equal(archived.length, 1, 'narrowing in place archives nothing')
})

test('P2-24 a channel Session gets no tools by default and only web_search when read tools are on', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const off = setup({ session: true })
  t.after(async () => { await off.ctx.dispose(); rmSync(off.home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(off.ctx, receiver)
  const offUrl = await inboundUrl(off.ctx)
  await postInbound({ url: offUrl, secret: 'test-secret', msgId: 'm-off', sender: 'creator', text: 'none' })
  const offAgent = await until(() => [...off.sessionAgents.values()].find(entry => entry.calls.length === 1), 'the default Session')
  assert.deepEqual(offAgent.restricted.at(-1), { allow: [] })

  // A fresh channel with the switch on: only web_search, even though the host serves more.
  const on = setup({ session: true })
  t.after(async () => { await on.ctx.dispose(); rmSync(on.home, { recursive: true, force: true, maxRetries: 5 }) })
  on.ctx.tools.schemas = () => [{ name: 'web_search' }, { name: 'bash' }]
  const saved = await call(on.ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic', allowReadTools: 'on' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  await call(on.ctx, 'connector-connect', { id: 'wechat', values: { WECHAT_WEBHOOK_SECRET: 'test-secret' } })
  const onUrl = await inboundUrl(on.ctx)
  await postInbound({ url: onUrl, secret: 'test-secret', msgId: 'm-on', sender: 'creator', text: 'some' })
  const onAgent = await until(() => [...on.sessionAgents.values()].find(entry => entry.calls.length === 1), 'the read-tools Session')
  assert.deepEqual(onAgent.restricted.at(-1), { allow: ['web_search'] })
  // The segmented field reports the stored word, and no other tool is allowed.
  const row = await rowOf(on.ctx)
  assert.equal(row.fields.find(field => field.name === 'allowReadTools').value, 'on')
})
test.todo('P2-25 is covered by P2-13a + P2-13b (async 202 plus callback, wait cap, 504)')
test.todo('P3: open the ClawBot option and its token field')

// ---- G: the push webhook URL is a credential, and older state migrates once ----
const legacyHome = (settings) => {
  const home = teamHome()
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    ...TEAM,
    connectors: { wechat: { level: 'read', settings } },
  }))
  return home
}

test('G-1 an older plain webhook URL moves into the credential store', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const home = legacyHome({ transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' })
  const { ctx, rt } = setup({ home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await call(ctx, 'connector-retry', { id: 'wechat' })
  await until(async () => ((await rowOf(ctx))?.state === 'ready' ? true : undefined), 'the migrated channel')
  const row = await rowOf(ctx)
  assert.equal(row.fields.find(field => field.name === 'webhookUrl').saved, true)
  assert.equal(row.canTest, true)
  // The plain value is gone from the state and the credential store has it.
  await until(() => (readFileSync(join(home, 'state.json'), 'utf8').includes('webhookUrl') ? undefined : true), 'the legacy value to clear')
  assert.equal(JSON.stringify(rt.state.connectors.wechat.settings).includes(receiver.url), false)
})

test('G-6 readiness uses the framework naming helper, stays quiet while unknown and mount names a missing URL', async (t) => {
  const bot = () => ({ name: 'Chief' })
  // The framework names the credential; readiness must ask for exactly those names.
  const names = []
  const helper = (suffix) => ({
    secretName: base => `${base}${suffix}`,
    secretValue: name => { names.push(name); return undefined },
  })
  const base = { settings: { transport: 'webhook', botId: 'b1' }, rt: { botOf: bot }, instance: { base: 'wechat', id: 'wechat' } }
  assert.equal(wechatReadiness({ ...base, ...helper('') }), undefined)
  assert.equal(wechatReadiness({ ...base, ...helper('_2'), instance: { base: 'wechat', id: 'wechat-2' } }), undefined)
  assert.deepEqual(names, ['WECHAT_WEBHOOK_URL', 'WECHAT_WEBHOOK_URL_2'])
  // Unknown (not loaded) is not the same as empty: no note, the row stays clickable.
  assert.equal(wechatReadiness({ ...base, secretName: base => `${base}`, secretValue: () => undefined }), undefined)
  // Explicitly empty is missing.
  assert.match(wechatReadiness({ ...base, secretName: base => `${base}`, secretValue: () => '' }), /Add the push webhook URL/)
  // The mount names the same sentence when Connect really has no URL.
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const saved = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'b1' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const connected = await call(ctx, 'connector-connect', { id: 'wechat', values: { WECHAT_WEBHOOK_SECRET: 'test-secret' } })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  const row = await until(async () => ((await rowOf(ctx))?.state === 'error' ? await rowOf(ctx) : undefined), 'the missing URL error row')
  assert.match(row.error, /Add the push webhook URL/)
})

test('G-5 a replaced URL in the credential store wins over the old plain value', async (t) => {
  const oldReceiver = await startWebhookReceiver()
  t.after(() => oldReceiver.close())
  const newReceiver = await startWebhookReceiver()
  t.after(() => newReceiver.close())
  const home = legacyHome({ transport: 'webhook', botId: 'b1', webhookUrl: oldReceiver.url, webhookFormat: 'generic' })
  // The user replaced the URL on the card before the old value was cleaned up: the store has
  // the new URL while the settings still carry the old one.
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({
    version: 1,
    secrets: [{ name: 'WECHAT_WEBHOOK_URL', value: newReceiver.url, purpose: '', scope: 'all' }],
  }))
  const { ctx, rt } = setup({ home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await call(ctx, 'connector-retry', { id: 'wechat' })
  await until(async () => ((await rowOf(ctx))?.state === 'ready' ? true : undefined), 'the replaced channel')
  // Simulate the legacy value still being around (a pending or failed migration, or an old
  // backup): the credential must still win over it.
  rt.state.connectors.wechat.settings = { ...rt.state.connectors.wechat.settings, webhookUrl: oldReceiver.url }
  await toWrite(ctx, 'wechat')
  const pending = notifyToolOf(ctx).execute({ text: 'to the new one' }, { agent: { id: 'm1' } })
  const shown = await until(() => card(ctx), 'the notice approval')
  await answerCard(ctx, shown.id, ['Allow once'])
  assert.equal(await pending, 'Sent.')
  assert.equal(newReceiver.requests.length, 1)
  assert.equal(oldReceiver.requests.length, 0)
})

test('G-2 a URL that cannot be stored keeps working outbound and is retried later', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const home = legacyHome({ transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' })
  const { ctx, rt } = setup({ home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  // The credential store refuses the write; the plain URL must stay usable.
  const real = rt.secretEndpoint
  rt.secretEndpoint = async (endpoint, body) => {
    if (endpoint === 'secret-set' && body.name === 'WECHAT_WEBHOOK_URL') throw new Error('store down')
    return await real(endpoint, body)
  }
  await call(ctx, 'connector-retry', { id: 'wechat' })
  await until(async () => ((await rowOf(ctx))?.state === 'ready' ? true : undefined), 'the fallback channel')
  assert.equal(rt.state.connectors.wechat.settings.webhookUrl, receiver.url)
  await toWrite(ctx, 'wechat')
  const pending = notifyToolOf(ctx).execute({ text: 'with the old url' }, { agent: { id: 'm1' } })
  const shown = await until(() => card(ctx), 'the notice approval')
  await answerCard(ctx, shown.id, ['Allow once'])
  assert.equal(await pending, 'Sent.')
  assert.equal(receiver.requests.at(-1).json.text, 'with the old url')
})

test('G-3 a restart does not migrate the same URL twice', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const home = legacyHome({ transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' })
  const first = setup({ home })
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  await first.rt.load()
  await call(first.ctx, 'connector-retry', { id: 'wechat' })
  await until(async () => ((await rowOf(first.ctx))?.state === 'ready' ? true : undefined), 'the first migrate')
  await first.ctx.dispose()
  const second = setup({ home })
  t.after(async () => { await second.ctx.dispose() })
  const writes = []
  const real = second.rt.secretEndpoint
  second.rt.secretEndpoint = async (endpoint, body) => { if (endpoint === 'secret-set') writes.push(body.name); return await real(endpoint, body) }
  await second.rt.load()
  await call(second.ctx, 'connector-retry', { id: 'wechat' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(writes.includes('WECHAT_WEBHOOK_URL'), false, 'the second mount found the credential and did not write again')
})

test('G-4 wechat-2 migrates under the _2 name and its readiness sees it', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const home = teamHome()
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    ...TEAM,
    connectors: { wechat: { level: 'read', settings: { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' } }, 'wechat-2': { level: 'read', settings: { transport: 'webhook', botId: 'b2', webhookUrl: receiver.url, webhookFormat: 'generic' } } },
  }))
  const { ctx, rt } = setup({ home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await call(ctx, 'connector-retry', { id: 'wechat' })
  await call(ctx, 'connector-retry', { id: 'wechat-2' })
  await until(async () => { const rows = await rowsOf(ctx); return ['wechat', 'wechat-2'].every(id => rows.find(row => row.id === id)?.state === 'ready') ? true : undefined }, 'both migrated rows')
  await until(() => {
    const saved = readFileSync(join(home, 'secrets.json'), 'utf8')
    return saved.includes('WECHAT_WEBHOOK_URL') && saved.includes('WECHAT_WEBHOOK_URL_2') ? true : undefined
  }, 'both URL credentials')
  const row = await rowOf(ctx)
  assert.equal(row.levelNote, undefined, 'readiness sees the migrated URL')
  assert.equal(row.levelNotes, undefined)
})

test('F4 a bound Bot that is gone shows before Connect, not only as a mount error', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const saved = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'deleted-bot', webhookUrl: receiver.url, webhookFormat: 'generic' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  await until(async () => ((await rowOf(ctx))?.levelNotes !== undefined ? true : undefined), 'the level notes')
  const missing = await rowOf(ctx)
  assert.equal(missing.state, 'off')
  assert.match(missing.levelNotes.read, /bound to no longer exists/)

  // A Bot that exists clears the note and lets the channel mount.
  const fixed = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' } })
  assert.equal(fixed.ok, true, JSON.stringify(fixed))
  await until(async () => ((await rowOf(ctx))?.state === 'ready' ? true : undefined), 'the channel ready')
  assert.equal((await rowOf(ctx)).levelNotes, undefined)
})
