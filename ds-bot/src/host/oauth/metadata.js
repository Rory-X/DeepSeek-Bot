// Who authorizes a connector's server: RFC 9728 protected-resource metadata (which names
// the authorization server and the scopes it wants) and RFC 8414 authorization-server
// metadata (the endpoints). An MCP server without a token answers 401 with a
// WWW-Authenticate challenge that may point at its metadata; the well-known addresses are
// the fallback. Answers are cached for ten minutes, so a mount and a later refresh do not
// repeat the lookup.
import { OAuthError } from './client.js'

const REQUEST_TIMEOUT_MS = 10_000
const CACHE_MS = 10 * 60 * 1000
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

const secureAddress = (value) => {
  let url
  try {
    url = new URL(String(value))
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '') return false
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
}

export function normalizeResource(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new OAuthError('The connector has no valid server address', 'resource')
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '' || url.search !== '') {
    throw new OAuthError('The connector server address must be a plain URL', 'resource')
  }
  if (!secureAddress(url.href)) throw new OAuthError('The connector server address must start with https://', 'resource')
  return url.href
}

export function normalizeOrigin(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new OAuthError('DS Bot cannot tell where to receive the authorization', 'origin')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new OAuthError('DS Bot cannot tell where to receive the authorization', 'origin')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new OAuthError('The authorization must come back over https or to this computer', 'origin')
  }
  return url.origin
}

// The Bearer challenge's `resource_metadata` and `scope` parameters. The header may quote
// them or not; both forms appear in the wild.
export function parseChallenge(header) {
  if (typeof header !== 'string' || header === '') return undefined
  const param = (name) => {
    const quoted = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(header)
    if (quoted !== null) return quoted[1]
    const bare = new RegExp(`${name}\\s*=\\s*([^,\\s]+)`, 'i').exec(header)
    return bare?.[1]
  }
  const resourceMetadata = param('resource_metadata')
  const scope = param('scope')
  if (resourceMetadata === undefined && scope === undefined) return undefined
  return {
    ...(resourceMetadata === undefined ? {} : { resourceMetadata }),
    ...(scope === undefined ? {} : { scopes: scope.split(/\s+/).filter(value => value !== '') }),
  }
}

async function getJson(url, request) {
  let response
  try {
    response = await request(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }
  if (response.status !== 200) return undefined
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text)
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : undefined
  } catch {
    return undefined
  }
}

// An unauthenticated MCP initialize is exactly the request that makes the server say what
// it wants authorized; a server that answers 200 needs no OAuth at all.
async function challengeOf(resource, request) {
  let response
  try {
    response = await request(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ds-bot', version: '1' } } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }
  if (response.status !== 401) return undefined
  return parseChallenge(response.headers?.get?.('www-authenticate'))
}

const wellKnown = (address, name) => {
  const url = new URL(address)
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  return `${url.origin}/.well-known/${name}${path}`
}

const protectedResourceUrls = (resource, challenge) => {
  const url = new URL(resource)
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  const candidates = [
    ...(challenge?.resourceMetadata === undefined ? [] : [challenge.resourceMetadata]),
    `${url.origin}/.well-known/oauth-protected-resource${path}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ]
  return [...new Set(candidates)]
}

const validProtectedResource = (body, resource) => {
  if (body === undefined) return false
  if (!Array.isArray(body.authorization_servers) || body.authorization_servers.length === 0) return false
  if (typeof body.resource === 'string' && body.resource !== '' && normalizeOrUndefined(body.resource) !== resource) return false
  return true
}

const normalizeOrUndefined = (value) => {
  try {
    return normalizeResource(value)
  } catch {
    return undefined
  }
}

const validAuthorizationServer = (body, issuer) => {
  if (body === undefined) return false
  if (typeof body.issuer !== 'string' || body.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) return false
  for (const field of ['authorization_endpoint', 'token_endpoint']) {
    if (typeof body[field] !== 'string' || !secureAddress(body[field])) return false
  }
  for (const field of ['registration_endpoint', 'revocation_endpoint']) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || !secureAddress(body[field]))) return false
  }
  if (Array.isArray(body.code_challenge_methods_supported) && !body.code_challenge_methods_supported.includes('S256')) return false
  if (Array.isArray(body.response_types_supported) && !body.response_types_supported.includes('code')) return false
  if (Array.isArray(body.grant_types_supported) && !body.grant_types_supported.includes('authorization_code')) return false
  return true
}

const scopesOf = (protectedResource, challenge) => {
  if (Array.isArray(challenge?.scopes) && challenge.scopes.length > 0) return challenge.scopes
  if (Array.isArray(protectedResource.scopes_supported)) return protectedResource.scopes_supported.filter(scope => typeof scope === 'string' && scope !== '')
  return []
}

async function discoverResource(resource, request) {
  const challenge = await challengeOf(resource, request)
  let protectedResource
  for (const candidate of protectedResourceUrls(resource, challenge)) {
    if (!secureAddress(candidate)) continue
    const body = await getJson(candidate, request)
    if (!validProtectedResource(body, resource)) continue
    protectedResource = body
    break
  }
  if (protectedResource === undefined) {
    throw new OAuthError('Could not find the authorization metadata of this connector server', 'discovery')
  }
  const issuers = protectedResource.authorization_servers.filter(address => secureAddress(address))
  if (issuers.length === 0) throw new OAuthError('The connector server names no authorization server', 'discovery')
  for (const issuer of issuers) {
    for (const candidate of [wellKnown(issuer, 'oauth-authorization-server'), wellKnown(issuer, 'openid-configuration')]) {
      const body = await getJson(candidate, request)
      if (!validAuthorizationServer(body, issuer)) continue
      return {
        resource,
        scopes: scopesOf(protectedResource, challenge),
        authorizationServer: body,
      }
    }
  }
  throw new OAuthError('Could not read the metadata of the connector server authorization server', 'discovery')
}

export function createDiscovery({ request = fetch, cacheMs = CACHE_MS, now = Date.now } = {}) {
  const cache = new Map()
  return {
    async discover(resourceUrl) {
      const resource = normalizeResource(resourceUrl)
      const hit = cache.get(resource)
      if (hit !== undefined && hit.expiresAt > now()) return hit.value
      const value = await discoverResource(resource, request)
      cache.set(resource, { expiresAt: now() + cacheMs, value })
      return value
    },
    clear() {
      cache.clear()
    },
  }
}
