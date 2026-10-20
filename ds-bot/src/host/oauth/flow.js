// The OAuth flow: one state/PKCE attempt per connector, a callback route on DSH's own web
// server, the code exchange, and the token handles the connector mount uses. The grant
// lives in DSH's credential store (store.js); a pending attempt lives in memory for ten
// minutes at most and is good for one callback. The browser answers are written here
// directly — they carry no script, no code and no token.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { OAuthError, authorizationUrl, exchangeCode, pkce, refreshAccess, registerClient, revoke } from './client.js'
import { createDiscovery, normalizeOrigin } from './metadata.js'
import { createGrantStore, isExpiring } from './store.js'

export const OAUTH_PREFIX = '/oauth/ds-bot'
export const ATTEMPT_TTL_MS = 10 * 60 * 1000
const REFRESH_SKEW_MS = 60_000
const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,58}$/
const ERROR_CODE = /^[a-z_]{1,40}$/i

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
}

const escape = text => String(text).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])

function page(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#1d2129}main{max-width:34rem;padding:2rem;background:#fff;border-radius:1rem;box-shadow:0 1px 3px #0001}h1{margin:0 0 .75rem;font-size:1.25rem}p{margin:0;color:#4e5969}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`
}

function respond(res, status, title, message) {
  res.writeHead(status, HTML_HEADERS)
  res.end(page(title, message))
}

const messageOf = (error, redact) => {
  const text = redact(String(error?.message ?? error ?? 'error'))
  return text.slice(0, 300)
}

// The browser's Origin tells DS Bot where the callback can reach it. Without one (the
// desktop app's window has an opaque origin) the loopback address of DSH's own web server
// is used, which the system browser can reach.
function redirectOrigin({ callerOrigin, configured, webServer }) {
  if (typeof configured === 'string' && configured !== '') return normalizeOrigin(configured)
  if (typeof callerOrigin === 'string' && callerOrigin !== '' && callerOrigin !== 'null') return normalizeOrigin(callerOrigin)
  if (Number.isInteger(webServer?.port) && webServer.port > 0) return `http://127.0.0.1:${webServer.port}`
  throw new OAuthError('DS Bot cannot tell where to receive the authorization', 'origin')
}

// One pending attempt: everything the callback needs, kept in memory only.
export function createOAuthFlow({
  ctx,
  connectorOf,
  origin,
  canWrite,
  request = fetch,
  now = Date.now,
  ttlMs = ATTEMPT_TTL_MS,
  onConnecting,
  onAuthorized,
  onFailed,
  onExpired,
  warn,
  redact = text => text,
}) {
  const discovery = createDiscovery({ request, now })
  const pending = new Map()
  const flights = new Map()
  let routeReady = false
  let disposed = false

  const credentialStore = () => createGrantStore({ credentials: ctx.get?.('credentials') })
  const connectorOfId = (id) => {
    const connector = connectorOf(id)
    if (connector === undefined || connector === null) throw new OAuthError('No such connector', 'connector')
    return connector
  }
  const webServerOf = () => {
    const webServer = ctx.get?.('webServer')
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      throw new OAuthError('Connecting with OAuth needs DS Bot in the web app or the desktop app', 'available')
    }
    return webServer
  }
  const notify = (callback, ...args) => {
    if (typeof callback !== 'function') return undefined
    try {
      return callback(...args)
    } catch (error) {
      warn?.('ds-bot: oauth: %s', messageOf(error, redact))
      return undefined
    }
  }

  const clearAttempt = (id) => {
    const attempt = pending.get(id)
    if (attempt === undefined) return
    pending.delete(id)
    if (attempt.timer !== undefined) clearTimeout(attempt.timer)
  }

  const sameState = (received, expected) => {
    if (typeof received !== 'string' || received === '') return false
    const left = Buffer.from(received)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
  }

  const ensureRoute = (webServer) => {
    if (routeReady) return
    routeReady = true
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: OAUTH_PREFIX,
      handler: (req, res) => { void answerCallback(req, res) },
    }), 'ds-bot: oauth callback')
  }

  // `level` is the access level the user chose; a module that brings `authorize` answers
  // with the URL and scopes for it (Neon's readonly MCP URL or its full one), and without
  // the hook the connector's fixed url/scopes apply. The level is stored with the grant.
  async function start(id, { origin: callerOrigin, level, settings } = {}) {
    if (disposed) throw new OAuthError('DS Bot is stopping', 'available')
    const connector = connectorOfId(id)
    const webServer = webServerOf()
    const redirectUri = `${redirectOrigin({ callerOrigin, configured: origin, webServer })}${OAUTH_PREFIX}/${id}`
    const store = credentialStore()
    const grant = typeof connector.authorize === 'function'
      ? await connector.authorize({ level, settings: settings ?? {} })
      : undefined
    const address = typeof grant?.url === 'string' && grant.url !== '' ? grant.url : connector.url
    if (!/^https:\/\//i.test(String(address))) throw new OAuthError('The authorization address must start with https://', 'available')
    // A saved grant already has a client registered for this callback address; reuse it
    // so a reconnect does not register another dynamic client.
    const saved = await store.read(id)
    const { resource, scopes, authorizationServer } = await discovery.discover(address)
    const client = saved !== undefined && saved.resource === resource && saved.client?.redirectUri === redirectUri
      ? saved.client
      : await registerClient({ metadata: authorizationServer, redirectUri, request })
    const { verifier, challenge } = pkce()
    const state = randomBytes(32).toString('base64url')
    const expiresAt = now() + ttlMs
    const scopeNames = Array.isArray(grant?.scopes)
      ? grant.scopes
      : Array.isArray(connector.oauth?.scopes) ? connector.oauth.scopes : scopes
    const authorizeUrl = authorizationUrl({
      metadata: authorizationServer,
      clientId: client.id,
      redirectUri,
      state,
      challenge,
      scopes: scopeNames,
      resource,
    })
    clearAttempt(id)
    const timer = setTimeout(() => {
      if (pending.get(id)?.state !== state) return
      pending.delete(id)
      notify(onExpired, id)
    }, ttlMs)
    timer.unref?.()
    pending.set(id, { state, verifier, redirectUri, client, resource, scopes: scopeNames, level, authorizationServer, expiresAt, timer })
    ensureRoute(webServer)
    await notify(onConnecting, id)
    return { authorizeUrl, expiresAt }
  }

  async function answerCallback(req, res) {
    try {
      await callback(req, res)
    } catch (error) {
      warn?.('ds-bot: oauth callback failed: %s', messageOf(error, redact))
      if (typeof res.writeHead === 'function') respond(res, 500, 'Could not connect', 'Something went wrong. Return to DS Bot and try again.')
    }
  }

  async function callback(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      respond(res, 400, 'Not connected', 'This callback was not valid.')
      return
    }
    if (!url.pathname.startsWith(`${OAUTH_PREFIX}/`)) {
      respond(res, 404, 'Not found', 'There is nothing at this address.')
      return
    }
    const id = url.pathname.slice(OAUTH_PREFIX.length + 1)
    if (!CONNECTOR_ID.test(id)) {
      respond(res, 404, 'Not found', 'There is nothing at this address.')
      return
    }
    const attempt = pending.get(id)
    if (attempt === undefined) {
      respond(res, 410, 'This authorization expired', 'Return to DS Bot and connect again.')
      return
    }
    if (req.method !== 'GET') {
      respond(res, 405, 'Not connected', 'This callback only accepts a GET request.')
      return
    }
    const refused = url.searchParams.get('error')
    if (refused !== null) {
      clearAttempt(id)
      const message = refused === 'access_denied'
        ? 'The authorization was cancelled'
        : `The provider refused the authorization (${ERROR_CODE.test(refused) ? refused : 'error'})`
      await notify(onFailed, id, message)
      respond(res, 400, 'Not connected', message)
      return
    }
    const codes = url.searchParams.getAll('code')
    const states = url.searchParams.getAll('state')
    if (codes.length !== 1 || states.length !== 1 || !sameState(states[0], attempt.state)) {
      respond(res, 400, 'Not connected', 'This callback does not match the authorization DS Bot started. Return to DS Bot and try again.')
      return
    }
    if (now() > attempt.expiresAt) {
      clearAttempt(id)
      await notify(onExpired, id)
      respond(res, 410, 'This authorization expired', 'Return to DS Bot and connect again.')
      return
    }
    // Providers that support RFC 9207 name themselves; a callback for another issuer is not
    // ours, even when its state matched.
    const issuer = url.searchParams.get('iss')
    if (issuer !== null && issuer !== attempt.authorizationServer.issuer) {
      clearAttempt(id)
      await notify(onFailed, id, 'The authorization answered for another provider')
      respond(res, 400, 'Not connected', 'The authorization answered for another provider.')
      return
    }
    if (typeof canWrite === 'function' && !canWrite()) {
      clearAttempt(id)
      respond(res, 409, 'Not connected', 'This DS Bot connects to the team only to read; connect from the window that manages the team.')
      return
    }
    clearAttempt(id)
    let grant
    try {
      const tokens = await exchangeCode({
        metadata: attempt.authorizationServer,
        client: attempt.client,
        code: codes[0],
        verifier: attempt.verifier,
        redirectUri: attempt.redirectUri,
        resource: attempt.resource,
        now: now(),
        request,
      })
      grant = {
        issuer: attempt.authorizationServer.issuer,
        resource: attempt.resource,
        client: attempt.client,
        tokens,
        scopes: attempt.scopes,
        ...(attempt.level === undefined ? {} : { level: attempt.level }),
        authorizedAt: now(),
      }
      // The store read happens after the exchange on purpose: a failed exchange stores
      // nothing, so a refused authorization leaves any earlier grant untouched.
      await credentialStore().save(id, grant)
    } catch (error) {
      const message = messageOf(error, redact)
      await notify(onFailed, id, message)
      respond(res, 502, 'Not connected', message)
      return
    }
    // The mount may fail for a reason that is not the authorization's (a dead server, an
    // empty tool list); the grant is still good, so the card reports that failure and the
    // browser page keeps its confirmation.
    try {
      await onAuthorized?.(id, grant)
    } catch (error) {
      warn?.('ds-bot: oauth: the %s connector did not mount: %s', id, messageOf(error, redact))
    }
    respond(res, 200, 'Connected', `${connectorOfId(id).displayName ?? 'This connector'} is connected. You can close this window and return to DS Bot.`)
  }

  // The grant to mount with, refreshed first when it is about to expire. Undefined means
  // the connector is not connected at all.
  async function token(id) {
    const grant = await credentialStore().read(id)
    if (grant === undefined) return undefined
    if (!isExpiring(grant, { now: now(), skewMs: REFRESH_SKEW_MS })) return grant
    return await refresh(id, { grant })
  }

  // One refresh per connector at a time. A failed refresh that the provider calls
  // invalid_grant deletes the grant: retrying the same dead token would fail forever, and
  // the card's answer is Reconnect.
  async function refresh(id, { grant, force = false } = {}) {
    const running = flights.get(id)
    if (running !== undefined) return running
    const flight = (async () => {
      const connector = connectorOfId(id)
      const current = grant ?? await credentialStore().read(id)
      if (current === undefined) throw new OAuthError('This connector is not connected', 'reconnect')
      if (!force && !isExpiring(current, { now: now(), skewMs: REFRESH_SKEW_MS })) return current
      if (typeof current.tokens.refresh !== 'string') {
        await credentialStore().clear(id)
        throw new OAuthError('The authorization expired; connect again', 'reconnect')
      }
      const { authorizationServer } = await discovery.discover(connector.url)
      try {
        const rotated = await credentialStore().rotate(id, current.tokens.access, async (latest) => {
          const tokens = await refreshAccess({
            metadata: authorizationServer,
            client: latest.client,
            refreshToken: latest.tokens.refresh,
            resource: latest.resource,
            previous: latest.tokens,
            now: now(),
            request,
          })
          return { ...latest, tokens: { ...latest.tokens, ...tokens } }
        })
        if (rotated === undefined) throw new OAuthError('The authorization is gone; connect again', 'reconnect')
        return rotated
      } catch (error) {
        if (error?.code === 'oauth/invalid_grant') {
          await credentialStore().clear(id)
          throw new OAuthError('The authorization expired; connect again', 'reconnect')
        }
        throw error
      }
    })()
    flights.set(id, flight)
    try {
      return await flight
    } finally {
      if (flights.get(id) === flight) flights.delete(id)
    }
  }

  async function disconnect(id) {
    connectorOfId(id)
    clearAttempt(id)
    const credentials = ctx.get?.('credentials')
    if (credentials === undefined) return
    const store = credentialStore()
    const grant = await store.read(id)
    if (grant === undefined) return
    try {
      const { authorizationServer } = await discovery.discover(connectorOf(id).url)
      await revoke({
        metadata: authorizationServer,
        client: grant.client,
        token: typeof grant.tokens.refresh === 'string' ? grant.tokens.refresh : grant.tokens.access,
        request,
      })
    } catch (error) {
      warn?.('ds-bot: oauth: the %s grant could not be revoked: %s', id, messageOf(error, redact))
    }
    await store.clear(id)
  }

  function dispose() {
    disposed = true
    for (const id of pending.keys()) clearAttempt(id)
    flights.clear()
  }

  return { start, token, refresh, disconnect, dispose }
}
