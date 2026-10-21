// WeChat connector tests. P1 is red first: these cases are written against the design's
// contract and the module has to make them pass. P2 cases (inbound listener, sessions,
// isolation) stay todos until P2 starts.
//
// Checklist and the ID -> test -> status table live in
// docs/plans/2026-10-21-wechat-test-checklist.md. P1-14 is folded into P1-13; P2-25 is
// covered by P2-13a/13b. Tests marked (F5) wait for the host view/test hooks.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
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

function setup({ config = {} } = {}) {
  const home = teamHome()
  const registered = []
  const disposed = []
  const ctx = fakeContext()
  const register = ctx.tools.register
  ctx.tools.register = (tool) => {
    registered.push(tool.name)
    const undo = register(tool)
    return () => { disposed.push(tool.name); ctx.registeredTools.delete(tool.name); undo() }
  }
  const route = ctx.connection.fetch.register
  ctx.connection.fetch.register = (handled) => { ctx.route = handled; return route(handled) }
  apply(ctx, { home, ...config })
  registered.length = 0
  disposed.length = 0
  return { ctx, home, registered, disposed }
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
test('the webhook receiver records a signed request and its signature verifies', async (t) => {
  const receiver = await startWebhookReceiver({ secret: 'test-secret' })
  t.after(() => receiver.close())
  const body = JSON.stringify({ text: 'a notice' })
  await fetch(receiver.url, { method: 'POST', headers: wechatHeaders({ secret: 'test-secret', body }), body })
  assert.equal(receiver.requests.length, 1)
  assert.equal(receiver.requests[0].signatureOk, true)
  assert.deepEqual(receiver.requests[0].json, { text: 'a notice' })
})

test('the inbound signer builds one signature both directions can check', async () => {
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
  assert.deepEqual(row.levels, ['read', 'write'])
  assert.deepEqual(row.settings.map(field => field.name), ['label', 'transport', 'botId', 'webhookUrl', 'webhookFormat'])
  const json = JSON.stringify(await call(ctx, 'state', {}))
  assert.equal(json.includes('test-secret'), false)
})

// ---- P1-03: readiness and mount failures ----
test('P1-03 readiness names the missing field and a deleted Bot is a mount error', async (t) => {
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const row = await rowOf(ctx)
  assert.match(JSON.stringify(row.levelNotes ?? row.levelNote), /Choose a Bot/)
  const missingUrl = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'b1' } })
  assert.equal(missingUrl.ok, true)
  assert.match(JSON.stringify((await rowOf(ctx)).levelNotes ?? (await rowOf(ctx)).levelNote), /webhook URL/)
  const receiver = await startWebhookReceiver()
  t.after(() => receiver.close())
  const ghost = await call(ctx, 'connector-set-settings', { id: 'wechat', values: { transport: 'webhook', botId: 'deleted-bot', webhookUrl: receiver.url } })
  assert.equal(ghost.ok, true)
  const connected = await call(ctx, 'connector-connect', { id: 'wechat', values: { WECHAT_WEBHOOK_SECRET: 'test-secret' } })
  assert.equal(connected.ok, true)
  const failed = await until(async () => {
    const current = await rowOf(ctx)
    return current.state === 'error' ? current : undefined
  }, 'the mount failure')
  assert.match(failed.error, /no longer exists/)
})

// ---- P1-05: the notify tool and its approval ----
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

// ---- P1 remaining: F5-dependent host surface ----
test.todo('P1-07 (F5) transport change while ready: the host refuses with the fixed sentence, disconnect then saves')
test.todo('P1-08 (F5) connector-test posts the fixed notice through the module test hook and returns the view')
test.todo('P1-09 (F5) a secret saved from the settings card shows saved:true, never a value, and stays out of state')
test.todo('P1-12 (F5) clearSecrets:[webhookSecret] clears the saved secret; an empty text field clears its value')
test.todo('P1-14 (F5) view/status: fields.kind, instance.max, status block from the module view hook')
test.todo('P1-11 profile wechat:false hides the rows and opens nothing')
test.todo('P1-04 connector-connect on a webhook channel turns it ready and P1 has no inbound field')
test.todo('P1-07 changing transport while ready is refused with the fixed sentence; after disconnect it saves')
test.todo('P1-08 connector-test posts the fixed test notice and returns the whole view')
test.todo('P1-09 a secret given in settings is stored in Secrets, never in state or the view')
test.todo('P1-10 deleting an instance stops its mount and leaves the other channel ready')
test.todo('P1-11 profile wechat:false hides the rows and opens nothing')
test.todo('P1-12 clearSecrets:[webhookSecret] clears the saved secret; text fields clear with an empty string')
test('P1-13 two channels keep separate secrets: wechat-2 writes _2 and deleting it touches only its own', async (t) => {
  const receiver = await startWebhookReceiver()
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
    assert.deepEqual(row.inputs.map(field => field.name), ['WECHAT_WEBHOOK_SECRET'])
  }
  await toWrite(ctx, 'wechat')
  await toWrite(ctx, 'wechat-2')
  assert.ok(ctx.registeredTools.has('wechat_notify') && ctx.registeredTools.has('wechat_2_notify'))
  assert.equal((await call(ctx, 'connector-delete-instance', { id: 'wechat-2' })).ok, true)
  assert.equal((await names()).includes('WECHAT_WEBHOOK_SECRET_2'), false)
  assert.ok((await names()).includes('WECHAT_WEBHOOK_SECRET'))
  assert.equal(ctx.registeredTools.has('wechat_2_notify'), false)
})

// ---- P2: inbound listener, binding and replies ----
test.todo('P2-01 the listener binds 127.0.0.1 only: address is asserted, and no configuration can make it 0.0.0.0')
test.todo('P2-02 a taken port leaves only that channel error with port and fix; the plugin boots and other connectors are ready')
test.todo('P2-03 dispose closes the listener and unregisters every route: the port refuses connections, nothing stays in the route table')
test.todo('P2-04 a missing or wrong HMAC signature answers 401 bad-signature and starts 0 Bot turns')
test.todo('P2-05 a timestamp outside ±300s answers 401 stale-timestamp and starts 0 turns')
test.todo('P2-06 a replayed nonce answers 401 replayed-nonce and starts 0 turns')
test.todo('P2-07 a replayed msgId answers 200 duplicate and starts 0 turns; after a plugin restart it is still swallowed')
test.todo('P2-08 the same text under a new msgId starts a turn (no content-hash swallowing)')
test.todo('P2-09 over the per-channel rate limit answers 429 with retry_after and starts 0 turns')
test.todo('P2-10 a sender outside the allowlist answers 403 sender-not-allowed and starts 0 turns')
test.todo('P2-11 a deleted or failing Bot answers 502 bot-unavailable with the fallback sentence and no retry loop')
test.todo('P2-12 two inbound messages are serialized: each reply answers its own msgId, correlated to that turn end')
test.todo('P2-13a a synchronous wait over 20s answers 504 timeout; P2-13b an async turn over 120s sends a failure callback')
test.todo('P2-14 rebinding A->B archives the A session, creates a new session for B, and answers in-flight requests 503 channel-rebound')
test.todo('P2-15 an inbound turn that needs approval gets the WeChat notice only: the card stays unanswered and the tool runs 0 times')
test.todo('P2-16 logs, diagnostics and state.json carry no sender text, no message body and no secret')
test.todo('P2-17 the read level still answers inbound while wechat_notify stays unregistered')
test.todo('P2-18 an unsupported connector-command action is refused: per-action allow-list, args checked, login-* only on clawbot')
test.todo('P2-19 body over 64KB is refused while streaming (chunked included) and callbackUrl outside the loopback literals is refused')
test.todo('P2-20 visibility: channel sessions never appear in search, read_own_chat, the index, the sidebar or another session')
test.todo('P2-21 HMAC is mandatory and Bearer optional (default off); with Bearer on, a missing one answers 401')
test.todo('P2-22 memory: channel sessions get no review enumeration, no memory prompt injection and no MEMORY.md entry')
test.todo('P2-23 v1 keeps exactly one conversation session (the creator DM); no group session is pre-created')
test.todo('P2-24 the tool denylist holds and untrusted travels in the headerFor message header')
test.todo('P2-25 is covered by P2-13a + P2-13b (async 202 plus callback, wait cap, 504)')
