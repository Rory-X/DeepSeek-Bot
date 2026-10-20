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
  auth: ({ token, secrets }) => ({ Authorization: `Bearer ${token}`, 'X-Api-Key': secrets.POSTLY_API_KEY }),
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
  assert.throws(() => createRestTools('example', { ...connector(), restTools: [{ name: 'deploy', method: 'POST', path: '/v1/deploy' }] }, { token: TOKEN, output }), /must declare exactly one of readOnly: true or write: true/)
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

test('a connector auth hook receives its named credentials', async () => {
  const seen = []
  const [tool] = createRestTools('example', connector({
    auth: ({ token, secrets }) => ({ Authorization: `Bearer ${token}`, 'X-Named': secrets.EXTRA_KEY, 'Notion-Version': '2022-06-28' }),
  }), {
    token: TOKEN, secrets: { EXTRA_KEY: 'named-secret' }, output, fetch: async (url, init) => { seen.push(init.headers); return answer(200, {}) },
  })
  await tool.execute({ projectId: 'p1' })
  assert.equal(seen[0]['Notion-Version'], '2022-06-28')
  assert.equal(seen[0]['X-Named'], 'named-secret')
  // The old name still works for connectors written against it.
  const [legacy] = createRestTools('example', connector({ restHeaders: () => ({ Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28' }) }), {
    token: TOKEN, output, fetch: async (url, init) => { seen.push(init.headers); return answer(200, {}) },
  })
  await legacy.execute({ projectId: 'p1' })
  assert.equal(seen[1]['Notion-Version'], '2022-06-28')
})

test('a read-only POST sends only the mapped body fields, with connector-owned auth', async () => {
  const seen = []
  const [tool] = createRestTools('postly', postConnector(), {
    token: TOKEN,
    secrets: { POSTLY_API_KEY: KEY },
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

  const [post] = createRestTools('postly', postConnector(), { token: TOKEN, secrets: { POSTLY_API_KEY: KEY }, output, fetch: async () => answer(429, {}) })
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
  const [post] = createRestTools('postly', postConnector(), { token: TOKEN, secrets: { POSTLY_API_KEY: KEY }, output, redact, fetch: async () => answer(200, { key: KEY, data: 'z'.repeat(REST_RESULT_MAX + 100) }) })
  const postText = await post.execute({ bookId: 'b1', query: 'q' })
  assert.ok(!postText.includes(KEY))
  assert.match(postText, /result cut:/)
})

// WeRead answers HTTP 200 with `errcode`; ima with `code/msg/data`. An envelope turns either
// into a plain payload, and a nonzero status into a tool error.
const enveloped = (envelope, extra = {}) => ({
  displayName: 'Enveloped',
  api: 'https://enveloped.test',
  envelope,
  restTools: [{ name: 'query', method: 'POST', readOnly: true, path: '/v1/query', body: { q: 'q' }, parameters: { type: 'object', properties: { q: { type: 'string' } } }, ...extra }],
})

test('an envelope unwraps the payload and turns a bad status code into an error', async () => {
  const ok = createRestTools('env', enveloped({ ok: 'errcode', success: 0, data: 'data', error: 'errmsg' }), { output, fetch: async () => answer(200, { errcode: 0, errmsg: 'ok', data: { notes: 2 } }) })
  assert.equal(await ok[0].execute({ q: 'x' }), '{"notes":2}')

  const ima = createRestTools('ima', enveloped({ ok: 'code', success: 0, data: 'data', error: 'msg', errors: { 20002: 'ima is rate limited; try again later.', 20004: 'ima did not accept this API key.' } }), { output })
  for (const [code, pattern] of [[20002, /rate limited/], [20004, /did not accept this API key/], [210001, /Enveloped: something broke/]]) {
    const [tool] = createRestTools('ima', enveloped({ ok: 'code', success: 0, data: 'data', error: 'msg', errors: { 20002: 'ima is rate limited; try again later.', 20004: 'ima did not accept this API key.' } }), { output, fetch: async () => answer(200, { code, msg: 'something broke', data: {} }) })
    await assert.rejects(tool.execute({ q: 'x' }), pattern, String(code))
  }
  assert.equal(ima[0].name, 'ima_query')

  // A per-tool envelope replaces the connector's.
  const overridden = createRestTools('env', enveloped({ ok: 'errcode', success: 0, data: 'data' }, { envelope: { ok: 'status', success: 'ok', data: 'result' } }), { output, fetch: async () => answer(200, { status: 'ok', result: [1, 2] }) })
  assert.equal(await overridden[0].execute({ q: 'x' }), '[1,2]')

  const missing = createRestTools('env', enveloped({ ok: 'errcode', success: 0 }), { output, fetch: async () => answer(200, 'not json') })
  await assert.rejects(missing[0].execute({ q: 'x' }), /cannot read/)
})

test('a dotted body field nests its object, as a structured request needs', async () => {
  const seen = []
  const nested = {
    displayName: 'Nested',
    api: 'https://nested.test',
    restTools: [{
      name: 'search_note',
      method: 'POST',
      readOnly: true,
      path: '/note/search',
      body: { 'query_info.title': 'title', 'query_info.content': 'content', start: { const: 0 } },
      parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } } },
    }],
  }
  const [tool] = createRestTools('nested', nested, { output, fetch: async (url, init) => { seen.push(JSON.parse(init.body)); return answer(200, {}) } })
  await tool.execute({ title: '周报', content: '周报', start: 99 })
  assert.deepEqual(seen[0], { query_info: { title: '周报', content: '周报' }, start: 0 })
})

test('a per-tool result limit applies to an envelope answer too', async () => {
  const book = { text: 'x'.repeat(30_000) }
  const tool = (resultMax) => createRestTools('env', enveloped({ ok: 'code', success: 0, data: 'data' }, { resultMax }), { output, fetch: async () => answer(200, { code: 0, data: book }) })[0]

  // A big read that the connector asked to keep whole stays whole.
  const wide = await tool(40_000).execute({ q: 'x' })
  assert.ok(wide.length > REST_RESULT_MAX)
  assert.ok(!wide.includes('result cut:'))

  // A narrower limit still cuts, with the same note.
  const narrow = await tool(1_000).execute({ q: 'x' })
  assert.ok(narrow.length < 2_000)
  assert.match(narrow, /result cut: \d+ characters in all/)
})

test('an answer hook may format or refuse a successful response', async () => {
  const formatter = createRestTools('env', enveloped(undefined, {
    answer: ({ body }) => `notes: ${body.data.length}`,
  }), { output, fetch: async () => answer(200, { data: [1, 2, 3] }) })
  assert.equal(await formatter[0].execute({ q: 'x' }), 'notes: 3')

  const refusing = createRestTools('env', enveloped(undefined, {
    answer: ({ body }) => { if (body.code !== 0) throw new Error('no') ; return 'ok' },
  }), { output, fetch: async () => answer(200, { code: 20004 }) })
  await assert.rejects(refusing[0].execute({ q: 'x' }), /no/)

  // HTTP errors are mapped before the envelope sees anything.
  const http = createRestTools('env', enveloped({ ok: 'code', success: 0 }), { output, fetch: async () => answer(429, { code: 0 }) })
  await assert.rejects(http[0].execute({ q: 'x' }), /rate limited/)
})

// WeRead: success carries no errcode (only /_list sends errcode 0), a business error is HTTP
// 499 with errcode/errmsg, and the status code alone would hide the service's own words.
const wereadEnvelope = { ok: 'errcode', success: 0, allowAbsent: true, data: 'data', error: 'errmsg', errors: { '-2013': 'WeRead did not accept this API key.' } }
const weread = (envelope = wereadEnvelope) => ({
  displayName: 'WeRead',
  api: 'https://weread.test',
  auth: () => ({ Authorization: 'Bearer key' }),
  envelope,
  restTools: [{ name: 'sync', method: 'POST', readOnly: true, path: '/shelf/sync', body: {}, parameters: { type: 'object', properties: {} } }],
})

test('an envelope may treat an absent status field as success', async () => {
  const [ok] = createRestTools('weread', weread(), { output, fetch: async () => answer(200, { data: { notes: 1 } }) })
  assert.equal(await ok.execute({}), '{"notes":1}')
  const [zero] = createRestTools('weread', weread(), { output, fetch: async () => answer(200, { errcode: 0, data: [1] }) })
  assert.equal(await zero.execute({}), '[1]')
})

test('a business error in a non-2xx body keeps the service message, without its trace id', async () => {
  const [tool] = createRestTools('weread', weread(), {
    output,
    fetch: async () => answer(499, { errcode: -2003, errmsg: '参数格式错误', errlog: 'CDQ34Je' }),
  })
  await assert.rejects(tool.execute({}), (error) => {
    assert.match(error.message, /^WeRead: 参数格式错误$/)
    assert.ok(!error.message.includes('CDQ34Je'))
    assert.ok(!error.message.includes('499'))
    return true
  })
  const [auth] = createRestTools('weread', weread(), { output, fetch: async () => answer(401, { errcode: -2013, errmsg: '鉴权失败' }) })
  await assert.rejects(auth.execute({}), /did not accept this API key/)
})

test('a cut JSON answer says the JSON is incomplete', async () => {
  const [tool] = createRestTools('weread', weread(), { output, fetch: async () => answer(200, { data: { notes: 'z'.repeat(REST_RESULT_MAX + 100) } }) })
  const text = await tool.execute({})
  assert.match(text, /no longer complete/)
  assert.match(text, /result cut: \d+ characters in all/)
})


const writer = (restTools) => ({
  displayName: 'Writer',
  api: 'https://writer.example.com',
  restTools: [
    {
      name: 'get_env',
      description: 'Read one environment value',
      method: 'GET',
      path: '/v1/env',
      query: { name: 'name' },
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
    },
    ...restTools,
  ],
})

const addNote = {
  name: 'add_note',
  description: 'Add a note with its reviews',
  method: 'POST',
  write: true,
  path: '/v1/notes',
  body: {
    docId: 'docId',
    title: 'title',
    reviews: { array: 'reviews', items: { bookId: 'bookId', content: 'content', source: { const: 'bot' } } },
  },
  approval: async (args, { read }) => ({
    line: `Add note to ${await read('get_env', { name: 'doc' })}`,
    target: args.docId,
  }),
  parameters: { type: 'object', properties: { docId: { type: 'string' }, title: { type: 'string' }, reviews: { type: 'array' } } },
}

test('a write REST tool exists only at the write level', () => {
  const readLevel = createRestTools('writer', writer([addNote]), { output, level: 'read' })
  assert.deepEqual(readLevel.map(tool => tool.name), ['writer_get_env'])
  const writeLevel = createRestTools('writer', writer([addNote]), { output, level: 'write', approve: async () => {} })
  assert.deepEqual(writeLevel.map(tool => tool.name), ['writer_get_env', 'writer_add_note'])
})

test('a REST write asks first, sends only declared fields and may read a name for the card', async () => {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body })
    if (String(url).includes('/v1/env')) return answer(200, { env: 'doc-name' })
    return answer(200, { ok: true })
  }
  let asked
  const tools = createRestTools('writer', writer([addNote]), {
    output,
    level: 'write',
    fetch,
    approve: async (request) => { asked = request },
  })
  const tool = tools.find(entry => entry.name === 'writer_add_note')
  const text = await tool.execute({
    docId: 'd1',
    title: 'T',
    reviews: [{ bookId: 'b1', content: 'c1', secret: 'must not pass' }, { bookId: 'b2', content: 'c2' }],
    ignored: 'must not pass',
  }, { agent: { id: 'm1' } })
  assert.equal(text, '{"ok":true}')
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/v1\/env\?name=doc$/)
  assert.equal(calls[1].method, 'POST')
  assert.deepEqual(JSON.parse(calls[1].body), {
    docId: 'd1',
    title: 'T',
    reviews: [{ bookId: 'b1', content: 'c1', source: 'bot' }, { bookId: 'b2', content: 'c2', source: 'bot' }],
  })
  assert.equal(asked.tool, 'writer_add_note')
  assert.equal(asked.exec.agent.id, 'm1')
  assert.match(asked.summary.line, /Add note to \{"env":"doc-name"\}/)
  assert.equal(asked.summary.target, 'd1')
})

test('a refused REST write sends no write request', async () => {
  const requests = []
  const tools = createRestTools('writer', writer([addNote]), {
    output,
    level: 'write',
    fetch: async (url, init = {}) => { requests.push({ url: String(url), method: init.method ?? 'GET' }); return answer(200, { env: 'doc' }) },
    approve: async () => { throw new Error('The user denied Writer\'s add_note; nothing was sent.') },
  })
  const tool = tools.find(entry => entry.name === 'writer_add_note')
  await assert.rejects(tool.execute({ docId: 'd1', reviews: [] }, { agent: { id: 'm1' } }), /denied/)
  // The card's read-only lookup may run; the write itself never reaches the service.
  assert.equal(requests.filter(entry => entry.method !== 'GET').length, 0)
})

test('a write POST needs an explicit body and exactly one mode', () => {
  assert.throws(() => createRestTools('writer', writer([{ name: 'deploy', method: 'POST', write: true, path: '/v1/deploy' }]), { output, level: 'write', approve: async () => {} }), /needs an explicit body mapping/)
  assert.throws(() => createRestTools('writer', writer([{ name: 'both', method: 'POST', write: true, readOnly: true, path: '/v1/x', body: {} }]), { output, level: 'write', approve: async () => {} }), /exactly one of readOnly: true or write: true/)
  assert.throws(() => createRestTools('writer', writer([{ name: 'getwrite', method: 'GET', write: true, path: '/v1/x' }]), { output, level: 'write' }), /only marks a POST/)
})
