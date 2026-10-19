import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  OAuthError,
  authorizationUrl,
  exchangeCode,
  pkce,
  refreshAccess,
  registerClient,
  revoke,
  tokensFrom,
  VERIFIER_PATTERN,
} from '../src/host/oauth/client.js'

const answer = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: name => headers[String(name).toLowerCase()] ?? null },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
})

const metadata = {
  issuer: 'https://as.test',
  authorization_endpoint: 'https://as.test/authorize',
  token_endpoint: 'https://as.test/token',
  registration_endpoint: 'https://as.test/register',
  revocation_endpoint: 'https://as.test/token',
}

const noneClient = { id: 'client-1', tokenAuth: 'none', redirectUri: 'https://dsh.test/oauth/ds-bot/notion' }

test('pkce builds a verifier and its S256 challenge', () => {
  const pair = pkce()
  assert.match(pair.verifier, VERIFIER_PATTERN)
  assert.equal(pair.challenge, createHash('sha256').update(pair.verifier).digest('base64url'))
  // RFC 7636 Appendix B: the challenge of this verifier is the published value.
  assert.equal(createHash('sha256').update('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk').digest('base64url'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('the authorization URL carries PKCE, state, scopes and the resource', () => {
  const url = new URL(authorizationUrl({
    metadata,
    clientId: 'client-1',
    redirectUri: 'https://dsh.test/oauth/ds-bot/notion',
    state: 'state-1',
    challenge: 'challenge-1',
    scopes: ['default', ''],
    resource: 'https://mcp.test/mcp',
  }))
  assert.equal(url.origin + url.pathname, 'https://as.test/authorize')
  const params = url.searchParams
  assert.deepEqual(
    ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'].map(name => params.get(name)),
    ['code', 'client-1', 'https://dsh.test/oauth/ds-bot/notion', 'state-1', 'challenge-1', 'S256', 'default', 'https://mcp.test/mcp'],
  )
  // A server without an authorization endpoint cannot start a flow at all.
  assert.throws(() => authorizationUrl({ metadata: {}, clientId: 'c' }), /no authorization endpoint/)
})

test('client registration asks for a public client and keeps the answer', async () => {
  const seen = []
  const client = await registerClient({
    metadata,
    redirectUri: 'https://dsh.test/oauth/ds-bot/notion',
    request: async (url, init) => {
      seen.push({ url, init })
      return answer(201, { client_id: 'client-9', token_endpoint_auth_method: 'none', redirect_uris: ['https://dsh.test/oauth/ds-bot/notion'] })
    },
  })
  assert.deepEqual(client, { id: 'client-9', tokenAuth: 'none', redirectUri: 'https://dsh.test/oauth/ds-bot/notion' })
  assert.equal(seen[0].url, 'https://as.test/register')
  assert.equal(seen[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    client_name: 'DS Bot',
    redirect_uris: ['https://dsh.test/oauth/ds-bot/notion'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })

  const confidential = await registerClient({
    metadata,
    redirectUri: 'https://dsh.test/oauth/ds-bot/slack',
    request: async () => answer(201, { client_id: 'client-10', client_secret: 'secret-1', token_endpoint_auth_method: 'client_secret_post' }),
  })
  assert.deepEqual(confidential, { id: 'client-10', tokenAuth: 'client_secret_post', redirectUri: 'https://dsh.test/oauth/ds-bot/slack', secret: 'secret-1' })

  // RFC 7591 defaults a client that names no method to client_secret_basic when it has one.
  const fallback = await registerClient({ metadata, redirectUri: 'https://dsh.test/x', request: async () => answer(201, { client_id: 'client-11', client_secret: 'secret-2' }) })
  assert.equal(fallback.tokenAuth, 'client_secret_basic')

  await assert.rejects(registerClient({ metadata: {}, redirectUri: 'https://x.test/' }), /cannot register by itself/)
  await assert.rejects(registerClient({ metadata, redirectUri: 'https://x.test/', request: async () => answer(201, {}) }), /did not register DS Bot/)
  await assert.rejects(registerClient({ metadata, redirectUri: 'https://x.test/', request: async () => answer(201, { client_id: 'c', token_endpoint_auth_method: 'private_key_jwt' }) }), /does not support/)
  await assert.rejects(registerClient({ metadata, redirectUri: 'https://x.test/', request: async () => answer(201, { client_id: 'c', token_endpoint_auth_method: 'client_secret_post' }) }), /without a client secret/)
  await assert.rejects(registerClient({ metadata, redirectUri: 'https://x.test/', request: async () => answer(400, { error: 'invalid_redirect_uri' }) }), /answered 400 \(invalid_redirect_uri\)/)
})

test('the authorization code is exchanged with PKCE and the resource', async () => {
  const seen = []
  const tokens = await exchangeCode({
    metadata,
    client: noneClient,
    code: 'code-1',
    verifier: 'verifier-'.padEnd(51, 'x'),
    redirectUri: 'https://dsh.test/oauth/ds-bot/notion',
    resource: 'https://mcp.test/mcp',
    now: 1000,
    request: async (url, init) => {
      seen.push({ url, init })
      return answer(200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 60, scope: 'default' })
    },
  })
  assert.equal(seen[0].url, 'https://as.test/token')
  assert.equal(seen[0].init.headers['content-type'], 'application/x-www-form-urlencoded')
  const form = new URLSearchParams(seen[0].init.body)
  assert.deepEqual(
    ['grant_type', 'code', 'redirect_uri', 'code_verifier', 'client_id', 'resource'].map(name => form.get(name)),
    ['authorization_code', 'code-1', 'https://dsh.test/oauth/ds-bot/notion', 'verifier-'.padEnd(51, 'x'), 'client-1', 'https://mcp.test/mcp'],
  )
  assert.deepEqual(tokens, { access: 'access-1', refresh: 'refresh-1', expiresAt: 61_000, scope: 'default', tokenType: 'Bearer' })

  // A provider that hands out a secret gets it back on the token call.
  const confidential = await exchangeCode({
    metadata,
    client: { id: 'client-2', tokenAuth: 'client_secret_post', secret: 'secret-2', redirectUri: 'https://dsh.test/x' },
    code: 'code-2',
    verifier: 'verifier-'.padEnd(51, 'x'),
    redirectUri: 'https://dsh.test/x',
    request: async (url, init) => {
      seen.push({ url, init })
      return answer(200, { access_token: 'access-2', expires_in: 0 })
    },
  })
  const form2 = new URLSearchParams(seen[1].init.body)
  assert.equal(form2.get('client_secret'), 'secret-2')
  // No expires_in means the token has no stated lifetime; a 401 asks for a refresh later.
  assert.deepEqual(confidential, { access: 'access-2', tokenType: 'Bearer' })

  // client_secret_basic travels in the Authorization header, form-encoded.
  await exchangeCode({
    metadata,
    client: { id: 'client id', tokenAuth: 'client_secret_basic', secret: 'secret/3', redirectUri: 'https://dsh.test/x' },
    code: 'code-3',
    verifier: 'verifier-'.padEnd(51, 'x'),
    redirectUri: 'https://dsh.test/x',
    request: async (url, init) => {
      seen.push({ url, init })
      return answer(200, { access_token: 'access-3' })
    },
  })
  assert.equal(seen[2].init.headers.authorization, `Basic ${Buffer.from('client%20id:secret%2F3').toString('base64')}`)
})

test('a refused exchange says why without repeating the code', async () => {
  const request = async () => answer(400, { error: 'invalid_grant', error_description: 'code code-1 is bad' })
  await assert.rejects(
    exchangeCode({ metadata, client: noneClient, code: 'code-1', verifier: 'verifier-'.padEnd(51, 'x'), redirectUri: 'https://x.test/', request }),
    (error) => {
      assert.equal(error.code, 'oauth/invalid_grant')
      assert.match(error.message, /connect again/)
      assert.ok(!error.message.includes('code-1'))
      return true
    },
  )
  await assert.rejects(exchangeCode({ metadata, client: noneClient, code: '', verifier: 'verifier-'.padEnd(51, 'x'), redirectUri: 'https://x.test/', request }), /no authorization code/)
  await assert.rejects(exchangeCode({ metadata, client: noneClient, code: 'c', verifier: 'short', redirectUri: 'https://x.test/', request }), /lost the request/)
  await assert.rejects(exchangeCode({ metadata: {}, client: noneClient, code: 'c', verifier: 'verifier-'.padEnd(51, 'x'), redirectUri: 'https://x.test/', request }), /no token endpoint/)
})

test('network, protocol and server failures stay readable', async () => {
  const fields = { metadata, client: noneClient, code: 'c', verifier: 'verifier-'.padEnd(51, 'x'), redirectUri: 'https://x.test/' }
  await assert.rejects(exchangeCode({ ...fields, request: async () => { throw new Error('offline') } }), (error) => error.code === 'oauth/network' && /offline/.test(error.message))
  await assert.rejects(exchangeCode({ ...fields, request: async () => answer(500, { error: 'server_error' }) }), /answered 500 \(server_error\)/)
  await assert.rejects(exchangeCode({ ...fields, request: async () => answer(200, undefined) }), /answered no JSON/)
  await assert.rejects(exchangeCode({ ...fields, request: async () => answer(200, {}) }), /no access token/)
})

test('refresh keeps the old refresh token when the provider rotates nothing', async () => {
  const seen = []
  const tokens = await refreshAccess({
    metadata,
    client: noneClient,
    refreshToken: 'refresh-1',
    resource: 'https://mcp.test/mcp',
    previous: { access: 'access-1', refresh: 'refresh-1' },
    now: 2000,
    request: async (url, init) => {
      seen.push(init)
      return answer(200, { access_token: 'access-2', expires_in: 3600 })
    },
  })
  const form = new URLSearchParams(seen[0].body)
  assert.deepEqual(['grant_type', 'refresh_token', 'client_id', 'resource'].map(name => form.get(name)), ['refresh_token', 'refresh-1', 'client-1', 'https://mcp.test/mcp'])
  assert.deepEqual(tokens, { access: 'access-2', refresh: 'refresh-1', expiresAt: 2000 + 3_600_000, tokenType: 'Bearer' })

  await assert.rejects(refreshAccess({ metadata, client: noneClient, refreshToken: '' }), (error) => error.code === 'oauth/reconnect')
})

test('revocation is best effort and never throws', async () => {
  const seen = []
  const revoked = await revoke({
    metadata,
    client: noneClient,
    token: 'refresh-1',
    request: async (url, init) => {
      seen.push({ url, init })
      return answer(200, undefined)
    },
  })
  assert.equal(revoked, true)
  assert.equal(seen[0].url, 'https://as.test/token')
  const form = new URLSearchParams(seen[0].init.body)
  assert.deepEqual(['token', 'token_type_hint', 'client_id'].map(name => form.get(name)), ['refresh-1', 'refresh_token', 'client-1'])
  assert.equal(await revoke({ metadata, client: noneClient, token: 't', request: async () => { throw new Error('offline') } }), false)
  assert.equal(await revoke({ metadata: {}, client: noneClient, token: 't' }), false)
  assert.equal(await revoke({ metadata, client: noneClient, token: '' }), false)
})

test('tokensFrom reads the token shape the store keeps', () => {
  assert.deepEqual(tokensFrom({ access_token: 'a' }, { now: 10 }), { access: 'a', tokenType: 'Bearer' })
  assert.deepEqual(
    tokensFrom({ access_token: 'a', refresh_token: 'r', expires_in: '60' }, { now: 10 }),
    { access: 'a', refresh: 'r', expiresAt: 60_010, tokenType: 'Bearer' },
  )
  assert.throws(() => tokensFrom({}), (error) => error instanceof OAuthError && error.code === 'oauth/token')
})
