// A local Neon-shaped MCP server with its own OAuth authorization server, for acceptance
// shots and for the QA baseline. It answers what the connector's OAuth client discovers
// (protected-resource and authorization-server metadata), registers a public client,
// approves the browser authorization by itself, and speaks enough MCP for a mount:
// initialize, tools/list and tools/call.
//
// The catalog follows the published Neon tool names and the read-only query parameter:
// `?readonly=true` lists only reads, a write grant gets the four P1 writes plus decoys that
// a whitelist must drop. The debug endpoints exist only here, in dev/, never in the plugin.
//
// HTTPS with a self-signed certificate, because a connector address must be https. The DSH
// the connector runs in is started with NODE_TLS_REJECT_UNAUTHORIZED=0 for the bench only.
//
//   node dev/neon-mock.mjs <port> [approve-delay-ms]
//
// Debug (dev-only, never shipped):
//   GET  /debug/last-authorize   the query the authorization page was opened with
//   GET  /debug/calls            every tools/list and tools/call the connector sent
//   GET  /debug/dcr              dynamic client registrations served so far
//   POST /debug/reset            clear the call log and counters
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 8912)
const approveDelayMs = Number(process.argv[3] ?? 1200)
const origin = `https://127.0.0.1:${port}`

const READ_TOOLS = [
  'list_organizations',
  'list_projects',
  'describe_project',
  'list_branches',
  'describe_branch',
  'get_default_branch',
  'list_postgres_databases',
  'list_postgres_roles',
  'list_postgres_endpoints',
  'list_branch_computes',
  'get_database_tables',
  'describe_table_schema',
  'run_sql',
  'explain_sql_statement',
  'list_slow_queries',
  'inspect_database',
]
// The four writes the write level must register, plus writes and a secret-bearing read a
// whitelist has to drop even though the server offers them.
const WRITE_TOOLS = ['create_branch', 'create_snapshot', 'delete_branch']
const DECOY_TOOLS = ['update_branch', 'delete_project', 'get_connection_string', 'list_credentials', 'run_sql_transaction']
const BRANCHES = [{ id: 'br-main', name: 'main', default: true }, { id: 'br-feature', name: 'feature-copy' }]

const dir = mkdtempSync(join(tmpdir(), 'neon-mock-'))
const key = join(dir, 'key.pem')
const cert = join(dir, 'cert.pem')
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
  '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert,
], { stdio: 'ignore' })

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
const bodyOf = async (req) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
const tool = name => ({ name, description: `Neon ${name}`, inputSchema: { type: 'object', properties: {} } })

const codes = new Map()
const debug = { authorize: null, calls: [], dcr: 0, tokens: 0 }
const live = new Set()
let issued = 0

const metadata = {
  issuer: origin,
  authorization_endpoint: `${origin}/authorize`,
  token_endpoint: `${origin}/token`,
  registration_endpoint: `${origin}/register`,
  revocation_endpoint: `${origin}/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['read', 'write'],
}
const protectedResource = {
  resource: `${origin}/mcp`,
  authorization_servers: [origin],
  scopes_supported: ['read', 'write'],
  bearer_methods_supported: ['header'],
}

// What one grant may see: a read-only grant lists the reads only; a write grant also lists
// the writes and the decoys, so a mount that registers more than its whitelist is visible.
const catalogOf = (readOnly) => readOnly
  ? READ_TOOLS.map(tool)
  : [...READ_TOOLS, ...WRITE_TOOLS, ...DECOY_TOOLS].map(tool)

async function mcp(req, res) {
  const url = new URL(req.url ?? '/', origin)
  const authorization = req.headers.authorization
  const token = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '') : ''
  if (!live.has(token)) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
    })
    res.end('{}')
    return
  }
  const message = JSON.parse(await bodyOf(req))
  const readOnly = url.searchParams.get('readonly') === 'true'
  if (message.id === undefined) {
    res.writeHead(202)
    res.end()
    return
  }
  const answer = (result) => {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mock-session' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  }
  switch (message.method) {
    case 'initialize':
      answer({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'neon-mock', version: '1' },
        ...(readOnly ? {} : { instructions: 'write grant' }),
      })
      return
    case 'tools/list':
      debug.calls.push({ kind: 'tools/list', readOnly, at: Date.now() })
      answer({ tools: catalogOf(readOnly) })
      return
    case 'tools/call': {
      const name = String(message.params?.name ?? '')
      const args = message.params?.arguments ?? {}
      debug.calls.push({ kind: 'tools/call', name, args, readOnly, at: Date.now() })
      if (name === 'list_branches') {
        answer({ content: [{ type: 'text', text: JSON.stringify({ branches: BRANCHES }) }] })
        return
      }
      if (name === 'list_organizations') {
        answer({ content: [{ type: 'text', text: JSON.stringify({ organizations: [{ id: 'org-1', name: 'Acme' }] }) }] })
        return
      }
      answer({ content: [{ type: 'text', text: `mock ${name} ${JSON.stringify(args)}` }] })
      return
    }
    default:
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } }))
  }
}

const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
  const url = new URL(req.url ?? '/', origin)
  const path = url.pathname
  if (path === '/mcp') return mcp(req, res)
  if (path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource') return json(res, 200, protectedResource)
  if (path === '/.well-known/oauth-authorization-server') return json(res, 200, metadata)
  if (path === '/register' && req.method === 'POST') {
    const request = JSON.parse(await bodyOf(req))
    debug.dcr += 1
    return json(res, 201, { client_id: 'neon-mock-client', token_endpoint_auth_method: 'none', redirect_uris: request.redirect_uris })
  }
  if (path === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri')
    if (redirectUri === null) return json(res, 400, { error: 'invalid_request' })
    // A new authorization replaces the grant: tokens issued before it stop working.
    // The grant parameters live in the `resource` URL, as Neon's server reads them.
    live.clear()
    const resource = new URL(url.searchParams.get('resource') ?? origin)
    debug.authorize = {
      resource: resource.href,
      readonly: resource.searchParams.getAll('readonly'),
      categories: resource.searchParams.getAll('category'),
      projectId: resource.searchParams.get('projectId'),
      roleName: resource.searchParams.get('roleName'),
      scope: url.searchParams.get('scope'),
      at: Date.now(),
    }
    const code = `code-${issued += 1}`
    codes.set(code, { redirectUri })
    setTimeout(() => {
      res.writeHead(302, { location: `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}&iss=${encodeURIComponent(origin)}` })
      res.end()
    }, approveDelayMs)
    return
  }
  if (path === '/token' && req.method === 'POST') {
    const form = new URLSearchParams(await bodyOf(req))
    const code = form.get('code')
    if (form.get('grant_type') === 'authorization_code') {
      if (code === null || !codes.has(code)) return json(res, 400, { error: 'invalid_grant' })
      codes.delete(code)
    }
    debug.tokens += 1
    const access = `mock-access-${issued += 1}`
    live.add(access)
    return json(res, 200, {
      access_token: access,
      refresh_token: `mock-refresh-${debug.tokens}`,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read write',
    })
  }
  if (path === '/revoke' && req.method === 'POST') {
    await bodyOf(req)
    live.clear()
    return json(res, 200, {})
  }
  // Dev-only observation endpoints; the plugin never calls these.
  if (path === '/debug/last-authorize') return json(res, 200, debug.authorize)
  if (path === '/debug/calls') return json(res, 200, debug.calls)
  if (path === '/debug/dcr') return json(res, 200, { registrations: debug.dcr })
  if (path === '/debug/reset' && req.method === 'POST') {
    debug.calls = []
    debug.dcr = 0
    debug.tokens = 0
    debug.authorize = null
    return json(res, 200, { ok: true })
  }
  json(res, 404, { error: 'not_found' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`neon mock: ${origin}/mcp  (authorize delay ${approveDelayMs} ms)  debug: ${origin}/debug/calls`)
})
