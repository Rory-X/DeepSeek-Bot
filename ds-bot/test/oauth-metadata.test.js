import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDiscovery, normalizeOrigin, normalizeResource, parseChallenge } from '../src/host/oauth/metadata.js'

const answer = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: name => headers[String(name).toLowerCase()] ?? null },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
})

const protectedResource = {
  resource: 'https://mcp.test/mcp',
  authorization_servers: ['https://mcp.test'],
  scopes_supported: ['read', 'write'],
  bearer_methods_supported: ['header'],
}

const authorizationServer = {
  issuer: 'https://mcp.test',
  authorization_endpoint: 'https://mcp.test/authorize',
  token_endpoint: 'https://mcp.test/token',
  registration_endpoint: 'https://mcp.test/register',
  code_challenge_methods_supported: ['S256'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
}

// One MCP endpoint and its metadata, recording each request.
function bench({ challenge = `Bearer realm="OAuth", resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="user:read account:read"`, prm = protectedResource, as = authorizationServer, prmStatus = 200 } = {}) {
  const requests = []
  const request = async (url, init = {}) => {
    const address = String(url)
    requests.push({ url: address, method: init.method ?? 'GET' })
    if (address === 'https://mcp.test/mcp' && init.method === 'POST') {
      return { status: 401, ok: false, headers: { get: name => (String(name).toLowerCase() === 'www-authenticate' ? challenge : null) }, text: async () => '' }
    }
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') return answer(prmStatus, prm)
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource') return answer(404, undefined)
    if (address === 'https://mcp.test/.well-known/oauth-authorization-server') return answer(200, as)
    if (address === 'https://mcp.test/.well-known/openid-configuration') return answer(404, undefined)
    throw new Error(`unexpected request ${address}`)
  }
  return { request, requests }
}

test('discovery reads the challenge, the resource metadata and the server metadata', async () => {
  const { request, requests } = bench()
  const discovery = createDiscovery({ request })
  const found = await discovery.discover('https://mcp.test/mcp')
  assert.equal(found.resource, 'https://mcp.test/mcp')
  // The challenge's scope wins over the resource metadata's supported list.
  assert.deepEqual(found.scopes, ['user:read', 'account:read'])
  assert.equal(found.authorizationServer.token_endpoint, 'https://mcp.test/token')
  assert.deepEqual(requests.map(entry => entry.url), [
    'https://mcp.test/mcp',
    'https://mcp.test/.well-known/oauth-protected-resource/mcp',
    'https://mcp.test/.well-known/oauth-authorization-server',
  ])
})

test('discovery goes on without a challenge and falls back to the metadata scope list', async () => {
  const { request } = bench({ challenge: null })
  const found = await createDiscovery({ request }).discover('https://mcp.test/mcp')
  assert.deepEqual(found.scopes, ['read', 'write'])
})

test('the well-known address without the path is the fallback', async () => {
  const requests = []
  const request = async (url, init = {}) => {
    const address = String(url)
    requests.push({ url: address, method: init.method ?? 'GET' })
    if (address === 'https://mcp.test/mcp') return { status: 401, ok: false, headers: { get: () => 'Bearer realm="OAuth"' }, text: async () => '' }
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') return answer(404, undefined)
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource') return answer(200, protectedResource)
    if (address === 'https://mcp.test/.well-known/oauth-authorization-server') return answer(200, authorizationServer)
    throw new Error(`unexpected request ${address}`)
  }
  const found = await createDiscovery({ request }).discover('https://mcp.test/mcp')
  assert.deepEqual(requests.map(entry => entry.url), [
    'https://mcp.test/mcp',
    'https://mcp.test/.well-known/oauth-protected-resource/mcp',
    'https://mcp.test/.well-known/oauth-protected-resource',
    'https://mcp.test/.well-known/oauth-authorization-server',
  ])
  assert.deepEqual(found.scopes, ['read', 'write'])
})

test('metadata for another resource is not used', async () => {
  const requests = []
  const request = async (url) => {
    const address = String(url)
    requests.push(address)
    if (address === 'https://mcp.test/mcp') return { status: 401, ok: false, headers: { get: () => 'Bearer realm="OAuth", resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"' }, text: async () => '' }
    // The challenge points at metadata for the bare origin, not for /mcp.
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource') return answer(200, { ...protectedResource, resource: 'https://mcp.test' })
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') return answer(404, undefined)
    throw new Error(`unexpected request ${address}`)
  }
  await assert.rejects(createDiscovery({ request }).discover('https://mcp.test/mcp'), /authorization metadata/)
  // The mismatched answer is skipped, not accepted, and no authorization server is read.
  assert.deepEqual(requests, [
    'https://mcp.test/mcp',
    'https://mcp.test/.well-known/oauth-protected-resource',
    'https://mcp.test/.well-known/oauth-protected-resource/mcp',
  ])
})

test('a server metadata answer for another issuer is skipped, OpenID configuration is the fallback', async () => {
  const requests = []
  const request = async (url, init = {}) => {
    const address = String(url)
    requests.push(address)
    if (address === 'https://mcp.test/mcp' && init.method === 'POST') return { status: 401, ok: false, headers: { get: () => undefined }, text: async () => '' }
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') return answer(200, protectedResource)
    if (address === 'https://mcp.test/.well-known/oauth-authorization-server') return answer(200, { ...authorizationServer, issuer: 'https://other.test' })
    if (address === 'https://mcp.test/.well-known/openid-configuration') return answer(200, authorizationServer)
    throw new Error(`unexpected request ${address}`)
  }
  const found = await createDiscovery({ request }).discover('https://mcp.test/mcp')
  assert.equal(found.authorizationServer.issuer, 'https://mcp.test')
  assert.ok(requests.includes('https://mcp.test/.well-known/openid-configuration'))
})

test('a resource with a query accepts metadata for its origin and path', async () => {
  const requests = []
  const request = async (url, init = {}) => {
    const address = String(url)
    requests.push(address)
    if (address === 'https://mcp.test/mcp?codemode=false' && init.method === 'POST') {
      return { status: 401, ok: false, headers: { get: () => `Bearer realm="OAuth", resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"` }, text: async () => '' }
    }
    // Cloudflare-style metadata names the path without the query the client uses.
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') return answer(200, protectedResource)
    if (address === 'https://mcp.test/.well-known/oauth-authorization-server') return answer(200, authorizationServer)
    throw new Error(`unexpected request ${address}`)
  }
  const found = await createDiscovery({ request }).discover('https://mcp.test/mcp?codemode=false')
  assert.equal(found.resource, 'https://mcp.test/mcp?codemode=false')
  // The well-known lookup ignores the query.
  assert.equal(requests[1], 'https://mcp.test/.well-known/oauth-protected-resource/mcp')
})

test('a query on the metadata must agree with a query the client names', async () => {
  const seen = []
  const request = async (url) => {
    const address = String(url)
    seen.push(address)
    if (address === 'https://mcp.test/mcp?codemode=false') return { status: 401, ok: false, headers: { get: () => undefined }, text: async () => '' }
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') return answer(200, { ...protectedResource, resource: 'https://mcp.test/mcp?other=1' })
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource') return answer(200, { ...protectedResource, resource: 'https://mcp.test/mcp?other=1' })
    throw new Error(`unexpected request ${address}`)
  }
  await assert.rejects(createDiscovery({ request }).discover('https://mcp.test/mcp?codemode=false'), /authorization metadata/)
  assert.ok(seen.includes('https://mcp.test/.well-known/oauth-protected-resource/mcp'))
})

test('a resource without a query still has to match the metadata exactly', async () => {
  const request = async (url) => {
    const address = String(url)
    if (address === 'https://mcp.test/mcp') return { status: 401, ok: false, headers: { get: () => undefined }, text: async () => '' }
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') return answer(200, { ...protectedResource, resource: 'https://mcp.test/mcp?codemode=false' })
    if (address === 'https://mcp.test/.well-known/oauth-protected-resource') return answer(200, { ...protectedResource, resource: 'https://mcp.test/mcp?codemode=false' })
    throw new Error(`unexpected request ${address}`)
  }
  await assert.rejects(createDiscovery({ request }).discover('https://mcp.test/mcp'), /authorization metadata/)
})

test('a server without S256 is not usable', async () => {
  const { request } = bench({ as: { ...authorizationServer, code_challenge_methods_supported: ['plain'] } })
  await assert.rejects(createDiscovery({ request }).discover('https://mcp.test/mcp'), /Could not read the metadata/)
})

test('discovery is cached, then looked up again after the cache expires', async () => {
  const { request, requests } = bench()
  let clock = 0
  const discovery = createDiscovery({ request, now: () => clock, cacheMs: 1000 })
  await discovery.discover('https://mcp.test/mcp')
  await discovery.discover('https://mcp.test/mcp')
  assert.equal(requests.length, 3)
  clock = 1001
  await discovery.discover('https://mcp.test/mcp')
  assert.equal(requests.length, 6)
})

test('addresses must be https, except a server on this computer', () => {
  assert.equal(normalizeResource('https://mcp.test/mcp'), 'https://mcp.test/mcp')
  assert.equal(normalizeResource('http://127.0.0.1:8787/mcp'), 'http://127.0.0.1:8787/mcp')
  assert.throws(() => normalizeResource('http://mcp.test/mcp'), /https/)
  assert.throws(() => normalizeResource('not a url'), /valid server address/)
  // A query can select a server mode; a fragment or credentials cannot.
  assert.equal(normalizeResource('https://mcp.test/mcp?codemode=false'), 'https://mcp.test/mcp?codemode=false')
  assert.throws(() => normalizeResource('https://mcp.test/mcp#x'), /plain URL/)
  assert.throws(() => normalizeResource('https://user:key@mcp.test/mcp'), /plain URL/)
})

test('an authorization may come back over https or to this computer only', () => {
  assert.equal(normalizeOrigin('https://dsh.test'), 'https://dsh.test')
  assert.equal(normalizeOrigin('https://dsh.test/'), 'https://dsh.test')
  assert.equal(normalizeOrigin('http://127.0.0.1:19387'), 'http://127.0.0.1:19387')
  assert.equal(normalizeOrigin('http://localhost:19387'), 'http://localhost:19387')
  // Only the origin matters; an accidental path is dropped.
  assert.equal(normalizeOrigin('https://dsh.test/path'), 'https://dsh.test')
  assert.throws(() => normalizeOrigin('http://dsh.test'), /https or to this computer/)
  assert.throws(() => normalizeOrigin('nonsense'), /cannot tell/)
})

test('a Bearer challenge is read in its quoted and bare forms', () => {
  assert.deepEqual(parseChallenge('Bearer realm="OAuth", resource_metadata="https://m.test/meta", scope="a b"'), { resourceMetadata: 'https://m.test/meta', scopes: ['a', 'b'] })
  assert.deepEqual(parseChallenge('Bearer resource_metadata=https://m.test/meta'), { resourceMetadata: 'https://m.test/meta' })
  assert.equal(parseChallenge('Basic realm="x"'), undefined)
  assert.equal(parseChallenge(undefined), undefined)
})
