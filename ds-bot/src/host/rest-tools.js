// REST tools for a connector whose service has no usable MCP endpoint. One definition maps
// one model tool to one request: placeholders in the path, query names, connector-owned auth
// headers, a bounded and redacted answer, and plain error text.
//
// A GET is read-only by construction. A service whose read calls are POST (WeRead, ima) uses
// POST, and that is never a passthrough: the definition must say `readOnly: true` and name
// every body field it sends, with an argument name or a constant. An argument the definition
// does not name never reaches the request, and nothing but the mapped scalars can enter the
// body. Any other method is refused when the tools are built.
//
// Some services answer HTTP 200 with their own status field (WeRead's `errcode`, ima's
// `code`). A connector may declare `envelope` (or one tool may override it): the field name
// for the status and the success value, where the payload lives, how codes map to messages,
// and optionally a full `answer({ body, status })` hook. A failed envelope is a tool error,
// never a successful-looking answer.
export const REST_RESULT_MAX = 20_000
export const REST_ERROR_MAX = 2_000
export const REST_BODY_MAX_BYTES = 8_192
const TIMEOUT_MS = 20_000
const METHODS = new Set(['GET', 'POST'])
const SCALAR = new Set(['string', 'number', 'boolean'])

const safeName = (id, name) => `${id}_${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64)
const cut = (text, redact, wasJson = false, limit = REST_RESULT_MAX) => {
  const safe = redact(String(text))
  if (safe.length <= limit) return safe
  const note = wasJson
    ? `result cut: ${safe.length} characters in all; this JSON is no longer complete, so ask for less (a smaller limit or a narrower query)`
    : `result cut: ${safe.length} characters in all; narrow the request with fewer or smaller parameters`
  return `${safe.slice(0, limit)}\n… (${note})`
}

function errorText(connector, response) {
  const name = connector.displayName
  switch (response.status) {
    case 401: return `${name} did not accept this token or key`
    case 403: return `${name} refused this call (403)`
    case 404: return `${name} did not find it (404)`
    case 429: return `${name} is rate limited; try again later (429)`
    default: return `${name} answered ${response.status}`
  }
}

function requestUrl(connector, definition, args) {
  let path = definition.path
  for (const match of path.matchAll(/\{([A-Za-z0-9_-]+)\}/g)) {
    const value = args?.[match[1]]
    if (value === undefined || value === null || value === '') throw new Error(`Missing "${match[1]}" for this call.`)
    path = path.replace(match[0], encodeURIComponent(String(value)))
  }
  const url = new URL(`${String(connector.api).replace(/\/$/, '')}${path}`)
  for (const [argument, query] of Object.entries(definition.query ?? {})) {
    const value = args?.[argument]
    if (value === undefined || value === null) continue
    url.searchParams.set(query, String(value))
  }
  return url
}

const isScalar = value => SCALAR.has(typeof value)
const isScalarList = value => Array.isArray(value) && value.every(isScalar)

// Only the definition's own fields are sent, built from the arguments it names (or a fixed
// constant). Everything else in `args` is ignored, so a model cannot widen the request.
function requestBody(connector, definition, args) {
  const body = {}
  // A dotted field nests (`query_info.title`), which is how a service with a structured
  // request body keeps one flat body mapping.
  const setPath = (field, value) => {
    const parts = field.split('.')
    let node = body
    for (const part of parts.slice(0, -1)) node = node[part] ??= {}
    node[parts.at(-1)] = value
  }
  for (const [field, mapping] of Object.entries(definition.body ?? {})) {
    if (mapping !== null && typeof mapping === 'object') {
      if (!Object.hasOwn(mapping, 'const')) throw new Error(`${connector.displayName} REST tool "${definition.name}" body field "${field}" must name an argument or a constant.`)
      setPath(field, mapping.const)
      continue
    }
    if (typeof mapping !== 'string' || mapping === '') throw new Error(`${connector.displayName} REST tool "${definition.name}" body field "${field}" must name an argument or a constant.`)
    const value = args?.[mapping]
    if (value === undefined || value === null) continue
    if (!isScalar(value) && !isScalarList(value)) throw new Error(`"${mapping}" must be text, a number, a boolean or a list of those.`)
    setPath(field, value)
  }
  const text = JSON.stringify(body)
  if (Buffer.byteLength(text) > REST_BODY_MAX_BYTES) throw new Error(`The request body is too large; keep it under ${REST_BODY_MAX_BYTES} bytes.`)
  return text
}

function headers(connector, definition, { token, secrets }) {
  const auth = connector.auth ?? connector.restHeaders
  const own = typeof auth === 'function' ? auth({ token, secrets }) ?? {} : { Authorization: `Bearer ${token}` }
  return { accept: 'application/json', ...(definition.headers ?? {}), ...own }
}

function validate(connector, definition) {
  const method = String(definition.method ?? 'GET').toUpperCase()
  if (!METHODS.has(method)) throw new Error(`${connector.displayName} REST tool "${definition.name}" must be GET or POST`)
  if (method === 'POST') {
    if (definition.readOnly !== true) throw new Error(`${connector.displayName} REST tool "${definition.name}" POST must declare readOnly: true`)
    const body = definition.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`${connector.displayName} REST tool "${definition.name}" POST needs an explicit body mapping (it may be empty)`)
    }
  }
  if (typeof definition.path !== 'string' || !definition.path.startsWith('/')) {
    throw new Error(`${connector.displayName} REST tool "${definition.name}" needs a path`)
  }
  return method
}

// The service's own envelope around a 200 answer. `success` defaults to 0; `errors` maps a
// status code to the sentence the model sees, and the envelope's message field is the
// fallback so an unknown code still says what the service said.
function unwrap(connector, envelope, body) {
  if (body === undefined || body === null || typeof body !== 'object') {
    throw new Error(`${connector.displayName} answered something this connector cannot read.`)
  }
  const code = body[envelope.ok]
  const success = envelope.success === undefined ? 0 : envelope.success
  // WeRead omits its errcode on success, so a connector may say an absent status is fine.
  const ok = envelope.successTrue === true ? code === true : (code === success || (envelope.allowAbsent === true && code === undefined))
  if (ok) {
    const payload = envelope.data === undefined ? body : body[envelope.data]
    return payload === undefined ? 'null' : JSON.stringify(payload)
  }
  const mapped = envelope.errors !== null && typeof envelope.errors === 'object' ? envelope.errors[String(code)] : undefined
  if (typeof mapped === 'string' && mapped !== '') throw new Error(mapped)
  const detail = envelope.error === undefined ? undefined : body[envelope.error]
  if (typeof detail === 'string' && detail !== '') throw new Error(`${connector.displayName}: ${detail.slice(0, 160)}`)
  throw new Error(`${connector.displayName} answered code ${String(code)}`)
}

// Builds the connector's tools. `definition.parameters` is the model-facing JSON schema;
// `path` may carry `{argument}` placeholders, `query` maps argument names to query names,
// and a POST's `body` maps body fields to argument names or `{ const }`. `connector.api` is
// the service origin, `connector.auth({ token, secrets })` supplies auth headers (the old
// `restHeaders` name still works), and `secrets` is the named-credential map.
export function createRestTools(id, connector, { token, secrets = {}, output, redact = text => String(text), fetch: request = fetch } = {}) {
  return (connector.restTools ?? []).map((definition) => {
    const method = validate(connector, definition)
    const name = safeName(id, definition.name)
    return {
      name,
      description: String(definition.description ?? ''),
      parameters: definition.parameters ?? { type: 'object', properties: {} },
      output,
      async execute(args) {
        let url
        let body
        try {
          url = requestUrl(connector, definition, args)
          if (method === 'POST') body = requestBody(connector, definition, args)
        } catch (error) {
          throw new Error(redact(String(error?.message ?? error)).slice(0, REST_ERROR_MAX))
        }
        let response
        try {
          response = await request(url, {
            method,
            headers: method === 'POST' ? { ...headers(connector, definition, { token, secrets }), 'content-type': 'application/json' } : headers(connector, definition, { token, secrets }),
            ...(method === 'POST' ? { body } : {}),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        } catch {
          throw new Error(`Could not reach ${connector.displayName}`)
        }
        const text = await response.text()
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        const envelope = definition.envelope ?? connector.envelope
        const hook = definition.answer ?? connector.answer
        const limit = definition.resultMax ?? REST_RESULT_MAX
        // A service may answer its business error with a non-2xx status (WeRead uses 499);
        // its own envelope explains it better than "answered 499", so it is checked first
        // whenever the body parses as one.
        if (envelope !== undefined && parsed !== undefined) {
          let answer
          try {
            answer = unwrap(connector, envelope, parsed)
          } catch (error) {
            throw new Error(redact(String(error?.message ?? error)).slice(0, REST_ERROR_MAX))
          }
          // The envelope speaks for the body; a non-2xx status still means the call itself
          // failed (auth, rate limit, transport), so it is not reported as success.
          if (!response.ok) throw new Error(errorText(connector, response))
          return cut(answer, redact, true, limit)
        }
        if (envelope !== undefined) throw new Error(`${connector.displayName} answered something this connector cannot read.`)
        if (!response.ok) throw new Error(errorText(connector, response))
        if (typeof hook === 'function') {
          const answer = await hook({ body: parsed, status: response.status })
          return cut(typeof answer === 'string' ? answer : JSON.stringify(answer), redact, parsed !== undefined, limit)
        }
        return cut(parsed === undefined ? text : JSON.stringify(parsed), redact, parsed !== undefined, limit)
      },
    }
  })
}
