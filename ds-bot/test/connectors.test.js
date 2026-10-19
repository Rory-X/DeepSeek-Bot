import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { signIn } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'

const fresh = () => `tok_${randomBytes(16).toString('hex')}`
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
const off = id => ({ id, state: 'off', account: null })
const OFF = { github: { id: 'github', name: 'GitHub', ...off('github') }, vercel: { id: 'vercel', name: 'Vercel', ...off('vercel'), actions: false } }
const statuses = view => view.map(item => [item.id, item.state, item.account])

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
function setup({ fail = false, github = { api: 'https://gh.test' }, vercel = { api: 'https://vercel.test', url: 'https://mcp.vercel.test' }, secrets = [], state = TEAM } = {}) {
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
  const ctx = fakeContext({ services: { loader } })
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
  apply(ctx, { home, github, vercel })
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
async function call(ctx, endpoint, payload) {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
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
  assert.deepEqual(before.value.connectors, [OFF.github, OFF.vercel])

  const connected = await call(ctx, 'connector-connect', { id: 'github', token: ` ${token} ` })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  assert.deepEqual(connected.value, [{ id: 'github', name: 'GitHub', state: 'ready', account: 'octo' }, OFF.vercel])
  assert.equal(mounts.length, 1)
  assert.deepEqual(mounts[0].config, githubMount(token))
  const state = await call(ctx, 'state', {})
  assert.deepEqual(state.value.secrets.map(secret => [secret.name, secret.scope]), [['GITHUB_TOKEN', []]])
  assert.ok(!JSON.stringify(state).includes(token))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(token))

  const disconnected = await call(ctx, 'connector-disconnect', { id: 'github' })
  assert.deepEqual(disconnected.value, [OFF.github, OFF.vercel])
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
  assert.deepEqual(statuses(state.value.connectors), [['github', 'off', null], ['vercel', 'off', null]])
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
  assert.deepEqual(connected.value, [OFF.github, { id: 'vercel', name: 'Vercel', state: 'ready', account: 'acme', actions: false }])
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
  assert.deepEqual(connectors[1], { id: 'vercel', name: 'Vercel', state: 'ready', account: 'acme', actions: false })
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
  assert.deepEqual(connectors[1], { id: 'vercel', name: 'Vercel', state: 'ready', account: null, actions: false })
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

test('an action tool asks before it runs, and a read tool does not', async (t) => {
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const [approve] = ctx.listeners.get('tools/pre-execute')
  assert.equal(typeof approve, 'function')
  let passed = 0
  const next = () => { passed += 1; return Promise.resolve({ kind: 'allow' }) }
  const asked = await approve({ name: 'vercel_create_deployment', arguments: {} }, next)
  assert.equal(asked.kind, 'ask')
  assert.match(asked.reason, /Vercel: create_deployment/)
  assert.ok(asked.displayReason.en.includes('create_deployment'))
  assert.ok(asked.displayReason.zh.includes('create_deployment'))
  assert.equal(passed, 0)
  assert.deepEqual(await approve({ name: 'vercel_list_projects', arguments: {} }, next), { kind: 'allow' })
  assert.deepEqual(await approve({ name: 'bash', arguments: {} }, next), { kind: 'allow' })
  assert.equal(passed, 2)
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
  assert.deepEqual([...registered].sort(), [...vercelNames(VERCEL_READ), ...vercelNames(VERCEL_ACTIONS)].sort())
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
  assert.deepEqual(statuses(state.value.connectors), [['github', 'off', null], ['vercel', 'off', null]])
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
  assert.deepEqual(statuses((await call(ctx, 'state', {})).value.connectors), [['github', 'ready', 'octo'], ['vercel', 'ready', 'acme']])

  await call(ctx, 'connector-disconnect', { id: 'vercel' })
  assert.deepEqual([...disposed].sort(), vercelNames(VERCEL_READ).sort())
  assert.equal(mounts[0].disposed, false)
  assert.deepEqual(statuses((await call(ctx, 'state', {})).value.connectors), [['github', 'ready', 'octo'], ['vercel', 'off', null]])

  await call(ctx, 'connector-disconnect', { id: 'github' })
  assert.equal(mounts[0].disposed, true)
})

test('github: false hides only the GitHub connector', async (t) => {
  const { ctx, home } = setup({ github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual((await call(ctx, 'state', {})).value.connectors, [OFF.vercel])
})

test('vercel: false hides only the Vercel connector', async (t) => {
  const { ctx, home } = setup({ vercel: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual((await call(ctx, 'state', {})).value.connectors, [OFF.github])
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
