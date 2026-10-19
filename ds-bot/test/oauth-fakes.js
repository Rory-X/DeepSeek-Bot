// Fakes for the OAuth tests: DSH's credential store over a Map, DSH's web server keeping
// its routes, one authorization server (and MCP endpoint) behind a fetch, and a browser
// response whose end() a test can await.
export function fakeCredentials() {
  const records = new Map()
  let tail = Promise.resolve()
  const exclusive = (run) => {
    const next = tail.then(run, run)
    tail = next.catch(() => {})
    return next
  }
  return {
    records,
    readRecord: async key => records.get(key),
    modifyRecord: (key, mutate) => exclusive(async () => {
      const current = records.get(key)
      const next = await mutate(current)
      if (next === undefined) return current
      records.set(key, next)
      return next
    }),
    deleteRecord: async (key) => { records.delete(key) },
  }
}

export function fakeWebServer(port = 19387) {
  const routes = []
  return {
    port,
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }
}

export function fakeResponse() {
  const chunks = []
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
      return this
    },
    end(body) {
      if (body !== undefined) chunks.push(String(body))
      this.body = chunks.join('')
      settle(this)
    },
  }
  return { res, done }
}

const jsonAnswer = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: name => headers[String(name).toLowerCase()] ?? null },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
})

// One fake authorization server. It answers the unauthenticated MCP probe with a Bearer
// challenge, serves the protected-resource and authorization-server metadata, registers a
// client, and exchanges and refreshes tokens. `requests` records every call so a test can
// check what DS Bot sent.
export function fakeOAuthServer({
  resource = 'https://mcp.test/mcp',
  issuer = 'https://mcp.test',
  scopes = ['read'],
  challengeScope = 'read write',
  tokenAuthMethod = 'none',
  clientSecret,
  registerStatus = 201,
  tokenStatus = 200,
  tokenError = 'invalid_grant',
  expiresIn = 3600,
  declaredResource = resource,
  extraWellKnown = {},
  tokenHandler,
} = {}) {
  const requests = []
  const url = new URL(resource)
  const protectedResourceUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`
  const challenge = `Bearer realm="OAuth", resource_metadata="${protectedResourceUrl}", scope="${challengeScope}"`
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/token`,
    code_challenge_methods_supported: ['S256'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: scopes,
    ...extraWellKnown,
  }
  const protectedResource = {
    resource: declaredResource,
    authorization_servers: [issuer],
    scopes_supported: scopes,
    bearer_methods_supported: ['header'],
  }
  let registrations = 0
  let tokens = 0
  const server = {
    resource,
    issuer,
    protectedResourceUrl,
    challenge,
    metadata,
    protectedResource,
    requests,
    tokenRequests: () => requests.filter(request => request.url === `${issuer}/token` && request.method === 'POST'),
    async fetch(target, init = {}) {
      const address = String(target)
      const method = init.method ?? 'GET'
      const headers = init.headers ?? {}
      const record = { url: address, method, headers, body: init.body }
      requests.push(record)
      if (address === resource && method === 'POST' && headers.authorization === undefined) {
        return {
          status: 401,
          ok: false,
          headers: { get: name => (String(name).toLowerCase() === 'www-authenticate' ? challenge : null) },
          text: async () => '',
        }
      }
      if (address === protectedResourceUrl) return jsonAnswer(200, protectedResource)
      if (address === `${issuer}/.well-known/oauth-authorization-server`) return jsonAnswer(200, metadata)
      if (address === `${issuer}/register` && method === 'POST') {
        if (registerStatus !== 201) return jsonAnswer(registerStatus, { error: 'invalid_client_metadata' })
        registrations += 1
        return jsonAnswer(201, {
          client_id: `client-${registrations}`,
          ...(tokenAuthMethod === 'none' ? { token_endpoint_auth_method: 'none' } : { token_endpoint_auth_method: tokenAuthMethod, client_secret: clientSecret ?? 'client-secret-1' }),
          redirect_uris: JSON.parse(init.body).redirect_uris,
        })
      }
      if (address === `${issuer}/token` && method === 'POST') {
        if (tokenHandler !== undefined) return tokenHandler(new URLSearchParams(String(init.body)), record)
        if (tokenStatus !== 200) return jsonAnswer(tokenStatus, { error: tokenError })
        tokens += 1
        return jsonAnswer(200, {
          access_token: `access-${tokens}`,
          refresh_token: `refresh-${tokens}`,
          token_type: 'Bearer',
          expires_in: expiresIn,
          scope: scopes.join(' '),
        })
      }
      throw new Error(`unexpected fetch ${method} ${address}`)
    },
  }
  return server
}
