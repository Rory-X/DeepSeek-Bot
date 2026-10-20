import assert from 'node:assert/strict'
import { test } from 'node:test'
import { McpHttpClient, mcpResultText } from '../src/host/mcp.js'
import { createOAuthFlow, OAUTH_PREFIX } from '../src/host/oauth/flow.js'
import { OAuthError } from '../src/host/oauth/client.js'
import neon, {
  NEON_READ_TOOLS, NEON_WRITE_TOOLS, configure, neonAccount, neonActionApproval, neonAuthorize, neonDisplayNameFor,
  neonInstance, neonReadiness, neonTools, neonToolsOf, neonUrl, neonWriteUrl, normalizeNeonSettings, sqlPreview,
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
  // The label is the card's own name; the two pins reach the authorization.
  assert.deepEqual(neon.settings.map(field => field.name), ['label', 'projectId', 'roleName'])
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

test('the card name is trimmed, kept apart from the pins, and never reaches a grant', () => {
  // Renaming an instance only changes what the card is called; the id, the tool prefix and
  // the grant stay where they are.
  assert.deepEqual(normalizeNeonSettings({ label: '  Production DB  ', projectId: 'spring-brook-12345678' }), {
    label: 'Production DB',
    projectId: 'spring-brook-12345678',
  })
  // Control characters are dropped and a very long name is cut, not refused.
  assert.equal(normalizeNeonSettings({ label: 'Prod\u0007uct\u001bion' }).label, 'Production')
  assert.equal(normalizeNeonSettings({ label: 'x'.repeat(200) }).label.length, 60)
  // An emptied label drops the field, so the card falls back to its default name.
  assert.deepEqual(normalizeNeonSettings({ label: '   ' }), {})
  // The label never becomes part of the authorization URL.
  const grant = neonInstance({ id: 'neon-2' }).authorize({
    level: 'read',
    settings: { label: 'Production DB', projectId: 'spring-brook-12345678' },
  })
  assert.equal(new URL(grant.url).searchParams.get('label'), null)
  assert.equal(new URL(grant.url).searchParams.get('projectId'), 'spring-brook-12345678')
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

test('a configured address is the base one instance builds its grants on', () => {
  // A self-hosted or test MCP address replaces the host for that instance; the grant
  // parameters are rebuilt per level, so a configured read-only address must not leak into
  // the write grant. The other cards keep their own address: configure() no longer moves a
  // module-wide value.
  const card = configure({ url: 'https://mcp.test/mcp?readonly=true&category=querying&projectId=old' })
  assert.equal(new URL(card.url).searchParams.get('readonly'), 'true')
  assert.equal(new URL(card.url).searchParams.get('projectId'), 'old')
  const read = new URL(card.authorize({ level: 'read' }).url)
  assert.deepEqual([read.origin + read.pathname, read.searchParams.get('readonly'), read.searchParams.getAll('category').length], ['https://mcp.test/mcp', 'true', 5])
  const write = new URL(card.authorize({ level: 'write', settings: { projectId: 'spring-brook-12345678', roleName: 'app_reader' } }).url)
  assert.deepEqual([write.searchParams.get('readonly'), write.searchParams.get('projectId')], [null, 'spring-brook-12345678'])
  // The default instance still authorizes against Neon itself.
  const untouched = new URL(neonAuthorize({ level: 'read' }).url)
  assert.equal(untouched.origin + untouched.pathname, 'https://mcp.neon.tech/mcp')
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

// --- multi-instance ---------------------------------------------------------
// Every Neon project is its own card: its own id/prefix, grant, address, level and settings.
// The state these tests pin lived in two module-level singletons (baseAddress and
// mountedSettings) before the multi-instance work; the first card's mount must never show
// up on the second card's approval line again.

test('an instance declares its own id, display name, address and hook set', () => {
  assert.deepEqual(neon.instances, { prefix: 'neon', min: 1, max: 8 })
  const first = neonInstance({ id: 'neon' })
  const second = neonInstance({ id: 'neon-2' })
  const third = neonInstance({ id: 'neon-3', displayName: 'Production' })
  assert.deepEqual([first.id, second.id, third.id], ['neon', 'neon-2', 'neon-3'])
  assert.deepEqual([first.displayName, second.displayName, third.displayName], ['Neon', 'Neon 2', 'Production'])
  assert.equal(neonDisplayNameFor('neon'), 'Neon')
  assert.equal(neonDisplayNameFor('neon-12'), 'Neon 12')
  // A user label is the card name; the id and the tool prefix never change.
  assert.equal(third.id, 'neon-3')
  // Different instances must not share the mutable half of the definition.
  assert.notEqual(first.toolsOf, second.toolsOf)
  assert.notEqual(first.actionApproval, second.actionApproval)
  assert.notEqual(first.authorize, second.authorize)
})

test('every instance declares the same read whitelist and its own level settings', () => {
  for (const id of ['neon', 'neon-2']) {
    const card = neonInstance({ id })
    assert.deepEqual(card.readTools, neon.readTools)
    assert.deepEqual(card.levels, ['read', 'write'])
    assert.deepEqual(card.settings.map(field => field.name), ['label', 'projectId', 'roleName'])
    assert.deepEqual(card.oauth.scopes, ['read'])
    // The first card's address is Neon's own; an instance built without an override gets it
    // too, so a new card authorizes the same server.
    assert.equal(new URL(card.url).origin + new URL(card.url).pathname, 'https://mcp.neon.tech/mcp')
    assert.equal(new URL(card.authorize({ level: 'read' }).url).searchParams.get('readonly'), 'true')
  }
  // Only the write level locks the project and role into the grant.
  const second = neonInstance({ id: 'neon-2' })
  assert.equal(neonReadiness({ level: 'write', settings: {} }), 'Set the Neon project ID before connecting with full access.')
  assert.equal(neonReadiness({ level: 'write', settings: { projectId: 'spring-brook-12345678', roleName: 'app_reader' } }), undefined)
  assert.deepEqual(second.toolsOf({ level: 'read' }).actionTools, [])
  assert.deepEqual(second.toolsOf({ level: 'write' }).actionTools, ['create_branch', 'run_sql', 'create_snapshot', 'delete_branch'])
})

test('two mounted instances keep their own pinned project and role on the approval card', async () => {
  const first = neonInstance({ id: 'neon' })
  const second = neonInstance({ id: 'neon-2', override: { url: 'https://mcp.test/mcp' } })
  // Mount A with project A, then mount B with project B — the order the framework mounts
  // them in must not matter.
  first.toolsOf({ level: 'write', settings: { projectId: 'proj-a', roleName: 'role_a' } })
  second.toolsOf({ level: 'write', settings: { projectId: 'proj-b', roleName: 'role_b' } })
  const cardA = await first.actionApproval('run_sql', { sql: 'select 1' })
  const cardB = await second.actionApproval('run_sql', { sql: 'select 1' })
  assert.match(cardA.line, /role_a/)
  assert.match(cardA.line, /proj-a/)
  assert.ok(!cardA.line.includes('role_b'))
  assert.match(cardB.line, /role_b/)
  assert.match(cardB.line, /proj-b/)
  assert.ok(!cardB.line.includes('role_a'))
  // A second mount of A does not reach into B: B still names its own role.
  first.toolsOf({ level: 'read' })
  assert.match((await second.actionApproval('run_sql', { sql: 'select 1' })).line, /role_b/)
  // Each card authorizes on its own address; B's override never moves A.
  assert.equal(new URL(first.authorize({ level: 'read' }).url).origin, 'https://mcp.neon.tech')
  assert.equal(new URL(second.authorize({ level: 'read' }).url).origin, 'https://mcp.test')
})

test('the module export is the first card and no other card writes into it', async () => {
  // This is the bug the module-level `mountedSettings` caused: mounting neon-2 overwrote the
  // value neon read back on its approval line.
  neonToolsOf({ level: 'write', settings: { projectId: 'proj-neon', roleName: 'role_neon' } })
  const second = neonInstance({ id: 'neon-2' })
  second.toolsOf({ level: 'write', settings: { projectId: 'proj-two', roleName: 'role_two' } })
  const first = await neonActionApproval('run_sql', { sql: 'select 1' })
  assert.match(first.line, /role_neon/)
  assert.match(first.line, /proj-neon/)
  assert.ok(!first.line.includes('role_two'))
  assert.match((await second.actionApproval('run_sql', { sql: 'select 1' })).line, /role_two/)
})

test('configure() hands each instance its own hook set for the framework merge', async () => {
  // What a registry that calls configure() once per instance does: merge the module
  // definition, the instance override and configure()'s answer. The hooks in that answer
  // must belong to that instance alone.
  const definition = (id, override = {}) => ({ ...neon, id, displayName: neonDisplayNameFor(id), ...override, ...configure(override) })
  const a = definition('neon')
  const b = definition('neon-2', { url: 'https://mcp.test/mcp?projectId=pinned' })
  assert.notEqual(a.toolsOf, b.toolsOf)
  a.toolsOf({ level: 'write', settings: { projectId: 'proj-a', roleName: 'role_a' } })
  b.toolsOf({ level: 'write', settings: { projectId: 'proj-b', roleName: 'role_b' } })
  assert.match((await a.actionApproval('run_sql', { sql: 'select 1' })).line, /role_a/)
  assert.match((await b.actionApproval('run_sql', { sql: 'select 1' })).line, /role_b/)
  // The override moves only b's grant address; a keeps Neon's own server.
  assert.equal(new URL(a.authorize({ level: 'read' }).url).origin, 'https://mcp.neon.tech')
  assert.equal(new URL(b.authorize({ level: 'read' }).url).origin, 'https://mcp.test')
})

test('configure() still refuses an address that cannot carry an https grant', () => {
  assert.throws(() => configure({ url: 'http://mcp.neon.tech/mcp' }), /plain https:\/\//)
  assert.throws(() => configure({ url: 'https://user:pass@mcp.neon.tech/mcp' }), /plain https:\/\//)
  assert.throws(() => neonInstance({ id: 'neon-2', override: { url: 'mcp.neon.tech/mcp' } }), /plain https:\/\//)
})

test('each Neon card keeps its own grant, and disconnecting one leaves the other', async () => {
  const neonAuth = fakeOAuthServer({
    resource: 'https://mcp.neon.tech/mcp',
    issuer: 'https://mcp.neon.tech',
    declaredResource: 'https://mcp.neon.tech/mcp',
    scopes: ['read', 'write'],
    challengeScope: 'read write',
  })
  const testAuth = fakeOAuthServer({
    resource: 'https://mcp.test/mcp',
    issuer: 'https://mcp.test',
    declaredResource: 'https://mcp.test/mcp',
    scopes: ['read', 'write'],
    challengeScope: 'read write',
  })
  const request = (target, init = {}) => (String(target).startsWith('https://mcp.test') ? testAuth : neonAuth).fetch(target, init)
  const cards = {
    neon: neonInstance({ id: 'neon' }),
    'neon-2': neonInstance({ id: 'neon-2', override: { url: 'https://mcp.test/mcp' } }),
  }
  const credentials = fakeCredentials()
  const webServer = fakeWebServer()
  const ctx = fakeContext({ services: { credentials, webServer } })
  const authorized = []
  const flow = createOAuthFlow({
    ctx,
    connectorOf: id => cards[id],
    request,
    warn: () => {},
    redact: text => text,
    onAuthorized: id => { authorized.push(id) },
  })

  const start = async (id, level, settings) => {
    const started = await flow.start(id, { origin: 'https://dsh.test', level, settings })
    const state = new URL(started.authorizeUrl).searchParams.get('state')
    const { res, done } = fakeResponse()
    webServer.routes[0].handler({ method: 'GET', url: `${OAUTH_PREFIX}/${id}?code=code-${id}&state=${encodeURIComponent(state)}` }, res)
    const page = await done
    assert.equal(page.statusCode, 200, page.body)
    return started
  }

  await start('neon', 'read', {})
  await start('neon-2', 'write', { projectId: 'spring-brook-12345678', roleName: 'app_reader' })
  assert.deepEqual(authorized, ['neon', 'neon-2'])

  const first = credentials.records.get('ds-bot/connector-neon').payload
  const second = credentials.records.get('ds-bot/connector-neon-2').payload
  // Each grant carries its own address, level and scopes: the write card never inherits the
  // read card's grant, and the read card never sees the write scope.
  assert.ok(first.resource.startsWith('https://mcp.neon.tech/mcp?readonly=true&category=projects'))
  assert.deepEqual([first.level, first.scopes], ['read', ['read']])
  assert.deepEqual([second.level, second.scopes], ['write', ['read', 'write']])
  assert.ok(second.resource.startsWith('https://mcp.test/mcp?'))
  assert.ok(second.resource.includes('projectId=spring-brook-12345678'))
  assert.equal(second.resource.includes('readonly'), false)
  // Both records are addressed by instance id, and no token sits in a card definition.
  assert.equal(JSON.stringify(cards['neon-2']).includes(second.tokens.access), false)
  assert.equal(JSON.stringify(cards['neon']).includes(first.tokens.access), false)

  // Disconnecting neon-2 revokes its token and clears its record; the first card's grant is
  // untouched (no cross-instance fallback, no shared cleanup).
  const neonRequestsBefore = neonAuth.requests.length
  await flow.disconnect('neon-2')
  assert.equal(credentials.records.has('ds-bot/connector-neon-2'), false)
  assert.equal(credentials.records.has('ds-bot/connector-neon'), true)
  assert.ok(testAuth.requests.some(entry => entry.url === 'https://mcp.test/token' && entry.method === 'POST'
    && String(entry.body).includes(`token=${second.tokens.refresh}`)), 'neon-2 revoke went to its own server')
  // The other card's server saw no revoke at all.
  assert.ok(!neonAuth.requests.slice(neonRequestsBefore).some(entry => entry.method === 'POST' && String(entry.body).includes('token=')))
})

test('a write level that is not ready never takes the instance grant away', async () => {
  const oauth = fakeOAuthServer({
    resource: ADDRESS,
    issuer: 'https://mcp.neon.tech',
    declaredResource: 'https://mcp.neon.tech/mcp',
    scopes: ['read', 'write'],
    challengeScope: 'read write',
  })
  const credentials = fakeCredentials()
  const webServer = fakeWebServer()
  const ctx = fakeContext({ services: { credentials, webServer } })
  const card = neonInstance({ id: 'neon' })
  const flow = createOAuthFlow({ ctx, connectorOf: () => card, request: oauth.fetch, warn: () => {}, redact: text => text })

  const started = await flow.start('neon', { origin: 'https://dsh.test', level: 'read', settings: {} })
  const state = new URL(started.authorizeUrl).searchParams.get('state')
  const { res, done } = fakeResponse()
  webServer.routes[0].handler({ method: 'GET', url: `${OAUTH_PREFIX}/neon?code=code-neon&state=${encodeURIComponent(state)}` }, res)
  assert.equal((await done).statusCode, 200)
  const saved = credentials.records.get('ds-bot/connector-neon')

  // The level switch asks for the write grant first; without a project and role it must
  // refuse before the read grant is disconnected (3b hotfix invariant, per instance).
  await assert.rejects(flow.start('neon', { origin: 'https://dsh.test', level: 'write', settings: {} }), /project ID/)
  assert.deepEqual(credentials.records.get('ds-bot/connector-neon'), saved)
  assert.equal(new URL(saved.payload.mountUrl).searchParams.get('readonly'), 'true')
})

// --- multi-instance through the real connector host -------------------------
// These tests drive the framework the registry loads: two state keys, two grants, two tool
// prefixes. They are the integration half of the module-level isolation above.

const { apply } = await import('../index.js')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const INSTANCE_TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const NEON_GRANT = (resource, level, scopes, access) => ({
  kind: 'grant',
  payload: {
    version: 1,
    issuer: new URL(resource).origin,
    resource,
    client: { id: `client-${access}`, tokenAuth: 'none', redirectUri: 'https://dsh.test/oauth/ds-bot/neon' },
    tokens: { access, refresh: `refresh-${access}`, expiresAt: Date.now() + 3_600_000, tokenType: 'Bearer' },
    scopes,
    level,
    mountUrl: resource,
    authorizedAt: 1,
  },
})

// A Neon MCP server behind each grant: initialize, tools/list and tools/call.
function neonMcpServer() {
  return async (body) => {
    if (body.method === 'initialize') return mcpAnswer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Neon MCP', version: '1' } })
    if (body.method === 'notifications/initialized') return emptyAnswer()
    if (body.method === 'tools/list') return mcpAnswer(body.id, { tools: [...NEON_READ_TOOLS, ...NEON_WRITE_TOOLS.filter(name => name !== 'run_sql')].map(tool) })
    if (body.method === 'tools/call') return mcpAnswer(body.id, { content: [{ type: 'text', text: `${body.params.name} answered` }] })
    throw new Error(`unexpected method ${body.method}`)
  }
}

function neonInstanceHost({ state, credentials, config = {} }) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-neon-instances-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const registered = []
  const disposed = []
  const webServer = fakeWebServer()
  const ctx = fakeContext({ services: { credentials, webServer } })
  const fetchRegister = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return fetchRegister(route) }
  const toolRegister = ctx.tools.register
  ctx.tools.register = (tool) => {
    registered.push(tool.name)
    const undo = toolRegister(tool)
    return () => { disposed.push(tool.name); undo() }
  }
  apply(ctx, { home, ...config })
  registered.length = 0
  disposed.length = 0
  return { ctx, home, registered, disposed, webServer }
}

const callBot = async (ctx, endpoint, payload) => {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}

const untilReady = async (ctx, ids) => {
  for (let count = 0; count < 200; count += 1) {
    const view = (await callBot(ctx, 'state', {})).value.connectors.filter(item => ids.includes(item.id))
    if (view.length === ids.length && view.every(item => item.state === 'ready')) return view
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const everything = (await callBot(ctx, 'state', {})).value.connectors
  throw new Error(`timed out waiting for ${ids.join(', ')}: ${JSON.stringify(everything.filter(item => ids.includes(item.id)).map(item => [item.id, item.state, item.error]))}`)
}

test('two Neon cards mount from their own grants, and disconnecting one leaves the other', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const neonAuth = fakeOAuthServer({
    resource: 'https://mcp.neon.tech/mcp',
    issuer: 'https://mcp.neon.tech',
    declaredResource: 'https://mcp.neon.tech/mcp',
    scopes: ['read', 'write'],
    challengeScope: 'read write',
  })
  const testAuth = fakeOAuthServer({
    resource: 'https://mcp.test/mcp',
    issuer: 'https://mcp.test',
    declaredResource: 'https://mcp.test/mcp',
    scopes: ['read', 'write'],
    challengeScope: 'read write',
  })
  const neonCalls = []
  const testCalls = []
  const neonServe = neonMcpServer()
  const testServe = neonMcpServer()
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url)
    const isTest = address.startsWith('https://mcp.test/')
    const isNeon = address.startsWith('https://mcp.neon.tech/')
    if (!isTest && !isNeon) throw new Error(`unexpected fetch ${address}`)
    if (init.headers?.authorization === undefined) return (isTest ? testAuth : neonAuth).fetch(url, init)
    const body = JSON.parse(init.body)
    ;(isTest ? testCalls : neonCalls).push({ method: body.method, name: body.params?.name, authorization: init.headers.authorization })
    return (isTest ? testServe : neonServe)(body)
  }

  const credentials = fakeCredentials()
  const readUrl = neonInstance({ id: 'neon' }).authorize({ level: 'read', settings: {} }).url
  credentials.records.set('ds-bot/connector-neon', NEON_GRANT(readUrl, 'read', ['read'], 'access-neon'))
  const state = { ...INSTANCE_TEAM, connectors: { neon: { level: 'read', settings: {}, authorizedAt: 1 } } }
  const { ctx, home, registered, disposed, webServer } = neonInstanceHost({
    state,
    credentials,
    config: { 'neon-2': { url: 'https://mcp.test/mcp' } },
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const first = (await untilReady(ctx, ['neon']))[0]
  assert.deepEqual([first.instance.base, first.instance.id], ['neon', 'neon'])
  assert.equal(first.level, 'read')

  // A second card is one endpoint call: off, read level, nothing authorized yet.
  const added = await callBot(ctx, 'connector-create-instance', { base: 'neon' })
  assert.equal(added.ok, true, JSON.stringify(added))
  const secondRow = added.value.find(item => item.id === 'neon-2')
  assert.deepEqual([secondRow.state, secondRow.level, secondRow.instance.base, secondRow.instance.label], ['off', 'read', 'neon', 'Neon 2'])

  // Its own settings, then its own browser authorization at write level. The callback route
  // is per instance (`/oauth/ds-bot/neon-2`), so the two cards can never swap grants.
  const settings = { projectId: 'spring-brook-12345678', roleName: 'app_reader' }
  assert.equal((await callBot(ctx, 'connector-set-settings', { id: 'neon-2', values: settings })).ok, true)
  const authorize = async (id, level) => {
    const started = await callBot(ctx, 'connector-oauth-start', { id, level })
    assert.equal(started.ok, true, JSON.stringify(started))
    const url = new URL(started.value.authorizeUrl)
    assert.equal(url.searchParams.get('redirect_uri').endsWith(`/oauth/ds-bot/${id}`), true)
    const { res, done } = fakeResponse()
    webServer.routes[0].handler({ method: 'GET', url: `/oauth/ds-bot/${id}?code=code-${id}&state=${encodeURIComponent(url.searchParams.get('state'))}` }, res)
    assert.equal((await done).statusCode, 200)
    return url
  }
  const writeAuthorize = await authorize('neon-2', 'write')
  assert.equal(writeAuthorize.searchParams.get('scope'), 'read write')
  const view = await untilReady(ctx, ['neon', 'neon-2'])
  assert.deepEqual([view[0].level, view[1].level], ['read', 'write'])
  assert.deepEqual([view[1].settings.find(field => field.name === 'projectId').value], ['spring-brook-12345678'])

  // Each card mounts its own tools under its own id prefix; the write card alone has writes.
  assert.ok(registered.includes('neon_list_projects'))
  assert.ok(registered.includes('neon-2_list_projects'))
  assert.ok(registered.includes('neon-2_create_branch'))
  assert.ok(!registered.includes('neon_create_branch'))
  // Each mount used its own grant: the read card never saw the write token and vice versa.
  assert.ok(neonCalls.every(entry => entry.authorization === 'Bearer access-neon'))
  assert.ok(testCalls.every(entry => entry.authorization === 'Bearer access-1'))
  // The tokens stay in DSH's credential store: not in the team file, not in the view.
  const savedFile = readFileSync(join(home, 'state.json'), 'utf8')
  assert.ok(!savedFile.includes('access-neon') && !savedFile.includes('access-1'))
  assert.ok(!savedFile.includes('refresh-1'))
  assert.ok(!JSON.stringify(await callBot(ctx, 'state', {})).includes('access-1'))

  // A level switch on the write card revokes that card's grant and asks it to authorize
  // again; the read card's grant, state and tools are untouched.
  const switched = await callBot(ctx, 'connector-set-level', { id: 'neon-2', level: 'read' })
  assert.equal(switched.ok, true, JSON.stringify(switched))
  assert.equal(credentials.records.has('ds-bot/connector-neon-2'), false)
  assert.equal(credentials.records.has('ds-bot/connector-neon'), true)
  assert.equal(switched.value.find(item => item.id === 'neon-2').needsReauth, true)
  assert.equal(switched.value.find(item => item.id === 'neon').state, 'ready')
  assert.equal(credentials.records.get('ds-bot/connector-neon').payload.level, 'read')

  // Re-authorizing the second card at read level mounts it again; disconnecting it then
  // revokes only its own grant.
  await authorize('neon-2', 'read')
  await untilReady(ctx, ['neon', 'neon-2'])
  const disconnected = await callBot(ctx, 'connector-disconnect', { id: 'neon-2' })
  assert.equal(disconnected.ok, true, JSON.stringify(disconnected))
  assert.equal(credentials.records.has('ds-bot/connector-neon-2'), false)
  assert.equal(credentials.records.has('ds-bot/connector-neon'), true)
  assert.ok(disposed.includes('neon-2_list_projects'))
  assert.ok(!disposed.includes('neon_list_projects'))
  const kept = (await callBot(ctx, 'state', {})).value.connectors.find(item => item.id === 'neon')
  assert.equal(kept.state, 'ready')
  // Both revokes went to the second card's own authorization server.
  const revokes = testAuth.tokenRequests().filter(entry => String(entry.body).includes('token=') && !String(entry.body).includes('grant_type'))
  assert.equal(revokes.length, 2)
})

test('instances are created and removed without touching the others', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const neonAuth = fakeOAuthServer({ resource: 'https://mcp.neon.tech/mcp', issuer: 'https://mcp.neon.tech', declaredResource: 'https://mcp.neon.tech/mcp' })
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url)
    if (!address.startsWith('https://mcp.neon.tech/')) throw new Error(`unexpected fetch ${address}`)
    if (init.headers?.authorization === undefined) return neonAuth.fetch(url, init)
    return neonMcpServer()(JSON.parse(init.body))
  }
  const credentials = fakeCredentials()
  credentials.records.set('ds-bot/connector-neon', NEON_GRANT(neonInstance({ id: 'neon' }).authorize({ level: 'read', settings: {} }).url, 'read', ['read'], 'access-neon'))
  const state = { ...INSTANCE_TEAM, connectors: { neon: { level: 'read', settings: {}, authorizedAt: 1 } } }
  const { ctx, home, registered } = neonInstanceHost({ state, credentials })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await untilReady(ctx, ['neon'])

  // Adding a card writes state only: off, read level, no authorization.
  const added = await callBot(ctx, 'connector-create-instance', { base: 'neon' })
  assert.equal(added.ok, true, JSON.stringify(added))
  const off = added.value.find(item => item.id === 'neon-2')
  assert.deepEqual([off.state, off.level, off.instance.base], ['off', 'read', 'neon'])
  assert.equal(credentials.records.has('ds-bot/connector-neon-2'), false)
  // The new card has a label, and a rename changes only the label, not the id or the tools.
  const renamed = await callBot(ctx, 'connector-set-settings', { id: 'neon-2', values: { label: 'Staging DB' } })
  assert.equal(renamed.ok, true, JSON.stringify(renamed))
  const labeled = renamed.value.find(item => item.id === 'neon-2')
  assert.equal(labeled.instance.label, 'Staging DB')

  // A deleted instance never returns with its old id; the next card takes the next number.
  const removed = await callBot(ctx, 'connector-delete-instance', { id: 'neon-2' })
  assert.equal(removed.ok, true, JSON.stringify(removed))
  assert.equal(removed.value.some(item => item.id === 'neon-2'), false)
  const again = await callBot(ctx, 'connector-create-instance', { base: 'neon' })
  assert.equal(again.value.some(item => item.id === 'neon-3'), true)
  assert.equal(again.value.some(item => item.id === 'neon-2'), false)

  // The last card cannot be removed; the first card still mounts.
  const removedAgain = await callBot(ctx, 'connector-delete-instance', { id: 'neon-3' })
  assert.equal(removedAgain.ok, true, JSON.stringify(removedAgain))
  const last = await callBot(ctx, 'connector-delete-instance', { id: 'neon' })
  assert.equal(last.ok, false)
  assert.match(last.error.message, /keeps at least 1 instance/)
  assert.equal((await callBot(ctx, 'state', {})).value.connectors.find(item => item.id === 'neon').state, 'ready')
  assert.ok(registered.includes('neon_list_projects'))
})
