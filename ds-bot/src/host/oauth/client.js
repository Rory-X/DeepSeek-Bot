// OAuth 2.1 client half for connectors: dynamic client registration (RFC 7591), PKCE,
// the authorization URL, code exchange, refresh and revocation. Every function takes the
// fetch it should use, so a test drives it with a fake authorization server; nothing here
// reads DS Bot's state or a credential store, and no token is ever logged.
import { createHash, randomBytes } from 'node:crypto'

const REQUEST_TIMEOUT_MS = 15_000
const ERROR_CODE = /^[a-z_]{1,40}$/i
export const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/
export const CLIENT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic']

// A refused or failed OAuth step. `code` is `oauth/<reason>`; the flow turns the reasons
// that mean "a new authorization is needed" into the connector's reconnect state.
export class OAuthError extends Error {
  constructor(message, code = 'oauth') {
    super(message)
    this.name = 'OAuthError'
    this.code = `oauth/${code}`
  }
}

const errorCodeOf = (body, status) => {
  const value = typeof body?.error === 'string' ? body.error : ''
  return ERROR_CODE.test(value) ? value : `http_${status}`
}

async function requestJson(url, init, request) {
  let response
  try {
    response = await request(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw new OAuthError(`Could not reach the authorization server: ${String(error?.message ?? error)}`, 'network')
  }
  const text = await response.text().catch(() => '')
  let body
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const code = errorCodeOf(body, response.status)
    if (code === 'invalid_grant') throw new OAuthError('The provider no longer accepts this authorization; connect again', 'invalid_grant')
    if (code === 'invalid_client') throw new OAuthError('The provider did not accept DS Bot as a client', 'invalid_client')
    throw new OAuthError(`The authorization server answered ${response.status} (${code})`, 'http')
  }
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new OAuthError('The authorization server answered no JSON', 'protocol')
  }
  return body
}

// PKCE (RFC 7636): a 32-byte verifier and its S256 challenge.
export function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function authorizationUrl({ metadata, clientId, redirectUri, state, challenge, scopes, resource }) {
  if (typeof metadata?.authorization_endpoint !== 'string') throw new OAuthError('The provider has no authorization endpoint', 'protocol')
  const url = new URL(metadata.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (typeof resource === 'string' && resource !== '') url.searchParams.set('resource', resource)
  const scope = Array.isArray(scopes) ? scopes.filter(item => typeof item === 'string' && item !== '').join(' ') : String(scopes ?? '')
  if (scope !== '') url.searchParams.set('scope', scope)
  return url.href
}

// Registers DS Bot with a provider that offers dynamic client registration. The answer
// says how the token endpoint authenticates this client: a public client has no secret,
// and a provider that hands one out gets it back on every token call.
export async function registerClient({ metadata, redirectUri, name = 'DS Bot', request = fetch }) {
  if (typeof metadata?.registration_endpoint !== 'string' || metadata.registration_endpoint === '') {
    throw new OAuthError('This provider needs a client id that DS Bot cannot register by itself', 'registration')
  }
  const answer = await requestJson(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  }, request)
  const clientId = answer?.client_id
  if (typeof clientId !== 'string' || clientId === '') throw new OAuthError('The provider did not register DS Bot', 'registration')
  const secret = typeof answer.client_secret === 'string' && answer.client_secret !== '' ? answer.client_secret : undefined
  const method = answer.token_endpoint_auth_method
  const tokenAuth = method === undefined ? (secret === undefined ? 'none' : 'client_secret_basic') : method
  if (!CLIENT_AUTH_METHODS.includes(tokenAuth)) {
    throw new OAuthError('The provider asked for a client authentication DS Bot does not support', 'registration')
  }
  if (tokenAuth !== 'none' && secret === undefined) throw new OAuthError('The provider registered DS Bot without a client secret', 'registration')
  return { id: clientId, tokenAuth, redirectUri, ...(secret === undefined ? {} : { secret }) }
}

// One token response in the shape the grant store keeps. A provider may rotate the
// refresh token; one that omits it leaves the previous one in place.
export function tokensFrom(answer, { previous, now = Date.now() } = {}) {
  const access = answer?.access_token
  if (typeof access !== 'string' || access === '') throw new OAuthError('The provider returned no access token', 'token')
  const expiresIn = Number(answer.expires_in)
  const refresh = typeof answer.refresh_token === 'string' && answer.refresh_token !== ''
    ? answer.refresh_token
    : previous?.refresh
  return {
    access,
    ...(refresh === undefined ? {} : { refresh }),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(typeof answer.scope === 'string' && answer.scope !== '' ? { scope: answer.scope } : {}),
    tokenType: typeof answer.token_type === 'string' && answer.token_type !== '' ? answer.token_type : 'Bearer',
  }
}

function clientBody(client, fields) {
  if (client.tokenAuth === 'client_secret_basic') {
    const encoded = `${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`
    return { body: new URLSearchParams(fields), headers: { authorization: `Basic ${Buffer.from(encoded).toString('base64')}` } }
  }
  const body = new URLSearchParams(fields)
  body.set('client_id', client.id)
  if (client.tokenAuth === 'client_secret_post') body.set('client_secret', client.secret)
  return { body, headers: {} }
}

async function tokenRequest({ metadata, client, fields, previous, now, request }) {
  if (typeof metadata?.token_endpoint !== 'string' || metadata.token_endpoint === '') {
    throw new OAuthError('The provider has no token endpoint', 'protocol')
  }
  const { body, headers } = clientBody(client, fields)
  const answer = await requestJson(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
    body: body.toString(),
  }, request)
  return tokensFrom(answer, { previous, now })
}

export async function exchangeCode({ metadata, client, code, verifier, redirectUri, resource, now = Date.now(), request = fetch }) {
  if (typeof code !== 'string' || code === '') throw new OAuthError('The provider returned no authorization code', 'exchange')
  if (!VERIFIER_PATTERN.test(String(verifier ?? ''))) throw new OAuthError('DS Bot lost the request that this authorization answers', 'exchange')
  return tokenRequest({
    metadata,
    client,
    now,
    request,
    fields: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      ...(typeof resource === 'string' && resource !== '' ? { resource } : {}),
    },
  })
}

export async function refreshAccess({ metadata, client, refreshToken, resource, previous, now = Date.now(), request = fetch }) {
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new OAuthError('The authorization has no refresh token; connect again', 'reconnect')
  }
  return tokenRequest({
    metadata,
    client,
    now,
    request,
    previous,
    fields: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...(typeof resource === 'string' && resource !== '' ? { resource } : {}),
    },
  })
}

// Best effort: a provider that fails or has no revocation endpoint still gets its grant
// deleted on this side. Never throws.
export async function revoke({ metadata, client, token, tokenTypeHint = 'refresh_token', request = fetch }) {
  const endpoint = metadata?.revocation_endpoint
  if (typeof endpoint !== 'string' || endpoint === '' || typeof token !== 'string' || token === '') return false
  const { body, headers } = clientBody(client, { token, token_type_hint: tokenTypeHint })
  try {
    const response = await request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return response.ok === true
  } catch {
    return false
  }
}
