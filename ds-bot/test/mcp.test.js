import assert from 'node:assert/strict'
import { test } from 'node:test'
import { McpHttpClient } from '../src/host/mcp.js'

const TOKEN = 'tok_test'

// One HTTP answer shaped like fetch's Response, as far as the client reads it.
const response = ({ status = 200, body, headers = {} }) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: name => headers[String(name).toLowerCase()] ?? (body === undefined ? null : 'application/json') },
  text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
})

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value })
const failure = (id, message) => ({ jsonrpc: '2.0', id, error: { code: -32000, message } })

test('opening a session sends the protocol version and keeps its session id', async () => {
  const seen = []
  const client = new McpHttpClient('https://mcp.test/', TOKEN, {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      seen.push({ url, body, headers: init.headers })
      if (body.method === 'initialize') return response({ body: result(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Test', version: '1' } }), headers: { 'mcp-session-id': 's1' } })
      if (body.method === 'notifications/initialized') return response({ status: 202 })
      if (body.method === 'tools/list') return response({ body: result(body.id, { tools: [{ name: 'list_projects' }] }) })
      throw new Error(`unexpected ${body.method}`)
    },
  })
  await client.open()
  assert.deepEqual(await client.listTools(), [{ name: 'list_projects' }])
  assert.equal(seen[0].url, 'https://mcp.test/')
  assert.equal(seen[0].body.params.protocolVersion, '2025-03-26')
  assert.equal(seen[0].body.params.clientInfo.name, 'ds-bot')
  assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`)
  assert.match(seen[0].headers.accept, /text\/event-stream/)
  assert.equal(seen[0].headers['mcp-session-id'], undefined)
  assert.equal(seen[1].body.method, 'notifications/initialized')
  assert.equal(seen[2].headers['mcp-session-id'], 's1')
})

test('an SSE answer is read as the JSON-RPC response', async () => {
  const client = new McpHttpClient('https://mcp.test/', TOKEN, {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.method === 'initialize') {
        return response({
          headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' },
          body: `event: message\ndata: ${JSON.stringify(result(body.id, { serverInfo: { name: 'Test' } }))}\n\n`,
        })
      }
      if (body.method === 'notifications/initialized') return response({ status: 202 })
      return response({
        headers: { 'content-type': 'text/event-stream' },
        body: `event: message\ndata: ${JSON.stringify(result(body.id, { tools: [{ name: 'list_domains' }] }))}\n\n`,
      })
    },
  })
  await client.open()
  assert.deepEqual(await client.listTools(), [{ name: 'list_domains' }])
})

test('a tool call sends the session id and returns the result', async () => {
  const seen = []
  const client = new McpHttpClient('https://mcp.test/', TOKEN, {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      seen.push({ body, headers: init.headers })
      if (body.method === 'initialize') return response({ body: result(body.id, { serverInfo: { name: 'Test' } }), headers: { 'mcp-session-id': 's1' } })
      if (body.method === 'notifications/initialized') return response({ status: 202 })
      return response({ body: result(body.id, { content: [{ type: 'text', text: 'ok' }] }) })
    },
  })
  await client.open()
  const answer = await client.callTool('get_project', { idOrName: 'site' })
  assert.deepEqual(answer, { content: [{ type: 'text', text: 'ok' }] })
  assert.deepEqual(seen.at(-1).body.params, { name: 'get_project', arguments: { idOrName: 'site' } })
  assert.equal(seen.at(-1).headers['mcp-session-id'], 's1')
})

test('a JSON-RPC error is thrown with its message', async () => {
  const client = new McpHttpClient('https://mcp.test/', TOKEN, {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.method === 'initialize') return response({ body: result(body.id, {}) })
      if (body.method === 'notifications/initialized') return response({ status: 202 })
      return response({ body: failure(body.id, 'no such tool') })
    },
  })
  await client.open()
  await assert.rejects(client.listTools(), /no such tool/)
})

test('a dropped session opens a new one and retries the call once', async () => {
  const methods = []
  let calls = 0
  const client = new McpHttpClient('https://mcp.test/', TOKEN, {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      methods.push(body.method)
      if (body.method === 'initialize') return response({ body: result(body.id, {}), headers: { 'mcp-session-id': `s${methods.filter(name => name === 'initialize').length}` } })
      if (body.method === 'notifications/initialized') return response({ status: 202 })
      calls += 1
      if (calls === 1) return response({ status: 404, body: {} })
      return response({ body: result(body.id, { content: [{ type: 'text', text: 'after reopen' }] }) })
    },
  })
  await client.open()
  assert.deepEqual(await client.callTool('list_projects', {}), { content: [{ type: 'text', text: 'after reopen' }] })
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call', 'initialize', 'notifications/initialized', 'tools/call'])
})

test('an unreachable server and a closed client fail clearly', async () => {
  const unreachable = new McpHttpClient('https://mcp.test/', TOKEN, { fetch: async () => { throw new Error('offline') } })
  await assert.rejects(unreachable.open(), /Could not reach the MCP server: offline/)
  const client = new McpHttpClient('https://mcp.test/', TOKEN, { fetch: async () => { throw new Error('should not be called') } })
  client.close()
  await assert.rejects(client.callTool('list_projects', {}), /connection is closed/)
})
