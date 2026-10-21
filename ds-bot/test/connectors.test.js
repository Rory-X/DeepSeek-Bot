import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createConnectorHost, signIn } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'
import { fakeCredentials, fakeOAuthServer, fakeResponse, fakeWebServer } from './oauth-fakes.js'

const fresh = () => `tok_${randomBytes(16).toString('hex')}`
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
const off = id => ({ id, state: 'off', account: null })
const OFF = {
  vercel: { id: 'vercel', name: 'Vercel', ...off('vercel'), level: 'read', levels: ['read', 'write'], actions: false, toolbox: false, toolboxCall: 'vercel_call', card: { glyph: 'vercel', about: 'Projects, deployments and runtime logs from a connected Vercel account.', docsUrl: 'https://vercel.com/docs/mcp', readOnlyNote: 'Read tools run directly; the four deployment actions are off by default and each asks for approval.' } },
  cloudflare: { id: 'cloudflare', name: 'Cloudflare', ...off('cloudflare'), level: 'read', levels: ['read', 'write'], oauth: true, toolbox: false, toolboxCall: 'cloudflare_call', card: { glyph: 'cloudflare', about: "Zones, DNS records, analytics and Workers through Cloudflare's own MCP server.", docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/', readOnlyNote: 'The named tools only read. Full access can change your account; every write still asks for your approval first.', consent: { title: 'Choose the access level on the authorization page', body: 'Requested scopes is read-only, and it is all this connector asks for. Full access lets Bots change your Cloudflare account; every write still asks for your approval first.', acknowledge: "I'll choose the access level on the authorization page" } } },
}
// The built-ins these tests are about. A connector module added under src/host/connectors
// hands the view one more row, and every line adds one; these assertions are about the
// built-ins, so they ignore module rows instead of failing on every connector branch.
const BUILTINS = new Set(['vercel', 'cloudflare'])
const builtins = view => view.filter(item => BUILTINS.has(item.id))
const statuses = view => builtins(view).map(item => [item.id, item.state, item.account])

test('signIn asks Vercel who owns the token, and keeps the default team', async () => {
  const token = fresh()
  let seen
  const user = await signIn('vercel', token, { api: 'https://vercel.test/', fetch: async (url, init) => { seen = { url, init }; return answer(200, { user: { username: 'acme', defaultTeamId: 'team_1' } }) } })
  assert.deepEqual(user, { username: 'acme', teamId: 'team_1' })
  assert.equal(seen.url, 'https://vercel.test/v2/user')
  assert.deepEqual(seen.init.headers, { Authorization: `Bearer ${token}` })
  await assert.rejects(signIn('vercel', token, { fetch: async () => answer(401, {}) }), /Vercel did not accept/)
  await assert.rejects(signIn('vercel', token, { fetch: async () => answer(500, {}) }), /Vercel answered 500/)
  await assert.rejects(signIn('vercel', token, { fetch: async () => answer(200, { user: {} }) }), /did not say who this token belongs to/)
  await assert.rejects(signIn('vercel', token, { fetch: async () => { throw new Error('down') } }), /^Error: Could not reach Vercel$/)
  await assert.rejects(signIn('nobody', token), /No such connector/)
})

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const teamHome = (state = TEAM) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-connectors-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  return home
}

// A loader that hands out a fake MCP client and records each mount.
function setup({ vercel = { api: 'https://vercel.test', url: 'https://mcp.vercel.test' }, cloudflare, secrets = [], state = TEAM, services = {}, config = {} } = {}) {
  const home = teamHome(state)
  if (secrets.length > 0) {
    writeFileSync(join(home, 'secrets.json'), JSON.stringify({
      version: 1,
      secrets: secrets.map(entry => ({ name: entry.name, value: entry.value, purpose: entry.purpose ?? '', scope: entry.scope ?? 'all' })),
    }))
  }
  const mounts = []
  const registered = []
  const disposed = []
  const ctx = fakeContext({ services })
  const register = ctx.tools.register
  ctx.tools.register = tool => {
    registered.push(tool.name)
    const undo = register(tool)
    return () => { disposed.push(tool.name); undo() }
  }
  capture(ctx)
  apply(ctx, { home, vercel, ...(cloudflare === undefined ? {} : { cloudflare }), ...config })
  // Only what a mount registers later matters here; the team tools come with apply().
  registered.length = 0
  disposed.length = 0
  return { ctx, home, mounts, registered, disposed }
}

// Waits for the background mount a saved token starts.
async function until(check, label) {
  for (let count = 0; count < 200; count += 1) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out: ${label}`)
}

function capture(ctx) {
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
}

// Calls the /api/bot route the way the client does.
async function call(ctx, endpoint, payload, headers = {}) {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', headers, body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}

const VERCEL_READ = ['search_vercel_documentation', 'list_projects', 'get_project', 'list_deployments', 'get_deployment', 'list_deployment_events', 'get_runtime_logs', 'get_runtime_errors', 'list_project_domains', 'list_domains', 'list_teams', 'get_team', 'get_git_deployment_context']
const VERCEL_ACTIONS = ['create_deployment', 'cancel_deployment', 'request_promote', 'request_rollback']
const vercelTool = (name, properties = {}, required) => ({ name, description: `Vercel ${name}`, inputSchema: { type: 'object', properties, ...(required === undefined ? {} : { required }) } })
const VERCEL_TOOLS = [
  vercelTool('list_projects', { teamId: { type: 'string' } }),
  vercelTool('get_runtime_logs', { projectId: { type: 'string' }, teamId: { type: 'string' } }, ['projectId', 'teamId']),
  ...VERCEL_READ.filter(name => name !== 'list_projects' && name !== 'get_runtime_logs').map(name => vercelTool(name)),
  ...VERCEL_ACTIONS.map(name => vercelTool(name)),
  vercelTool('create_project', { name: { type: 'string' } }),
  vercelTool('get_project_env', { projectId: { type: 'string' } }),
]
const vercelNames = names => names.map(name => `vercel_${name}`)

const mcpAnswer = (id, value, headers = {}) => ({
  status: 200,
  ok: true,
  headers: { get: name => headers[String(name).toLowerCase()] ?? 'application/json' },
  text: async () => JSON.stringify({ jsonrpc: '2.0', id, result: value }),
})
const emptyAnswer = () => ({ status: 202, ok: true, headers: { get: () => null }, text: async () => '' })

// A Vercel API and MCP server behind one fetch, recording what the connector sends.
function vercelBench({ user = { username: 'acme', defaultTeamId: 'team_1' }, status = 200, tools = VERCEL_TOOLS, toolError = false } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const target = String(url)
    if (target === 'https://vercel.test/v2/user') return answer(status, { user })
    if (target !== 'https://mcp.vercel.test') throw new Error(`unexpected fetch ${target}`)
    const body = JSON.parse(init.body)
    calls.push({ method: body.method, params: body.params, headers: init.headers })
    if (body.method === 'initialize') return mcpAnswer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Vercel MCP Server', version: '0.1.0' } }, { 'mcp-session-id': 'session-1' })
    if (body.method === 'notifications/initialized') return emptyAnswer()
    if (body.method === 'tools/list') {
      if (toolError) {
        return {
          status: 200,
          ok: true,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `refused ${init.headers.authorization}` } }),
        }
      }
      return mcpAnswer(body.id, { tools })
    }
    if (body.method === 'tools/call') return mcpAnswer(body.id, { content: [{ type: 'text', text: `called ${body.params.name}` }] })
    throw new Error(`unexpected method ${body.method}`)
  }
  return { fetch, calls }
}

test('connecting Vercel mounts only its read tools, and the default team answers what needs one', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home, mounts, registered } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const token = fresh()

  const connected = await call(ctx, 'connector-connect', { id: 'vercel', token })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  assert.deepEqual(builtins(connected.value), [{ id: 'vercel', name: 'Vercel', state: 'ready', account: 'acme', level: 'read', levels: ['read', 'write'], actions: false, toolbox: false, toolboxCall: 'vercel_call', card: { glyph: 'vercel', about: 'Projects, deployments and runtime logs from a connected Vercel account.', docsUrl: 'https://vercel.com/docs/mcp', readOnlyNote: 'Read tools run directly; the four deployment actions are off by default and each asks for approval.' } }, OFF.cloudflare])
  // The write tool is never registered, and Vercel is not mounted through DSH's client.
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
  assert.equal(mounts.length, 0)
  const list = bench.calls.find(entry => entry.method === 'tools/list')
  assert.equal(list.headers['mcp-session-id'], 'session-1')
  assert.equal(list.headers.authorization, `Bearer ${token}`)

  const tool = ctx.registeredTools.get('vercel_get_runtime_logs')
  assert.equal(await tool.execute({ projectId: 'p1' }, { agent: { id: 'm1' } }), 'called get_runtime_logs')
  assert.deepEqual(bench.calls.filter(entry => entry.method === 'tools/call').at(-1).params, { name: 'get_runtime_logs', arguments: { projectId: 'p1', teamId: 'team_1' } })
  // An argument the caller gives wins over the default team.
  await tool.execute({ projectId: 'p1', teamId: 'team_2' }, { agent: { id: 'm1' } })
  assert.deepEqual(bench.calls.filter(entry => entry.method === 'tools/call').at(-1).params.arguments, { projectId: 'p1', teamId: 'team_2' })
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets.map(secret => [secret.name, secret.scope]), [['VERCEL_TOKEN', []]])
})

test('a saved Vercel token connects on its own and fills the account and team', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const token = fresh()
  const { ctx, home, registered } = setup({ secrets: [{ name: 'VERCEL_TOKEN', value: token }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const connectors = await until(async () => {
    const view = (await call(ctx, 'state', {})).value.connectors
    return view[0]?.state === 'ready' ? view : undefined
  }, 'Vercel to connect from its saved token')
  assert.deepEqual(connectors[0], { id: 'vercel', name: 'Vercel', state: 'ready', account: 'acme', level: 'read', levels: ['read', 'write'], actions: false, toolbox: false, toolboxCall: 'vercel_call', card: { glyph: 'vercel', about: 'Projects, deployments and runtime logs from a connected Vercel account.', docsUrl: 'https://vercel.com/docs/mcp', readOnlyNote: 'Read tools run directly; the four deployment actions are off by default and each asks for approval.' } })
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
  // The account and its default team are kept in the team file, without the token.
  const savedText = readFileSync(join(home, 'state.json'), 'utf8')
  const saved = JSON.parse(savedText)
  assert.deepEqual([saved.connectors.vercel.username, saved.connectors.vercel.teamId], ['acme', 'team_1'])
  assert.ok(!savedText.includes(token))
  // The default team answers the tools that need one.
  const tool = ctx.registeredTools.get('vercel_get_runtime_logs')
  await tool.execute({ projectId: 'p1' }, { agent: { id: 'm1' } })
  assert.deepEqual(bench.calls.filter(entry => entry.method === 'tools/call').at(-1).params.arguments, { projectId: 'p1', teamId: 'team_1' })
})

test('a failed account check does not stop the saved-token mount', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench({ status: 500 })
  globalThis.fetch = bench.fetch
  const { ctx, home, registered } = setup({ secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const connectors = await until(async () => {
    const view = (await call(ctx, 'state', {})).value.connectors
    return view[0]?.state === 'ready' ? view : undefined
  }, 'Vercel to mount without an account')
  assert.deepEqual(connectors[0], { id: 'vercel', name: 'Vercel', state: 'ready', account: null, level: 'read', levels: ['read', 'write'], actions: false, toolbox: false, toolboxCall: 'vercel_call', card: { glyph: 'vercel', about: 'Projects, deployments and runtime logs from a connected Vercel account.', docsUrl: 'https://vercel.com/docs/mcp', readOnlyNote: 'Read tools run directly; the four deployment actions are off by default and each asks for approval.' } })
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors?.vercel, undefined)
})

test('replacing the saved Vercel token re-reads the account and its team', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const first = vercelBench()
  globalThis.fetch = first.fetch
  const { ctx, home } = setup({ secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[0]
    return item?.state === 'ready' && item.account === 'acme' ? item : undefined
  }, 'the first token to connect')

  // Another account's token replaces the saved one on the Secrets page.
  const second = vercelBench({ user: { username: 'other', defaultTeamId: 'team_2' } })
  globalThis.fetch = second.fetch
  await call(ctx, 'secret-set', { name: 'VERCEL_TOKEN', value: fresh(), purpose: 'replaced' })

  const view = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[0]
    return item?.account === 'other' ? item : undefined
  }, 'the new token to bring its account')
  assert.equal(view.state, 'ready')
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual([saved.connectors.vercel.username, saved.connectors.vercel.teamId], ['other', 'team_2'])
  // The remounted tools answer with the new default team.
  const tool = ctx.registeredTools.get('vercel_get_runtime_logs')
  await tool.execute({ projectId: 'p1' }, { agent: { id: 'm1' } })
  assert.deepEqual(second.calls.filter(entry => entry.method === 'tools/call').at(-1).params.arguments, { projectId: 'p1', teamId: 'team_2' })
})

test('the write level mounts the vendor toolbox, and the read level takes it away', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home, registered } = setup({ secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const ready = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[0]
    return item?.state === 'ready' ? item : undefined
  }, 'Vercel to connect read-only')
  assert.equal(ready.level, 'read')
  assert.deepEqual([ready.actions, ready.toolbox], [false, false])
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
  assert.ok(!registered.includes('vercel_create_deployment'))

  const raised = (await call(ctx, 'connector-set-level', { id: 'vercel', level: 'write' })).value
  assert.equal(raised[0].level, 'write')
  assert.deepEqual([raised[0].actions, raised[0].toolbox], [true, true])
  await until(async () => (registered.includes('vercel_call') ? true : undefined), 'the toolbox')
  // 13 read + the two meta tools; no named action tool is registered.
  assert.deepEqual(registered.slice(-15).sort(), [...vercelNames(VERCEL_READ), 'vercel_search_tools', 'vercel_call'].sort())
  assert.ok(!registered.includes('vercel_create_deployment'))

  const lowered = (await call(ctx, 'connector-set-level', { id: 'vercel', level: 'read' })).value
  assert.equal(lowered[0].level, 'read')
  assert.equal(lowered[0].toolbox, false)
  assert.deepEqual(registered.slice(-13).sort(), vercelNames(VERCEL_READ).sort())
  assert.ok(!registered.slice(-13).includes('vercel_create_deployment'))
})

const writeState = () => ({ ...TEAM, connectors: { vercel: { username: 'acme', teamId: 'team_1', level: 'write', connectedAt: 1 } } })

// The approval card a connector write leaves in the dock for the running Bot's session.
const approvalCard = async (ctx) => (await call(ctx, 'state', {})).value.questions.m1
const answerCard = (ctx, questionId, selected) => call(ctx, 'answer-question', { sessionId: 'm1', questionId, answer: { selected } })

test('an approval card left by an earlier host can still be dismissed', async (t) => {
  const { ctx, home } = setup({
    state: { ...TEAM, questions: { m1: { id: 'q-left', kind: 'connector-approval', question: "Allow Chief to run Vercel's create_deployment?", options: [{ label: 'Allow once' }, { label: 'Deny' }], askedAt: Date.now() } } },
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.equal((await call(ctx, 'state', {})).value.questions.m1.id, 'q-left')
  assert.equal((await call(ctx, 'dismiss-question', { sessionId: 'm1' })).ok, true)
  assert.equal((await call(ctx, 'state', {})).value.questions.m1, undefined)
})

test('an unanswered approval is refused after the timeout, and nothing is sent', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup({ state: writeState(), secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }], config: { connectorApprovalTimeoutMs: 60 } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[0]
    return item?.state === 'ready' && item.toolbox === true ? item : undefined
  }, 'Vercel at its write level')

  const pending = ctx.registeredTools.get('vercel_call').execute({ tool: 'create_deployment' }, { agent: { id: 'm1' } })
  await until(() => approvalCard(ctx), 'the approval card')
  await assert.rejects(pending, /did not answer in time/)
  assert.equal(await approvalCard(ctx), undefined)
  assert.equal(bench.calls.filter(entry => entry.method === 'tools/call').length, 0)
  const log = (await call(ctx, 'diagnostics-log')).value
  assert.match(log, /timed out: Vercel's create_deployment/)
})

test('a saved write level survives a restart', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const saved = { ...TEAM, connectors: { vercel: { username: 'acme', teamId: 'team_1', level: 'write', connectedAt: 1 } } }
  const { ctx, home, registered } = setup({ state: saved, secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const ready = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[0]
    return item?.state === 'ready' && item.toolbox === true ? item : undefined
  }, 'Vercel at its saved level')
  assert.equal(ready.level, 'write')
  assert.deepEqual([ready.actions, ready.toolbox], [true, true])
  assert.deepEqual([...registered].sort(), [...vercelNames(VERCEL_READ), 'vercel_search_tools', 'vercel_call'].sort())
  assert.ok(!registered.includes('vercel_create_deployment'))
})

// A team saved before levels: both switches on is a write grant.
const legacyWriteState = () => ({ ...TEAM, connectors: { vercel: { username: 'acme', teamId: 'team_1', actions: true, toolbox: true, connectedAt: 1 } } })

test('vercel_call asks on the approval card for a write target; blocked targets are still refused outright', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup({ state: writeState(), secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[0]
    return item?.state === 'ready' && item.toolbox === true ? item : undefined
  }, 'the toolbox to connect')
  const [gate] = ctx.listeners.get('tools/pre-execute')
  let passed = 0
  const next = () => { passed += 1; return Promise.resolve({ kind: 'allow' }) }

  // A blocked target needs no card: it can never run.
  const denied = await gate({ name: 'vercel_call', arguments: { tool: 'get_project_env' } }, next)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /environment values or credentials/)
  assert.equal(passed, 0)
  // A write target passes pre-execute; the card is made inside the call, without arguments.
  assert.deepEqual(await gate({ name: 'vercel_call', arguments: { tool: 'create_deployment' } }, next), { kind: 'allow' })
  assert.equal(passed, 1)
  const pending = ctx.registeredTools.get('vercel_call').execute({ tool: 'create_deployment', args: { project: 'shh-do-not-show' } }, { agent: { id: 'm1' } })
  const card = await until(() => approvalCard(ctx), 'the approval card')
  assert.ok(card.question.includes('create_deployment'))
  // No module hook here, so the default summary names the call and shows the arguments.
  assert.match(card.detail, /create_deployment/)
  assert.match(card.detail, /shh-do-not-show/)
  assert.equal(bench.calls.filter(entry => entry.method === 'tools/call').length, 0)
  await answerCard(ctx, card.id, ['Allow once'])
  assert.equal(await pending, 'called create_deployment')
  assert.equal(bench.calls.filter(entry => entry.method === 'tools/call').length, 1)

  // A read target runs with no card.
  assert.equal(await ctx.registeredTools.get('vercel_call').execute({ tool: 'list_projects' }, { agent: { id: 'm1' } }), 'called list_projects')
  assert.equal(await approvalCard(ctx), undefined)
  // The card may show arguments; the diagnostics log still keeps them out.
  const log = (await call(ctx, 'diagnostics-log')).value
  assert.ok(!log.includes('shh-do-not-show'))
})

test('an older team with the switches on reads as a write level', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home, registered } = setup({ state: legacyWriteState(), secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const ready = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[0]
    return item?.state === 'ready' && item.toolbox === true ? item : undefined
  }, 'Vercel at the migrated level')
  assert.equal(ready.level, 'write')
  assert.ok(registered.includes('vercel_call'))
  assert.ok(!registered.includes('vercel_create_deployment'))
})

test('a Vercel token that is refused or cannot name the account is not saved', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const { ctx, home, registered } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const refusedBench = vercelBench({ status: 401 })
  globalThis.fetch = refusedBench.fetch
  const refused = await call(ctx, 'connector-connect', { id: 'vercel', token: fresh() })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Vercel did not accept/)
  const unnamedBench = vercelBench({ user: {} })
  globalThis.fetch = unnamedBench.fetch
  const unnamed = await call(ctx, 'connector-connect', { id: 'vercel', token: fresh() })
  assert.equal(unnamed.ok, false)
  assert.match(unnamed.error.message, /did not say who this token belongs to/)
  assert.deepEqual(registered, [])
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a Vercel mount that fails shows the error without the token, and Try again mounts the tools', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const token = fresh()
  const bad = vercelBench({ toolError: true })
  globalThis.fetch = bad.fetch
  const { ctx, home, registered } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const result = await call(ctx, 'connector-connect', { id: 'vercel', token })
  const [vercel] = result.value
  assert.equal(vercel.state, 'error')
  assert.ok(!vercel.error.includes(token), vercel.error)
  assert.match(vercel.error, /\[secret:VERCEL_TOKEN\]/)
  assert.deepEqual(registered, [])

  const good = vercelBench()
  globalThis.fetch = good.fetch
  await call(ctx, 'connector-retry', { id: 'vercel' })
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
})

test('deleting VERCEL_TOKEN on the Secrets page unmounts Vercel and its tools', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home, registered, disposed } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call(ctx, 'connector-connect', { id: 'vercel', token: fresh() })
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
  await call(ctx, 'secret-delete', { name: 'VERCEL_TOKEN' })
  const state = await call(ctx, 'state', {})
  assert.deepEqual(statuses(state.value.connectors), [['vercel', 'off', null], ['cloudflare', 'off', null]])
  assert.deepEqual([...disposed].sort(), vercelNames(VERCEL_READ).sort())
})

test('a connector mounts and unmounts on its own', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home, registered, disposed } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await call(ctx, 'connector-connect', { id: 'vercel', token: fresh() })
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
  assert.deepEqual(statuses((await call(ctx, 'state', {})).value.connectors), [['vercel', 'ready', 'acme'], ['cloudflare', 'off', null]])

  await call(ctx, 'connector-disconnect', { id: 'vercel' })
  assert.deepEqual([...disposed].sort(), vercelNames(VERCEL_READ).sort())
  assert.deepEqual(statuses((await call(ctx, 'state', {})).value.connectors), [['vercel', 'off', null], ['cloudflare', 'off', null]])
})

test('vercel: false hides only the Vercel connector', async (t) => {
  const { ctx, home } = setup({ vercel: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual(builtins((await call(ctx, 'state', {})).value.connectors), [OFF.cloudflare])
})

test('a Vercel address without https refuses to send the token', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  let asked = false
  globalThis.fetch = async () => { asked = true; return answer(200, { user: { username: 'acme' } }) }
  const { ctx, home, registered } = setup({ vercel: { url: 'http://mcp.test/', api: 'https://vercel.test' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const refused = await call(ctx, 'connector-connect', { id: 'vercel', token: fresh() })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /https/)
  assert.equal(asked, false)
  assert.deepEqual(registered, [])
})

test('an unknown connector is refused', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const result = await call(ctx, 'connector-connect', { id: 'nowhere', token: fresh() })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /No such connector/)
})

// A connector in OAuth mode: no pasted token, one browser authorization, tools mounted from
// the grant. The Vercel entry is put in `oauth-mcp` mode through its profile config, which
// is the same override mechanism that names another server address.
const oauthVercel = { mode: 'oauth-mcp', oauth: { scopes: ['user:read', 'account:read'] }, url: 'https://mcp.vercel.test/mcp', api: 'https://vercel.test' }

test('an OAuth connector connects in the browser, mounts its read tools and refreshes a refused call once', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const oauth = fakeOAuthServer({ resource: 'https://mcp.vercel.test/mcp', issuer: 'https://mcp.vercel.test' })
  const mcpCalls = []
  let refused = false
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url)
    if (address !== 'https://mcp.vercel.test/mcp' || init.headers?.authorization === undefined) return oauth.fetch(url, init)
    const body = JSON.parse(init.body)
    mcpCalls.push({ method: body.method, authorization: init.headers.authorization })
    if (body.method === 'initialize') return mcpAnswer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Fake', version: '1' } }, { 'mcp-session-id': 'session-1' })
    if (body.method === 'notifications/initialized') return emptyAnswer()
    if (body.method === 'tools/list') return mcpAnswer(body.id, { tools: VERCEL_TOOLS })
    if (body.method === 'tools/call') {
      if (!refused) {
        refused = true
        return { status: 401, ok: false, headers: { get: () => null }, text: async () => '' }
      }
      return mcpAnswer(body.id, { content: [{ type: 'text', text: `called ${body.params.name} with ${init.headers.authorization}` }] })
    }
    throw new Error(`unexpected method ${body.method}`)
  }
  const credentials = fakeCredentials()
  const webServer = fakeWebServer()
  const { ctx, home, registered, disposed } = setup({ vercel: oauthVercel, services: { credentials, webServer } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  // Before the authorization the card is off, and it announces OAuth instead of a token form.
  const before = (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'vercel')
  assert.deepEqual([before.state, before.oauth, before.account], ['off', true, null])
  assert.equal((await call(ctx, 'connector-connect', { id: 'vercel', token: fresh() })).error.message, 'Vercel connects with OAuth, not a token')

  // Starting returns the provider URL; the browser follows it back to the callback route.
  const started = await call(ctx, 'connector-oauth-start', { id: 'vercel' }, { origin: 'https://dsh.test' })
  assert.equal(started.ok, true, JSON.stringify(started))
  const authorizeUrl = new URL(started.value.authorizeUrl)
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://dsh.test/oauth/ds-bot/vercel')
  assert.equal(authorizeUrl.searchParams.get('scope'), 'user:read account:read')
  const state = authorizeUrl.searchParams.get('state')
  const { res, done } = fakeResponse()
  webServer.routes[0].handler({ method: 'GET', url: `/oauth/ds-bot/vercel?code=auth-code&state=${encodeURIComponent(state)}` }, res)
  const page = await done
  assert.equal(page.statusCode, 200)
  assert.match(page.body, /Vercel is connected/)

  await until(async () => (registered.includes('vercel_list_projects') ? true : undefined), 'the OAuth mount')
  // Only the read whitelist is mounted: the action tools need the switch, which is off.
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
  const ready = (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'vercel')
  assert.deepEqual([ready.state, ready.oauth, ready.account], ['ready', true, null])
  assert.equal(credentials.records.get('ds-bot/connector-vercel').payload.tokens.access, 'access-1')
  // The grant stays out of the team file and every view.
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes('access-1'))
  assert.ok(!JSON.stringify(await call(ctx, 'state', {})).includes('access-1'))

  // A refused tool call refreshes the grant once and retries with the new token.
  const output = await ctx.registeredTools.get('vercel_list_projects').execute({})
  assert.match(output, /called list_projects with Bearer access-2/)
  assert.equal(oauth.tokenRequests().filter(request => new URLSearchParams(request.body).get('grant_type') === 'refresh_token').length, 1)
  assert.equal(mcpCalls.filter(entry => entry.method === 'tools/call').length, 2)

  // Disconnecting revokes the grant, deletes it and unmounts the tools.
  const disconnected = await call(ctx, 'connector-disconnect', { id: 'vercel' })
  assert.equal(disconnected.ok, true)
  assert.equal(disconnected.value.find(connector => connector.id === 'vercel').state, 'off')
  assert.equal(credentials.records.has('ds-bot/connector-vercel'), false)
  await until(async () => (disposed.includes('vercel_list_projects') ? true : undefined), 'the unmount')
})

test('an OAuth connector mounts by itself from a saved grant', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const oauth = fakeOAuthServer({ resource: 'https://mcp.vercel.test/mcp', issuer: 'https://mcp.vercel.test' })
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url)
    if (address !== 'https://mcp.vercel.test/mcp' || init.headers?.authorization === undefined) return oauth.fetch(url, init)
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') return mcpAnswer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Fake', version: '1' } })
    if (body.method === 'notifications/initialized') return emptyAnswer()
    if (body.method === 'tools/list') return mcpAnswer(body.id, { tools: VERCEL_TOOLS })
    throw new Error(`unexpected method ${body.method}`)
  }
  // The grant a previous run's callback would have written, in DSH's credential store.
  const credentials = fakeCredentials()
  credentials.records.set('ds-bot/connector-vercel', {
    kind: 'grant',
    payload: {
      version: 1,
      issuer: 'https://mcp.vercel.test',
      resource: 'https://mcp.vercel.test/mcp',
      client: { id: 'client-1', tokenAuth: 'none', redirectUri: 'https://dsh.test/oauth/ds-bot/vercel' },
      tokens: { access: 'access-1', refresh: 'refresh-1', expiresAt: Date.now() + 3_600_000, tokenType: 'Bearer' },
      scopes: ['user:read', 'account:read'],
      authorizedAt: 1,
    },
  })
  const saved = { ...TEAM, connectors: { vercel: { authorizedAt: 1 } } }
  const { ctx, home, registered } = setup({ vercel: oauthVercel, state: saved, services: { credentials, webServer: fakeWebServer() } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const ready = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'vercel')
    return item?.state === 'ready' ? item : undefined
  }, 'the saved grant to mount')
  assert.deepEqual([ready.oauth, ready.account], [true, null])
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
})

// Cloudflare's API server in endpoint mode, addressed with a query. The connector's whole
// point is a strict read whitelist: nothing else the server lists may be registered.
const CLOUDFLARE_READ = [
  'whoami',
  'get_accounts',
  'get_zones',
  'get_zones_by_zone_id',
  'get_zones_dns_records',
  'get_zones_dns_records_by_dns_record_id',
  'get_zones_dns_analytics_report',
  'get_zones_dns_analytics_report_bytime',
  'get_zones_analytics_latency',
  'get_zones_rate_limit_analytics',
  'get_zones_workers_routes',
  'get_zones_workers_routes_by_route_id',
  'get_accounts_workers_scripts',
  'get_accounts_workers_scripts_by_script_name',
]
const CLOUDFLARE_SCOPES = ['user:read', 'account:read', 'zone.read', 'dns.read', 'analytics.read', 'workers-routes.read', 'workers-scripts.read', 'offline_access']
const CLOUDFLARE_ADDRESS = 'https://mcp.cloudflare.test/mcp?codemode=false'

test('Cloudflare connects read-only, mounts exactly its whitelist, names the account and reconnects on a dead grant', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const oauth = fakeOAuthServer({
    resource: CLOUDFLARE_ADDRESS,
    issuer: 'https://mcp.cloudflare.test',
    // The server's metadata names the path without the mode query, as Cloudflare's does.
    declaredResource: 'https://mcp.cloudflare.test/mcp',
  })
  // The server lists far more than DS Bot exposes; none of it may reach a model.
  const listedTools = [
    ...CLOUDFLARE_READ.map(name => vercelTool(name)),
    vercelTool('post_zones_dns_records'),
    vercelTool('patch_zones_dns_records_by_dns_record_id'),
    vercelTool('delete_zones_by_zone_id'),
    vercelTool('post_graphql'),
    vercelTool('docs'),
    vercelTool('search'),
    vercelTool('execute'),
  ]
  let deadGrant = false
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url)
    if (deadGrant && address === 'https://mcp.cloudflare.test/token' && init.method === 'POST') {
      return { status: 400, ok: false, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ error: 'invalid_grant' }) }
    }
    if (address !== CLOUDFLARE_ADDRESS || init.headers?.authorization === undefined) return oauth.fetch(url, init)
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') return mcpAnswer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Fake', version: '1' } })
    if (body.method === 'notifications/initialized') return emptyAnswer()
    if (body.method === 'tools/list') return mcpAnswer(body.id, { tools: listedTools })
    if (body.method === 'tools/call') {
      if (deadGrant) return { status: 401, ok: false, headers: { get: () => null }, text: async () => '' }
      if (body.params.name === 'whoami') return mcpAnswer(body.id, { content: [{ type: 'text', text: JSON.stringify({ id: 'user:abc', email: 'dev@example.com' }) }] })
      return mcpAnswer(body.id, { content: [{ type: 'text', text: `called ${body.params.name}` }] })
    }
    throw new Error(`unexpected method ${body.method}`)
  }
  const credentials = fakeCredentials()
  const webServer = fakeWebServer()
  const { ctx, home, registered } = setup({ cloudflare: { url: CLOUDFLARE_ADDRESS }, services: { credentials, webServer } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  // Off, and OAuth rather than a token form, before the authorization.
  const before = (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'cloudflare')
  assert.deepEqual([before.state, before.oauth, before.account], ['off', true, null])
  assert.equal((await call(ctx, 'connector-connect', { id: 'cloudflare', token: fresh() })).error.message, 'Cloudflare connects with OAuth, not a token')

  // The authorization names the endpoint-mode resource and exactly the read scopes.
  const started = await call(ctx, 'connector-oauth-start', { id: 'cloudflare' }, { origin: 'https://dsh.test' })
  assert.equal(started.ok, true, JSON.stringify(started))
  const authorizeUrl = new URL(started.value.authorizeUrl)
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, 'https://mcp.cloudflare.test/authorize')
  assert.equal(authorizeUrl.searchParams.get('resource'), CLOUDFLARE_ADDRESS)
  assert.equal(authorizeUrl.searchParams.get('scope'), CLOUDFLARE_SCOPES.join(' '))
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://dsh.test/oauth/ds-bot/cloudflare')
  assert.equal((await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'cloudflare').state, 'connecting')

  const state = authorizeUrl.searchParams.get('state')
  const { res, done } = fakeResponse()
  webServer.routes[0].handler({ method: 'GET', url: `/oauth/ds-bot/cloudflare?code=auth-code&state=${encodeURIComponent(state)}` }, res)
  const page = await done
  assert.equal(page.statusCode, 200)
  assert.match(page.body, /Cloudflare is connected/)

  await until(async () => (registered.includes('cloudflare_whoami') ? true : undefined), 'the Cloudflare mount')
  // Exactly the whitelist: no write endpoint tool, no code-mode tool, nothing else.
  assert.deepEqual([...registered].sort(), CLOUDFLARE_READ.map(name => `cloudflare_${name}`).sort())
  assert.equal(registered.filter(name => name.startsWith('cloudflare_')).length, 14)
  const ready = (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'cloudflare')
  assert.deepEqual([ready.state, ready.oauth, ready.account], ['ready', true, 'dev@example.com'])
  // The token exchange carries the whole resource URL, query included.
  assert.equal(new URLSearchParams(oauth.tokenRequests()[0].body).get('resource'), CLOUDFLARE_ADDRESS)
  // The account is kept; no token text reaches the team file or the view.
  const savedText = readFileSync(join(home, 'state.json'), 'utf8')
  assert.match(savedText, /dev@example\.com/)
  assert.ok(!savedText.includes('access-1'))
  assert.ok(!JSON.stringify(await call(ctx, 'state', {})).includes('access-1'))
  assert.deepEqual(credentials.records.get('ds-bot/connector-cloudflare').payload.scopes, CLOUDFLARE_SCOPES)

  // The provider rejects the refresh token: the grant goes, the card asks to reconnect.
  deadGrant = true
  await assert.rejects(ctx.registeredTools.get('cloudflare_get_zones').execute({}), /connect again/)
  const broken = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'cloudflare')
    return item?.state === 'error' ? item : undefined
  }, 'the connector to ask for a reconnect')
  assert.match(broken.error, /connect again/)
  assert.equal(credentials.records.has('ds-bot/connector-cloudflare'), false)
})

test('the Cloudflare toolbox runs reads directly, asks for each write and never offers credentials', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const oauth = fakeOAuthServer({
    resource: CLOUDFLARE_ADDRESS,
    issuer: 'https://mcp.cloudflare.test',
    declaredResource: 'https://mcp.cloudflare.test/mcp',
  })
  const accountId = '0123456789abcdef0123456789abcdef'
  const namespaceTool = (name, properties = {}, required) => ({ name, description: `Cloudflare ${name}`, inputSchema: { type: 'object', properties, ...(required === undefined ? {} : { required }) } })
  const listedTools = [
    ...CLOUDFLARE_READ.map(name => namespaceTool(name, name === 'get_zones_dns_records' ? { zone_id: { type: 'string' }, account_id: { type: 'string' } } : {})),
    namespaceTool('post_zones_dns_records', { zone_id: { type: 'string' }, body: { type: 'object' } }, ['zone_id', 'body']),
    namespaceTool('delete_zones_by_zone_id', { zone_id: { type: 'string' } }, ['zone_id']),
    namespaceTool('docs'),
    namespaceTool('post_user_tokens'),
    namespaceTool('get_accounts_workers_scripts_secrets'),
    namespaceTool('get_accounts_members'),
  ]
  const mcpCalls = []
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url)
    if (address !== CLOUDFLARE_ADDRESS || init.headers?.authorization === undefined) return oauth.fetch(url, init)
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') return mcpAnswer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Fake', version: '1' } })
    if (body.method === 'notifications/initialized') return emptyAnswer()
    if (body.method === 'tools/list') return mcpAnswer(body.id, { tools: listedTools })
    if (body.method === 'tools/call') {
      mcpCalls.push({ name: body.params.name, args: body.params.arguments })
      if (body.params.name === 'whoami') return mcpAnswer(body.id, { content: [{ type: 'text', text: JSON.stringify({ id: 'user:abc', email: 'dev@example.com' }) }] })
      if (body.params.name === 'get_accounts') return mcpAnswer(body.id, { content: [{ type: 'text', text: JSON.stringify({ result: [{ id: accountId, name: 'Acme' }], success: true }) }] })
      return mcpAnswer(body.id, { content: [{ type: 'text', text: `called ${body.params.name} ${JSON.stringify(body.params.arguments)}` }] })
    }
    throw new Error(`unexpected method ${body.method}`)
  }
  const credentials = fakeCredentials()
  const webServer = fakeWebServer()
  const { ctx, home, registered } = setup({ cloudflare: { url: CLOUDFLARE_ADDRESS }, services: { credentials, webServer } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const started = await call(ctx, 'connector-oauth-start', { id: 'cloudflare', level: 'write' }, { origin: 'https://dsh.test' })
  const authorizeUrl = new URL(started.value.authorizeUrl)
  const { res, done } = fakeResponse()
  webServer.routes[0].handler({ method: 'GET', url: `/oauth/ds-bot/cloudflare?code=auth-code&state=${encodeURIComponent(authorizeUrl.searchParams.get('state'))}` }, res)
  assert.equal((await done).statusCode, 200)
  await until(async () => (registered.includes('cloudflare_whoami') ? true : undefined), 'the Cloudflare mount')

  // The account list answers the id account-scoped calls default to; it is not a re-auth.
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.cloudflare
  assert.equal(saved.accountId, accountId)
  assert.equal(saved.accountName, 'Acme')
  const ready = (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'cloudflare')
  // A write grant mounts the 14 read tools and the two meta tools of the vendor toolbox.
  assert.deepEqual([ready.level, ready.toolbox, ready.toolboxCall], ['write', true, 'cloudflare_call'])
  await until(async () => (registered.includes('cloudflare_search_tools') ? true : undefined), 'the Cloudflare toolbox')
  assert.deepEqual(registered.slice(-16).sort(), [...CLOUDFLARE_READ.map(name => `cloudflare_${name}`), 'cloudflare_search_tools', 'cloudflare_call'].sort())

  // Search shows reads and writes, and none of the credential tools.
  const search = ctx.registeredTools.get('cloudflare_search_tools')
  const found = await search.execute({ query: 'dns' })
  assert.match(found, /get_zones_dns_records \[read\]/)
  assert.match(found, /post_zones_dns_records \[write: needs approval\]/)
  assert.ok(!/user_tokens|workers_scripts_secrets|accounts_members/.test(found))
  assert.match(await search.execute({ query: 'tokens' }), /No Cloudflare tool matches/)

  const tool = ctx.registeredTools.get('cloudflare_call')
  // A read runs straight through, with the connected account filled in.
  const read = await tool.execute({ tool: 'get_zones_dns_records', args: { zone_id: 'z1' } }, { agent: { id: 'm1' } })
  assert.match(read, /called get_zones_dns_records/)
  assert.deepEqual(mcpCalls.at(-1).args, { zone_id: 'z1', account_id: accountId })
  assert.equal(await approvalCard(ctx), undefined)

  // A write asks first; the arguments never appear on the card.
  const callsBefore = mcpCalls.length
  const pending = tool.execute({ tool: 'post_zones_dns_records', args: { zone_id: 'z1', body: { marker: 'CARD-MUST-NOT-SHOW' } } }, { agent: { id: 'm1' } })
  const card = await until(() => approvalCard(ctx), 'the write approval card')
  assert.match(card.question, /Cloudflare's post_zones_dns_records/)
  // The card names the write target, and the request body is not printed.
  assert.match(card.detail, /post_zones_dns_records on zone z1/)
  assert.equal(card.target, 'zone z1')
  assert.equal(card.danger, undefined)
  assert.ok(!JSON.stringify(card).includes('CARD-MUST-NOT-SHOW'))
  assert.equal(mcpCalls.length, callsBefore)
  assert.equal((await answerCard(ctx, card.id, ['Allow once'])).ok, true)
  assert.match(await pending, /called post_zones_dns_records/)
  assert.equal(mcpCalls.length, callsBefore + 1)

  // A denied write never reaches Cloudflare.
  const denied = tool.execute({ tool: 'delete_zones_by_zone_id', args: { zone_id: 'z1' } }, { agent: { id: 'm1' } })
  const second = await until(() => approvalCard(ctx), 'the deny card')
  assert.match(second.detail, /delete_zones_by_zone_id on zone z1/)
  assert.equal(second.target, 'zone z1')
  assert.equal(second.danger, true)
  assert.equal(second.reversible, false)
  await answerCard(ctx, second.id, ['Deny'])
  await assert.rejects(denied, /denied Cloudflare's delete_zones_by_zone_id/)
  assert.equal(mcpCalls.length, callsBefore + 1)

  // A credential endpoint is refused before a card can even be made.
  const [gate] = ctx.listeners.get('tools/pre-execute')
  let passed = 0
  const next = () => { passed += 1; return Promise.resolve({ kind: 'allow' }) }
  const blocked = await gate({ name: 'cloudflare_call', arguments: { tool: 'post_user_tokens' } }, next)
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /mint or read credentials/)
  assert.equal(passed, 0)
  await assert.rejects(tool.execute({ tool: 'post_user_tokens' }, { agent: { id: 'm1' } }), /does not run it/)
  assert.equal(await approvalCard(ctx), undefined)
})

test('the access level is stored, shown and kept across a disconnect', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup({ secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const ready = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[0]
    return item?.state === 'ready' ? item : undefined
  }, 'Vercel to connect')
  assert.equal(ready.level, 'read')

  const raised = (await call(ctx, 'connector-set-level', { id: 'vercel', level: 'write' })).value
  assert.equal(raised[0].level, 'write')
  assert.equal((await call(ctx, 'state', {})).value.secrets.length, 1)

  const refused = await call(ctx, 'connector-set-level', { id: 'vercel', level: 'admin' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /no admin access level/)

  const gone = (await call(ctx, 'connector-disconnect', { id: 'vercel' })).value
  assert.equal(gone[0].state, 'off')
  assert.equal(gone[0].level, 'write')
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('only a connector that declares settings takes them', async (t) => {
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const result = await call(ctx, 'connector-set-settings', { id: 'cloudflare', values: { projectId: 'p1' } })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /no settings/)
})

test('an OAuth grant records the chosen level, and a level change asks for a new authorization', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const oauth = fakeOAuthServer({ resource: CLOUDFLARE_ADDRESS, issuer: 'https://mcp.cloudflare.test', declaredResource: 'https://mcp.cloudflare.test/mcp' })
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url)
    if (address !== CLOUDFLARE_ADDRESS || init.headers?.authorization === undefined) return oauth.fetch(url, init)
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') return mcpAnswer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Fake', version: '1' } })
    if (body.method === 'notifications/initialized') return emptyAnswer()
    if (body.method === 'tools/list') {
      return mcpAnswer(body.id, { tools: CLOUDFLARE_READ.map(name => ({ name, description: `Cloudflare ${name}`, inputSchema: { type: 'object', properties: {} } })) })
    }
    if (body.method === 'tools/call') return mcpAnswer(body.id, { content: [{ type: 'text', text: 'called' }] })
    throw new Error(`unexpected method ${body.method}`)
  }
  const credentials = fakeCredentials()
  const webServer = fakeWebServer()
  const { ctx, home } = setup({ cloudflare: { url: CLOUDFLARE_ADDRESS }, services: { credentials, webServer } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const started = await call(ctx, 'connector-oauth-start', { id: 'cloudflare', level: 'write' }, { origin: 'https://dsh.test' })
  assert.equal(started.ok, true, JSON.stringify(started))
  const authorizeUrl = new URL(started.value.authorizeUrl)
  const { res, done } = fakeResponse()
  webServer.routes[0].handler({ method: 'GET', url: `/oauth/ds-bot/cloudflare?code=auth-code&state=${encodeURIComponent(authorizeUrl.searchParams.get('state'))}` }, res)
  assert.equal((await done).statusCode, 200)
  await until(async () => (credentials.records.has('ds-bot/connector-cloudflare') ? true : undefined), 'the grant')

  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.cloudflare
  assert.equal(saved.level, 'write')
  const ready = (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'cloudflare')
  assert.equal(ready.level, 'write')

  const changed = (await call(ctx, 'connector-set-level', { id: 'cloudflare', level: 'read' })).value.find(connector => connector.id === 'cloudflare')
  assert.equal(changed.level, 'read')
  assert.equal(changed.needsReauth, true)
  assert.equal(changed.state, 'off')
  assert.equal(credentials.records.has('ds-bot/connector-cloudflare'), false)
})


test('switching to a level that is not ready is refused before the authorization is touched', async (t) => {
  const credentials = fakeCredentials()
  const state = { ...TEAM, connectors: { neon: { level: 'read', authorizedAt: 1, account: 'acme', settings: {} } } }
  const { ctx, home } = setup({ state, services: { credentials } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  credentials.records.set('ds-bot/connector-neon', { kind: 'grant', payload: { version: 1 } })

  const refused = await call(ctx, 'connector-set-level', { id: 'neon', level: 'write' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /project ID/)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.neon
  assert.deepEqual([saved.level, saved.authorizedAt], ['read', 1])
  assert.ok(credentials.records.has('ds-bot/connector-neon'))
})

test('a connector that is not ready for a level says why before the user switches', async (t) => {
  const { ctx, home } = setup({ state: { ...TEAM, connectors: { neon: { level: 'read', settings: {} } } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const row = (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'neon')
  assert.equal(row.levelNote, undefined)
  assert.match(row.levelNotes.write, /project ID/)
  assert.equal(row.levelNotes.read, undefined)

  const filled = await call(ctx, 'connector-set-settings', {
    id: 'neon',
    values: { projectId: 'spring-brook-12345678', roleName: 'neondb_owner' },
  })
  assert.equal(filled.ok, true, JSON.stringify(filled))
  assert.equal(filled.value.find(connector => connector.id === 'neon').levelNotes, undefined)
})

test('a level that is ready can be chosen and is stored', async (t) => {
  const state = { ...TEAM, connectors: { neon: { level: 'read', settings: { projectId: 'spring-brook-12345678', roleName: 'neondb_owner' } } } }
  const { ctx, home } = setup({ state })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const raised = await call(ctx, 'connector-set-level', { id: 'neon', level: 'write' })
  assert.equal(raised.ok, true, JSON.stringify(raised))
  assert.equal(raised.value.find(connector => connector.id === 'neon').level, 'write')
})

test('an authorization for a level that is not ready does not start', async (t) => {
  const { ctx, home } = setup({ state: { ...TEAM, connectors: { neon: { level: 'read', settings: {} } } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const refused = await call(ctx, 'connector-oauth-start', { id: 'neon', level: 'write' }, { origin: 'https://dsh.test' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /project ID/)
})

test('a blocked tool name is denied before a card or a request', async (t) => {
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const gates = ctx.listeners.get('tools/pre-execute') ?? []
  const gateFor = async (name) => {
    let passed = 0
    for (const gate of gates) {
      const result = await gate({ name, arguments: {} }, () => { passed += 1; return Promise.resolve({ kind: 'allow' }) })
      if (result?.kind === 'deny') return { result, passed }
    }
    return { passed }
  }

  for (const name of ['github_delete_repository', 'delete_repository']) {
    const blocked = await gateFor(name)
    assert.equal(blocked.result?.kind, 'deny', name)
    assert.match(blocked.result.reason, /GitHub does not run/)
  }
  // A normal GitHub tool is not affected, and no approval card was made for either.
  assert.equal((await gateFor('github_list_issues')).result, undefined)
  assert.equal((await call(ctx, 'state', {})).value.questions.m1, undefined)
})

// ---------------------------------------------------------------------------------------
// Multi-instance connectors. The plugin's own modules are tested above; these cases pin the
// framework rules every multi-instance connector shares, on a definition the test owns.

function demoDefinition(overrides = {}) {
  return {
    displayName: 'Demo',
    mode: 'oauth-mcp',
    levels: ['read', 'write'],
    defaultLevel: 'read',
    mcpUrl: 'https://mcp.demo.test/mcp',
    readTools: ['ping', 'pong'],
    oauth: { scopes: ['read'] },
    settings: [{ name: 'label', label: 'Name' }, { name: 'projectId', label: 'Project ID' }],
    instances: { prefix: 'demo', min: 1, max: 2 },
    ...overrides,
  }
}

const DEMO_TOOL_LIST = ['ping', 'pong'].map(name => ({ name, description: `Demo ${name}`, inputSchema: { type: 'object', properties: {} } }))

// One fake Demo MCP server: it lists the whitelist and records the token each call carries.
function demoBench({ tools = DEMO_TOOL_LIST } = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    assert.equal(String(url), 'https://mcp.demo.test/mcp')
    const body = JSON.parse(init.body)
    calls.push({ method: body.method, name: body.params?.name, authorization: init.headers?.authorization })
    if (body.method === 'initialize') return mcpAnswer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Demo', version: '1' } })
    if (body.method === 'notifications/initialized') return emptyAnswer()
    if (body.method === 'tools/list') return mcpAnswer(body.id, { tools })
    if (body.method === 'tools/call') return mcpAnswer(body.id, { content: [{ type: 'text', text: `ran ${body.params.name}` }] })
    throw new Error(`unexpected method ${body.method}`)
  }
  return { calls, fetch }
}

const demoGrant = (access, { level = 'read' } = {}) => ({
  version: 1,
  client: { id: `client-${access}`, redirectUri: 'https://dsh.test/oauth/ds-bot/demo' },
  resource: 'https://mcp.demo.test/mcp',
  tokens: { access, refresh: `refresh-${access}`, expiresAt: Date.now() + 3_600_000 },
  scopes: level === 'write' ? ['read', 'write'] : ['read'],
  level,
})

// A connector host on its own definitions, so an instance case never depends on which
// modules happen to live under src/host/connectors.
function hostSetup({ state = { connectors: {} }, definition = demoDefinition(), extraDefinitions = {}, config = {}, grants = {}, secrets = {}, home, credentials, loadSecrets = async () => {} } = {}) {
  const dir = home ?? mkdtempSync(join(tmpdir(), 'dsb-connector-instances-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify(state))
  const store = credentials ?? fakeCredentials()
  for (const [id, grant] of Object.entries(grants)) store.records.set(`ds-bot/connector-${id}`, { kind: 'grant', payload: grant })
  const webServer = fakeWebServer()
  const ctx = fakeContext({ services: { credentials: store, webServer } })
  const audit = []
  const warnings = []
  const registered = []
  const disposed = []
  const register = ctx.tools.register
  ctx.tools.register = (tool) => {
    registered.push(tool.name)
    const undo = register(tool)
    return () => { disposed.push(tool.name); undo() }
  }
  const rt = {
    ctx,
    state,
    config,
    home: dir,
    statePath,
    warn: (template, ...args) => { warnings.push(String(template).replace(/%s/g, () => String(args.shift()))) },
    redactSecrets: text => String(text),
    readOnly: () => undefined,
    save: async () => { writeFileSync(statePath, JSON.stringify(state)) },
    loadSecrets,
    secretValue: name => secrets[name],
    secretEndpoint: async () => {},
    diagnostics: { record: entry => audit.push(entry) },
    selfOf: () => 'm1',
    botOf: () => ({ name: 'Chief' }),
  }
  const host = createConnectorHost(rt, { demo: definition, ...extraDefinitions })
  Object.assign(rt, host)
  return { rt, ctx, home: dir, statePath, credentials: store, webServer, audit, warnings, registered, disposed, host }
}

const rowOf = (rt, id) => rt.connectorsView().find(row => row.id === id)

test('a multi-instance connector gives each instance its own row, grant and tools', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = demoBench()
  globalThis.fetch = bench.fetch
  const state = {
    connectors: {
      demo: { level: 'read', settings: { projectId: 'proj-a' }, authorizedAt: 1 },
      'demo-2': { level: 'read', settings: { projectId: 'proj-b' }, authorizedAt: 2 },
    },
  }
  const { ctx, rt, home, registered } = hostSetup({ state, grants: { demo: demoGrant('access-a'), 'demo-2': demoGrant('access-b') } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await until(async () => (['demo', 'demo-2'].every(id => rowOf(rt, id)?.state === 'ready') ? true : undefined), 'both instances to mount')
  const rows = rt.connectorsView()
  assert.deepEqual(rows.map(row => row.id), ['demo', 'demo-2'])
  assert.deepEqual(rows.map(row => row.name), ['Demo', 'Demo 2'])
  assert.deepEqual(rows.map(row => row.instance), [
    { base: 'demo', id: 'demo', label: 'Demo', max: 2 },
    { base: 'demo', id: 'demo-2', label: 'Demo 2', max: 2 },
  ])
  assert.deepEqual(rows.map(row => row.settings.find(field => field.name === 'projectId').value), ['proj-a', 'proj-b'])
  // Each instance mounted with its own grant and registered its own prefixed tools.
  assert.deepEqual([...registered].sort(), ['demo-2_ping', 'demo-2_pong', 'demo_ping', 'demo_pong'])
  await ctx.registeredTools.get('demo_ping').execute({})
  await ctx.registeredTools.get('demo-2_ping').execute({})
  const calls = bench.calls.filter(call => call.method === 'tools/call').map(call => call.authorization)
  assert.deepEqual(calls, ['Bearer access-a', 'Bearer access-b'])
  // Neither instance's token reaches the view or the team file.
  assert.ok(!JSON.stringify(rows).includes('access-a'))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes('access-a'))
})

test('a profile that turns the module off hides every instance and mounts none', async (t) => {
  const state = { connectors: { demo: { level: 'read', settings: {} }, 'demo-2': { level: 'read', settings: {} } } }
  const { ctx, rt, home, registered } = hostSetup({ state, config: { demo: false } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  // Instances that already exist in the team file stay hidden as well: the module is off.
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(rt.connectorsView(), [])
  assert.equal(registered.length, 0)
  // The late-instance pass that runs after a state load does not bring them back either.
  assert.deepEqual(rt.connectorsView().filter(row => row.id.startsWith('demo')), [])
})

test('a saved single-instance authorization becomes the default instance without a rewrite', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = demoBench()
  globalThis.fetch = bench.fetch
  const state = { revision: 3, connectors: { demo: { level: 'write', settings: { projectId: 'proj-1', roleName: 'app' }, account: 'acme', authorizedAt: 9 } } }
  const { ctx, rt, home, statePath, credentials } = hostSetup({ state, grants: { demo: demoGrant('access-a', { level: 'write' }) } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const before = readFileSync(statePath, 'utf8')

  await until(async () => (rowOf(rt, 'demo')?.state === 'ready' ? true : undefined), 'the default instance to mount')
  const rows = rt.connectorsView()
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].id, rows[0].name, rows[0].level, rows[0].instance], ['demo', 'Demo', 'write', { base: 'demo', id: 'demo', label: 'Demo', max: 2 }])
  assert.deepEqual(rows[0].settings.find(field => field.name === 'projectId').value, 'proj-1')
  // The old grant mounts the old instance, and nothing was rewritten or re-authorized.
  await ctx.registeredTools.get('demo_ping').execute({})
  assert.equal(bench.calls.find(call => call.method === 'tools/call').authorization, 'Bearer access-a')
  assert.equal(readFileSync(statePath, 'utf8'), before)
  assert.deepEqual(credentials.records.get('ds-bot/connector-demo').payload.level, 'write')
  assert.equal(credentials.records.size, 1)
})

test('creating, renaming and removing an instance never authorizes it and never reuses its id', async (t) => {
  const { ctx, rt, home, credentials, audit, registered, disposed } = hostSetup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  // A team that never configured the connector still has its first instance, off.
  assert.deepEqual(rt.connectorsView().map(row => row.id), ['demo'])

  const created = await rt.connectorEndpoint('connector-create-instance', { base: 'demo' })
  assert.deepEqual(created.map(row => row.id), ['demo', 'demo-2'])
  const added = created[1]
  assert.deepEqual([added.name, added.state, added.level, added.instance], ['Demo 2', 'off', 'read', { base: 'demo', id: 'demo-2', label: 'Demo 2', max: 2 }])
  assert.deepEqual(rt.state.connectors['demo-2'], { level: 'read', settings: {} })
  // No authorization was started and no tool was mounted for the new instance.
  assert.equal(credentials.records.has('ds-bot/connector-demo-2'), false)
  assert.ok(!registered.some(name => name.startsWith('demo-2_')))
  assert.match(audit.at(-1).text, /Demo instance demo-2 added as "Demo 2"/)

  const renamed = await rt.connectorEndpoint('connector-set-settings', { id: 'demo-2', values: { label: 'Staging', projectId: 'proj-b' } })
  const renamedRow = renamed.find(row => row.id === 'demo-2')
  assert.deepEqual([renamedRow.name, renamedRow.instance.label], ['Staging', 'Staging'])
  assert.deepEqual(rt.state.connectors['demo-2'].settings, { label: 'Staging', projectId: 'proj-b' })

  const removed = await rt.connectorEndpoint('connector-delete-instance', { id: 'demo-2' }, { origin: 'https://dsh.test' })
  assert.deepEqual(removed.map(row => row.id), ['demo'])
  assert.equal(rt.state.connectors['demo-2'], undefined)
  assert.deepEqual(disposed, [])
  assert.match(audit.at(-1).text, /Demo instance demo-2 \("Staging"\) removed from https:\/\/dsh\.test/)

  // The id is not reused: the next instance is demo-3, and the high-water mark is saved.
  const again = await rt.connectorEndpoint('connector-create-instance', { base: 'demo' })
  assert.deepEqual(again.map(row => row.id), ['demo', 'demo-3'])
  assert.equal(rt.state.connectorInstances.demo.next, 4)

  // The base instance may go while another stays; the list is the state keys, not a name.
  const withoutBase = await rt.connectorEndpoint('connector-delete-instance', { id: 'demo' })
  assert.deepEqual(withoutBase.map(row => row.id), ['demo-3'])
  const fourth = await rt.connectorEndpoint('connector-create-instance', { base: 'demo' })
  assert.deepEqual(fourth.map(row => row.id), ['demo-3', 'demo-4'])
  const last = await rt.connectorEndpoint('connector-delete-instance', { id: 'demo-4' })
  assert.deepEqual(last.map(row => row.id), ['demo-3'])
  // The last instance cannot be removed.
  await assert.rejects(rt.connectorEndpoint('connector-delete-instance', { id: 'demo-3' }), /keeps at least 1 instance/)
})

test('a new instance skips an id another connector module already uses', async (t) => {
  const { ctx, rt, home } = hostSetup({
    extraDefinitions: { 'demo-2': { displayName: 'Other', mode: 'oauth-mcp', levels: ['read'], defaultLevel: 'read', mcpUrl: 'https://other.test/mcp', readTools: ['ping'], oauth: { scopes: ['read'] } } },
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const created = await rt.connectorEndpoint('connector-create-instance', { base: 'demo' })
  // demo-2 belongs to another module, so the framework's instance starts at demo-3.
  assert.deepEqual(created.map(row => row.id), ['demo', 'demo-2', 'demo-3'])
  assert.equal(rowOf(rt, 'demo-2').instance, undefined)
  assert.deepEqual(rowOf(rt, 'demo-3').instance, { base: 'demo', id: 'demo-3', label: 'Demo 3', max: 2 })
})

test('two instance creations queue behind each other and the limit holds', async (t) => {
  const { ctx, rt, home } = hostSetup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const attempted = await Promise.allSettled([
    rt.connectorEndpoint('connector-create-instance', { base: 'demo' }),
    rt.connectorEndpoint('connector-create-instance', { base: 'demo' }),
  ])
  assert.equal(attempted.filter(result => result.status === 'fulfilled').length, 1)
  assert.match(attempted.find(result => result.status === 'rejected').reason.message, /at most 2 instances/)
  assert.deepEqual(rt.connectorsView().map(row => row.id), ['demo', 'demo-2'])
})

test('removing one instance clears only its own grant and tools', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = demoBench()
  globalThis.fetch = bench.fetch
  const state = {
    connectors: {
      demo: { level: 'read', settings: { projectId: 'proj-a' }, authorizedAt: 1 },
      'demo-2': { level: 'read', settings: { projectId: 'proj-b' }, authorizedAt: 2 },
    },
  }
  const { ctx, rt, home, credentials, disposed } = hostSetup({
    state,
    grants: { demo: demoGrant('access-a'), 'demo-2': demoGrant('access-b') },
    extraDefinitions: { single: { displayName: 'Single', mode: 'oauth-mcp', levels: ['read'], defaultLevel: 'read', mcpUrl: 'https://single.test/mcp', readTools: ['ping'], oauth: { scopes: ['read'] } } },
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => (['demo', 'demo-2'].every(id => rowOf(rt, id)?.state === 'ready') ? true : undefined), 'both instances to mount')

  // The provider cannot be asked to revoke: the local removal still completes.
  globalThis.fetch = async () => ({ status: 404, ok: false, headers: { get: () => null }, text: async () => '' })
  const removed = await rt.connectorEndpoint('connector-delete-instance', { id: 'demo-2' })
  assert.deepEqual(removed.filter(row => row.id.startsWith('demo')).map(row => row.id), ['demo'])
  assert.equal(credentials.records.has('ds-bot/connector-demo-2'), false)
  assert.equal(credentials.records.has('ds-bot/connector-demo'), true)
  assert.deepEqual([...disposed].sort(), ['demo-2_ping', 'demo-2_pong'])
  assert.deepEqual(rt.state.connectors.demo.settings, { projectId: 'proj-a' })
  assert.equal(rowOf(rt, 'demo').state, 'ready')

  // A single-instance connector has no instance endpoints at all.
  await assert.rejects(rt.connectorEndpoint('connector-create-instance', { base: 'single' }), /does not support more than one instance/)
  await assert.rejects(rt.connectorEndpoint('connector-delete-instance', { id: 'single' }), /single instance and cannot be removed/)
})

test('an instance without a grant does not borrow another instance grant', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = demoBench()
  globalThis.fetch = bench.fetch
  const state = {
    connectors: {
      demo: { level: 'read', settings: {} },
      'demo-2': { level: 'read', settings: {}, authorizedAt: 1 },
    },
  }
  const { ctx, rt, home, registered } = hostSetup({ state, grants: { 'demo-2': demoGrant('access-b') } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await until(async () => (rowOf(rt, 'demo-2')?.state === 'ready' ? true : undefined), 'the authorized instance to mount')
  assert.deepEqual([rowOf(rt, 'demo').state, rowOf(rt, 'demo-2').state], ['off', 'ready'])
  assert.deepEqual([...registered].sort(), ['demo-2_ping', 'demo-2_pong'])
  assert.equal(ctx.registeredTools.get('demo_ping'), undefined)
})

test('a new instance authorizes through its own callback and keeps its own grant', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const oauth = fakeOAuthServer({ resource: 'https://mcp.demo.test/mcp', issuer: 'https://mcp.demo.test' })
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) !== 'https://mcp.demo.test/mcp' || init.headers?.authorization === undefined) return oauth.fetch(url, init)
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') return mcpAnswer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Demo', version: '1' } })
    if (body.method === 'notifications/initialized') return emptyAnswer()
    if (body.method === 'tools/list') return mcpAnswer(body.id, { tools: DEMO_TOOL_LIST })
    if (body.method === 'tools/call') return mcpAnswer(body.id, { content: [{ type: 'text', text: `ran ${body.params.name}` }] })
    throw new Error(`unexpected method ${body.method}`)
  }
  const { ctx, rt, home, credentials, webServer } = hostSetup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.connectorEndpoint('connector-create-instance', { base: 'demo' })

  const started = await rt.connectorEndpoint('connector-oauth-start', { id: 'demo-2' }, { origin: 'https://dsh.test' })
  const authorizeUrl = new URL(started.authorizeUrl)
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://dsh.test/oauth/ds-bot/demo-2')
  const { res, done } = fakeResponse()
  webServer.routes[0].handler({ method: 'GET', url: `/oauth/ds-bot/demo-2?code=auth-code&state=${encodeURIComponent(authorizeUrl.searchParams.get('state'))}` }, res)
  assert.equal((await done).statusCode, 200)
  await until(async () => (rowOf(rt, 'demo-2')?.state === 'ready' ? true : undefined), 'the new instance to mount')

  // The grant is addressed by instance id, and the default instance never authorized.
  assert.deepEqual([...credentials.records.keys()], ['ds-bot/connector-demo-2'])
  assert.deepEqual(credentials.records.get('ds-bot/connector-demo-2').payload.tokens.access, 'access-1')
  assert.equal(rowOf(rt, 'demo').state, 'off')
  assert.deepEqual([...ctx.registeredTools.keys()].filter(name => name.startsWith('demo-2_')).sort(), ['demo-2_ping', 'demo-2_pong'])
  assert.ok(ctx.registeredTools.get('demo_ping') === undefined)
  assert.ok(!JSON.stringify(rt.connectorsView()).includes('access-1'))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes('access-1'))
})

test('the instance soft limit refuses one more create with a clear message', async (t) => {
  const { ctx, rt, home, credentials, audit } = hostSetup({ definition: demoDefinition({ instances: { prefix: 'demo', min: 1, max: 8 } }) })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  for (let count = 2; count <= 8; count += 1) {
    const rows = await rt.connectorEndpoint('connector-create-instance', { base: 'demo' })
    assert.equal(rows.length, count)
  }
  assert.equal(rt.connectorsView().length, 8)
  await assert.rejects(
    rt.connectorEndpoint('connector-create-instance', { base: 'demo' }),
    /Demo supports at most 8 instances \(8 already exist\); remove one before adding another/,
  )
  // The refused create changed nothing.
  assert.equal(rt.connectorsView().length, 8)
  assert.equal(credentials.records.size, 0)
  // Every creation left one audit line with the id and label, and no credential.
  const created = audit.filter(entry => entry.source === 'connector-created')
  assert.equal(created.length, 7)
  assert.match(created[0].text, /Demo instance demo-2 added as "Demo 2"/)
})

test('instance changes queue behind each other and stay on their own instance', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = demoBench()
  globalThis.fetch = bench.fetch
  const state = {
    connectors: {
      demo: { level: 'read', settings: { projectId: 'proj-a' }, authorizedAt: 1 },
      'demo-2': { level: 'read', settings: { projectId: 'proj-b' }, authorizedAt: 2 },
    },
  }
  const { ctx, rt, home, credentials, audit } = hostSetup({ state, grants: { demo: demoGrant('access-a'), 'demo-2': demoGrant('access-b') } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => (['demo', 'demo-2'].every(id => rowOf(rt, id)?.state === 'ready') ? true : undefined), 'both instances to mount')

  // Two changes at once: each lands on its own instance, one at a time.
  const [levelChanged, renamed] = await Promise.all([
    rt.connectorEndpoint('connector-set-level', { id: 'demo', level: 'write' }),
    rt.connectorEndpoint('connector-set-settings', { id: 'demo-2', values: { label: 'Staging', projectId: 'proj-b' } }),
  ])
  const changed = levelChanged.find(row => row.id === 'demo')
  const renamedRow = renamed.find(row => row.id === 'demo-2')
  assert.deepEqual([changed.level, changed.needsReauth], ['write', true])
  assert.deepEqual([renamedRow.name, renamedRow.level], ['Staging', 'read'])
  assert.deepEqual(rt.state.connectors.demo.settings, { projectId: 'proj-a' })
  assert.deepEqual(rt.state.connectors['demo-2'].settings, { label: 'Staging', projectId: 'proj-b' })
  // The level change needed a new authorization for its own instance and dropped only that
  // grant; the rename kept the other instance's grant and remounted it.
  assert.deepEqual([...credentials.records.keys()], ['ds-bot/connector-demo-2'])
  assert.equal(rowOf(rt, 'demo-2').state, 'ready')
  // The implicit disconnect caused by the level change is audited with the instance id.
  assert.ok(audit.some(entry => entry.source === 'connector-disconnected' && entry.text.includes('Demo (demo)')), JSON.stringify(audit))

  // A removal racing a settings change: the queue decides the order, and the loser hears a
  // clean "No such connector" instead of resurrecting the instance.
  const raced = await Promise.allSettled([
    rt.connectorEndpoint('connector-delete-instance', { id: 'demo-2' }),
    rt.connectorEndpoint('connector-set-settings', { id: 'demo-2', values: { label: 'Late' } }),
  ])
  assert.equal(raced[0].status, 'fulfilled')
  assert.equal(raced[1].status, 'rejected')
  assert.match(raced[1].reason.message, /No such connector/)
  assert.deepEqual(rt.connectorsView().map(row => row.id), ['demo'])
  assert.equal(rt.state.connectors['demo-2'], undefined)
})

test('a revoke that fails is only a warning and the removal still clears locally', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = demoBench()
  globalThis.fetch = bench.fetch
  const state = {
    connectors: {
      demo: { level: 'read', settings: { projectId: 'proj-a' }, authorizedAt: 1 },
      'demo-2': { level: 'read', settings: { projectId: 'proj-b' }, authorizedAt: 2 },
    },
  }
  const { ctx, rt, home, credentials, warnings, audit } = hostSetup({ state, grants: { demo: demoGrant('access-a'), 'demo-2': demoGrant('access-b') } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => (['demo', 'demo-2'].every(id => rowOf(rt, id)?.state === 'ready') ? true : undefined), 'both instances to mount')

  // The provider cannot be asked to revoke: the local removal completes all the same.
  globalThis.fetch = async () => ({ status: 404, ok: false, headers: { get: () => null }, text: async () => '' })
  const rows = await rt.connectorEndpoint('connector-delete-instance', { id: 'demo-2' }, { origin: 'https://dsh.test' })
  assert.deepEqual(rows.map(row => row.id), ['demo'])
  assert.ok(warnings.some(text => text.includes('demo-2') && /could not be revoked/.test(text)), JSON.stringify(warnings))
  assert.equal(credentials.records.has('ds-bot/connector-demo-2'), false)
  assert.equal(credentials.records.has('ds-bot/connector-demo'), true)
  assert.equal(rt.state.connectors['demo-2'], undefined)
  const deleted = audit.find(entry => entry.source === 'connector-deleted')
  assert.match(deleted.text, /Demo instance demo-2 \("Demo 2"\) removed from https:\/\/dsh\.test/)
  assert.ok(!JSON.stringify(audit).includes('access-b'))
  assert.ok(!JSON.stringify(rt.connectorsView()).includes('access-b'))
})

test('after a restart every instance mounts from its own grant', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = demoBench()
  globalThis.fetch = bench.fetch
  const state = {
    connectors: {
      demo: { level: 'read', settings: { projectId: 'proj-a' }, authorizedAt: 1 },
      'demo-2': { level: 'read', settings: { projectId: 'proj-b' }, authorizedAt: 2 },
    },
  }
  const first = hostSetup({ state, grants: { demo: demoGrant('access-a'), 'demo-2': demoGrant('access-b') } })
  t.after(() => rmSync(first.home, { recursive: true, force: true, maxRetries: 5 }))
  await until(async () => (['demo', 'demo-2'].every(id => rowOf(first.rt, id)?.state === 'ready') ? true : undefined), 'both instances to mount')
  await first.ctx.dispose()

  // A second host over the same team file and credential store is a restart.
  const second = hostSetup({ state: first.rt.state, home: first.home, credentials: first.credentials })
  await until(async () => (['demo', 'demo-2'].every(id => rowOf(second.rt, id)?.state === 'ready') ? true : undefined), 'both instances after the restart')
  await second.ctx.registeredTools.get('demo_ping').execute({})
  await second.ctx.registeredTools.get('demo-2_ping').execute({})
  const lastTokens = bench.calls.filter(call => call.method === 'tools/call').slice(-2).map(call => call.authorization)
  assert.deepEqual(lastTokens, ['Bearer access-a', 'Bearer access-b'])

  // Remove one instance, restart again: only the remaining instance comes back.
  await second.rt.connectorEndpoint('connector-delete-instance', { id: 'demo-2' })
  await second.ctx.dispose()
  const third = hostSetup({ state: second.rt.state, home: first.home, credentials: first.credentials })
  await until(async () => (rowOf(third.rt, 'demo')?.state === 'ready' ? true : undefined), 'the remaining instance after the second restart')
  assert.deepEqual(third.rt.connectorsView().map(row => row.id), ['demo'])
  assert.ok(!third.registered.some(name => name.startsWith('demo-2_')))
  assert.equal(third.credentials.records.has('ds-bot/connector-demo-2'), false)
  await third.ctx.dispose()
})

test('an approval outcome is audited with the instance id and never the arguments', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const danger = { name: 'danger', description: 'Demo danger', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } }
  const bench = demoBench({ tools: [...DEMO_TOOL_LIST, danger] })
  globalThis.fetch = bench.fetch
  const definition = demoDefinition({ readTools: ['ping'], actionTools: ['danger'] })
  const state = { connectors: { 'demo-2': { level: 'write', settings: { projectId: 'proj-b' }, authorizedAt: 1 } } }
  const { ctx, rt, home, audit } = hostSetup({
    state,
    definition,
    grants: { 'demo-2': demoGrant('access-b', { level: 'write' }) },
    config: { connectorApprovalTimeoutMs: 40 },
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => (rowOf(rt, 'demo-2')?.state === 'ready' ? true : undefined), 'the write instance to mount')

  const tool = ctx.registeredTools.get('demo-2_danger')
  assert.ok(tool !== undefined)
  await assert.rejects(tool.execute({ sql: 'select secret_value from users' }, { agent: { id: 'm1' } }), /did not answer in time/)
  const approval = audit.filter(entry => entry.source === 'connector-approval')
  assert.ok(approval.length > 0)
  const line = approval.at(-1).text
  assert.match(line, /timed out/)
  assert.match(line, /Demo 2 \(demo-2\)'s danger/)
  assert.ok(!line.includes('select secret_value'))
  assert.ok(!JSON.stringify(audit).includes('select secret_value'))
  assert.ok(!JSON.stringify(audit).includes('access-b'))
  assert.deepEqual(rt.state.questions, {})
})

test('an instance that appears after the host started is adopted and mounted', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = demoBench()
  globalThis.fetch = bench.fetch
  const { ctx, rt, home, credentials, registered } = hostSetup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  // The team file is adopted lazily on the first read, after this host installed: both the
  // implied instance and the saved ones have to end up on the page with their grants.
  rt.state.connectors = {
    demo: { level: 'read', settings: { projectId: 'proj-a' }, authorizedAt: 1 },
    'demo-2': { level: 'read', settings: { projectId: 'proj-b' }, authorizedAt: 2 },
  }
  credentials.records.set('ds-bot/connector-demo', { kind: 'grant', payload: demoGrant('access-a') })
  credentials.records.set('ds-bot/connector-demo-2', { kind: 'grant', payload: demoGrant('access-b') })

  assert.deepEqual(rt.connectorsView().map(row => row.id), ['demo', 'demo-2'])
  await until(async () => (['demo', 'demo-2'].every(id => rowOf(rt, id)?.state === 'ready') ? true : undefined), 'the adopted instances to mount')
  assert.deepEqual([...registered].sort(), ['demo-2_ping', 'demo-2_pong', 'demo_ping', 'demo_pong'])
  // A second read does not add or remount anything.
  assert.deepEqual(rt.connectorsView().map(row => row.id), ['demo', 'demo-2'])
  assert.equal(registered.length, 4)
})

test('switching to a level that is not ready is refused before the grant is touched', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = demoBench()
  globalThis.fetch = bench.fetch
  const definition = demoDefinition({
    readiness: ({ level, settings }) => (level === 'write' && (typeof settings.projectId !== 'string' || typeof settings.roleName !== 'string')
      ? 'A project id and a SQL role are required for write access'
      : undefined),
  })
  const state = { connectors: { demo: { level: 'read', settings: {}, authorizedAt: 1 } } }
  const { ctx, rt, home, credentials } = hostSetup({ state, definition, grants: { demo: demoGrant('access-a') } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => (rowOf(rt, 'demo')?.state === 'ready' ? true : undefined), 'the read instance to mount')

  // The level is not usable yet: the refusal comes before any disconnect or state write.
  await assert.rejects(rt.connectorEndpoint('connector-set-level', { id: 'demo', level: 'write' }), /project id and a SQL role/)
  const unchanged = rowOf(rt, 'demo')
  assert.deepEqual([unchanged.level, unchanged.state], ['read', 'ready'])
  assert.deepEqual(rt.state.connectors.demo.settings, {})
  assert.equal(credentials.records.has('ds-bot/connector-demo'), true)
  // The view names every level that is not usable so the client can disable it first.
  assert.match(unchanged.levelNotes.write, /project id and a SQL role/)
  assert.equal(unchanged.levelNotes.read, undefined)

  // The authorization for the same unready level is refused too.
  await rt.connectorEndpoint('connector-create-instance', { base: 'demo' })
  await assert.rejects(
    rt.connectorEndpoint('connector-oauth-start', { id: 'demo-2', level: 'write' }, { origin: 'https://dsh.test' }),
    /project id and a SQL role/,
  )
  assert.equal(credentials.records.has('ds-bot/connector-demo-2'), false)
})

test('renaming an instance keeps its grant while a grant setting change drops it', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = demoBench()
  globalThis.fetch = bench.fetch
  const state = { connectors: { demo: { level: 'read', settings: { projectId: 'proj-a' }, authorizedAt: 1 } } }
  // A real OAuth connector brings an `authorize` hook; it is what makes a settings change
  // count against the stored grant.
  const definition = demoDefinition({ authorize: () => ({ url: 'https://mcp.demo.test/mcp', scopes: ['read'] }) })
  const { ctx, rt, home, credentials } = hostSetup({ state, definition, grants: { demo: demoGrant('access-a') } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => (rowOf(rt, 'demo')?.state === 'ready' ? true : undefined), 'the instance to mount')

  // A rename is display-only: the authorization and the mount stay.
  const renamed = await rt.connectorEndpoint('connector-set-settings', { id: 'demo', values: { label: 'Prod', projectId: 'proj-a' } })
  const renamedRow = renamed.find(row => row.id === 'demo')
  assert.deepEqual([renamedRow.name, renamedRow.needsReauth], ['Prod', undefined])
  assert.equal(credentials.records.has('ds-bot/connector-demo'), true)
  assert.equal(rt.state.connectors.demo.needsReauth, undefined)
  await until(async () => (rowOf(rt, 'demo')?.state === 'ready' ? true : undefined), 'the renamed instance to be ready again')

  // The project id feeds the grant: changing it asks for a new authorization and clears
  // only this instance's grant.
  const changed = await rt.connectorEndpoint('connector-set-settings', { id: 'demo', values: { label: 'Prod', projectId: 'proj-b' } })
  const changedRow = changed.find(row => row.id === 'demo')
  assert.deepEqual([changedRow.name, changedRow.needsReauth], ['Prod', true])
  assert.equal(credentials.records.has('ds-bot/connector-demo'), false)
  assert.deepEqual(rt.state.connectors.demo.settings, { label: 'Prod', projectId: 'proj-b' })
})

// A REST connector's write tool goes through the same approval card as a module that mounts
// its own tools: the framework must name the connector by its id instead of handing the
// definition itself to the approval path, and the request waits for Allow.
test('a REST write asks on the approval card and sends nothing before the answer', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method, body: init.body })
    return { ok: true, status: 200, text: async () => JSON.stringify({ note_id: 'n-1' }) }
  }
  const definition = {
    displayName: 'Demo REST',
    mode: 'rest-tools',
    api: 'https://rest.demo.test',
    tokenSecret: 'DEMO_REST_TOKEN',
    levels: ['read', 'write'],
    defaultLevel: 'read',
    restTools: [
      { name: 'list_notes', method: 'GET', path: '/notes', parameters: { type: 'object', properties: {} } },
      {
        name: 'create_note',
        method: 'POST',
        write: true,
        path: '/notes',
        body: { content: 'content' },
        approval: async () => ({ line: 'Create a note' }),
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      },
    ],
  }
  const state = { connectors: { demo: { level: 'write', connectedAt: 1 } } }
  const { ctx, rt, home } = hostSetup({ state, definition, secrets: { DEMO_REST_TOKEN: 'tok-rest' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const write = await until(() => ctx.registeredTools.get('demo_create_note'), 'the REST write tool')
  assert.deepEqual(write.parameters.required, ['content'])
  assert.deepEqual(requests, [])

  // The call waits on the plugin's own card instead of failing on its way there.
  const pending = write.execute({ content: '# Weekly' }, { agent: { id: 'm1' } })
  const card = await until(() => rt.state.questions?.m1, 'the approval card')
  assert.equal(card.kind, 'connector-approval')
  assert.match(card.question, /Allow Chief to run Demo REST's demo_create_note\?/)
  assert.equal(card.detail, 'Create a note')
  assert.deepEqual(requests, [])

  await rt.answerConnectorApproval('m1', card.id, { selected: ['Allow once'] })
  assert.equal(await pending, '{"note_id":"n-1"}')
  assert.deepEqual(requests, [{ url: 'https://rest.demo.test/notes', method: 'POST', body: '{"content":"# Weekly"}' }])
})

// A custom multi-instance connector keeps one credential per instance: the first uses the
// declared name, later ones append their number, and a removal clears only its own.
function demoCredentialDefinition(overrides = {}) {
  return {
    displayName: 'Channel',
    mode: 'custom',
    tokenSecret: 'CHANNEL_TOKEN',
    levels: ['read'],
    defaultLevel: 'read',
    instances: { prefix: 'demo', min: 1, max: 4 },
    mount: ({ secretName, secrets, token, instance }) => ({
      tools: [{
        name: `${instance.id}_probe`,
        description: 'Probe',
        parameters: { type: 'object', properties: {} },
        execute: async () => JSON.stringify({ id: instance.id, token, name: secretName('CHANNEL_TOKEN'), mapped: secrets.CHANNEL_TOKEN }),
      }],
    }),
    ...overrides,
  }
}

const secretDesk = (store, calls) => async (endpoint, body) => {
  calls.push({ endpoint, ...body })
  if (endpoint === 'secret-set') store[body.name] = body.value
  if (endpoint === 'secret-delete') delete store[body.name]
}

test('a custom instance keeps its own declared credential', async (t) => {
  const store = { CHANNEL_TOKEN: 'token-one', CHANNEL_TOKEN_2: 'token-two' }
  const calls = []
  const state = { connectors: { demo: { level: 'read', settings: {} }, 'demo-2': { level: 'read', settings: {} } } }
  const { ctx, rt, home } = hostSetup({ state, definition: demoCredentialDefinition(), secrets: store })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  rt.secretEndpoint = secretDesk(store, calls)

  const one = await until(() => ctx.registeredTools.get('demo_probe'), 'the first instance tool')
  const two = await until(() => ctx.registeredTools.get('demo-2_probe'), 'the second instance tool')
  assert.deepEqual(JSON.parse(await one.execute({})), { id: 'demo', token: 'token-one', name: 'CHANNEL_TOKEN', mapped: 'token-one' })
  assert.deepEqual(JSON.parse(await two.execute({})), { id: 'demo-2', token: 'token-two', name: 'CHANNEL_TOKEN_2', mapped: 'token-two' })
  // The card names the declared credential; the stored name and its value never reach it.
  const row = rt.connectorsView().find(item => item.id === 'demo-2')
  assert.deepEqual(row.inputs.map(input => input.name), ['CHANNEL_TOKEN'])
  assert.ok(!JSON.stringify(rt.connectorsView()).includes('token-two'))

  // Removing the second instance clears only its own secret.
  await rt.connectorEndpoint('connector-delete-instance', { id: 'demo-2' })
  assert.deepEqual(calls.map(call => `${call.endpoint}:${call.name}`), ['secret-delete:CHANNEL_TOKEN_2'])
  assert.equal(store.CHANNEL_TOKEN, 'token-one')
  assert.equal(store.CHANNEL_TOKEN_2, undefined)
})

test('connecting a custom instance stores its credential under its own name', async (t) => {
  const store = {}
  const calls = []
  const state = { connectors: { demo: { level: 'read', settings: {} }, 'demo-2': { level: 'read', settings: {} } } }
  const { ctx, rt, home } = hostSetup({ state, definition: demoCredentialDefinition(), secrets: store })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  rt.secretEndpoint = secretDesk(store, calls)

  await rt.connectorEndpoint('connector-connect', { id: 'demo-2', token: 'typed-token' })
  assert.deepEqual(calls.map(call => `${call.endpoint}:${call.name}`), ['secret-set:CHANNEL_TOKEN_2'])
  assert.equal(store.CHANNEL_TOKEN_2, 'typed-token')
  assert.equal(store.CHANNEL_TOKEN, undefined)
  const two = await until(() => ctx.registeredTools.get('demo-2_probe'), 'the connected tool')
  assert.equal(JSON.parse(await two.execute({})).token, 'typed-token')
  // The first instance never sees the second one's credential.
  assert.equal(ctx.registeredTools.get('demo_probe'), undefined)
})

// A channel connector's only credential is optional: deleting it leaves the connector
// "configured", so only the Disconnect mark keeps it off (F8).
function channelDefinition(overrides = {}) {
  return {
    displayName: 'Channel',
    mode: 'custom',
    tokenSecret: 'CHANNEL_TOKEN',
    credentials: [{ name: 'CHANNEL_TOKEN', required: false }],
    levels: ['read'],
    defaultLevel: 'read',
    settings: [
      { name: 'label', label: 'Name' },
      { name: 'transport', kind: 'segmented', options: [{ value: 'webhook' }, { value: 'clawbot' }] },
    ],
    mount: ({ instance }) => ({
      tools: [{
        name: `${instance.id}_probe`,
        description: 'Probe',
        parameters: { type: 'object', properties: {} },
        execute: async () => JSON.stringify({ id: instance.id }),
      }],
    }),
    ...overrides,
  }
}

test('a disconnected channel stays off after a restart', async (t) => {
  const store = { CHANNEL_TOKEN: 'first-token' }
  const state = { connectors: { demo: { level: 'read', settings: { transport: 'webhook', label: 'Desk' } } } }
  const first = hostSetup({ state, definition: channelDefinition(), secrets: store })
  t.after(() => rmSync(first.home, { recursive: true, force: true, maxRetries: 5 }))
  first.rt.secretEndpoint = secretDesk(store, [])
  await until(() => (rowOf(first.rt, 'demo')?.state === 'ready' ? true : undefined), 'the channel to mount')

  // Disconnect leaves the mark in the team file, not only in memory.
  await first.rt.connectorEndpoint('connector-disconnect', { id: 'demo' })
  assert.equal(first.rt.state.connectors.demo.off, true)
  assert.equal(store.CHANNEL_TOKEN, undefined)
  assert.equal(rowOf(first.rt, 'demo').state, 'off')
  await first.ctx.dispose()

  // A second host over the same team file is a restart: the mark still keeps it off.
  const second = hostSetup({ state: first.rt.state, home: first.home, credentials: first.credentials, definition: channelDefinition(), secrets: store })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(rowOf(second.rt, 'demo').state, 'off')
  assert.equal(second.registered.includes('demo_probe'), false)

  // Only a new connect clears the mark and mounts the channel again.
  await second.rt.connectorEndpoint('connector-connect', { id: 'demo', token: 'second-token' })
  await until(() => (rowOf(second.rt, 'demo')?.state === 'ready' ? true : undefined), 'the reconnected channel')
  assert.equal(second.rt.state.connectors.demo.off, undefined)
  await second.ctx.dispose()
})

test('a team file without the off mark connects the channel as before', async (t) => {
  const store = { CHANNEL_TOKEN: 'saved-token' }
  const state = { connectors: { demo: { level: 'read', settings: { transport: 'webhook' } } } }
  const { ctx, rt, home, registered } = hostSetup({ state, definition: channelDefinition(), secrets: store })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  // A team file saved before F8 has no mark; the saved credential still mounts the channel.
  assert.equal(state.connectors.demo.off, undefined)
  await until(() => (rowOf(rt, 'demo')?.state === 'ready' ? true : undefined), 'the channel to mount')
  assert.ok(registered.includes('demo_probe'))
})

test('a disconnected channel keeps its row, its settings and its Connect action', async (t) => {
  const store = { CHANNEL_TOKEN: 'first-token' }
  const state = { connectors: { demo: { level: 'read', settings: { transport: 'webhook', label: 'Desk' } } } }
  const { ctx, rt, home } = hostSetup({ state, definition: channelDefinition(), secrets: store })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  rt.secretEndpoint = secretDesk(store, [])
  await until(() => (rowOf(rt, 'demo')?.state === 'ready' ? true : undefined), 'the channel to mount')
  await rt.connectorEndpoint('connector-disconnect', { id: 'demo' })

  // The instance does not disappear with the mark: the card still draws it, off, with its
  // settings and a Connect to press.
  const row = rowOf(rt, 'demo')
  assert.ok(row, 'the disconnected channel keeps its row')
  assert.deepEqual([row.state, row.level], ['off', 'read'])
  assert.deepEqual(row.settings.map(field => [field.name, field.value]), [['label', 'Desk'], ['transport', 'webhook']])
  // A retry waits as off, and the transport can change while it is off.
  await rt.connectorEndpoint('connector-retry', { id: 'demo' })
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(rowOf(rt, 'demo').state, 'off')
  await rt.connectorEndpoint('connector-set-settings', { id: 'demo', values: { transport: 'clawbot' } })
  assert.deepEqual([rowOf(rt, 'demo').state, rt.state.connectors.demo.settings.transport], ['off', 'clawbot'])
  // Connect still works and clears the mark.
  await rt.connectorEndpoint('connector-connect', { id: 'demo', token: 'second-token' })
  await until(() => (rowOf(rt, 'demo')?.state === 'ready' ? true : undefined), 'the reconnected channel')
  assert.equal(rt.state.connectors.demo.off, undefined)
})

// A module's command endpoint runs only the actions it declared, with only the arguments it
// declared, and only on the transport the action names.
function commandDefinition() {
  return {
    displayName: 'Channel',
    mode: 'custom',
    tokenSecret: 'CHANNEL_TOKEN',
    levels: ['read'],
    defaultLevel: 'read',
    settings: [{ name: 'transport', kind: 'segmented', options: [{ value: 'webhook' }, { value: 'clawbot' }] }],
    commands: {
      'login-start': { transport: 'clawbot' },
      'login-info': { transport: 'clawbot', args: ['refresh'] },
    },
    command: async (context) => { context.calls?.push({ action: context.action, args: context.args }) },
    mount: () => ({ tools: [] }),
  }
}

test('a module command runs only the action it declares', async (t) => {
  const calls = []
  const definition = commandDefinition()
  const command = definition.command
  definition.command = async (context) => { await command({ ...context, calls }) }
  const state = { connectors: { demo: { level: 'read', settings: { transport: 'clawbot' } } } }
  const { ctx, rt, home } = hostSetup({ state, definition, secrets: { CHANNEL_TOKEN: 'tok' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const rows = await rt.connectorEndpoint('connector-command', { id: 'demo', action: 'login-start' })
  assert.deepEqual(rows.map(row => row.id), ['demo'])
  assert.deepEqual(calls, [{ action: 'login-start', args: {} }])

  // A declared argument travels; an undeclared one is refused before the hook runs.
  await rt.connectorEndpoint('connector-command', { id: 'demo', action: 'login-info', args: { refresh: true } })
  assert.deepEqual(calls.at(-1), { action: 'login-info', args: { refresh: true } })
  await assert.rejects(rt.connectorEndpoint('connector-command', { id: 'demo', action: 'login-info', args: { refresh: 'yes', extra: 1 } }), /Unknown argument "extra"/)
  await assert.rejects(rt.connectorEndpoint('connector-command', { id: 'demo', action: 'login-start', args: { nested: { a: 1 } } }), /Unknown argument "nested"/)
  await assert.rejects(rt.connectorEndpoint('connector-command', { id: 'demo', action: 'delete-everything' }), error => error.code === 'bot/unknown-action')
  assert.equal(calls.length, 2)

  // The same action on another transport is refused, not passed through.
  await rt.connectorEndpoint('connector-set-settings', { id: 'demo', values: { transport: 'webhook' } })
  await assert.rejects(rt.connectorEndpoint('connector-command', { id: 'demo', action: 'login-start' }), error => error.code === 'bot/unsupported-transport')
  assert.equal(calls.length, 2)
})

// A declared secret field lives in the credential store: the view says only whether it is
// saved, an empty value keeps it, and only clearSecrets removes it.
test('a declared secret field is stored as a credential', async (t) => {
  const store = {}
  const calls = []
  const definition = {
    displayName: 'Channel',
    mode: 'custom',
    tokenSecret: 'CHANNEL_TOKEN',
    credentials: [{ name: 'CHANNEL_TOKEN', required: false }],
    levels: ['read'],
    defaultLevel: 'read',
    settings: [
      { name: 'label', label: 'Name' },
      { name: 'webhookSecret', kind: 'secret', secret: 'CHANNEL_SECRET', label: 'Secret' },
      { name: 'transport', kind: 'segmented', options: [{ value: 'webhook' }, { value: 'clawbot' }] },
    ],
    mount: () => ({ tools: [] }),
  }
  const state = { connectors: { demo: { level: 'read', settings: { transport: 'webhook' } } } }
  const { ctx, rt, home } = hostSetup({ state, definition, secrets: store })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  rt.secretEndpoint = secretDesk(store, calls)

  // The object-shaped field list is what the client reads; a secret carries no value.
  const secretField = () => rowOf(rt, 'demo').fields.find(field => field.name === 'webhookSecret')
  const transportField = () => rowOf(rt, 'demo').fields.find(field => field.name === 'transport')
  assert.deepEqual([secretField().kind, secretField().saved], ['secret', false])
  assert.equal('value' in secretField(), false)
  assert.deepEqual([transportField().kind, transportField().value], ['segmented', 'webhook'])

  // An omitted or empty secret keeps what is stored.
  await rt.connectorEndpoint('connector-set-settings', { id: 'demo', values: { webhookSecret: '' } })
  assert.deepEqual(calls.filter(call => call.endpoint === 'secret-set'), [])
  await rt.connectorEndpoint('connector-set-settings', { id: 'demo', values: { webhookSecret: 'secret-1' } })
  assert.deepEqual(calls.map(call => [call.endpoint, call.name, call.value]).filter(call => call[0] === 'secret-set'), [['secret-set', 'CHANNEL_SECRET', 'secret-1']])
  assert.equal(secretField().saved, true)
  assert.ok(!JSON.stringify(rt.connectorsView()).includes('secret-1'))

  // Only clearSecrets removes a stored secret, and an unknown field is refused.
  await rt.connectorEndpoint('connector-set-settings', { id: 'demo', clearSecrets: ['webhookSecret'] })
  assert.deepEqual(calls.at(-1), { endpoint: 'secret-delete', name: 'CHANNEL_SECRET' })
  assert.equal(secretField().saved, false)
  await assert.rejects(rt.connectorEndpoint('connector-set-settings', { id: 'demo', clearSecrets: ['token'] }), /Unknown secret field "token"/)
})

// A module's test runs its own path: a failure shows on the card, which stays connected.
test('a module test failure shows on the ready card', async (t) => {
  let failure
  const definition = {
    displayName: 'Channel',
    mode: 'custom',
    tokenSecret: 'CHANNEL_TOKEN',
    levels: ['read'],
    defaultLevel: 'read',
    mount: () => ({ tools: [] }),
    test: async () => { if (failure !== undefined) throw new Error(failure) },
  }
  const state = { connectors: { demo: { level: 'read', settings: {} } } }
  const { ctx, rt, home } = hostSetup({ state, definition, secrets: { CHANNEL_TOKEN: 'tok' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(() => (rowOf(rt, 'demo')?.state === 'ready' ? true : undefined), 'the channel to mount')

  failure = 'the webhook answered 404'
  await rt.connectorEndpoint('connector-test', { id: 'demo' })
  assert.equal(rowOf(rt, 'demo').state, 'ready')
  assert.match(rowOf(rt, 'demo').error, /webhook answered 404/)

  failure = undefined
  await rt.connectorEndpoint('connector-test', { id: 'demo' })
  assert.equal(rowOf(rt, 'demo').state, 'ready')
  assert.equal(rowOf(rt, 'demo').error, undefined)
})

// A module's view adds card data (inbound address, login step), and the row names the
// module's instance cap so the client knows when Add is exhausted.
test('a module view adds row data and the instance cap', async (t) => {
  const definition = {
    displayName: 'Channel',
    mode: 'custom',
    tokenSecret: 'CHANNEL_TOKEN',
    levels: ['read', 'write'],
    defaultLevel: 'read',
    instances: { prefix: 'demo', min: 1, max: 4 },
    settings: [{ name: 'transport', kind: 'segmented', options: [{ value: 'webhook' }, { value: 'clawbot' }] }],
    mount: () => ({ tools: [] }),
    view: ({ settings, instance }) => ({
      levels: [{ id: 'read', title: 'Read', description: 'Receive messages' }],
      canTest: true,
      inbound: settings.transport === 'webhook' ? { url: `http://127.0.0.1:8799/wechat/${instance.id}/inbound`, token: 'inbound-1' } : undefined,
      login: { state: settings.transport === 'clawbot' ? 'logged-in' : 'logged-out' },
      status: { lastInboundAt: 5 },
    }),
  }
  const state = { connectors: { demo: { level: 'read', settings: { transport: 'webhook' } }, 'demo-2': { level: 'read', settings: { transport: 'clawbot' } } } }
  const { ctx, rt, home } = hostSetup({ state, definition, secrets: { CHANNEL_TOKEN: 'tok', CHANNEL_TOKEN_2: 'tok-2' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(() => (rowOf(rt, 'demo')?.state === 'ready' && rowOf(rt, 'demo-2')?.state === 'ready' ? true : undefined), 'both instances to mount')

  const first = rowOf(rt, 'demo')
  assert.equal(first.instance.max, 4)
  assert.deepEqual(first.levels, [{ id: 'read', title: 'Read', description: 'Receive messages' }])
  assert.deepEqual(first.inbound, { url: 'http://127.0.0.1:8799/wechat/demo/inbound', token: 'inbound-1' })
  assert.deepEqual(first.login, { state: 'logged-out' })
  assert.equal(first.canTest, true)
  assert.deepEqual(first.status, { lastInboundAt: 5 })
  assert.deepEqual(rowOf(rt, 'demo-2').login, { state: 'logged-in' })
  assert.equal(rowOf(rt, 'demo-2').inbound, undefined)
})

// A view that throws hides its data instead of the card.
test('a failing view hides only its own data', async (t) => {
  const definition = {
    displayName: 'Channel',
    mode: 'custom',
    tokenSecret: 'CHANNEL_TOKEN',
    levels: ['read'],
    defaultLevel: 'read',
    mount: () => ({ tools: [] }),
    view: () => { throw new Error('view broke') },
  }
  const state = { connectors: { demo: { level: 'read', settings: {} } } }
  const { ctx, rt, home } = hostSetup({ state, definition, secrets: { CHANNEL_TOKEN: 'tok' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(() => (rowOf(rt, 'demo')?.state === 'ready' ? true : undefined), 'the channel to mount')
  const row = rowOf(rt, 'demo')
  assert.equal(row.id, 'demo')
  assert.equal(row.inbound, undefined)
  assert.equal(row.login, undefined)
})

// A module's readiness hook sees the running host: it can tell a missing Bot from a missing
// project id before the user presses Connect, not only after a failed mount.
test('readiness receives the read-only runtime and the instance', async (t) => {
  const seen = []
  const definition = demoDefinition({ readiness: (context) => { seen.push(context); return undefined } })
  const { ctx, rt, home } = hostSetup({ state: { connectors: { demo: { level: 'read', settings: {} } } }, definition })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  rt.connectorsView()
  // The view asks each declared level, so the read-level question is among them.
  const context = seen.find(entry => entry.level === 'read')
  assert.equal(context.rt, rt)
  assert.equal(typeof context.rt.botOf, 'function')
  assert.deepEqual(context.instance, { base: 'demo', id: 'demo' })
})

// A module that opens a listener can fail asynchronously; that failure must land on the
// connector's own row instead of escaping the host, and other connectors still mount.
test('an async mount failure becomes the connector row error', async (t) => {
  const broken = {
    displayName: 'Broken channel',
    mode: 'custom',
    tokenSecret: 'BROKEN_TOKEN',
    levels: ['read'],
    defaultLevel: 'read',
    mount: async () => { throw Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8799'), { code: 'EADDRINUSE' }) },
  }
  const healthy = {
    displayName: 'Healthy channel',
    mode: 'custom',
    tokenSecret: 'HEALTHY_TOKEN',
    levels: ['read'],
    defaultLevel: 'read',
    mount: () => ({ tools: [{ name: 'healthy_ping', description: 'Ping', parameters: { type: 'object', properties: {} }, execute: async () => 'pong' }] }),
  }
  const state = { connectors: { demo: { level: 'read', settings: {} }, healthy: { level: 'read', settings: {} } } }
  const { ctx, rt, home } = hostSetup({ state, definition: broken, extraDefinitions: { healthy }, secrets: { BROKEN_TOKEN: 'b', HEALTHY_TOKEN: 'h' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await until(() => (rowOf(rt, 'demo')?.state === 'error' ? true : undefined), 'the bind failure row')
  const row = rowOf(rt, 'demo')
  assert.match(row.error, /EADDRINUSE/)
  assert.match(row.error, /8799/)
  assert.equal(rowOf(rt, 'healthy').state, 'ready')
  assert.equal(await ctx.registeredTools.get('healthy_ping').execute({}), 'pong')
})

// F10: the async mount path must not change how the shipped connectors settle, how a
// failure is reported, how the queue serialises mounts, or how a removal while a mount is
// running ends.
test('the shipped connectors still settle after the async mount path', async (t) => {
  const { ctx } = setup()
  t.after(async () => { await ctx.dispose() })
  await new Promise(resolve => setTimeout(resolve, 150))
  const rows = (await call(ctx, 'state')).value.connectors
  assert.equal(rows.length, 10)
  assert.deepEqual(rows.filter(row => row.state === 'error'), [])
  assert.deepEqual(rows.filter(row => row.state === 'ready'), [])
})

test('an async mount failure is reported, never unhandled', async (t) => {
  const rejections = []
  const listener = reason => rejections.push(reason)
  process.on('unhandledRejection', listener)
  t.after(() => process.off('unhandledRejection', listener))
  const broken = {
    displayName: 'Broken channel',
    mode: 'custom',
    tokenSecret: 'BROKEN_TOKEN',
    levels: ['read'],
    defaultLevel: 'read',
    mount: async () => { throw Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8799'), { code: 'EADDRINUSE' }) },
  }
  const { ctx, rt, home } = hostSetup({ state: { connectors: { demo: { level: 'read', settings: {} } } }, definition: broken, secrets: { BROKEN_TOKEN: 'b' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(() => (rowOf(rt, 'demo')?.state === 'error' ? true : undefined), 'the bind failure row')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(rejections.length, 0)
})

test('async mounts still run one at a time through the queue', async (t) => {
  const steps = []
  const slow = {
    displayName: 'Slow channel',
    mode: 'custom',
    tokenSecret: 'SLOW_TOKEN',
    levels: ['read'],
    defaultLevel: 'read',
    mount: async () => {
      steps.push('start')
      await new Promise(resolve => setTimeout(resolve, 25))
      steps.push('end')
      return { tools: [] }
    },
  }
  const { ctx, rt, home } = hostSetup({ state: { connectors: { demo: { level: 'read', settings: {} } } }, definition: slow, secrets: { SLOW_TOKEN: 's' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(() => (rowOf(rt, 'demo')?.state === 'ready' ? true : undefined), 'the slow mount')
  steps.length = 0
  await Promise.all([
    rt.connectorEndpoint('connector-retry', { id: 'demo' }),
    rt.connectorEndpoint('connector-retry', { id: 'demo' }),
  ])
  assert.deepEqual(steps, ['start', 'end', 'start', 'end'])
})

test('a removed instance whose mount was running leaves nothing behind', async (t) => {
  const slow = {
    displayName: 'Slow channel',
    mode: 'custom',
    tokenSecret: 'SLOW_TOKEN',
    levels: ['read'],
    defaultLevel: 'read',
    instances: { prefix: 'demo', min: 1, max: 4 },
    mount: async () => {
      await new Promise(resolve => setTimeout(resolve, 40))
      return { tools: [{ name: 'demo_ping', description: 'Ping', parameters: { type: 'object', properties: {} }, execute: async () => 'pong' }] }
    },
  }
  const state = { connectors: { demo: { level: 'read', settings: {} }, 'demo-2': { level: 'read', settings: {} } } }
  const { ctx, rt, home, disposed } = hostSetup({ state, definition: slow, secrets: { SLOW_TOKEN: 's', SLOW_TOKEN_2: 's2' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(() => (rowOf(rt, 'demo-2')?.state === 'ready' ? true : undefined), 'the slow instance')
  const retry = rt.connectorEndpoint('connector-retry', { id: 'demo-2' })
  const removed = rt.connectorEndpoint('connector-delete-instance', { id: 'demo-2' })
  await Promise.all([retry, removed])
  assert.equal(rowOf(rt, 'demo-2'), undefined)
  // A tool the queued mount registered is disposed by the removal that follows it.
  assert.ok(disposed.includes('demo_ping'))
})

// readiness must name per-instance credentials the same way a mount does: a module that
// checks a stored secret before Connect cannot keep a second naming rule of its own.
test('readiness gets the same secret naming and values as a mount', async (t) => {
  const seen = []
  const definition = {
    displayName: 'Secret channel',
    mode: 'custom',
    levels: ['read'],
    defaultLevel: 'read',
    instances: { prefix: 'demo', min: 1, max: 2 },
    mount: () => ({ tools: [] }),
    readiness: (context) => { seen.push(context); return undefined },
  }
  const state = { connectors: { demo: { level: 'read', settings: {} }, 'demo-2': { level: 'read', settings: {} } } }
  const { ctx, rt, home } = hostSetup({ state, definition, secrets: { DEMO_SECRET: 'base-value', DEMO_SECRET_2: 'second-value' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  rt.connectorsView()
  const base = seen.find(context => context.instance?.id === 'demo' && context.level === 'read')
  const second = seen.find(context => context.instance?.id === 'demo-2' && context.level === 'read')
  assert.equal(base.secretName('DEMO_SECRET'), 'DEMO_SECRET')
  assert.equal(second.secretName('DEMO_SECRET'), 'DEMO_SECRET_2')
  assert.equal(base.secretValue('DEMO_SECRET'), 'base-value')
  assert.equal(second.secretValue('DEMO_SECRET'), 'second-value')
})

// readiness is asked before the first mount, so the credential store must be read first:
// an unloaded store must never be read as "this credential is missing".
test('readiness runs only after the credential store is loaded', async (t) => {
  const order = []
  const definition = demoDefinition({ readiness: () => { order.push('readiness') } })
  const { ctx, rt, home } = hostSetup({
    state: { connectors: { demo: { level: 'read', settings: {} } } },
    definition,
    loadSecrets: async () => { order.push('load') },
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(() => { rt.connectorsView(); return order.includes('readiness') ? true : undefined }, 'the first readiness')
  assert.equal(order[0], 'load')
  assert.equal(order.filter(step => step === 'load').length >= 1, true)
})

// Adding fields to the readiness context must not change what another connector gets back.
test('another connector still gets its readiness result unchanged', async (t) => {
  const definition = demoDefinition({
    readiness: ({ level }) => (level === 'write' ? 'A project id and a SQL role are required for write access' : undefined),
  })
  const { ctx, rt, home } = hostSetup({ state: { connectors: { demo: { level: 'read', settings: {} } } }, definition })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const row = rowOf(rt, 'demo')
  assert.deepEqual(row.levelNotes, { write: 'A project id and a SQL role are required for write access' })
  assert.equal(row.levelNote, undefined)
})
