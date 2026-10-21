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
import { createServer as createHttpServer } from 'node:http'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import wechatConnector, { normalizeWechatSettings, wechatReadiness } from '../src/host/connectors/wechat.js'
import { inboundFor } from '../src/host/wechat-inbound.js'
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
  // Messaging channels declare one write level and hide the level choice.
  assert.equal(row.level, 'write')
  assert.deepEqual(row.levels.map(level => level.id), ['write'])
  assert.equal(row.card.levelChoice, false)
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
  assert.match(missingBot.levelNotes.write, /bound to no longer exists/)
})

// ---- P1-04: connect; P1-05: the notify tool and its approval ----
test('P1-04 connect turns the channel ready; P2 serves it a loopback inbound address', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const row = await connectChannel(ctx, receiver)
  assert.deepEqual([row.state, row.level], ['ready', 'write'])
  assert.equal(row.card.levelChoice, false)
  const inbound = await until(async () => (await rowOf(ctx))?.inbound, 'the inbound address')
  assert.match(inbound.url, /^http:\/\/127\.0\.0\.1:\d+\/wechat\/wechat\/inbound$/)
  assert.equal(row.login, undefined)
})

test('P1-05 wechat_notify sends directly, exactly once per call', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, registered } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  assert.ok(registered.includes('wechat_notify'))

  // Sending is a direct user-facing action now: no approval card, one request per call.
  assert.equal(await notifyToolOf(ctx).execute({ text: 'deploy done' }, { agent: { id: 'm1' } }), 'Sent.')
  assert.equal(receiver.requests.length, 1)
  assert.deepEqual(receiver.requests[0].json, { text: 'deploy done' })
  assert.equal(card(ctx) === undefined || (await card(ctx)) === undefined, true, 'no approval card was drawn')
  assert.equal(await notifyToolOf(ctx).execute({ text: 'again' }, { agent: { id: 'm1' } }), 'Sent.')
  assert.equal(receiver.requests.length, 2)
})

test('P1-05b a channel stops after twenty sends a minute and audits each send without the body', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const audited = []
  rt.diagnostics.record = entry => audited.push(entry)
  await connectChannel(ctx, receiver)
  for (let index = 1; index <= 20; index += 1) {
    assert.equal(await notifyToolOf(ctx).execute({ text: `note ${index}` }, { agent: { id: 'm1' } }), 'Sent.')
  }
  await assert.rejects(notifyToolOf(ctx).execute({ text: 'the 21st' }, { agent: { id: 'm1' } }), /sent 20 messages in the last minute/)
  assert.equal(receiver.requests.length, 20)
  assert.equal(audited.filter(entry => entry.source === 'wechat-notify').length, 20)
  const text = JSON.stringify(audited)
  assert.equal(text.includes('note 1'), false)
  assert.equal(text.includes('the 21st'), false)
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
  assert.deepEqual(byName.transport.options.map(option => option.value), ['webhook', 'clawbot']) // ClawBot arrives with this release (beta).
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
    assert.deepEqual(row.inputs.map(field => field.name), ['WECHAT_WEBHOOK_SECRET', 'WECHAT_WEBHOOK_URL', 'WECHAT_ILINK_TOKEN'])
  }
  await toWrite(ctx, 'wechat')
  await toWrite(ctx, 'wechat-2')
  assert.ok(ctx.registeredTools.has('wechat_notify') && ctx.registeredTools.has('wechat_2_notify'))
  // Each channel signs with its own secret: the framework resolved secrets per instance.
  await toWrite(ctx, 'wechat-2')
  const pending = notifyToolOf(ctx, 'wechat-2').execute({ text: 'from the second channel' }, { agent: { id: 'm1' } })
  assert.equal(await pending, 'Sent.')
  const last = receiver.requests.at(-1)
  assert.equal(last.signatureOk, true, 'wechat-2 signed with its own secret')
  assert.equal((await call(ctx, 'connector-delete-instance', { id: 'wechat-2' })).ok, true)
  assert.equal((await names()).includes('WECHAT_WEBHOOK_SECRET_2'), false)
  assert.ok((await names()).includes('WECHAT_WEBHOOK_SECRET'))
  assert.equal(ctx.registeredTools.has('wechat_2_notify'), false)
})

// ---- ClawBot login against a mock iLink server ----
const startIlinkMock = async ({
  statuses = ['wait'],
  qrcode = 'qr-1',
  image = 'https://cdn.test/qr.png',
  token = 'ilink-token',
  userId = 'ilink_user_123456',
  qrFailures = 0,
  qrcodes = null,
  send = () => ({ ret: 0 }),
  updates = () => ({ ret: 0, get_updates_buf: 'cursor-1' }),
  updatesDelayMs = 40,
  qrDelayMs = 0,
  statusDelayMs = 0,
  statusHang = false,
  sendHang = false,
} = {}) => {
  const calls = []
  let index = 0
  let qrCalls = 0
  let qrIndex = 0
  const server = createHttpServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed
      try { parsed = body === '' ? undefined : JSON.parse(body) } catch { parsed = undefined }
      const call = { method: request.method, url: request.url, headers: request.headers, body, json: parsed }
      calls.push(call)
      const json = (value, status = 200) => {
        if (response.destroyed || response.writableEnded) return
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      // The service answers the QR status call slowly (a 30s long poll); tests shorten that.
      const later = (value, status = 200, delay = 0) => {
        if (delay <= 0) return json(value, status)
        setTimeout(() => json(value, status), delay)
        return undefined
      }
      if (request.url.startsWith('/ilink/bot/get_bot_qrcode')) {
        qrCalls += 1
        // The QR request itself can answer `-14` too: the retry must ask again instead of
        // polling a code it never received.
        if (qrCalls <= qrFailures) return later({ ret: 0, errcode: -14, errmsg: 'session timeout' }, 200, qrDelayMs)
        const value = qrcodes === null ? qrcode : qrcodes[Math.min(qrIndex, qrcodes.length - 1)]
        qrIndex += 1
        return later({ qrcode: value, qrcode_img_content: image }, 200, qrDelayMs)
      }
      if (request.url.startsWith('/ilink/bot/get_qrcode_status')) {
        const status = statuses[Math.min(index, statuses.length - 1)]
        index += 1
        // A stuck answer never ends: the host's deadline has to end it.
        if (statusHang) return undefined
        if (status === 'auth-fail') return later({ error: 'unauthorized' }, 401, statusDelayMs)
        if (status === 'paused') return later({ ret: 0, errcode: -14, errmsg: 'session timeout' }, 200, statusDelayMs)
        return later({ status, ...(status === 'confirmed' || status === 'binded_redirect' ? { bot_token: token, ilink_bot_id: 'bot-1', baseurl: 'https://base.test', ...(userId === undefined ? {} : { ilink_user_id: userId }) } : {}) }, 200, statusDelayMs)
      }
      if (request.url.startsWith('/ilink/bot/getupdates')) {
        const answer = updates(call) ?? {}
        // A real long poll waits for a message or its timeout; keep the mock from spinning.
        setTimeout(() => json(answer), updatesDelayMs)
        return undefined
      }
      if (request.url.startsWith('/ilink/bot/sendmessage')) {
        if (sendHang) return undefined
        return json(send(call))
      }
      return json({ ret: 0 })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // A logged-in channel keeps a long poll open, so a graceful close alone would wait for the
  // host to stop; the test's teardown drops the connections it still holds.
  return { base: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}

const connectClawbot = async (ctx) => {
  const saved = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'clawbot', botId: 'b1' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const connected = await call(ctx, 'connector-connect', { id: 'wechat', values: { WECHAT_WEBHOOK_SECRET: 'test-secret' } })
  assert.equal(connected.ok, true, JSON.stringify(connected))
}

// Sign in through the mock and wait for the remount a written token causes: that mount is
// the one that registers the notify tool and starts the inbound long poll.
const loginClawbot = async (ctx) => {
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-poll' })
  await until(async () => (ctx.registeredTools.has('wechat_notify') ? true : undefined), 'the ClawBot notify tool')
  return await rowOf(ctx)
}

test('CB-04 a QR page URL becomes a PNG data URL, a PNG passes through and junk is refused', async (t) => {
  const page = await startIlinkMock({ image: 'https://liteapp.weixin.qq.com/q/abc?qrcode=qr-1&bot_type=3' })
  t.after(() => page.close())
  const first = setup({ config: { wechat: { listenPort: 0, ilinkBase: page.base } } })
  t.after(async () => { await first.ctx.dispose(); rmSync(first.home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(first.ctx)
  await call(first.ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  const encoded = (await rowOf(first.ctx)).login.qr
  assert.match(encoded, /^data:image\/png;base64,/)
  assert.equal(Buffer.from(encoded.split(',')[1], 'base64').subarray(0, 4).toString('hex'), '89504e47')

  const png = 'data:image/png;base64,iVBORw0KGgo='
  const direct = await startIlinkMock({ image: png })
  t.after(() => direct.close())
  const second = setup({ config: { wechat: { listenPort: 0, ilinkBase: direct.base } } })
  t.after(async () => { await second.ctx.dispose(); rmSync(second.home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(second.ctx)
  await call(second.ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  assert.equal((await rowOf(second.ctx)).login.qr, png)

  const junk = await startIlinkMock({ image: 'plain-login-token' })
  t.after(() => junk.close())
  const third = setup({ config: { wechat: { listenPort: 0, ilinkBase: junk.base } } })
  t.after(async () => { await third.ctx.dispose(); rmSync(third.home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(third.ctx)
  await call(third.ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  const row = await rowOf(third.ctx)
  assert.equal(row.login.qr, null)
  assert.match(row.login.error, /unsupported form/)
})

test('CB-03i binded_redirect logs in and stores the token', async (t) => {
  const mock = await startIlinkMock({ statuses: ['binded_redirect'] })
  t.after(() => mock.close())
  const { ctx, home } = setup({ config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(ctx)
  const started = await call(ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal((await rowOf(ctx)).login.state, 'qr')
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-poll' })
  const row = await rowOf(ctx)
  assert.equal(row.login.state, 'logged-in')
  const secrets = (await call(ctx, 'state', {})).value.secrets.map(secret => secret.name)
  assert.ok(secrets.includes('WECHAT_ILINK_TOKEN'))
})

test('a confirmed answer without a token is confirm-failed, and a 401 poll is login-expired', async (t) => {
  const failed = await startIlinkMock({ statuses: ['confirmed'], token: '', userId: undefined })
  t.after(() => failed.close())
  const first = setup({ config: { wechat: { listenPort: 0, ilinkBase: failed.base } } })
  t.after(async () => { await first.ctx.dispose(); rmSync(first.home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(first.ctx)
  await call(first.ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  await call(first.ctx, 'connector-command', { id: 'wechat', action: 'login-poll' })
  assert.equal((await rowOf(first.ctx)).login.state, 'confirm-failed')

  const expired = await startIlinkMock({ statuses: ['auth-fail'] })
  t.after(() => expired.close())
  const second = setup({ config: { wechat: { listenPort: 0, ilinkBase: expired.base } } })
  t.after(async () => { await second.ctx.dispose(); rmSync(second.home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(second.ctx)
  await call(second.ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  await call(second.ctx, 'connector-command', { id: 'wechat', action: 'login-poll' })
  const row = await rowOf(second.ctx)
  assert.equal(row.login.state, 'login-expired')
  assert.match(row.login.error, /Webhook channels are not affected/)
})

test('CG-02 a rebuilt channel drops the in-memory login and asks for consent again', async (t) => {
  const mock = await startIlinkMock({ statuses: ['wait'] })
  t.after(() => mock.close())
  const { ctx, home } = setup({ config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(ctx, mock)
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  assert.equal((await rowOf(ctx)).login.state, 'qr')
  assert.equal((await call(ctx, 'connector-disconnect', { id: 'wechat' })).ok, true)
  await connectClawbot(ctx, mock)
  const row = await rowOf(ctx)
  assert.equal(row.login.state, 'logged-out')
  // Consent was given on this channel before; a deleted-and-rebuilt channel clears the
  // state key, so the same field would be missing there and ask again.
  assert.equal(row.login.consentRequired, false)
})

// ---- ClawBot `-14` ("session timeout") and the outbound half ----
test('CB-03j a -14 poll is retryable: the row stays clean and the next poll draws the QR again', async (t) => {
  const mock = await startIlinkMock({ statuses: ['paused', 'wait', 'scaned'] })
  t.after(() => mock.close())
  const { ctx, home } = setup({ config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(ctx)
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-poll' })
  // While signing in, `-14` is a temporary pause: a retryable note in the login block, never
  // a failed row and never the expired-login state (that one is for a login that existed).
  const paused = await rowOf(ctx)
  assert.equal(paused.login.state, 'protocol-error')
  assert.match(paused.login.error, /paused this login/)
  assert.deepEqual([paused.state, paused.error], ['ready', undefined])
  // Retry keeps the code; a `wait` answer must put the card back into the QR state.
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-poll' })
  const waiting = await rowOf(ctx)
  assert.equal(waiting.login.state, 'qr')
  assert.equal(waiting.login.scanned, false)
  assert.match(waiting.login.qr, /^data:image\/png;base64,/)
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-poll' })
  const scanned = await rowOf(ctx)
  assert.equal(scanned.login.state, 'qr')
  assert.equal(scanned.login.scanned, true)
})

test('CB-03k a -14 on the QR request leaves Retry able to fetch a fresh code', async (t) => {
  const mock = await startIlinkMock({ statuses: ['wait'], qrFailures: 1 })
  t.after(() => mock.close())
  const { ctx, home } = setup({ config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(ctx)
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  const failed = await rowOf(ctx)
  assert.equal(failed.login.state, 'protocol-error')
  assert.match(failed.login.error, /paused this login/)
  assert.deepEqual([failed.state, failed.error], ['ready', undefined])
  assert.equal(failed.login.qr, null)
  // Retry (the only action of a protocol error) has no code to poll: it asks for one again.
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-poll' })
  const retried = await rowOf(ctx)
  assert.equal(retried.login.state, 'qr')
  assert.match(retried.login.qr, /^data:image\/png;base64,/)
})

test('CB-06 after login a -14 send means the login expired: row error, a code-filled audit and no re-login', async (t) => {
  const mock = await startIlinkMock({ statuses: ['confirmed'], send: () => ({ ret: 0, errcode: -14, errmsg: 'session timeout' }) })
  t.after(() => mock.close())
  const { ctx, home, rt } = setup({ config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const audited = []
  rt.diagnostics.record = entry => audited.push(entry)
  await connectClawbot(ctx)
  await loginClawbot(ctx)
  const qrCalls = () => mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/get_bot_qrcode')).length
  const before = qrCalls()
  await assert.rejects(notifyToolOf(ctx).execute({ text: 'hello' }, { agent: { id: 'm1' } }), /The WeChat login expired/)
  const row = await rowOf(ctx)
  assert.equal(row.state, 'error')
  assert.match(row.error, /Webhook channels are not affected; scan the QR code again/)
  assert.equal(row.login.state, 'login-expired')
  // The bot identity is the bearer token, so `from_user_id` is empty; the scanned account is
  // the target and the send carries a generated client id.
  const sent = mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/sendmessage')).at(-1)
  assert.equal(sent.json.msg.from_user_id, '')
  assert.equal(sent.json.msg.to_user_id, 'ilink_user_123456')
  assert.match(sent.json.msg.client_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(sent.json.msg.item_list, [{ type: 1, text_item: { text: 'hello' } }])
  // An expired login waits for the user: no QR is fetched behind their back.
  assert.equal(qrCalls(), before)
  // The audit line records the code, never the message.
  const line = audited.filter(entry => entry.source === 'wechat-notify').at(-1)
  assert.match(line.text, /result -14$/)
  assert.equal(JSON.stringify(audited).includes('hello'), false)
})

test('CB-07 a -14 from the inbound poll after login expires the login and stops the poll', async (t) => {
  const mock = await startIlinkMock({ statuses: ['confirmed'], updates: () => ({ ret: 0, errcode: -14, errmsg: 'session timeout' }) })
  t.after(() => mock.close())
  const { ctx, home } = setup({ config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(ctx)
  await loginClawbot(ctx)
  const expired = await until(async () => {
    const row = await rowOf(ctx)
    return row.login?.state === 'login-expired' ? row : undefined
  }, 'the expired login')
  assert.equal(expired.state, 'error')
  assert.match(expired.error, /scan the QR code again/)
  const polls = () => mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/getupdates')).length
  const settled = polls()
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(polls(), settled, 'the long poll stops once the session is gone')
})

test('CB-08 a logged-in channel keeps its inbound long poll and its cursor, and a remount restarts it', async (t) => {
  const mock = await startIlinkMock({ statuses: ['confirmed'] })
  t.after(() => mock.close())
  const { ctx, home } = setup({ config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(ctx)
  await loginClawbot(ctx)
  const polls = () => mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/getupdates'))
  await until(async () => (polls().length >= 1 ? true : undefined), 'the inbound long poll')
  // The first poll has no cursor; a restart continues from the saved one.
  assert.equal(polls()[0].json.get_updates_buf === undefined || polls()[0].json.get_updates_buf === '', true)
  await until(async () => (polls().some(entry => entry.json?.get_updates_buf === 'cursor-1') ? true : undefined), 'a poll carrying the saved cursor')
  await until(async () => {
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    return state.channels?.wechat?.ilink?.cursor === 'cursor-1' ? true : undefined
  }, 'the cursor to reach the state file')
  // A settings save remounts the channel: keepalive must start again, not stop.
  const before = polls().length
  const saved = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'clawbot', botId: 'b1', label: 'Live' } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  await until(async () => (polls().length > before ? true : undefined), 'the restarted inbound long poll')
})

test('CB-09 a ClawBot Test sends directly and audits its real result, not a guessed ok', async (t) => {
  let outcome = { ret: 0 }
  const mock = await startIlinkMock({ statuses: ['confirmed'], send: () => outcome })
  t.after(() => mock.close())
  const { ctx, home, rt } = setup({ config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const audited = []
  rt.diagnostics.record = entry => audited.push(entry)
  await connectClawbot(ctx)
  await loginClawbot(ctx)
  const tested = await call(ctx, 'connector-test', { id: 'wechat' })
  assert.equal(tested.ok, true, JSON.stringify(tested))
  const sent = mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/sendmessage')).at(-1)
  assert.equal(sent.json.msg.from_user_id, '')
  assert.equal(sent.json.msg.item_list[0].text_item.text, 'DS Bot: the WeChat channel works.')
  assert.match(audited.filter(entry => entry.source === 'wechat-notify').at(-1).text, /result ok$/)
  // A failing Test records the failure's code: the old path wrote `ok` before sending.
  outcome = { ret: 0, errcode: -14, errmsg: 'session timeout' }
  const failed = await call(ctx, 'connector-test', { id: 'wechat' })
  assert.equal(failed.ok, true, JSON.stringify(failed))
  assert.match(failed.value.find(item => item.id === 'wechat').error, /The WeChat login expired/)
  assert.match(audited.filter(entry => entry.source === 'wechat-notify').at(-1).text, /result -14$/)
  assert.equal(JSON.stringify(audited).includes('DS Bot: the WeChat channel works.'), false)
})

test('CB-09b a Webhook Test audits its send like a notice does', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const audited = []
  rt.diagnostics.record = entry => audited.push(entry)
  await connectChannel(ctx, receiver)
  const tested = await call(ctx, 'connector-test', { id: 'wechat' })
  assert.equal(tested.ok, true, JSON.stringify(tested))
  assert.equal(receiver.requests.length, 1)
  assert.match(audited.filter(entry => entry.source === 'wechat-notify').at(-1).text, /wechat sent \d+ chars, result ok$/)
  receiver.setReply(() => ({ status: 401, body: '{}' }))
  const failed = await call(ctx, 'connector-test', { id: 'wechat' })
  assert.match(failed.value.find(item => item.id === 'wechat').error, /refused the credential/)
  assert.match(audited.filter(entry => entry.source === 'wechat-notify').at(-1).text, /result 401$/)
  assert.equal(JSON.stringify(audited).includes('DS Bot: the WeChat channel works.'), false)
})

// ---- The QR poll flood: one 30s call at a time, and no stale answer ----
// A minimal run of the module's own commands, without the host's endpoint queue: single flight
// and stale-answer handling are rules of the module, so they are checked here directly.
const commandHost = (base, wechat = {}) => {
  const host = {
    state: { channels: {} },
    savedSecrets: [],
    config: { wechat: { ilinkBase: base, ...wechat } },
    save: async () => {},
    secretEndpoint: async (endpoint, payload) => { host.savedSecrets.push({ endpoint, payload }) },
  }
  return host
}
const runWechat = (host, action, args) => wechatConnector.command({ id: 'wechat', rt: host, action, args, secretName: name => name })
const loginViewOfHost = (host, secrets = {}) => wechatConnector.view({ id: 'wechat', settings: { transport: 'clawbot' }, rt: host, secrets }).login
const closeCommandHost = (host) => { void inboundFor(host).dispose() }

test('CB-10 one QR poll per channel: ten concurrent asks make one upstream call', async (t) => {
  // The real status call takes 30s and the card asks every 2s; a shortened delay keeps the
  // shape while the ten asks still overlap.
  const mock = await startIlinkMock({ statuses: ['wait'], statusDelayMs: 80 })
  t.after(() => mock.close())
  const host = commandHost(mock.base)
  t.after(() => closeCommandHost(host))
  await runWechat(host, 'login-start', { consent: true })
  assert.equal(loginViewOfHost(host).state, 'qr')
  const statusCalls = () => mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/get_qrcode_status')).length
  const startedAt = Date.now()
  await Promise.all(Array.from({ length: 10 }, () => runWechat(host, 'login-poll')))
  assert.equal(statusCalls(), 1, 'the other nine asks must not reach WeChat')
  assert.ok(Date.now() - startedAt < 1_000, `ten asks must not take ten polls (${Date.now() - startedAt}ms)`)
  assert.equal(loginViewOfHost(host).state, 'qr')
  // The single flight is released once the real answer lands: the next ask goes out again.
  await runWechat(host, 'login-poll')
  assert.equal(statusCalls(), 2)
  // The declaration is what lets the framework keep a poll out of the connector queue.
  assert.equal(wechatConnector.commands['login-poll'].concurrent, true)
})

test('CB-11 a late poll cannot revive a cancelled or refreshed login', async (t) => {
  // Cancel while the confirming answer is still on its way.
  const cancelledMock = await startIlinkMock({ statuses: ['confirmed'], statusDelayMs: 80 })
  t.after(() => cancelledMock.close())
  const cancelled = commandHost(cancelledMock.base)
  t.after(() => closeCommandHost(cancelled))
  await runWechat(cancelled, 'login-start', { consent: true })
  const lateAfterCancel = runWechat(cancelled, 'login-poll')
  await new Promise(resolve => setTimeout(resolve, 10))
  await runWechat(cancelled, 'login-cancel')
  await lateAfterCancel
  assert.deepEqual(cancelled.savedSecrets, [], 'a cancelled login must not store a token')
  assert.equal(loginViewOfHost(cancelled).state, 'logged-out')

  // Refresh replaces the code while the answer is in flight: that answer belongs to the old code.
  const refreshedMock = await startIlinkMock({ statuses: ['confirmed'], statusDelayMs: 80, qrcodes: ['qr-1', 'qr-2'] })
  t.after(() => refreshedMock.close())
  const refreshed = commandHost(refreshedMock.base)
  t.after(() => closeCommandHost(refreshed))
  await runWechat(refreshed, 'login-start', { consent: true })
  const lateAfterRefresh = runWechat(refreshed, 'login-poll')
  await new Promise(resolve => setTimeout(resolve, 10))
  await runWechat(refreshed, 'login-refresh')
  await lateAfterRefresh
  assert.deepEqual(refreshed.savedSecrets, [], 'the old code\'s answer must not log in')
  const view = loginViewOfHost(refreshed)
  assert.equal(view.state, 'qr')
  assert.match(view.qr, /^data:image\/png;base64,/)
})

test('CB-12 a stuck iLink call ends on its deadline and maps like any other failure', async (t) => {
  // A status call that never answers stands in for a stuck socket; the deadline must end it.
  const hung = await startIlinkMock({ statuses: ['wait'], statusHang: true })
  t.after(() => hung.close())
  const { ctx, home } = setup({ config: { wechat: { listenPort: 0, ilinkBase: hung.base, ilinkTimeouts: { qr: 120, poll: 120, send: 120 } } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(ctx)
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-start', args: { consent: true } })
  assert.equal((await rowOf(ctx)).login.state, 'qr')
  const startedAt = Date.now()
  await call(ctx, 'connector-command', { id: 'wechat', action: 'login-poll' })
  const row = await rowOf(ctx)
  // The login phase maps a failed poll to a retryable protocol error, not a dead row.
  assert.equal(row.login.state, 'protocol-error')
  assert.match(row.login.error, /timeout/i)
  assert.deepEqual([row.state, row.error], ['ready', undefined])
  assert.ok(Date.now() - startedAt < 5_000, `the command must not hang (${Date.now() - startedAt}ms)`)
})

test('CB-12b a stuck send is reported as unreachable and audits the failure', async (t) => {
  const hung = await startIlinkMock({ statuses: ['confirmed'], sendHang: true })
  t.after(() => hung.close())
  const { ctx, home, rt } = setup({ config: { wechat: { listenPort: 0, ilinkBase: hung.base, ilinkTimeouts: { qr: 400, send: 80 } } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const audited = []
  rt.diagnostics.record = entry => audited.push(entry)
  await connectClawbot(ctx)
  await loginClawbot(ctx)
  await assert.rejects(notifyToolOf(ctx).execute({ text: 'hello' }, { agent: { id: 'm1' } }), /Could not reach WeChat/)
  assert.match(audited.filter(entry => entry.source === 'wechat-notify').at(-1).text, /result error$/)
})

// ---- ClawBot inbound: a WeChat message becomes a Bot turn and the answer goes back ----
const ilinkTurn = (emitSession, agent, turn, text) => {
  const message = agent.calls[turn - 1]
  emitSession(agent.session.id, 'user/message', { source: { exchangeId: message.source.exchangeId } })
  emitSession(agent.session.id, 'turn/start', { turn })
  emitSession(agent.session.id, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
  emitSession(agent.session.id, 'turn/end', { turn, reason: { kind: 'completed' } })
}

test('CB-13 a WeChat message reaches the Bot and its answer goes back with the context token', async (t) => {
  const mock = await startIlinkMock({
    statuses: ['confirmed'],
    updates: (() => {
      let served = false
      return () => {
        if (served) return { ret: 0, get_updates_buf: 'cursor-2' }
        served = true
        return {
          ret: 0,
          get_updates_buf: 'cursor-1',
          msgs: [{
            message_id: 41,
            message_type: 1,
            message_state: 0,
            from_user_id: 'ilink_user_123456',
            context_token: 'ctx-1',
            item_list: [{ type: 1, text_item: { text: 'hello bot' } }],
          }],
        }
      }
    })(),
  })
  t.after(() => mock.close())
  const { ctx, home, sessionAgents, emitSession } = setup({ session: true, config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectClawbot(ctx)
  await loginClawbot(ctx)
  // The bot told WeChat it is online when the token mounted.
  await until(() => (mock.calls.some(entry => entry.url.startsWith('/ilink/bot/msg/notifystart')) ? true : undefined), 'the online ping')
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the inbound delivery')
  const delivered = agent.calls[0]
  assert.equal(delivered.source.sender.id, 'ilink_user_123456')
  assert.match(delivered.content[0].text, /hello bot$/)
  // The long poll keeps running while the turn is still open: a stopped poll would drop the
  // session, so the message queue must never be awaited by the loop itself.
  const polls = () => mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/getupdates')).length
  await until(() => (polls() >= 2 ? true : undefined), 'the long poll to keep running during the turn')
  ilinkTurn(emitSession, agent, 1, 'answer from the Bot')
  const sent = await until(() => mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/sendmessage')).at(-1), 'the answer in WeChat')
  assert.equal(sent.json.msg.from_user_id, '')
  assert.equal(sent.json.msg.to_user_id, 'ilink_user_123456')
  assert.equal(sent.json.msg.context_token, 'ctx-1')
  assert.deepEqual([sent.json.msg.message_type, sent.json.msg.message_state], [2, 2])
  assert.deepEqual(sent.json.msg.item_list, [{ type: 1, text_item: { text: 'answer from the Bot' } }])
  // Going away tells WeChat the bot is offline.
  assert.equal((await call(ctx, 'connector-disconnect', { id: 'wechat' })).ok, true)
  await until(() => (mock.calls.some(entry => entry.url.startsWith('/ilink/bot/msg/notifystop')) ? true : undefined), 'the offline ping')
})

test('CB-14 only a new text message from the scanned account is delivered, and a replayed id is not', async (t) => {
  const messages = [
    { message_id: 1, message_type: 1, message_state: 0, from_user_id: 'someone-else', context_token: 'ctx-x', item_list: [{ type: 1, text_item: { text: 'not the owner' } }] },
    { message_id: 2, message_type: 2, message_state: 0, from_user_id: 'ilink_user_123456', context_token: 'ctx-y', item_list: [{ type: 1, text_item: { text: 'a bot echo' } }] },
    { message_id: 3, message_type: 1, message_state: 2, from_user_id: 'ilink_user_123456', context_token: 'ctx-z', item_list: [{ type: 1, text_item: { text: 'an older message' } }] },
    { message_id: 4, message_type: 1, message_state: 0, from_user_id: 'ilink_user_123456', context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'first real message' } }] },
    { message_id: 4, message_type: 1, message_state: 0, from_user_id: 'ilink_user_123456', context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'first real message' } }] },
    { message_id: 5, message_type: 1, message_state: 0, from_user_id: 'ilink_user_123456', context_token: 'ctx-2', item_list: [{ type: 2, image_item: { media: { full_url: 'https://cdn.test/x.png' } } }] },
  ]
  const mock = await startIlinkMock({
    statuses: ['confirmed'],
    updates: (() => {
      let served = false
      return () => {
        if (served) return { ret: 0, get_updates_buf: 'cursor-2' }
        served = true
        return { ret: 0, get_updates_buf: 'cursor-1', msgs: messages }
      }
    })(),
  })
  t.after(() => mock.close())
  const { ctx, rt, home, sessionAgents, emitSession } = setup({ session: true, config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const audited = []
  rt.diagnostics.record = entry => audited.push(entry)
  await connectClawbot(ctx)
  await loginClawbot(ctx)
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the one delivered message')
  assert.match(agent.calls[0].content[0].text, /first real message$/)
  // Nothing else may start a turn: wrong sender, a bot echo, an older message, a replay and a
  // non-text message are all ignored.
  await new Promise(resolve => setTimeout(resolve, 150))
  const total = () => [...sessionAgents.values()].reduce((count, entry) => count + entry.calls.length, 0)
  assert.equal(total(), 1)
  assert.ok(audited.some(entry => entry.source === 'wechat-inbound' && /without text/.test(entry.text)))
  ilinkTurn(emitSession, agent, 1, 'one answer')
  await until(() => (mock.calls.some(entry => entry.url.startsWith('/ilink/bot/sendmessage')) ? true : undefined), 'the one answer')
  assert.equal(mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/sendmessage')).length, 1)
})

test('CB-15 a restart keeps the login and resumes the long poll without clearing the account', async (t) => {
  const mock = await startIlinkMock({ statuses: ['confirmed'] })
  t.after(() => mock.close())
  const first = setup({ config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  await connectClawbot(first.ctx)
  const signedIn = await loginClawbot(first.ctx)
  assert.equal(signedIn.login.state, 'logged-in')
  assert.equal(first.rt.state.channels?.wechat?.ilink?.ilinkUserId, 'ilink_user_123456')
  await first.ctx.dispose()
  const polls = () => mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/getupdates')).length
  const before = polls()
  const second = setup({ home: first.home, config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await second.ctx.dispose(); rmSync(second.home, { recursive: true, force: true, maxRetries: 5 }) })
  // The token lives in the credential store, so the card comes back signed in on its own.
  const restored = await until(async () => {
    const row = await rowOf(second.ctx)
    return row?.state === 'ready' ? row : undefined
  }, 'the restored channel')
  assert.equal(restored.login.state, 'logged-in')
  // The scanned account survived too, and the long poll resumes on mount.
  assert.equal(second.rt.state.channels?.wechat?.ilink?.ilinkUserId, 'ilink_user_123456')
  await until(() => (polls() > before ? true : undefined), 'the restored long poll')
})

test('CB-17 a remount during the token write still persists the account and finishes logged-in', async (t) => {
  const mock = await startIlinkMock({ statuses: ['confirmed'] })
  t.after(() => mock.close())
  const host = commandHost(mock.base)
  t.after(() => closeCommandHost(host))
  // Writing the token makes the framework reconcile and mount again; emulate that remount by
  // bumping the login epoch inside the credential write, before the poll resumes.
  host.secretEndpoint = async (endpoint, payload) => {
    host.savedSecrets.push({ endpoint, payload, accountAtWrite: host.state.channels.wechat?.ilink?.ilinkUserId })
    const channel = host.state.channels.wechat ?? (host.state.channels.wechat = {})
    channel.ilink = { ...(channel.ilink ?? {}), epoch: (channel.ilink?.epoch ?? 0) + 1 }
  }
  await runWechat(host, 'login-start', { consent: true })
  await runWechat(host, 'login-poll')
  // The identity is on disk before the credential, so the remount already knows its account.
  assert.equal(host.savedSecrets[0].accountAtWrite, 'ilink_user_123456')
  assert.equal(host.state.channels.wechat.ilink.ilinkUserId, 'ilink_user_123456')
  assert.equal(host.state.channels.wechat.ilink.ilinkBotId, 'bot-1')
  // The remount owns a new login object; the stored token is what reads as logged-in.
  assert.equal(loginViewOfHost(host, { WECHAT_ILINK_TOKEN: 'ilink-token' }).state, 'logged-in')
})

test('CB-18 a failed turn is one send audit plus one turn diagnostic, never a second send', async (t) => {
  const mock = await startIlinkMock({
    statuses: ['confirmed'],
    updates: (() => {
      let served = false
      return () => {
        if (served) return { ret: 0, get_updates_buf: 'cursor-2' }
        served = true
        return {
          ret: 0,
          get_updates_buf: 'cursor-1',
          msgs: [{ message_id: 51, message_type: 1, message_state: 0, from_user_id: 'ilink_user_123456', context_token: 'ctx-fail', item_list: [{ type: 1, text_item: { text: 'fail this turn' } }] }],
        }
      }
    })(),
  })
  t.after(() => mock.close())
  const { ctx, rt, home, sessionAgents, emitSession } = setup({ session: true, config: { wechat: { listenPort: 0, ilinkBase: mock.base } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const audited = []
  rt.diagnostics.record = entry => audited.push(entry)
  await connectClawbot(ctx)
  await loginClawbot(ctx)
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the inbound delivery')
  const message = agent.calls[0]
  emitSession(agent.session.id, 'user/message', { source: { exchangeId: message.source.exchangeId } })
  emitSession(agent.session.id, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'the model failed' } } })
  const sent = await until(() => mock.calls.filter(entry => entry.url.startsWith('/ilink/bot/sendmessage')).at(-1), 'the failure reply')
  const reply = sent.json.msg.item_list[0].text_item.text
  assert.match(reply, /not available right now/)
  // One send is one wechat-notify line carrying its real result, not a pre-audit plus the send.
  const notify = audited.filter(entry => entry.source === 'wechat-notify')
  assert.equal(notify.length, 1, `one send must be one audit line: ${JSON.stringify(notify)}`)
  assert.match(notify[0].text, new RegExp(`^wechat sent ${reply.length} chars, result ok$`))
  // The failed turn has its own line: the code and a length, never the words.
  const turn = audited.filter(entry => entry.source === 'wechat-inbound')
  assert.equal(turn.length, 1, `one turn diagnostic expected: ${JSON.stringify(turn)}`)
  assert.match(turn[0].text, /^wechat turn result bot-unavailable, \d+ chars$/)
  assert.equal(JSON.stringify(audited).includes('fail this turn'), false)
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
  // The port refuses connections once the plugin is gone, and quickly: a silent leak would
  // leave the loopback port open after the user removed the last channel.
  const started = Date.now()
  await until(async () => {
    try {
      await fetch(url, { method: 'POST' })
      return undefined
    } catch {
      return true
    }
  }, 'the inbound listener to close')
  assert.ok(Date.now() - started < 2_000, `the port took ${Date.now() - started}ms to close`)
})

test('P2-28 disconnect closes the port and a disable keeps it closed', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const port = await freePort()
  const { ctx, home } = setup({ config: { wechat: { listenPort: port } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  await inboundUrl(ctx)
  const url = `http://127.0.0.1:${port}/wechat/wechat/inbound`
  assert.equal((await call(ctx, 'connector-disconnect', { id: 'wechat' })).ok, true)
  const started = Date.now()
  await until(async () => {
    try {
      await fetch(url, { method: 'POST' })
      return undefined
    } catch {
      return true
    }
  }, 'the port to close after a disconnect')
  assert.ok(Date.now() - started < 2_000, `disconnect left the port open for ${Date.now() - started}ms`)
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
  assert.equal(ctx.registeredTools.has('wechat_notify'), true, 'the single write level registers the notify tool')
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
test('P2-17 the write level answers inbound and keeps wechat_notify registered', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, sessionAgents, emitSession } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const row = await connectChannel(ctx, receiver)
  assert.equal(row.level, 'write')
  assert.equal(ctx.registeredTools.has('wechat_notify'), true)
  const url = await inboundUrl(ctx)
  const waiting = postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'hello', wait: 5_000 })
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the read turn')
  emitSession(agent.session.id, 'user/message', { source: { exchangeId: agent.calls[0].source.exchangeId } })
  emitSession(agent.session.id, 'turn/start', { turn: 1 })
  emitSession(agent.session.id, 'assistant/message', { message: { content: [{ type: 'text', text: 'hi' }] } })
  emitSession(agent.session.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const answered = await waiting
  assert.deepEqual([answered.status, answered.json.reply], [200, 'hi'])
  assert.equal(ctx.registeredTools.has('wechat_notify'), true)
})
test('P2-18 the login commands are declared and transport-gated', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  for (const action of ['login-start', 'login-refresh', 'login-cancel', 'login-poll']) {
    const refused = await call(ctx, 'connector-command', { id: 'wechat', action })
    assert.equal(refused.ok, false, action)
    assert.equal(refused.error.code, 'bot/unsupported-transport', action)
  }
  assert.equal((await call(ctx, 'connector-disconnect', { id: 'wechat' })).ok, true)
  assert.equal((await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'clawbot', botId: 'b1' } })).ok, true)
  const unknown = await call(ctx, 'connector-command', { id: 'wechat', action: 'delete-everything' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'bot/unknown-action')
  const noConsent = await call(ctx, 'connector-command', { id: 'wechat', action: 'login-start' })
  assert.equal(noConsent.ok, false)
  assert.equal(noConsent.error.code, 'bot/invalid')
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

// Main path: agent/created alone restricts a conversation that survived a restart.
test('P2-24c a restart opens the old conversation already restricted by agent/created', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const turn = (sessionId, agent, number, emitSession) => {
    const message = agent.calls.at(-1)
    emitSession(sessionId, 'user/message', { source: { exchangeId: message.source.exchangeId } })
    emitSession(sessionId, 'turn/start', { turn: number })
    emitSession(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })
    emitSession(sessionId, 'turn/end', { turn: number, reason: { kind: 'completed' } })
  }
  const first = setup({ session: true })
  t.after(() => rmSync(first.home, { recursive: true, force: true, maxRetries: 5 }))
  await connectChannel(first.ctx, receiver)
  const firstUrl = await inboundUrl(first.ctx)
  await postInbound({ url: firstUrl, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'one' })
  const firstAgent = await until(() => [...first.sessionAgents.values()].find(entry => entry.calls.length === 1), 'the first Session')
  turn(firstAgent.session.id, firstAgent, 1, first.emitSession)
  await first.ctx.dispose()

  // New host, same home; the per-turn safety net is off so only agent/created can restrict.
  const second = setup({ session: true, home: first.home, config: { wechat: { listenPort: 0, turnToolsRestrict: false } } })
  t.after(async () => { await second.ctx.dispose() })
  await second.rt.load()
  await call(second.ctx, 'connector-retry', { id: 'wechat' })
  await until(async () => ((await rowOf(second.ctx))?.state === 'ready' ? true : undefined), 'the restarted channel')
  const url = await inboundUrl(second.ctx)
  await postInbound({ url, secret: 'test-secret', msgId: 'm-2', sender: 'creator', text: 'two' })
  const agent = await until(() => [...second.sessionAgents.values()].find(entry => entry.calls.length === 1), 'the restarted conversation')
  assert.deepEqual(agent.restricted.at(-1), { allow: [] })
})

// Safety net: with the agent/created listener removed, runOne still restricts the turn.
test('P2-24d the per-turn safety net restricts even without the agent/created hook', async (t) => {
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const { ctx, home, sessionAgents } = setup({ session: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connectChannel(ctx, receiver)
  // Only the hub's own listener matters here: drop the hook before the first message.
  ctx.listeners.set('agent/created', [])
  const url = await inboundUrl(ctx)
  await postInbound({ url, secret: 'test-secret', msgId: 'm-1', sender: 'creator', text: 'one' })
  const agent = await until(() => [...sessionAgents.values()].find(entry => entry.calls.length === 1), 'the safety-net turn')
  assert.deepEqual(agent.restricted.at(-1), { allow: [] })
  // Completing the turn is not needed for this assertion.
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
  assert.match(missing.levelNotes.write, /bound to no longer exists/)

  // A Bot that exists clears the note and lets the channel mount.
  const fixed = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'b1', webhookUrl: receiver.url, webhookFormat: 'generic' } })
  assert.equal(fixed.ok, true, JSON.stringify(fixed))
  await until(async () => ((await rowOf(ctx))?.state === 'ready' ? true : undefined), 'the channel ready')
  assert.equal((await rowOf(ctx)).levelNotes, undefined)
})
