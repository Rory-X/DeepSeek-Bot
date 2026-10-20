import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { signIn } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'
import { fakeCredentials, fakeOAuthServer, fakeResponse, fakeWebServer } from './oauth-fakes.js'

const fresh = () => `tok_${randomBytes(16).toString('hex')}`
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
const off = id => ({ id, state: 'off', account: null })
const OFF = {
  github: { id: 'github', name: 'GitHub', ...off('github'), level: 'read', levels: ['read'], card: { glyph: 'github', about: "Issues, pull requests and repository context through GitHub's own MCP server.", docsUrl: 'https://docs.github.com', readOnlyNote: 'Only the issue, pull-request and repository tools are mounted.' } },
  vercel: { id: 'vercel', name: 'Vercel', ...off('vercel'), level: 'read', levels: ['read', 'write'], actions: false, toolbox: false, toolboxCall: 'vercel_call', card: { glyph: 'vercel', about: 'Projects, deployments and runtime logs from a connected Vercel account.', docsUrl: 'https://vercel.com/docs/mcp', readOnlyNote: 'Read tools run directly; the four deployment actions are off by default and each asks for approval.' } },
  cloudflare: { id: 'cloudflare', name: 'Cloudflare', ...off('cloudflare'), level: 'read', levels: ['read', 'write'], oauth: true, toolbox: false, toolboxCall: 'cloudflare_call', card: { glyph: 'cloudflare', about: "Zones, DNS records, analytics and Workers through Cloudflare's own MCP server.", docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/', readOnlyNote: 'The named tools only read. Full access can change your account; every write still asks for your approval first.', consent: { title: 'Choose the access level on the authorization page', body: 'Requested scopes is read-only, and it is all this connector asks for. Full access lets Bots change your Cloudflare account; every write still asks for your approval first.', acknowledge: "I'll choose the access level on the authorization page" } } },
}
// The built-ins these tests are about. A connector module added under src/host/connectors
// hands the view one more row, and every line adds one; these assertions are about the
// built-ins, so they ignore module rows instead of failing on every connector branch.
const BUILTINS = new Set(['github', 'vercel', 'cloudflare'])
const builtins = view => view.filter(item => BUILTINS.has(item.id))
const statuses = view => builtins(view).map(item => [item.id, item.state, item.account])

test('signIn asks GitHub who owns the token', async () => {
  const token = fresh()
  let seen
  const user = await signIn('github', token, { api: 'https://gh.test/', fetch: async (url, init) => { seen = { url, init }; return answer(200, { login: 'octo' }) } })
  assert.deepEqual(user, { login: 'octo' })
  assert.equal(seen.url, 'https://gh.test/user')
  assert.equal(seen.init.headers.Authorization, `Bearer ${token}`)
  assert.equal(seen.init.headers['X-GitHub-Api-Version'], '2022-11-28')
  await assert.rejects(signIn('github', token, { fetch: async () => answer(401, {}) }), /did not accept/)
  await assert.rejects(signIn('github', token, { fetch: async () => answer(500, {}) }), /GitHub answered 500/)
  await assert.rejects(signIn('github', token, { fetch: async () => { throw new Error(`boom ${token}`) } }), /^Error: Could not reach GitHub$/)
  await assert.rejects(signIn('github', token, { fetch: async () => answer(200, {}) }), /did not say who this token belongs to/)
})

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
function setup({ fail = false, github = { api: 'https://gh.test' }, vercel = { api: 'https://vercel.test', url: 'https://mcp.vercel.test' }, cloudflare, secrets = [], state = TEAM, services = {}, config = {} } = {}) {
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
  const plugin = { name: 'mcp-client', apply() {} }
  const loader = {
    import: async name => { assert.equal(name, '@deepseek-ai/dsh-mcp-client'); return { default: plugin } },
    unwrapExports: exports => exports.default,
  }
  const ctx = fakeContext({ services: { loader, ...services } })
  ctx.plugin = (given, config) => {
    assert.equal(given, plugin)
    const mount = { config, disposed: false }
    mounts.push(mount)
    return {
      await: async () => { if (fail) throw new Error(`refused ${config.headers.Authorization}`) },
      dispose: () => { mount.disposed = true },
    }
  }
  const register = ctx.tools.register
  ctx.tools.register = tool => {
    registered.push(tool.name)
    const undo = register(tool)
    return () => { disposed.push(tool.name); undo() }
  }
  capture(ctx)
  apply(ctx, { home, github, vercel, ...(cloudflare === undefined ? {} : { cloudflare }), ...config })
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

const githubMount = token => ({
  transport: 'streamable-http',
  serverName: 'github',
  url: 'https://api.githubcopilot.com/mcp/',
  headers: { Authorization: `Bearer ${token}`, 'X-MCP-Toolsets': 'context,repos,issues,pull_requests' },
  failOnStartupError: true,
})

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

test('connecting GitHub saves the token, kept out of every Bot shell, and mounts its MCP; disconnecting undoes both', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const token = fresh()

  const before = await call(ctx, 'state', {})
  assert.deepEqual(builtins(before.value.connectors), [OFF.github, OFF.vercel, OFF.cloudflare])

  const connected = await call(ctx, 'connector-connect', { id: 'github', token: ` ${token} ` })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  assert.deepEqual(builtins(connected.value), [{ id: 'github', name: 'GitHub', state: 'ready', account: 'octo', level: 'read', levels: ['read'], card: { glyph: 'github', about: "Issues, pull requests and repository context through GitHub's own MCP server.", docsUrl: 'https://docs.github.com', readOnlyNote: 'Only the issue, pull-request and repository tools are mounted.' } }, OFF.vercel, OFF.cloudflare])
  assert.equal(mounts.length, 1)
  assert.deepEqual(mounts[0].config, githubMount(token))
  const state = await call(ctx, 'state', {})
  assert.deepEqual(state.value.secrets.map(secret => [secret.name, secret.scope]), [['GITHUB_TOKEN', []]])
  assert.ok(!JSON.stringify(state).includes(token))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(token))

  const disconnected = await call(ctx, 'connector-disconnect', { id: 'github' })
  assert.deepEqual(builtins(disconnected.value), [OFF.github, OFF.vercel, OFF.cloudflare])
  assert.equal(mounts[0].disposed, true)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a token GitHub refuses is not saved', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(401, {})
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const result = await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /did not accept/)
  assert.equal(mounts.length, 0)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a failed MCP connection shows the error without the token, and Try again mounts again', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup({ fail: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const token = fresh()
  const result = await call(ctx, 'connector-connect', { id: 'github', token })
  const [github] = result.value
  assert.equal(github.state, 'error')
  assert.ok(!github.error.includes(token), github.error)
  assert.match(github.error, /\[secret:GITHUB_TOKEN\]/)
  await call(ctx, 'connector-retry', { id: 'github' })
  assert.equal(mounts.length, 2)
})

test('deleting GITHUB_TOKEN on the Secrets page unmounts GitHub', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  await call(ctx, 'secret-delete', { name: 'GITHUB_TOKEN' })
  const state = await call(ctx, 'state', {})
  assert.equal(mounts[0].disposed, true)
  assert.deepEqual(statuses(state.value.connectors), [['github', 'off', null], ['vercel', 'off', null], ['cloudflare', 'off', null]])
})

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
  assert.deepEqual(builtins(connected.value), [OFF.github, { id: 'vercel', name: 'Vercel', state: 'ready', account: 'acme', level: 'read', levels: ['read', 'write'], actions: false, toolbox: false, toolboxCall: 'vercel_call', card: { glyph: 'vercel', about: 'Projects, deployments and runtime logs from a connected Vercel account.', docsUrl: 'https://vercel.com/docs/mcp', readOnlyNote: 'Read tools run directly; the four deployment actions are off by default and each asks for approval.' } }, OFF.cloudflare])
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
    return view[1]?.state === 'ready' ? view : undefined
  }, 'Vercel to connect from its saved token')
  assert.deepEqual(connectors[1], { id: 'vercel', name: 'Vercel', state: 'ready', account: 'acme', level: 'read', levels: ['read', 'write'], actions: false, toolbox: false, toolboxCall: 'vercel_call', card: { glyph: 'vercel', about: 'Projects, deployments and runtime logs from a connected Vercel account.', docsUrl: 'https://vercel.com/docs/mcp', readOnlyNote: 'Read tools run directly; the four deployment actions are off by default and each asks for approval.' } })
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
    return view[1]?.state === 'ready' ? view : undefined
  }, 'Vercel to mount without an account')
  assert.deepEqual(connectors[1], { id: 'vercel', name: 'Vercel', state: 'ready', account: null, level: 'read', levels: ['read', 'write'], actions: false, toolbox: false, toolboxCall: 'vercel_call', card: { glyph: 'vercel', about: 'Projects, deployments and runtime logs from a connected Vercel account.', docsUrl: 'https://vercel.com/docs/mcp', readOnlyNote: 'Read tools run directly; the four deployment actions are off by default and each asks for approval.' } })
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
    const item = (await call(ctx, 'state', {})).value.connectors[1]
    return item?.state === 'ready' && item.account === 'acme' ? item : undefined
  }, 'the first token to connect')

  // Another account's token replaces the saved one on the Secrets page.
  const second = vercelBench({ user: { username: 'other', defaultTeamId: 'team_2' } })
  globalThis.fetch = second.fetch
  await call(ctx, 'secret-set', { name: 'VERCEL_TOKEN', value: fresh(), purpose: 'replaced' })

  const view = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[1]
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

test('the action tools stay off until the switch turns them on', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home, registered } = setup({ secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const ready = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[1]
    return item?.state === 'ready' ? item : undefined
  }, 'Vercel to connect read-only')
  assert.equal(ready.actions, false)
  assert.equal(registered.length, 13)
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
  assert.ok(!registered.includes('vercel_create_deployment'))

  const on = (await call(ctx, 'connector-set-actions', { id: 'vercel', enabled: true })).value
  assert.equal(on[1].actions, true)
  const withActions = new Set(registered.slice(-17))
  assert.equal(withActions.size, 17)
  assert.deepEqual([...withActions].sort(), [...vercelNames(VERCEL_READ), ...vercelNames(VERCEL_ACTIONS)].sort())
  assert.ok(!withActions.has('vercel_create_project'))

  const off = (await call(ctx, 'connector-set-actions', { id: 'vercel', enabled: false })).value
  assert.equal(off[1].actions, false)
  assert.deepEqual(registered.slice(-13).sort(), vercelNames(VERCEL_READ).sort())
  assert.ok(!registered.slice(-13).includes('vercel_create_deployment'))
})

const actionsState = () => ({ ...TEAM, connectors: { vercel: { username: 'acme', teamId: 'team_1', actions: true, connectedAt: 1 } } })

// The approval card a connector write leaves in the dock for the running Bot's session.
const approvalCard = async (ctx) => (await call(ctx, 'state', {})).value.questions.m1
const answerCard = (ctx, questionId, selected) => call(ctx, 'answer-question', { sessionId: 'm1', questionId, answer: { selected } })

test('a named action asks on the approval card before it runs, and a read tool does not', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup({ state: actionsState(), secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[1]
    return item?.state === 'ready' && item.actions === true ? item : undefined
  }, 'Vercel with its actions')

  // A read tool runs with no card and no wait.
  assert.equal(await ctx.registeredTools.get('vercel_list_projects').execute({}, { agent: { id: 'm1' } }), 'called list_projects')
  assert.equal(await approvalCard(ctx), undefined)

  // The write waits on the plugin's own card: it has not reached the server.
  const calls = () => bench.calls.filter(entry => entry.method === 'tools/call').length
  const pending = ctx.registeredTools.get('vercel_create_deployment').execute({}, { agent: { id: 'm1' } })
  const card = await until(() => approvalCard(ctx), 'the approval card')
  assert.equal(card.kind, 'connector-approval')
  assert.equal(card.question, "Allow Chief to run Vercel's create_deployment?")
  assert.deepEqual(card.options.map(option => option.label), ['Allow once', 'Deny'])
  assert.equal(calls(), 1)

  // Allow once: the call goes out and the card goes away.
  assert.equal((await answerCard(ctx, card.id, ['Allow once'])).ok, true)
  assert.equal(await pending, 'called create_deployment')
  assert.equal(calls(), 2)
  assert.equal(await approvalCard(ctx), undefined)

  // Deny: the call never reaches the server and the model sees why.
  const refused = ctx.registeredTools.get('vercel_cancel_deployment').execute({}, { agent: { id: 'm1' } })
  const second = await until(() => approvalCard(ctx), 'the second card')
  assert.equal((await answerCard(ctx, second.id, ['Deny'])).ok, true)
  await assert.rejects(refused, /The user denied Vercel's cancel_deployment; nothing was sent/)
  assert.equal(calls(), 2)

  // Every decision is in diagnostics, and no argument is.
  const log = (await call(ctx, 'diagnostics-log')).value
  assert.match(log, /connector-approval/)
  assert.match(log, /allowed: Vercel's create_deployment/)
  assert.match(log, /denied: Vercel's cancel_deployment/)
})

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
  const { ctx, home } = setup({ state: actionsState(), secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }], config: { connectorApprovalTimeoutMs: 60 } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[1]
    return item?.state === 'ready' && item.actions === true ? item : undefined
  }, 'Vercel with its actions')

  const pending = ctx.registeredTools.get('vercel_create_deployment').execute({}, { agent: { id: 'm1' } })
  await until(() => approvalCard(ctx), 'the approval card')
  await assert.rejects(pending, /did not answer in time/)
  assert.equal(await approvalCard(ctx), undefined)
  assert.equal(bench.calls.filter(entry => entry.method === 'tools/call').length, 0)
  const log = (await call(ctx, 'diagnostics-log')).value
  assert.match(log, /timed out: Vercel's create_deployment/)
})

test('a saved actions switch survives a restart', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const saved = { ...TEAM, connectors: { vercel: { username: 'acme', teamId: 'team_1', actions: true, connectedAt: 1 } } }
  const { ctx, home, registered } = setup({ state: saved, secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const ready = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[1]
    return item?.state === 'ready' && item.actions === true ? item : undefined
  }, 'Vercel with actions to connect')
  assert.equal(ready.actions, true)
  assert.equal(ready.level, 'write')
  assert.deepEqual([...registered].sort(), [...vercelNames(VERCEL_READ), ...vercelNames(VERCEL_ACTIONS)].sort())
})

const toolboxState = () => ({ ...TEAM, connectors: { vercel: { username: 'acme', teamId: 'team_1', actions: true, toolbox: true, connectedAt: 1 } } })

test('the toolbox replaces the named actions and comes back off again', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const saved = { ...TEAM, connectors: { vercel: { username: 'acme', teamId: 'team_1', actions: true, connectedAt: 1 } } }
  const { ctx, home, registered } = setup({ state: saved, secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const connected = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[1]
    return item?.state === 'ready' ? item : undefined
  }, 'Vercel with its actions to connect')
  assert.deepEqual([connected.actions, connected.toolbox], [true, false])
  assert.deepEqual([...registered].sort(), [...vercelNames(VERCEL_READ), ...vercelNames(VERCEL_ACTIONS)].sort())

  const on = (await call(ctx, 'connector-set-toolbox', { id: 'vercel', enabled: true })).value
  assert.deepEqual([on[1].actions, on[1].toolbox], [true, true])
  // 13 read + the two meta tools; no named action tool is registered.
  assert.deepEqual(registered.slice(-15).sort(), [...vercelNames(VERCEL_READ), 'vercel_search_tools', 'vercel_call'].sort())
  // A read tool runs through vercel_call with the default team filled in.
  const text = await ctx.registeredTools.get('vercel_call').execute({ tool: 'list_projects' }, { agent: { id: 'm1' } })
  assert.equal(text, 'called list_projects')
  assert.deepEqual(bench.calls.filter(entry => entry.method === 'tools/call').at(-1).params.arguments, { teamId: 'team_1' })

  const off = (await call(ctx, 'connector-set-toolbox', { id: 'vercel', enabled: false })).value
  assert.deepEqual([off[1].actions, off[1].toolbox], [true, false])
  assert.deepEqual(registered.slice(-17).sort(), [...vercelNames(VERCEL_READ), ...vercelNames(VERCEL_ACTIONS)].sort())
})

test('vercel_call asks on the approval card for a write target; blocked targets are still refused outright', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup({ state: toolboxState(), secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[1]
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
  assert.ok(!JSON.stringify(card).includes('shh-do-not-show'))
  assert.equal(bench.calls.filter(entry => entry.method === 'tools/call').length, 0)
  await answerCard(ctx, card.id, ['Allow once'])
  assert.equal(await pending, 'called create_deployment')
  assert.equal(bench.calls.filter(entry => entry.method === 'tools/call').length, 1)

  // A read target runs with no card.
  assert.equal(await ctx.registeredTools.get('vercel_call').execute({ tool: 'list_projects' }, { agent: { id: 'm1' } }), 'called list_projects')
  assert.equal(await approvalCard(ctx), undefined)
})

test('a saved toolbox switch survives a restart', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = bench.fetch
  const { ctx, home, registered } = setup({ state: toolboxState(), secrets: [{ name: 'VERCEL_TOKEN', value: fresh() }] })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const ready = await until(async () => {
    const item = (await call(ctx, 'state', {})).value.connectors[1]
    return item?.state === 'ready' && item.toolbox === true ? item : undefined
  }, 'the saved toolbox to connect')
  assert.deepEqual([ready.actions, ready.toolbox], [true, true])
  assert.deepEqual([...registered].sort(), [...vercelNames(VERCEL_READ), 'vercel_search_tools', 'vercel_call'].sort())
  assert.ok(!registered.includes('vercel_create_deployment'))
})

test('only a connector with a toolbox can switch it', async (t) => {
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const result = await call(ctx, 'connector-set-toolbox', { id: 'github', enabled: true })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /no toolbox/)
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
  const [, vercel] = result.value
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
  assert.deepEqual(statuses(state.value.connectors), [['github', 'off', null], ['vercel', 'off', null], ['cloudflare', 'off', null]])
  assert.deepEqual([...disposed].sort(), vercelNames(VERCEL_READ).sort())
})

test('each connector mounts and unmounts on its own', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = vercelBench()
  globalThis.fetch = async (url, init) => String(url) === 'https://gh.test/user' ? answer(200, { login: 'octo' }) : bench.fetch(url, init)
  const { ctx, home, mounts, registered, disposed } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  await call(ctx, 'connector-connect', { id: 'vercel', token: fresh() })
  assert.equal(mounts.length, 1)
  assert.deepEqual([...registered].sort(), vercelNames(VERCEL_READ).sort())
  assert.deepEqual(statuses((await call(ctx, 'state', {})).value.connectors), [['github', 'ready', 'octo'], ['vercel', 'ready', 'acme'], ['cloudflare', 'off', null]])

  await call(ctx, 'connector-disconnect', { id: 'vercel' })
  assert.deepEqual([...disposed].sort(), vercelNames(VERCEL_READ).sort())
  assert.equal(mounts[0].disposed, false)
  assert.deepEqual(statuses((await call(ctx, 'state', {})).value.connectors), [['github', 'ready', 'octo'], ['vercel', 'off', null], ['cloudflare', 'off', null]])

  await call(ctx, 'connector-disconnect', { id: 'github' })
  assert.equal(mounts[0].disposed, true)
})

test('github: false hides only the GitHub connector', async (t) => {
  const { ctx, home } = setup({ github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual(builtins((await call(ctx, 'state', {})).value.connectors), [OFF.vercel, OFF.cloudflare])
})

test('vercel: false hides only the Vercel connector', async (t) => {
  const { ctx, home } = setup({ vercel: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual(builtins((await call(ctx, 'state', {})).value.connectors), [OFF.github, OFF.cloudflare])
})

test('a GitHub address without https refuses to send the token', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  let asked = false
  globalThis.fetch = async () => { asked = true; return answer(200, { login: 'octo' }) }
  const { ctx, home, mounts } = setup({ github: { url: 'http://mcp.test/', api: 'https://gh.test' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const refused = await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /https/)
  assert.equal(asked, false)
  assert.equal(mounts.length, 0)
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

  const started = await call(ctx, 'connector-oauth-start', { id: 'cloudflare' }, { origin: 'https://dsh.test' })
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
  assert.deepEqual([ready.toolbox, ready.toolboxCall], [false, 'cloudflare_call'])

  // The switch adds the two meta tools next to the 14 read tools.
  const on = (await call(ctx, 'connector-set-toolbox', { id: 'cloudflare', enabled: true })).value.find(connector => connector.id === 'cloudflare')
  assert.equal(on.toolbox, true)
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
  assert.ok(!JSON.stringify(card).includes('CARD-MUST-NOT-SHOW'))
  assert.equal(mcpCalls.length, callsBefore)
  assert.equal((await answerCard(ctx, card.id, ['Allow once'])).ok, true)
  assert.match(await pending, /called post_zones_dns_records/)
  assert.equal(mcpCalls.length, callsBefore + 1)

  // A denied write never reaches Cloudflare.
  const denied = tool.execute({ tool: 'delete_zones_by_zone_id', args: { zone_id: 'z1' } }, { agent: { id: 'm1' } })
  const second = await until(() => approvalCard(ctx), 'the deny card')
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
    const item = (await call(ctx, 'state', {})).value.connectors[1]
    return item?.state === 'ready' ? item : undefined
  }, 'Vercel to connect')
  assert.equal(ready.level, 'read')

  const raised = (await call(ctx, 'connector-set-level', { id: 'vercel', level: 'write' })).value
  assert.equal(raised[1].level, 'write')
  assert.equal((await call(ctx, 'state', {})).value.secrets.length, 1)

  const refused = await call(ctx, 'connector-set-level', { id: 'vercel', level: 'admin' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /no admin access level/)

  const gone = (await call(ctx, 'connector-disconnect', { id: 'vercel' })).value
  assert.equal(gone[1].state, 'off')
  assert.equal(gone[1].level, 'write')
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('only a connector that declares settings takes them', async (t) => {
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const result = await call(ctx, 'connector-set-settings', { id: 'github', values: { projectId: 'p1' } })
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
