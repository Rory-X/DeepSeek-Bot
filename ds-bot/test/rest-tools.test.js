import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REST_BODY_MAX_BYTES, REST_RESULT_MAX, createRestTools } from '../src/host/rest-tools.js'

const output = { schema: { type: 'string' }, render: () => [] }
const connector = (extra = {}) => ({
  displayName: 'Example',
  api: 'https://api.example.com',
  restTools: [
    {
      name: 'get_project',
      description: 'Read one project',
      method: 'GET',
      path: '/v1/projects/{projectId}',
      query: { withMembers: 'with_members', limit: 'limit' },
      parameters: { type: 'object', properties: { projectId: { type: 'string' }, withMembers: { type: 'boolean' }, limit: { type: 'number' } }, required: ['projectId'] },
    },
  ],
  ...extra,
})
const answer = (status, body, headers = { 'content-type': 'application/json' }) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: name => headers[String(name).toLowerCase()] },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
})
const TOKEN = 'tok_rest_secret'
const KEY = 'ima_openapi_key'
const redact = text => String(text).split(TOKEN).join('[secret]').split(KEY).join('[secret]')

const postConnector = (extra = {}) => ({
  displayName: 'Postly',
  api: 'https://postly.example.com',
  restHeaders: ({ token, readSecret }) => ({ Authorization: `Bearer ${token}`, 'X-Api-Key': readSecret('POSTLY_API_KEY') }),
  restTools: [
    {
      name: 'search_notes',
      description: 'Search notes',
      method: 'POST',
      readOnly: true,
      path: '/v2/notes/{bookId}:search',
      query: { pageSize: 'page_size' },
      body: { query: 'query', topK: 'topK', mode: { const: 'read' } },
      parameters: { type: 'object', properties: { bookId: { type: 'string' }, query: { type: 'string' }, topK: { type: 'number' }, pageSize: { type: 'number' } }, required: ['bookId', 'query'] },
    },
  ],
  ...extra,
})

test('tools are built read-only and named by connector', () => {
  const [tool] = createRestTools('example', connector(), { token: TOKEN, output })
  assert.equal(tool.name, 'example_get_project')
  assert.equal(tool.description, 'Read one project')
  assert.deepEqual(tool.parameters.required, ['projectId'])
  assert.throws(() => createRestTools('example', { ...connector(), restTools: [{ name: 'deploy', method: 'POST', path: '/v1/deploy' }] }, { token: TOKEN, output }), /must declare readOnly: true/)
  assert.throws(() => createRestTools('example', { ...connector(), restTools: [{ name: 'deploy', method: 'POST', readOnly: true, path: '/v1/deploy' }] }, { token: TOKEN, output }), /needs an explicit body mapping/)
  assert.throws(() => createRestTools('example', { ...connector(), restTools: [{ name: 'deploy', method: 'PUT', path: '/v1/deploy' }] }, { token: TOKEN, output }), /must be GET or POST/)
  assert.throws(() => createRestTools('example', { ...connector(), restTools: [{ name: 'bad', method: 'GET', path: 'v1/x' }] }, { token: TOKEN, output }), /needs a path/)
})

test('a call fills path and query and sends the bearer token', async () => {
  const seen = []
  const [tool] = createRestTools('example', connector(), { token: TOKEN, output, fetch: async (url, init) => { seen.push([url, init]); return answer(200, { projects: [] }) } })
  assert.equal(await tool.execute({ projectId: 'a b', withMembers: true, limit: 5 }), '{"projects":[]}')
  const [url, init] = seen[0]
  assert.equal(url.toString(), 'https://api.example.com/v1/projects/a%20b?with_members=true&limit=5')
  assert.equal(init.method, 'GET')
  assert.equal(init.body, undefined)
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(init.headers.accept, 'application/json')
})

test('a missing path argument is reported before a request', async () => {
  let asked = false
  const [tool] = createRestTools('example', connector(), { token: TOKEN, output, fetch: async () => { asked = true; return answer(200, {}) } })
  await assert.rejects(tool.execute({}), /Missing "projectId"/)
  assert.equal(asked, false)
})

test('a service header can replace the default bearer', async () => {
  const seen = []
  const [tool] = createRestTools('example', connector({ restHeaders: () => ({ Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28' }) }), {
    token: TOKEN, output, fetch: async (url, init) => { seen.push(init.headers); return answer(200, {}) },
  })
  await tool.execute({ projectId: 'p1' })
  assert.equal(seen[0]['Notion-Version'], '2022-06-28')
})

test('a read-only POST sends only the mapped body fields, with connector-owned auth', async () => {
  const seen = []
  const [tool] = createRestTools('postly', postConnector(), {
    token: TOKEN,
    readSecret: name => (name === 'POSTLY_API_KEY' ? KEY : undefined),
    output,
    fetch: async (url, init) => { seen.push([url, init]); return answer(200, { notes: [] }) },
  })
  assert.equal(tool.name, 'postly_search_notes')
  assert.equal(await tool.execute({ bookId: 'b1', query: 'hello', topK: 4, pageSize: 10, rows: [1, 2, 3], injected: { admin: true } }, {}), '{"notes":[]}')
  const [url, init] = seen[0]
  assert.equal(url.toString(), 'https://postly.example.com/v2/notes/b1:search?page_size=10')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(init.headers['X-Api-Key'], KEY)
  assert.equal(init.headers['content-type'], 'application/json')
  // Only the definition's fields; the extra arguments are ignored and a constant is sent.
  assert.deepEqual(JSON.parse(init.body), { query: 'hello', topK: 4, mode: 'read' })
})

test('a POST body refuses values the definition did not map', async () => {
  const [tool] = createRestTools('postly', postConnector(), { token: TOKEN, output, fetch: async () => answer(200, {}) })
  await assert.rejects(tool.execute({ bookId: 'b1', query: { nested: 'no' } }), /must be text, a number, a boolean or a list of those/)
  await assert.rejects(tool.execute({ bookId: 'b1', query: ['ok', { nested: 'no' }] }), /must be text, a number, a boolean or a list of those/)
  const [badMapping] = createRestTools('postly', { ...postConnector(), restTools: [{ name: 'x', method: 'POST', readOnly: true, path: '/x', body: { field: 5 } }] }, { token: TOKEN, output, fetch: async () => answer(200, {}) })
  await assert.rejects(badMapping.execute({}), /must name an argument or a constant/)
})

test('a POST body stays under its size bound', async () => {
  let asked = false
  const [tool] = createRestTools('postly', postConnector(), { token: TOKEN, output, fetch: async () => { asked = true; return answer(200, {}) } })
  await assert.rejects(tool.execute({ bookId: 'b1', query: 'x'.repeat(REST_BODY_MAX_BYTES + 100) }), /too large/)
  assert.equal(asked, false)
})

test('http errors become clear tool errors', async () => {
  for (const [status, pattern] of [[401, /did not accept this token or key/], [403, /refused this call \(403\)/], [404, /did not find it \(404\)/], [429, /rate limited/], [500, /Example answered 500/]]) {
    const [tool] = createRestTools('example', connector(), { token: TOKEN, output, fetch: async () => answer(status, {}) })
    await assert.rejects(tool.execute({ projectId: 'p1' }), pattern, String(status))
  }
  const [tool] = createRestTools('example', connector(), { token: TOKEN, output, fetch: async () => { throw new Error('offline') } })
  await assert.rejects(tool.execute({ projectId: 'p1' }), /Could not reach Example/)

  const [post] = createRestTools('postly', postConnector(), { token: TOKEN, output, fetch: async () => answer(429, {}) })
  await assert.rejects(post.execute({ bookId: 'b1', query: 'q' }), /rate limited/)
})

test('a long answer is cut, plain text survives, and a token is redacted', async () => {
  const long = { data: 'z'.repeat(REST_RESULT_MAX + 200) }
  const [tool] = createRestTools('example', connector(), { token: TOKEN, output, fetch: async () => answer(200, long) })
  const text = await tool.execute({ projectId: 'p1' })
  assert.equal(text.startsWith('{"data":"z'), true)
  assert.match(text, /result cut: \d+ characters in all/)

  const [plain] = createRestTools('example', connector(), { token: TOKEN, output, fetch: async () => answer(200, 'plain words') })
  assert.equal(await plain.execute({ projectId: 'p1' }), 'plain words')

  const [leaky] = createRestTools('example', connector(), { token: TOKEN, output, redact, fetch: async () => answer(200, { token: TOKEN }) })
  assert.equal(await leaky.execute({ projectId: 'p1' }), '{"token":"[secret]"}')

  // A POST answer is redacted and cut the same way.
  const [post] = createRestTools('postly', postConnector(), { token: TOKEN, output, redact, fetch: async () => answer(200, { key: KEY, data: 'z'.repeat(REST_RESULT_MAX + 100) }) })
  const postText = await post.execute({ bookId: 'b1', query: 'q' })
  assert.ok(!postText.includes(KEY))
  assert.match(postText, /result cut:/)
})
