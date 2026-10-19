// A thin Streamable HTTP MCP client for a connector's own server. It speaks just enough
// of the protocol to open a session, list tools and call one: JSON-RPC 2.0 over POST, a
// JSON or SSE answer, the session id from `initialize` on every later request.
//
// The DSH MCP client plugin is not used here because it registers every tool a server
// offers. A connector that only wants a few read tools registers those itself, so a
// server with hundreds of write tools cannot flood the model's context or expose them.
const PROTOCOL_VERSION = '2025-03-26'
const CLIENT_INFO = { name: 'ds-bot', version: '1' }
const TIMEOUT_MS = 20_000

// One JSON-RPC answer out of a body: plain JSON, or the JSON of one SSE `data:` event.
function responseMessage(text, id) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    const messages = text.split('\n').filter(line => line.startsWith('data:')).map(line => {
      try {
        return JSON.parse(line.slice(5).trim())
      } catch {
        return undefined
      }
    }).filter(Boolean)
    parsed = messages.find(message => message.id === id) ?? messages.find(message => message.error !== undefined) ?? messages.at(-1)
  }
  if (parsed === undefined) throw new Error('The MCP server answered nothing')
  return parsed
}

// One MCP tool result as the text a Bot reads. A result the server marked as an error
// throws, so the model sees a tool error instead of a long report.
export function mcpResultText(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
  if (result?.isError === true) throw new Error(text || 'The tool failed')
  if (text !== '') return text
  if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
  return 'The tool returned nothing.'
}

export class McpHttpClient {
  // `refresh` hands back a new access token when the server refuses this one (a connector
  // with an OAuth grant). It runs at most once per request, and the request is then sent
  // again on a fresh session, because the refused one may no longer be alive.
  constructor(url, token, { fetch: request = fetch, timeoutMs = TIMEOUT_MS, refresh } = {}) {
    this.url = url
    this.token = token
    this.request = request
    this.timeoutMs = timeoutMs
    this.refresh = refresh
    this.sessionId = undefined
    this.nextId = 1
    this.closed = false
  }

  async post(body, { signal, retried = false } = {}) {
    if (this.closed) throw new Error('The MCP connection is closed')
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
    }
    if (this.sessionId !== undefined) headers['mcp-session-id'] = this.sessionId
    let response
    try {
      response = await this.request(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(this.timeoutMs) })
    } catch (error) {
      throw new Error(`Could not reach the MCP server: ${String(error?.message ?? error)}`)
    }
    if ((response.status === 401 || response.status === 403) && this.refresh !== undefined && !retried) {
      const token = await this.refresh()
      if (typeof token !== 'string' || token === '') throw new Error('The connection needs a new authorization')
      this.token = token
      this.sessionId = undefined
      return this.post(body, { signal, retried: true })
    }
    const sessionId = response.headers?.get?.('mcp-session-id')
    if (typeof sessionId === 'string' && sessionId !== '') this.sessionId = sessionId
    if (response.status === 202 || response.status === 204) return undefined
    if (!response.ok) throw Object.assign(new Error(`The MCP server answered ${response.status}`), { status: response.status })
    const text = await response.text()
    return responseMessage(text, body.id)
  }

  async rpc(method, params, { signal } = {}) {
    const id = this.nextId
    this.nextId += 1
    const message = await this.post({ jsonrpc: '2.0', id, method, params }, { signal })
    if (message?.error !== undefined) throw new Error(String(message.error?.message ?? 'The MCP server refused the call'))
    return message?.result
  }

  // Opens the session and sends the initialized notification the protocol asks for.
  async open() {
    this.sessionId = undefined
    const result = await this.rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO })
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.server = result?.serverInfo
    return result
  }

  async listTools({ signal } = {}) {
    const result = await this.rpc('tools/list', {}, { signal })
    return Array.isArray(result?.tools) ? result.tools : []
  }

  async callTool(name, args = {}, { signal } = {}) {
    try {
      return await this.rpc('tools/call', { name, arguments: args }, { signal })
    } catch (error) {
      // The server dropped the session (a restart, or an idle timeout): open a new one
      // and run the call there once.
      if (error?.status !== 404) throw error
      await this.open()
      return await this.rpc('tools/call', { name, arguments: args }, { signal })
    }
  }

  close() {
    this.closed = true
  }
}
