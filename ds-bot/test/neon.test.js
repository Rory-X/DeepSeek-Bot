import assert from 'node:assert/strict'
import { test } from 'node:test'
import { McpHttpClient, mcpResultText } from '../src/host/mcp.js'
import { createOAuthFlow, OAUTH_PREFIX } from '../src/host/oauth/flow.js'
import { OAuthError } from '../src/host/oauth/client.js'
import neon, {
  configure, neonAccount, neonActionApproval, neonAuthorize, neonReadiness, neonTools, neonToolsOf, neonUrl, neonWriteUrl,
  normalizeNeonSettings, sqlPreview,
} from '../src/host/connectors/neon.js'
import { fakeContext } from './fake-ctx.js'
import { fakeCredentials, fakeOAuthServer, fakeResponse, fakeWebServer } from './oauth-fakes.js'

// What `https://mcp.neon.tech/api/list-tools?readonly=true` publishes for the categories this
// connector asks for (2026-10-20): 30 tools, every one a read.
const SERVER_READ_ONLY = [
  'list_organizations', 'run_sql', 'describe_table_schema', 'get_database_tables', 'describe_branch',
  'explain_sql_statement', 'list_slow_queries', 'inspect_database', 'search', 'fetch', 'send_feedback',
  'list_projects', 'describe_project', 'list_project_permissions', 'list_project_members', 'list_regions',
  'list_operations', 'get_operation', 'list_branches', 'get_branch', 'get_default_branch',
  'compare_database_schema', 'list_postgres_roles', 'get_postgres_role', 'list_postgres_databases',
  'get_postgres_database', 'list_postgres_endpoints', 'list_branch_computes', 'get_postgres_endpoint',
  'list_credentials',
]
// The families the server drops in read-only mode; none may be registered here.
const SERVER_WRITES = [
  'create_project', 'delete_project', 'create_branch', 'delete_branch', 'reset_from_parent',
  'run_sql_transaction', 'get_connection_string', 'prepare_database_migration', 'complete_database_migration',
  'prepare_query_tuning', 'complete_query_tuning', 'create_postgres_database', 'create_postgres_role',
  'create_snapshot', 'restore_snapshot', 'update_auth_config', 'create_auth_user', 'deploy_function',
]

const ADDRESS = neon.mcpUrl
// The flow and the mount read `url`; the registry turns the module's `mcpUrl` into it.
const mounted = () => ({ ...neon, url: ADDRESS })

const tool = name => ({ name, description: `Neon ${name}`, inputSchema: { type: 'object', properties: {} } })
const mcpAnswer = (id, value) => ({
  status: 200,
  ok: true,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify({ jsonrpc: '2.0', id, result: value }),
})
const emptyAnswer = () => ({ status: 202, ok: true, headers: { get: () => null }, text: async () => '' })
const unauthorized = () => ({ status: 401, ok: false, headers: { get: () => null }, text: async () => '' })
const forbidden = () => ({ status: 403, ok: false, headers: { get: () => null }, text: async () => '' })

// One fake Neon MCP server: initialize, tools/list and tools/call, recording what arrived.
function neonServer({ listed = [...neon.readTools, ...SERVER_WRITES].map(tool), refuse = () => undefined } = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    assert.equal(String(url), ADDRESS)
    const body = JSON.parse(init.body)
    calls.push({ method: body.method, name: body.params?.name, args: body.params?.arguments, headers: init.headers })
    const refused = refuse(body, calls.length)
    if (refused !== undefined) return refused
    if (body.method === 'initialize') return mcpAnswer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Neon MCP', version: '1' } })
    if (body.method === 'notifications/initialized') return emptyAnswer()
    if (body.method === 'tools/list') return mcpAnswer(body.id, { tools: listed })
    if (body.method === 'tools/call') {
      return mcpAnswer(body.id, { content: [{ type: 'text', text: `ran ${body.params.arguments.sql ?? body.params.name}` }] })
    }
    throw new Error(`unexpected method ${body.method}`)
  }
  return { calls, fetch }
}

test('Neon is a read-only OAuth connector: read scope, read-only address, read tools only', () => {
  assert.deepEqual([neon.id, neon.displayName, neon.mode], ['neon', 'Neon', 'oauth-mcp'])
  const url = new URL(ADDRESS)
  assert.equal(url.origin + url.pathname, 'https://mcp.neon.tech/mcp')
  assert.equal(url.searchParams.get('readonly'), 'true')
  assert.deepEqual(url.searchParams.getAll('category'), ['projects', 'branches', 'endpoints', 'schema', 'querying'])
  assert.deepEqual(neon.oauth.scopes, ['read'])
  assert.equal(neon.accountTool, 'list_organizations')
  // Everything exposed is a tool Neon itself calls read-only; no write family is named.
  for (const name of neon.readTools) assert.ok(SERVER_READ_ONLY.includes(name), name)
  for (const name of SERVER_WRITES) assert.ok(!neon.readTools.includes(name), name)
  assert.equal(neon.readTools.includes('run_sql'), true)
})

test('a configured Neon address cannot turn read-only off', () => {
  const pinned = configure({ url: 'https://mcp.neon.tech/mcp?readonly=false&projectId=proj-1' })
  const url = new URL(pinned.url)
  assert.equal(url.searchParams.get('readonly'), 'true')
  assert.equal(url.searchParams.get('projectId'), 'proj-1')

  const scoped = new URL(configure({ url: neonUrl({ projectId: 'spring-brook-12345678', roleName: 'app_reader' }) }).url)
  assert.deepEqual(
    [scoped.searchParams.get('readonly'), scoped.searchParams.get('projectId'), scoped.searchParams.get('roleName')],
    ['true', 'spring-brook-12345678', 'app_reader'],
  )
  // A pinned role takes the same read-only grant with it.
  assert.equal(new URL(neonUrl({ roleName: 'app_reader' })).searchParams.get('roleName'), 'app_reader')
  // A value Neon would reject is dropped rather than sent.
  assert.equal(new URL(neonUrl({ roleName: 'drop table users;' })).searchParams.get('roleName'), null)
  assert.throws(() => configure({ url: 'http://mcp.neon.tech/mcp' }), /plain https:\/\//)
  assert.throws(() => configure({ url: 'https://user:pass@mcp.neon.tech/mcp' }), /plain https:\/\//)
  assert.throws(() => configure({ url: 'mcp.neon.tech/mcp' }), /plain https:\/\//)
  // The whitelist, the scope and the mode survive an override of their own.
  const forced = configure({ url: ADDRESS, mode: 'read-tools', readTools: ['create_project'], oauth: { scopes: ['read', 'write'] } })
  assert.deepEqual([forced.mode, forced.readTools, forced.oauth.scopes], ['oauth-mcp', neon.readTools, ['read']])
})

test('the framework merge of a profile override keeps the read-only grant', () => {
  // The registry copies the fields of the default export, so the hook must be one of them.
  assert.equal(typeof neon.configure, 'function')
  // What connectors.js does: merge the definition and the override, then merge configure()'s
  // answer over both, and mount from that.
  const override = { url: 'https://mcp.neon.tech/mcp?readonly=false&projectId=proj-9' }
  const merged = { ...neon, ...override, url: override.url, ...configure(override) }
  const url = new URL(merged.url)
  assert.deepEqual([url.searchParams.get('readonly'), url.searchParams.get('projectId')], ['true', 'proj-9'])
  assert.deepEqual(merged.readTools, neon.readTools)
  assert.deepEqual(merged.oauth.scopes, ['read'])
  assert.equal(merged.mode, 'oauth-mcp')
})

test('a Neon mount can register only the read whitelist, and run_sql answers', async () => {
  const server = neonServer()
  const client = new McpHttpClient(ADDRESS, 'access-1', { fetch: server.fetch })
  await client.open()
  const picked = neonTools(await client.listTools())
  // The server lists its write tools too (a different grant, a proxy in front); none mounts.
  assert.deepEqual(picked.map(entry => entry.name), neon.readTools)
  assert.equal(picked.length, 16)
  for (const name of SERVER_WRITES) assert.ok(!picked.some(entry => entry.name === name), name)

  const answer = mcpResultText(await client.callTool('run_sql', { sql: 'select count(*) from users' }))
  assert.equal(answer, 'ran select count(*) from users')
  assert.deepEqual(server.calls.at(-1).args, { sql: 'select count(*) from users' })
  assert.equal(server.calls.at(-1).headers.authorization, 'Bearer access-1')
})

test('a 401 on a mounted Neon tool refreshes the grant once and sends the call again', async () => {
  let refused = true
  const server = neonServer({
    refuse: (body) => {
      if (body.method !== 'initialize' || !refused) return undefined
      refused = false
      return unauthorized()
    },
  })
  const refreshed = []
  const client = new McpHttpClient(ADDRESS, 'old-token', {
    fetch: server.fetch,
    refresh: async () => {
      refreshed.push('once')
      return 'new-token'
    },
  })
  await client.open()
  assert.deepEqual(refreshed, ['once'])
  assert.equal(server.calls.at(-1).headers.authorization, 'Bearer new-token')
  // The refused session is not reused: the retry opened a fresh one.
  assert.equal(server.calls.filter(call => call.method === 'initialize').length, 2)
})

test('a 403 is reported, and a refresh that cannot renew the grant asks for a reconnect', async () => {
  const refusedAlways = neonServer({ refuse: () => forbidden() })
  let refreshes = 0
  const client = new McpHttpClient(ADDRESS, 'old-token', {
    fetch: refusedAlways.fetch,
    refresh: async () => {
      refreshes += 1
      return 'new-token'
    },
  })
  await assert.rejects(client.open(), /answered 403/)
  assert.equal(refreshes, 1)

  const dead = new McpHttpClient(ADDRESS, 'old-token', {
    fetch: neonServer({ refuse: () => unauthorized() }).fetch,
    refresh: async () => { throw new OAuthError('The authorization expired; connect again', 'reconnect') },
  })
  await assert.rejects(dead.open(), error => error.code === 'oauth/reconnect' && /connect again/.test(error.message))
})

test('a Neon server that never answers is reported as unreachable, not as a dead grant', async () => {
  const client = new McpHttpClient(ADDRESS, 'access-1', {
    fetch: async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    },
  })
  await assert.rejects(client.open(), /Could not reach the MCP server: The operation was aborted due to timeout/)
})

test('a query the read-only server refuses reaches the model as a tool error', async () => {
  const server = neonServer({
    refuse: (body) => {
      if (body.method !== 'tools/call') return undefined
      return mcpAnswer(body.id, { isError: true, content: [{ type: 'text', text: 'cannot execute INSERT in a read-only transaction' }] })
    },
  })
  const client = new McpHttpClient(ADDRESS, 'access-1', { fetch: server.fetch })
  await client.open()
  await assert.rejects(async () => mcpResultText(await client.callTool('run_sql', { sql: 'insert into users default values' })), /read-only transaction/)
})

test('Neon authorizes with the read-only address and the read scope only', async () => {
  const oauth = fakeOAuthServer({
    resource: ADDRESS,
    issuer: 'https://mcp.neon.tech',
    // Neon's metadata names the endpoint without the grant query, as Cloudflare's does.
    declaredResource: 'https://mcp.neon.tech/mcp',
    scopes: ['read', 'write'],
    challengeScope: 'read write',
  })
  const credentials = fakeCredentials()
  const webServer = fakeWebServer()
  const ctx = fakeContext({ services: { credentials, webServer } })
  const authorized = []
  const flow = createOAuthFlow({
    ctx,
    connectorOf: () => mounted(),
    request: oauth.fetch,
    warn: () => {},
    redact: text => text,
    onAuthorized: id => { authorized.push(id) },
  })

  const started = await flow.start('neon', { origin: 'https://dsh.test' })
  const authorizeUrl = new URL(started.authorizeUrl)
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, oauth.metadata.authorization_endpoint)
  assert.equal(authorizeUrl.searchParams.get('scope'), 'read')
  assert.equal(authorizeUrl.searchParams.get('resource'), ADDRESS)
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://dsh.test/oauth/ds-bot/neon')
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256')

  const { res, done } = fakeResponse()
  webServer.routes[0].handler({ method: 'GET', url: `${OAUTH_PREFIX}/neon?code=auth-code&state=${encodeURIComponent(authorizeUrl.searchParams.get('state'))}` }, res)
  const page = await done
  assert.equal(page.statusCode, 200, page.body)
  assert.match(page.body, /Neon is connected/)
  assert.deepEqual(authorized, ['neon'])

  const grant = credentials.records.get('ds-bot/connector-neon').payload
  assert.equal(grant.resource, ADDRESS)
  assert.deepEqual(grant.scopes, ['read'])
  assert.equal(new URLSearchParams(oauth.tokenRequests()[0].body).get('resource'), ADDRESS)
})

test('a Neon grant the provider will not refresh asks for a reconnect and is deleted', async () => {
  const oauth = fakeOAuthServer({
    resource: ADDRESS,
    issuer: 'https://mcp.neon.tech',
    declaredResource: 'https://mcp.neon.tech/mcp',
    tokenHandler: () => ({
      status: 400,
      ok: false,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: 'invalid_grant' }),
    }),
  })
  const credentials = fakeCredentials()
  credentials.records.set('ds-bot/connector-neon', {
    kind: 'grant',
    payload: {
      version: 1,
      issuer: 'https://mcp.neon.tech',
      resource: ADDRESS,
      client: { id: 'client-1', tokenAuth: 'none', redirectUri: 'https://dsh.test/oauth/ds-bot/neon' },
      tokens: { access: 'access-1', refresh: 'refresh-1', expiresAt: 1, tokenType: 'Bearer' },
      scopes: ['read'],
      authorizedAt: 1,
    },
  })
  const ctx = fakeContext({ services: { credentials, webServer: fakeWebServer() } })
  const flow = createOAuthFlow({ ctx, connectorOf: () => mounted(), request: oauth.fetch, warn: () => {}, redact: text => text })
  await assert.rejects(flow.token('neon'), error => error.code === 'oauth/reconnect' && /connect again/.test(error.message))
  assert.equal(credentials.records.has('ds-bot/connector-neon'), false)
})

test('the connected account is the organization list Neon answers', () => {
  assert.equal(neonAccount({ organizations: [{ name: 'Acme' }] }), 'Acme')
  assert.equal(neonAccount({ organizations: [{ name: 'Acme' }, { name: 'Labs' }] }), 'Acme and 1 more')
  assert.equal(neonAccount([{ name: 'Acme' }]), 'Acme')
  assert.equal(neonAccount({ email: 'dev@example.com' }), 'dev@example.com')
  assert.equal(neonAccount({ organizations: [] }), undefined)
  assert.equal(neonAccount(undefined), undefined)
  assert.equal(neon.accountOf({ organizations: [{ name: 'Acme' }] }), 'Acme')
  assert.deepEqual(neonTools(undefined), [])
})

test('Neon declares both access levels and the settings the full level needs', () => {
  assert.deepEqual(neon.levels, ['read', 'write'])
  assert.equal(neon.defaultLevel, 'read')
  assert.deepEqual(neon.settings.map(field => field.name), ['projectId', 'roleName'])
  for (const hook of ['authorize', 'toolsOf', 'readiness', 'normalizeSettings', 'actionApproval']) {
    assert.equal(typeof neon[hook], 'function', hook)
  }
  assert.equal(neon.authorize, neonAuthorize)
  assert.equal(neon.toolsOf, neonToolsOf)
  assert.equal(neon.readiness, neonReadiness)
  assert.equal(neon.normalizeSettings, normalizeNeonSettings)
  assert.equal(neon.actionApproval, neonActionApproval)
})

test('the read level authorizes the read-only address and the read scope', () => {
  const grant = neonAuthorize({ level: 'read', settings: {} })
  const url = new URL(grant.url)
  assert.deepEqual(grant.scopes, ['read'])
  assert.deepEqual([url.searchParams.get('readonly'), url.searchParams.getAll('category').length], ['true', 5])
  // A project may be pinned at the read level too: it only narrows what the grant can see.
  const pinned = new URL(neonAuthorize({ level: 'read', settings: { projectId: 'spring-brook-12345678' } }).url)
  assert.equal(pinned.searchParams.get('projectId'), 'spring-brook-12345678')
})

test('the full level authorizes a write grant on one project and one role', () => {
  const settings = { projectId: 'spring-brook-12345678', roleName: 'app_reader' }
  const grant = neonAuthorize({ level: 'write', settings })
  const url = new URL(grant.url)
  assert.deepEqual(grant.scopes, ['read', 'write'])
  assert.equal(url.searchParams.get('readonly'), null)
  assert.deepEqual(url.searchParams.getAll('category'), ['branches', 'querying', 'snapshots'])
  assert.deepEqual([url.searchParams.get('projectId'), url.searchParams.get('roleName')], [settings.projectId, settings.roleName])
  assert.equal(neonWriteUrl(settings), grant.url)
  // The pins are not optional: without them the grant would reach every project and run as
  // the database owner.
  assert.throws(() => neonAuthorize({ level: 'write', settings: { roleName: 'app_reader' } }), /project ID/)
  assert.throws(() => neonAuthorize({ level: 'write', settings: { projectId: 'spring-brook-12345678' } }), /restricted Postgres role/)
})

test('the full level says what it still needs before authorizing', () => {
  assert.equal(neonReadiness({ level: 'read', settings: {} }), undefined)
  assert.match(neonReadiness({ level: 'write', settings: {} }), /project ID/)
  assert.match(neonReadiness({ level: 'write', settings: { projectId: 'spring-brook-12345678' } }), /restricted Postgres role/)
  assert.match(neonReadiness({ level: 'write', settings: { projectId: 'Spring_Brook', roleName: 'app_reader' } }), /project ID/)
  assert.equal(neonReadiness({ level: 'write', settings: { projectId: 'spring-brook-12345678', roleName: 'app_reader' } }), undefined)
})

test('the settings form is trimmed and validated, and an emptied field is dropped', () => {
  assert.deepEqual(normalizeNeonSettings({ projectId: '  spring-brook-12345678 ', roleName: ' app_reader ' }), {
    projectId: 'spring-brook-12345678',
    roleName: 'app_reader',
  })
  assert.deepEqual(normalizeNeonSettings({ projectId: '', roleName: '' }), {})
  assert.deepEqual(normalizeNeonSettings(undefined), {})
  assert.throws(() => normalizeNeonSettings({ projectId: 'Spring_Brook' }), /project ID/)
  assert.throws(() => normalizeNeonSettings({ projectId: 'spring-brook-12345678', roleName: 'app-reader' }), /role name/)
})

test('the level picks the tool surface, and the write tools exist only at write', () => {
  const read = neonToolsOf({ level: 'read' })
  const write = neonToolsOf({ level: 'write' })
  assert.deepEqual(read.readTools, neon.readTools)
  assert.deepEqual(read.actionTools, [])
  assert.deepEqual(write.readTools, neon.readTools)
  assert.deepEqual(write.actionTools, ['create_branch', 'run_sql', 'create_snapshot', 'delete_branch'])
  // `run_sql` is the same Neon tool in both levels: a read-only transaction at the read
  // level, an approved write at the write level. The other three exist only at write.
  for (const name of write.actionTools.filter(entry => entry !== 'run_sql')) assert.ok(!neon.readTools.includes(name), name)
  assert.ok(neon.readTools.includes('run_sql'))
})

test('an approval line names the branch and never carries the whole SQL', async () => {
  const long = `select * from users where email = '${'a'.repeat(120)}' and note = '${'b'.repeat(120)}'`
  const run = await neonActionApproval('run_sql', { sql: long, branch_id: 'br-1' }, { settings: { roleName: 'app_reader' } })
  assert.ok(run.danger !== true)
  assert.equal(run.reversible, false)
  assert.match(run.line, /app_reader/)
  assert.match(run.line, /br-1/)
  assert.ok(run.line.includes(sqlPreview(long)))
  assert.ok(!run.line.includes('b'.repeat(120)))
  assert.ok(sqlPreview(long).length <= 200)

  const removed = await neonActionApproval('delete_branch', { branch_id: 'br-1' }, { settings: { projectId: 'spring-brook-12345678' } })
  assert.equal(removed.danger, true)
  assert.equal(removed.reversible, false)
  assert.match(removed.line, /br-1/)
  assert.match(removed.line, /deleted and cannot be recovered/)

  const created = await neonActionApproval('create_branch', { name: 'qa-branch' }, { settings: { projectId: 'spring-brook-12345678' } })
  assert.match(created.line, /qa-branch/)
  const snapshot = await neonActionApproval('create_snapshot', { branch_id: 'br-1', name: 'before-migration' }, {})
  assert.match(snapshot.line, /before-migration/)
})

test('the approval line resolves a branch name through the mounted client', async () => {
  const client = {
    callTool: async (name, args) => {
      assert.equal(name, 'list_branches')
      assert.deepEqual(args, {})
      return { content: [{ type: 'text', text: JSON.stringify({ branches: [{ id: 'br-1', name: 'feature-copy' }] }) }] }
    },
  }
  const removed = await neonActionApproval('delete_branch', { branch_id: 'br-1' }, { client })
  assert.match(removed.line, /feature-copy/)
  const broken = await neonActionApproval('delete_branch', { branch_id: 'br-1' }, { client: { callTool: async () => { throw new Error('down') } } })
  assert.match(broken.line, /br-1/)
})

test('a configured address is the base every level builds its grant on', () => {
  // A self-hosted or test MCP address replaces the host; the grant parameters are rebuilt
  // per level, so a configured read-only address must not leak into the write grant.
  const configured = configure({ url: 'https://mcp.test/mcp?readonly=true&category=querying&projectId=old' })
  assert.equal(new URL(configured.url).searchParams.get('readonly'), 'true')
  const read = new URL(neonAuthorize({ level: 'read' }).url)
  assert.deepEqual([read.origin + read.pathname, read.searchParams.get('readonly'), read.searchParams.getAll('category').length], ['https://mcp.test/mcp', 'true', 5])
  const write = new URL(neonAuthorize({ level: 'write', settings: { projectId: 'spring-brook-12345678', roleName: 'app_reader' } }).url)
  assert.deepEqual([write.searchParams.get('readonly'), write.searchParams.get('projectId')], [null, 'spring-brook-12345678'])
  // Put the real address back for the tests after this one.
  configure({})
})

test('the approval line names the pinned role the mount runs with', async () => {
  // The card is built from the call's arguments alone, so the settings that came with the
  // mount are kept and used when the call itself carries no role.
  neonToolsOf({ level: 'write', settings: { projectId: 'spring-brook-12345678', roleName: 'app_reader' } })
  const run = await neonActionApproval('run_sql', { sql: 'select 1', branch_id: 'br-main' })
  assert.match(run.line, /app_reader/)
  assert.match(run.line, /spring-brook-12345678/)
  neonToolsOf({ level: 'read' })
  const later = await neonActionApproval('run_sql', { sql: 'select 1' })
  assert.match(later.line, /the pinned role/)
})
