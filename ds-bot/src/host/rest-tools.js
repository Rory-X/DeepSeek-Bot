// REST tools for a connector whose service has no usable MCP endpoint. One definition maps
// one model tool to one GET request: placeholders in the path, query names, auth headers,
// a bounded and redacted answer, and plain error text. A definition is read-only by
// construction: a method other than GET is refused when the tools are built.
export const REST_RESULT_MAX = 20_000
export const REST_ERROR_MAX = 2_000
const TIMEOUT_MS = 20_000

const safeName = (id, name) => `${id}_${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64)
const cut = (text, redact) => {
  const safe = redact(String(text))
  if (safe.length <= REST_RESULT_MAX) return safe
  return `${safe.slice(0, REST_RESULT_MAX)}\n… (result cut: ${safe.length} characters in all; narrow the request with fewer or smaller parameters)`
}

function errorText(connector, response) {
  const name = connector.displayName
  switch (response.status) {
    case 401: return `${name} did not accept this token`
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

// Builds the connector's tools. `definition.parameters` is the model-facing JSON schema;
// `path` may carry `{argument}` placeholders and `query` maps argument names to query
// parameter names. `connector.restHeaders(token)` may add service headers, e.g. Notion's
// version header; the default is a bearer token.
export function createRestTools(id, connector, { token, output, redact = text => String(text), fetch: request = fetch } = {}) {
  return (connector.restTools ?? []).map(definition => {
    if (definition.method !== 'GET') throw new Error(`${connector.displayName} REST tool "${definition.name}" must be GET`)
    if (typeof definition.path !== 'string' || !definition.path.startsWith('/')) throw new Error(`${connector.displayName} REST tool "${definition.name}" needs a path`)
    const name = safeName(id, definition.name)
    return {
      name,
      description: String(definition.description ?? ''),
      parameters: definition.parameters ?? { type: 'object', properties: {} },
      output,
      async execute(args) {
        let url
        try {
          url = requestUrl(connector, definition, args)
        } catch (error) {
          throw new Error(redact(String(error?.message ?? error)).slice(0, REST_ERROR_MAX))
        }
        let response
        try {
          response = await request(url, {
            headers: { accept: 'application/json', ...(connector.restHeaders?.(token) ?? { Authorization: `Bearer ${token}` }) },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        } catch {
          throw new Error(`Could not reach ${connector.displayName}`)
        }
        if (!response.ok) throw new Error(errorText(connector, response))
        const text = await response.text()
        let body = text
        try {
          body = JSON.stringify(JSON.parse(text))
        } catch {
          // A plain-text answer is returned as it is.
        }
        return cut(body, redact)
      },
    }
  })
}
