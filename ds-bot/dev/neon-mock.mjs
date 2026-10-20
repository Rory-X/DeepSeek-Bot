// A local Neon-shaped MCP server with its own OAuth authorization server, for acceptance
// shots and black-box checks without a Neon account. It answers what the connector's OAuth
// client discovers (protected-resource and authorization-server metadata), registers a public
// client, approves the browser authorization by itself, and speaks enough MCP for a mount:
// initialize, tools/list (the read tools plus write tools a wrong grant would expose) and
// tools/call.
//
// HTTPS with a self-signed certificate, because a connector address must be https. The DSH
// the connector runs in is started with NODE_TLS_REJECT_UNAUTHORIZED=0 for the bench only.
//
//   node dev/neon-mock.mjs <port> [delay-ms]
//
// The delay (default 1200) is how long /authorize waits before sending the browser back, so a
// screenshot can catch the card waiting for the browser.
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
// What a read-only grant must hide, listed by the mock so a mount can be seen to drop them.
const WRITE_TOOLS = ['create_project', 'delete_project', 'create_branch', 'delete_branch', 'run_sql_transaction', 'get_connection_string']

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

async function mcp(req, res) {
  const authorization = req.headers.authorization
  if (authorization === undefined) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
    })
    res.end('{}')
    return
  }
  const message = JSON.parse(await bodyOf(req))
  const answer = (result) => {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mock-session' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  }
  if (message.id === undefined) {
    res.writeHead(202)
    res.end()
    return
  }
  switch (message.method) {
    case 'initialize':
      answer({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'neon-mock', version: '1' } })
      return
    case 'tools/list':
      answer({ tools: [...READ_TOOLS, ...WRITE_TOOLS].map(tool) })
      return
    case 'tools/call':
      answer({ content: [{ type: 'text', text: `mock ${message.params?.name} ${JSON.stringify(message.params?.arguments ?? {})}` }] })
      return
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
    return json(res, 201, { client_id: 'neon-mock-client', token_endpoint_auth_method: 'none', redirect_uris: request.redirect_uris })
  }
  if (path === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri')
    if (redirectUri === null) return json(res, 400, { error: 'invalid_request' })
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
    issued += 1
    return json(res, 200, {
      access_token: `mock-access-${issued}`,
      refresh_token: `mock-refresh-${issued}`,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read',
    })
  }
  if (path === '/revoke' && req.method === 'POST') {
    await bodyOf(req)
    return json(res, 200, {})
  }
  json(res, 404, { error: 'not_found' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`neon mock: ${origin}/mcp  (authorize delay ${approveDelayMs} ms)`)
})
