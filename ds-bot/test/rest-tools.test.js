import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REST_RESULT_MAX, createRestTools } from '../src/host/rest-tools.js'

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
const redact = text => String(text).split(TOKEN).join('[secret]')

test('tools are built read-only and named by connector', () => {
  const [tool] = createRestTools('example', connector(), { token: TOKEN, output })
  assert.equal(tool.name, 'example_get_project')
  assert.equal(tool.description, 'Read one project')
  assert.deepEqual(tool.parameters.required, ['projectId'])
  assert.throws(() => createRestTools('example', { ...connector(), restTools: [{ name: 'deploy', method: 'POST', path: '/v1/deploy' }] }, { token: TOKEN, output }), /must be GET/)
  assert.throws(() => createRestTools('example', { ...connector(), restTools: [{ name: 'bad', method: 'GET', path: 'v1/x' }] }, { token: TOKEN, output }), /needs a path/)
})

test('a call fills path and query and sends the bearer token', async () => {
  const seen = []
  const [tool] = createRestTools('example', connector(), { token: TOKEN, output, fetch: async (url, init) => { seen.push([url, init]); return answer(200, { projects: [] }) } })
  assert.equal(await tool.execute({ projectId: 'a b', withMembers: true, limit: 5 }), '{"projects":[]}')
  const [url, init] = seen[0]
  assert.equal(url.toString(), 'https://api.example.com/v1/projects/a%20b?with_members=true&limit=5')
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
  const [tool] = createRestTools('example', connector({ restHeaders: token => ({ Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }) }), {
    token: TOKEN, output, fetch: async (url, init) => { seen.push(init.headers); return answer(200, {}) },
  })
  await tool.execute({ projectId: 'p1' })
  assert.equal(seen[0]['Notion-Version'], '2022-06-28')
})

test('http errors become clear tool errors', async () => {
  for (const [status, pattern] of [[401, /did not accept this token/], [403, /refused this call \(403\)/], [404, /did not find it \(404\)/], [429, /rate limited/], [500, /Example answered 500/]]) {
    const [tool] = createRestTools('example', connector(), { token: TOKEN, output, fetch: async () => answer(status, {}) })
    await assert.rejects(tool.execute({ projectId: 'p1' }), pattern, String(status))
  }
  const [tool] = createRestTools('example', connector(), { token: TOKEN, output, fetch: async () => { throw new Error('offline') } })
  await assert.rejects(tool.execute({ projectId: 'p1' }), /Could not reach Example/)
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
})
