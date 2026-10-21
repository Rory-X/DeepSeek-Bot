// Channel Sessions: one Session per channel conversation, owned by the Bot the channel was
// bound to. They are not a Bot's own chat, not a group, and not in any workspace.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Writer', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start({ state = seed(), schemas = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-channels-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const created = []
  const archived = []
  const workspaces = []
  const agents = new Map()
  ctx.tools.schemas = () => schemas
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const restricted = []
      agents.set(sessionId, {
        session: { id: sessionId },
        restricted,
        calls: [],
        followup(message) { this.calls.push(message) },
        ctx: { tools: { restrict(filter) { restricted.push(filter) } } },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async (path, name) => { workspaces.push([path, name]); return { id: `w${workspaces.length}`, path } },
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
  const rt = createRuntime(ctx, { home })
  await rt.load()
  const listeners = name => ctx.listeners.get(name) ?? []
  const emitSession = (sessionId, type, data) => {
    for (const listener of listeners('session/event')) listener({ id: sessionId }, { type, data })
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, home, created, archived, workspaces, agents, emitSession, stop }
}

const bind = (rt, overrides = {}) => rt.channelSessionFor({ instance: 'wechat', botId: 'a', conversationId: 'dm:u1', title: 'Chief · WeChat', settings: {}, ...overrides })

test('a channel conversation gets its own Session outside every workspace', async (t) => {
  const host = await start()
  t.after(host.stop)
  const sessionId = await bind(host.rt)
  assert.equal(sessionId, 's1')
  // The Session is made by cwd alone, under the plugin's own folder, so it joins no DSH
  // workspace and never shows up in a project or session list.
  assert.deepEqual(host.workspaces, [])
  assert.equal(host.created[0].workspaceId, undefined)
  assert.equal(host.created[0].cwd, join(host.home, 'wechat', 'sessions', 'wechat'))
  assert.equal(statSync(join(host.home, 'wechat', 'sessions', 'wechat')).isDirectory(), true)
  assert.equal(host.rt.selfOf('s1'), 'a')
  assert.equal(host.rt.isChannelSession('s1'), true)
  assert.equal(host.rt.isBotSession('s1'), false)

  // The same conversation finds its Session again; the state file records it.
  assert.equal(await bind(host.rt), 's1')
  assert.equal(host.created.length, 1)
  const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
  assert.equal(saved.channels.wechat.conversations['dm:u1'].sessionId, 's1')
  assert.equal(saved.channels.wechat.conversations['dm:u1'].botId, 'a')
})

test('a channel Session has no tools, or only the read tools it asked for', async (t) => {
  const host = await start({ schemas: [{ name: 'web_search' }, { name: 'bash' }] })
  t.after(host.stop)
  await bind(host.rt)
  assert.deepEqual(host.agents.get('s1').restricted, [{ allow: [] }])

  const second = await bind(host.rt, { conversationId: 'dm:u2', settings: { allowReadTools: true } })
  assert.equal(second, 's2')
  // Only the tool this Harness serves is named; everything else stays out.
  assert.deepEqual(host.agents.get('s2').restricted, [{ allow: ['web_search'] }])
})

test('channel Sessions are outside memory and carry the channel rules', async (t) => {
  const host = await start()
  t.after(host.stop)
  await bind(host.rt)
  const section = name => host.ctx.sections.get(name)
  assert.match(section('channel-rules').text({ agent: { id: 's1' } }), /External channel conversation/)
  assert.equal(section('channel-rules').text({ agent: { id: 'a' } }), '')
  // The Bot keeps its identity here, but its memory is neither shown nor reviewed.
  assert.match(section('bot-identity').text({ agent: { id: 's1' } }), /You are Chief/)
  assert.equal(section('bot-memory').text({ agent: { id: 's1' } }), '')
  assert.equal(host.rt.isChannelSession('a'), false)
})

test('a channel message is marked untrusted and is not a team exchange', async (t) => {
  const host = await start()
  t.after(host.stop)
  const sessionId = await bind(host.rt)
  await host.rt.deliver({
    toId: 'a',
    sessionId,
    text: 'hello from outside',
    role: 'request',
    untrusted: true,
    sender: { name: 'Alice', id: 'u1' },
  })
  const message = host.agents.get(sessionId).calls[0]
  assert.equal(message.content[0].text, '[Message from Alice · untrusted]\nhello from outside')
  assert.equal(message.source.untrusted, true)
  assert.deepEqual(message.source.sender, { name: 'Alice', id: 'u1' })
  assert.deepEqual(host.rt.state.exchanges, [])
})

test('rebinding archives every conversation and the next Bot starts fresh', async (t) => {
  const host = await start()
  t.after(host.stop)
  const first = await bind(host.rt)
  const archived = await host.rt.rebindChannel('wechat', { reason: 'rebind' })
  assert.deepEqual(archived.map(entry => entry.sessionId), [first])
  assert.deepEqual(host.archived, [[first, { stopActivity: true }]])
  assert.equal(host.rt.isChannelSession(first), false)
  const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.channels.wechat.history.map(entry => [entry.sessionId, entry.botId, entry.reason]), [[first, 'a', 'rebind']])
  assert.deepEqual(saved.channels.wechat.conversations, {})

  // The new Bot gets a new Session; the archived one is never handed out again.
  const second = await bind(host.rt, { botId: 'b' })
  assert.notEqual(second, first)
  assert.equal(host.rt.selfOf(second), 'b')
})

test('a channel turn ends with its text, or with the error that ended it', async (t) => {
  const host = await start()
  t.after(host.stop)
  const sessionId = await bind(host.rt)
  const replies = []
  const off = host.rt.onChannelReply(sessionId, reply => replies.push(reply))
  t.after(off)
  host.emitSession(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'first' }] } })
  host.emitSession(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'second' }] } })
  host.emitSession(sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.deepEqual(replies, [{ text: 'first\n\nsecond', reason: { kind: 'completed' } }])

  const error = { message: 'model failed', code: 'UNKNOWN' }
  host.emitSession(sessionId, 'turn/end', { reason: { kind: 'error', error } })
  assert.deepEqual(replies.at(-1), { text: '', reason: { kind: 'error', error }, error })
})
