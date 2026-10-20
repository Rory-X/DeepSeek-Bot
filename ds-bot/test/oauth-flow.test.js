import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { ATTEMPT_TTL_MS, createOAuthFlow, OAUTH_PREFIX } from '../src/host/oauth/flow.js'
import { fakeContext } from './fake-ctx.js'
import { fakeCredentials, fakeOAuthServer, fakeResponse, fakeWebServer } from './oauth-fakes.js'

const CONNECTORS = {
  notion: { displayName: 'Notion', mode: 'oauth-mcp', url: 'https://mcp.test/mcp', oauth: { scopes: ['default'] } },
  cloudflare: { displayName: 'Cloudflare', mode: 'oauth-mcp', url: 'https://mcp.test/mcp' },
  levelled: {
    displayName: 'Levelled', mode: 'oauth-mcp', url: 'https://mcp.test/mcp', levels: ['read', 'write'], defaultLevel: 'read',
    authorize: ({ level }) => ({
      url: level === 'write' ? 'https://mcp.test/mcp?readonly=false' : 'https://mcp.test/mcp?readonly=true',
      scopes: level === 'write' ? ['read', 'write'] : ['read'],
    }),
  },
}

function setup({ server = fakeOAuthServer(), credentials = fakeCredentials(), webServer = fakeWebServer(), canWrite, ttlMs } = {}) {
  const clock = { value: 0 }
  const ctx = fakeContext({ services: { credentials, webServer } })
  const events = []
  const flow = createOAuthFlow({
    ctx,
    connectorOf: id => CONNECTORS[id],
    request: server.fetch,
    now: () => clock.value,
    ...(canWrite === undefined ? {} : { canWrite }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    onConnecting: id => { events.push(['connecting', id]) },
    onAuthorized: (id, grant) => { events.push(['authorized', id, grant.tokens.access]) },
    onFailed: (id, message) => { events.push(['failed', id, message]) },
    onExpired: id => { events.push(['expired', id]) },
    warn: () => {},
    redact: text => text,
  })
  return { ctx, flow, server, credentials, webServer, events, clock }
}

const stateOf = authorizeUrl => new URL(authorizeUrl).searchParams.get('state')
const challengeOf = authorizeUrl => new URL(authorizeUrl).searchParams.get('code_challenge')
const codeAndState = (authorizeUrl, code = 'auth-code') => `code=${code}&state=${encodeURIComponent(stateOf(authorizeUrl))}`

// The callback route the flow registered, driven the way DSH's web server would drive it.
async function callback(webServer, path, { method = 'GET' } = {}) {
  const route = webServer.routes[0]
  assert.ok(route !== undefined, 'no callback route')
  const { res, done } = fakeResponse()
  route.handler({ method, url: path }, res)
  return await done
}

const storedGrant = (overrides = {}) => ({
  kind: 'grant',
  payload: {
    version: 1,
    issuer: 'https://mcp.test',
    resource: 'https://mcp.test/mcp',
    client: { id: 'client-1', tokenAuth: 'none', redirectUri: 'https://dsh.test/oauth/ds-bot/notion' },
    tokens: { access: 'access-1', refresh: 'refresh-1', expiresAt: 3_600_000, tokenType: 'Bearer' },
    scopes: ['default'],
    authorizedAt: 0,
    ...overrides,
  },
})

// Starts a flow and completes its callback, returning the setup for further checks.
async function connected(options = {}) {
  const harness = setup(options)
  const started = await harness.flow.start('notion', { origin: 'https://dsh.test' })
  const answer = await callback(harness.webServer, `${OAUTH_PREFIX}/notion?${codeAndState(started.authorizeUrl)}`)
  assert.equal(answer.statusCode, 200, answer.body)
  return { ...harness, started }
}

test('starting an authorization returns the provider URL and arms the callback route', async () => {
  const { flow, server, webServer, events } = setup()
  const started = await flow.start('notion', { origin: 'https://dsh.test' })
  assert.equal(started.expiresAt, ATTEMPT_TTL_MS)
  assert.deepEqual(events, [['connecting', 'notion']])
  const url = new URL(started.authorizeUrl)
  assert.equal(url.origin + url.pathname, server.metadata.authorization_endpoint)
  const params = url.searchParams
  assert.deepEqual(
    ['response_type', 'client_id', 'redirect_uri', 'code_challenge_method', 'scope', 'resource'].map(name => params.get(name)),
    ['code', 'client-1', 'https://dsh.test/oauth/ds-bot/notion', 'S256', 'default', 'https://mcp.test/mcp'],
  )
  assert.equal(params.get('state').length, 43)
  assert.match(params.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/)
  assert.equal(webServer.routes.length, 1)
  assert.equal(webServer.routes[0].kind, 'prefix')
  assert.equal(webServer.routes[0].path, OAUTH_PREFIX)
  // The connector asked for one scope; the discovery scope list is only the default.
  const registration = server.requests.find(entry => entry.url === 'https://mcp.test/register')
  assert.equal(JSON.parse(registration.body).redirect_uris[0], 'https://dsh.test/oauth/ds-bot/notion')
})

test('a connector without its own scopes asks for the ones the server advertises', async () => {
  const { flow } = setup()
  const started = await flow.start('cloudflare', { origin: 'https://dsh.test' })
  assert.equal(new URL(started.authorizeUrl).searchParams.get('scope'), 'read write')
})

test('a module chooses the authorization for the level the user picked', async () => {
  const harness = setup()
  const started = await harness.flow.start('levelled', { origin: 'https://dsh.test', level: 'write', settings: { projectId: 'p' } })
  assert.equal(new URL(started.authorizeUrl).searchParams.get('scope'), 'read write')
  const answer = await callback(harness.webServer, `${OAUTH_PREFIX}/levelled?${codeAndState(started.authorizeUrl)}`)
  assert.equal(answer.statusCode, 200, answer.body)
  const record = harness.credentials.records.get('ds-bot/connector-levelled')
  assert.equal(record.payload.level, 'write')
  assert.deepEqual(record.payload.scopes, ['read', 'write'])
  // The grant keeps the exact address it was authorized for; the mount must use it, not
  // the connector's static url, or a write grant would mount the read-only address.
  assert.equal(record.payload.mountUrl, 'https://mcp.test/mcp?readonly=false')
  assert.deepEqual(harness.events, [['connecting', 'levelled'], ['authorized', 'levelled', 'access-1']])
})

test('an authorization address a module returns must be https', async () => {
  const flow = createOAuthFlow({
    ctx: fakeContext({ services: { credentials: fakeCredentials(), webServer: fakeWebServer() } }),
    connectorOf: () => ({ displayName: 'Plain', mode: 'oauth-mcp', url: 'https://mcp.test/mcp', authorize: () => ({ url: 'http://plain.test/mcp', scopes: ['read'] }) }),
    request: fakeOAuthServer().fetch,
    warn: () => {},
    redact: text => text,
  })
  await assert.rejects(flow.start('plain', { origin: 'https://dsh.test', level: 'read' }), /must start with https/)
})

test('the callback address falls back to the web server loopback for the desktop app', async () => {
  const { flow, webServer } = setup()
  const started = await flow.start('notion')
  assert.equal(new URL(started.authorizeUrl).searchParams.get('redirect_uri'), `http://127.0.0.1:${webServer.port}/oauth/ds-bot/notion`)
})

test('a start needs DSH web, an origin it can use, and a credential store', async () => {
  const { flow } = setup()
  await assert.rejects(flow.start('notion', { origin: 'http://public.test' }), /https or to this computer/)

  const noServer = createOAuthFlow({ ctx: fakeContext(), connectorOf: id => CONNECTORS[id] })
  await assert.rejects(noServer.start('notion', { origin: 'https://dsh.test' }), (error) => error.code === 'oauth/available' && /web app or the desktop app/.test(error.message))

  const noStore = createOAuthFlow({ ctx: fakeContext({ services: { webServer: fakeWebServer() } }), connectorOf: id => CONNECTORS[id] })
  await assert.rejects(noStore.start('notion', { origin: 'https://dsh.test' }), (error) => error.code === 'oauth/store' && /credential store/.test(error.message))

  await assert.rejects(flow.start('nobody'), /No such connector/)
})

test('a good callback stores the grant and says the connector is connected', async () => {
  const { flow, server, credentials, events, webServer } = setup()
  const started = await flow.start('notion', { origin: 'https://dsh.test' })
  const answer = await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(started.authorizeUrl)}`)
  assert.equal(answer.statusCode, 200)
  assert.match(answer.body, /Notion is connected/)
  assert.match(answer.headers['content-type'], /text\/html/)
  assert.equal(answer.headers['cache-control'], 'no-store')
  assert.match(answer.headers['content-security-policy'], /default-src 'none'/)
  // The browser page never carries the code, a token or script.
  assert.ok(!answer.body.includes('auth-code'))
  assert.ok(!answer.body.includes('access-1'))
  assert.ok(!answer.body.includes('<script'))

  const record = credentials.records.get('ds-bot/connector-notion')
  assert.equal(record.kind, 'grant')
  assert.equal(record.payload.version, 1)
  assert.equal(record.payload.tokens.access, 'access-1')
  assert.equal(record.payload.tokens.refresh, 'refresh-1')
  assert.equal(record.payload.issuer, 'https://mcp.test')
  assert.equal(record.payload.resource, 'https://mcp.test/mcp')
  assert.equal(record.payload.client.id, 'client-1')
  assert.deepEqual(record.payload.scopes, ['default'])
  assert.equal(record.payload.authorizedAt, 0)
  assert.deepEqual(events, [['connecting', 'notion'], ['authorized', 'notion', 'access-1']])

  const exchange = new URLSearchParams(server.tokenRequests()[0].body)
  assert.deepEqual(
    ['grant_type', 'code', 'redirect_uri', 'client_id', 'resource'].map(name => exchange.get(name)),
    ['authorization_code', 'auth-code', 'https://dsh.test/oauth/ds-bot/notion', 'client-1', 'https://mcp.test/mcp'],
  )
  // The verifier the token call sends is the one the authorization URL commits to.
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), challengeOf(started.authorizeUrl))
})

test('a callback is good for one use, and a wrong state does not burn a good attempt', async () => {
  const { flow, events, webServer, server } = setup()
  const started = await flow.start('notion', { origin: 'https://dsh.test' })

  const wrong = await callback(webServer, `${OAUTH_PREFIX}/notion?code=auth-code&state=not-the-state`)
  assert.equal(wrong.statusCode, 400)
  assert.match(wrong.body, /does not match/)
  assert.equal(server.tokenRequests().length, 0)
  const doubled = `state=${encodeURIComponent(stateOf(started.authorizeUrl))}`
  const repeated = await callback(webServer, `${OAUTH_PREFIX}/notion?code=auth-code&${doubled}&${doubled}`)
  assert.equal(repeated.statusCode, 400)
  assert.equal(events.some(event => event[0] === 'failed'), false)

  // The attempt survived the bad callbacks and still connects.
  assert.equal((await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(started.authorizeUrl)}`)).statusCode, 200)
  const replay = await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(started.authorizeUrl)}`)
  assert.equal(replay.statusCode, 410)
  assert.match(replay.body, /expired/)
})

test('an attempt expires after ten minutes', async () => {
  const { flow, clock, events, server, webServer } = setup()
  const started = await flow.start('notion', { origin: 'https://dsh.test' })
  clock.value = ATTEMPT_TTL_MS + 1
  const answer = await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(started.authorizeUrl)}`)
  assert.equal(answer.statusCode, 410)
  assert.deepEqual(events.at(-1), ['expired', 'notion'])
  assert.equal(server.tokenRequests().length, 0)
})

test('a provider refusal and a cancelled authorization fail the card', async () => {
  const { flow, events, webServer, server } = setup()
  const started = await flow.start('notion', { origin: 'https://dsh.test' })
  const cancelled = await callback(webServer, `${OAUTH_PREFIX}/notion?error=access_denied&state=${encodeURIComponent(stateOf(started.authorizeUrl))}`)
  assert.equal(cancelled.statusCode, 400)
  assert.match(cancelled.body, /cancelled/)
  assert.deepEqual(events.at(-1), ['failed', 'notion', 'The authorization was cancelled'])
  assert.equal(server.tokenRequests().length, 0)
  // The attempt is spent.
  assert.equal((await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(started.authorizeUrl)}`)).statusCode, 410)

  const second = await flow.start('notion', { origin: 'https://dsh.test' })
  const refused = await callback(webServer, `${OAUTH_PREFIX}/notion?error=server_error&state=${encodeURIComponent(stateOf(second.authorizeUrl))}`)
  assert.equal(refused.statusCode, 400)
  assert.match(refused.body, /server_error/)
})

test('the issuer has to be the one the authorization started with', async () => {
  const { flow, events, webServer } = setup()
  const started = await flow.start('notion', { origin: 'https://dsh.test' })
  const wrong = await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(started.authorizeUrl)}&iss=${encodeURIComponent('https://other.test')}`)
  assert.equal(wrong.statusCode, 400)
  assert.match(wrong.body, /another provider/)
  assert.deepEqual(events.at(-1), ['failed', 'notion', 'The authorization answered for another provider'])

  const second = await flow.start('notion', { origin: 'https://dsh.test' })
  const right = await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(second.authorizeUrl)}&iss=${encodeURIComponent('https://mcp.test')}`)
  assert.equal(right.statusCode, 200)
})

test('a host that only reads the team cannot commit a grant', async () => {
  const { flow, credentials, server, webServer } = setup({ canWrite: () => false })
  const started = await flow.start('notion', { origin: 'https://dsh.test' })
  const answer = await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(started.authorizeUrl)}`)
  assert.equal(answer.statusCode, 409)
  assert.match(answer.body, /only to read/)
  assert.equal(server.tokenRequests().length, 0)
  assert.equal(credentials.records.size, 0)
})

test('a failed exchange stores nothing and keeps an earlier grant', async () => {
  const credentials = fakeCredentials()
  credentials.records.set('ds-bot/connector-notion', storedGrant({
    client: { id: 'client-old', tokenAuth: 'none', redirectUri: 'https://dsh.test/oauth/ds-bot/notion' },
    tokens: { access: 'old-access', refresh: 'old-refresh', expiresAt: 10_000, tokenType: 'Bearer' },
  }))
  const server = fakeOAuthServer({ tokenStatus: 400, tokenError: 'invalid_grant' })
  const { flow, events, webServer } = setup({ server, credentials })
  const started = await flow.start('notion', { origin: 'https://dsh.test' })
  // The saved client is reused: a reconnect does not register another one.
  assert.equal(new URL(started.authorizeUrl).searchParams.get('client_id'), 'client-old')
  assert.equal(server.requests.some(entry => entry.url === 'https://mcp.test/register'), false)
  const answer = await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(started.authorizeUrl)}`)
  assert.equal(answer.statusCode, 502)
  assert.match(answer.body, /no longer accepts/)
  assert.deepEqual(events.at(-1), ['failed', 'notion', 'The provider no longer accepts this authorization; connect again'])
  assert.equal(credentials.records.get('ds-bot/connector-notion').payload.tokens.access, 'old-access')
})

test('not connected, connected and about to expire', async () => {
  const harness = setup()
  assert.equal(await harness.flow.token('notion'), undefined)

  const connectedHarness = await connected()
  const current = await connectedHarness.flow.token('notion')
  assert.equal(current.tokens.access, 'access-1')
  assert.equal(connectedHarness.server.tokenRequests().length, 1)

  // Inside the refresh window the token is refreshed before it is handed out.
  connectedHarness.clock.value = 3_600_000
  const refreshed = await connectedHarness.flow.token('notion')
  assert.equal(refreshed.tokens.access, 'access-2')
  assert.equal(refreshed.tokens.refresh, 'refresh-2')
  assert.equal((await connectedHarness.credentials.readRecord('ds-bot/connector-notion')).payload.tokens.access, 'access-2')
  const refresh = new URLSearchParams(connectedHarness.server.tokenRequests().at(-1).body)
  assert.deepEqual(
    ['grant_type', 'refresh_token', 'client_id', 'resource'].map(name => refresh.get(name)),
    ['refresh_token', 'refresh-1', 'client-1', 'https://mcp.test/mcp'],
  )
})

test('a token that cannot be refreshed asks for a reconnect and is dropped', async () => {
  const { flow, credentials, clock } = setup()
  await flow.start('notion', { origin: 'https://dsh.test' })
  // No refresh token at all: the grant is expired, so it is useless.
  credentials.records.set('ds-bot/connector-notion', storedGrant({ tokens: { access: 'access-1', expiresAt: 1000, tokenType: 'Bearer' } }))
  clock.value = 2000
  await assert.rejects(flow.token('notion'), (error) => error.code === 'oauth/reconnect' && /connect again/.test(error.message))
  assert.equal(credentials.records.has('ds-bot/connector-notion'), false)

  // The provider rejects the refresh token: same outcome, and no retry loop.
  credentials.records.set('ds-bot/connector-notion', storedGrant({ tokens: { access: 'access-1', refresh: 'dead-refresh', expiresAt: 1000, tokenType: 'Bearer' } }))
  const rejecting = fakeOAuthServer({ tokenStatus: 400, tokenError: 'invalid_grant' })
  const { flow: second } = setup({ server: rejecting, credentials })
  await assert.rejects(second.token('notion'), (error) => error.code === 'oauth/reconnect')
  assert.equal(credentials.records.has('ds-bot/connector-notion'), false)
})

test('one connector refreshes once even when asked twice at the same time', async () => {
  const { flow, server, credentials, clock } = await connected()
  credentials.records.set('ds-bot/connector-notion', storedGrant({ tokens: { access: 'access-1', refresh: 'refresh-1', expiresAt: 1000, tokenType: 'Bearer' } }))
  clock.value = 2000
  const tokensBefore = server.tokenRequests().length
  const [first, second] = await Promise.all([flow.token('notion'), flow.token('notion')])
  assert.equal(first.tokens.access, 'access-2')
  assert.equal(second.tokens.access, 'access-2')
  assert.equal(server.tokenRequests().length - tokensBefore, 1)
})

test('refresh can be forced after a refused request, and disconnect revokes and deletes', async () => {
  const { flow, server, credentials, clock } = await connected()
  clock.value = 100
  const rotated = await flow.refresh('notion', { force: true })
  assert.equal(rotated.tokens.access, 'access-2')
  const before = server.requests.length

  await flow.disconnect('notion')
  assert.equal(credentials.records.has('ds-bot/connector-notion'), false)
  // The revocation call went out before the local grant was deleted.
  assert.equal(server.requests.length - before, 1)
  await flow.disconnect('notion')
  await assert.rejects(flow.disconnect('nobody'), /No such connector/)
})

test('unmatched and unknown callbacks answer without touching anything', async () => {
  const { flow, webServer, credentials } = setup()
  await flow.start('notion', { origin: 'https://dsh.test' })
  assert.equal((await callback(webServer, `${OAUTH_PREFIX}/nobody?code=a&state=b`)).statusCode, 410)
  assert.equal((await callback(webServer, '/other/path')).statusCode, 404)
  assert.equal((await callback(webServer, `${OAUTH_PREFIX}/notion?code=a&state=b`, { method: 'POST' })).statusCode, 405)
  assert.equal(credentials.records.size, 0)
})

test('two starts leave only the newest state valid, and dispose forgets an attempt', async () => {
  const { flow, webServer } = setup()
  const first = await flow.start('notion', { origin: 'https://dsh.test' })
  const second = await flow.start('notion', { origin: 'https://dsh.test' })
  assert.equal((await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(first.authorizeUrl)}`)).statusCode, 400)
  flow.dispose()
  assert.equal((await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(second.authorizeUrl)}`)).statusCode, 410)
})


test('a revocation endpoint that refuses the token leaves a warning and still clears the grant', async () => {
  const credentials = fakeCredentials()
  const webServer = fakeWebServer()
  const server = fakeOAuthServer()
  const warnings = []
  const ctx = fakeContext({ services: { credentials, webServer } })
  // The authorization and token calls go to the fake server; the revocation call (the one
  // with a token and no grant_type) answers HTTP 500.
  const request = async (url, init = {}) => {
    const body = new URLSearchParams(String(init.body ?? ''))
    if (String(url) === `${server.issuer}/token` && body.get('token') !== null && body.get('grant_type') === null) {
      return { status: 500, ok: false, headers: { get: () => 'application/json' }, text: async () => '{}' }
    }
    return server.fetch(url, init)
  }
  const flow = createOAuthFlow({
    ctx,
    connectorOf: () => CONNECTORS.notion,
    request,
    warn: (template, ...args) => warnings.push(String(template).replace(/%s/g, () => String(args.shift()))),
    redact: text => text,
  })
  const started = await flow.start('notion', { origin: 'https://dsh.test' })
  const response = await callback(webServer, `${OAUTH_PREFIX}/notion?${codeAndState(started.authorizeUrl)}`)
  assert.equal(response.statusCode, 200)
  assert.ok(credentials.records.has('ds-bot/connector-notion'))

  await flow.disconnect('notion')
  assert.equal(credentials.records.has('ds-bot/connector-notion'), false)
  assert.ok(warnings.some(text => /could not be revoked/.test(text)), JSON.stringify(warnings))
  assert.ok(!warnings.join('\n').includes('access-1'))
  assert.ok(!warnings.join('\n').includes('refresh-1'))
})
