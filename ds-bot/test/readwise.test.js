// Readwise Reader connector: the declaration, the metadata-only list projection, and one
// mocked failure per case the shared REST adapter can hit. No test reaches the real API.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import readwise, { verifyReadwise } from '../src/host/connectors/readwise.js'
import { createRestTools } from '../src/host/rest-tools.js'

const output = { schema: { type: 'string' }, render: () => [] }
const TOKEN = 'rw_test_token_value'
const redact = text => String(text).split(TOKEN).join('[secret]')

const answer = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => 'application/json' },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body ?? {}),
})

async function run(toolName, args = {}, respond = () => answer(200, { count: 0, results: [] })) {
  const sent = []
  const tools = createRestTools('readwise', readwise, {
    token: TOKEN,
    output,
    redact,
    fetch: async (url, options) => {
      sent.push({ url: String(url), options })
      return respond()
    },
  })
  const tool = tools.find(item => item.name === `readwise_${toolName}`)
  assert.ok(tool !== undefined, `readwise_${toolName} is not built`)
  const result = await tool.execute(args)
  return { result, sent: sent[0] }
}

test('declares the Reader API, the Token header and a read-only rest-tools module', () => {
  assert.equal(readwise.id, 'readwise')
  assert.equal(readwise.mode, 'rest-tools')
  assert.equal(readwise.api, 'https://readwise.io')
  assert.equal(readwise.tokenSecret, 'READWISE_TOKEN')
  assert.deepEqual(readwise.auth({ token: TOKEN }), { Authorization: `Token ${TOKEN}` })
  assert.deepEqual(readwise.credentials, [{ name: 'READWISE_TOKEN', label: 'Readwise access token' }])
  assert.deepEqual(readwise.levels, ['read'])
  assert.equal(typeof readwise.verify, 'function')
  assert.equal(readwise.restTools.length, 5)
  // The card reads one object, and a module that declares levels must name its capabilities.
  assert.deepEqual(Object.keys(readwise.card).sort(), ['about', 'docsUrl', 'readOnlyNote'])
  assert.equal(readwise.capabilities.length, 3)
  assert.equal(typeof readwise.permissions.summary, 'string')
})

test('every tool is a fixed GET and no tool takes a path, url or header', () => {
  for (const tool of readwise.restTools) {
    assert.equal(tool.method, 'GET', `${tool.name} must be a GET`)
    assert.equal(tool.write, undefined, `${tool.name} must not be a write`)
    assert.equal(tool.readOnly, undefined, `${tool.name} must not mark a GET as readOnly`)
    assert.ok(tool.path.startsWith('/api/v3/'), `${tool.name} must stay under the fixed API prefix`)
    const properties = Object.keys(tool.parameters.properties ?? {})
    for (const forbidden of ['path', 'url', 'endpoint', 'headers', 'authorization', 'method']) {
      assert.equal(properties.includes(forbidden), false, `${tool.name} must not take "${forbidden}"`)
    }
  }
  assert.deepEqual(readwise.restTools.map(tool => tool.name), ['list_documents', 'get_document', 'list_highlights', 'list_notes', 'list_tags'])
})

test('a list answer keeps metadata and counts, never note or article text', async () => {
  const { result, sent } = await run('list_documents', {}, () => answer(200, {
    count: 2,
    nextPageCursor: 'cursor-1',
    results: [
      { id: 'a', title: 'A title', author: 'An author', location: 'later', category: 'article', summary: 'A short summary', notes: 'my private note text', content: 'the full article body', source_url: 'https://example.com/a', image_url: 'https://example.com/a.png' },
      { id: 'b', title: 'B title', notes: '' },
    ],
  }))
  assert.equal(sent.url, 'https://readwise.io/api/v3/list/?limit=25')
  assert.equal(sent.options.method, 'GET')
  assert.equal(sent.options.headers.Authorization, `Token ${TOKEN}`)
  const parsed = JSON.parse(result)
  assert.equal(parsed.count, 2)
  assert.equal(parsed.nextPageCursor, 'cursor-1')
  assert.equal(parsed.results[0].title, 'A title')
  assert.equal(parsed.results[0].has_note, true)
  assert.equal(parsed.results[1].has_note, false)
  for (const leaked of ['my private note text', 'the full article body', 'https://example.com/a']) {
    assert.equal(result.includes(leaked), false, `a list answer must not carry "${leaked}"`)
  }
})

test('a page cursor and an explicit limit replace the default page size', async () => {
  const { sent } = await run('list_documents', { pageCursor: 'abc', limit: 50 }, () => answer(200, { count: 0, results: [] }))
  const url = new URL(sent.url)
  assert.equal(url.searchParams.get('pageCursor'), 'abc')
  assert.equal(url.searchParams.get('limit'), '50')
  assert.equal(sent.url.split('limit=').length, 2, 'the default limit must be replaced, not duplicated')
})

test('highlights and notes are listed as their own documents without their text', async () => {
  const highlight = await run('list_highlights', {}, () => answer(200, { count: 1, results: [{ id: 'h1', parent_id: 'doc1', highlight_offset: 12, notes: 'private note', content: 'highlighted passage' }] }))
  assert.equal(highlight.sent.url.split('?')[1].startsWith('category=highlight'), true)
  const parsed = JSON.parse(highlight.result)
  assert.equal(parsed.results[0].parent_id, 'doc1')
  assert.equal(parsed.results[0].has_note, true)
  assert.equal(highlight.result.includes('highlighted passage'), false)
  assert.equal(highlight.result.includes('private note'), false)

  const note = await run('list_notes', {}, () => answer(200, { count: 1, results: [{ id: 'n1', parent_id: 'doc1', notes: 'note body' }] }))
  assert.equal(note.sent.url.split('?')[1].startsWith('category=note'), true)
  assert.equal(note.result.includes('note body'), false)
  assert.equal(JSON.parse(note.result).results[0].has_note, true)
})

test('one named document is returned whole, because the reader asked for it', async () => {
  const { result, sent } = await run('get_document', { id: 'doc-1' }, () => answer(200, { count: 1, results: [{ id: 'doc-1', title: 'T', notes: 'the note I wrote' }] }))
  assert.equal(new URL(sent.url).searchParams.get('id'), 'doc-1')
  assert.equal(result.includes('the note I wrote'), true)
})

test('tags are listed from its own endpoint, and only its fields come back', async () => {
  const { result, sent } = await run('list_tags', {}, () => answer(200, { count: 1, results: [{ id: 't1', name: 'work', color: '#fff', extra: 'not ours' }] }))
  assert.equal(sent.url, 'https://readwise.io/api/v3/tags/')
  const parsed = JSON.parse(result)
  assert.equal(parsed.count, 1)
  assert.deepEqual(Object.keys(parsed).sort(), ['count', 'results'])
  assert.deepEqual(Object.keys(parsed.results[0]).sort(), ['id', 'name'])
  assert.equal(result.includes('not ours'), false)
})

test('an empty library is an empty answer, not a failure', async () => {
  const { result } = await run('list_documents', {}, () => answer(200, { count: 0, nextPageCursor: null, results: [] }))
  assert.equal(JSON.parse(result).results.length, 0)
})

test('auth, permission and rate answers read as plain errors', async () => {
  await assert.rejects(run('list_documents', {}, () => answer(401, { detail: 'Invalid token' })), /did not accept this token or key/)
  await assert.rejects(run('list_documents', {}, () => answer(403, { detail: 'forbidden' })), /refused this call \(403\)/)
  await assert.rejects(run('list_documents', {}, () => answer(429, {})), /rate limited/)
})

test('an unreachable API is one plain error and never echoes the token', async () => {
  await assert.rejects(run('list_documents', {}, () => { throw new Error(`socket ${TOKEN}`) }), /Could not reach Readwise/)
  await assert.rejects(run('list_documents', {}, () => answer(401, { message: `bad ${TOKEN}` })), error => {
    assert.equal(error.message.includes(TOKEN), false)
    return true
  })
})

test('an oversized answer is cut with a note that says the JSON is incomplete', async () => {
  const longTitle = 'x'.repeat(30_000)
  const { result } = await run('list_documents', {}, () => answer(200, { count: 1, results: [{ id: 'a', title: longTitle }] }))
  assert.match(result, /result cut: \d+ characters in all/)
  assert.equal(result.includes(longTitle), false)
})

test('the token check asks the auth endpoint and accepts a 204', async () => {
  const sent = []
  const extra = await verifyReadwise({
    token: TOKEN,
    fetch: async (url, options) => {
      sent.push({ url: String(url), options })
      return { status: 204, ok: true }
    },
  })
  assert.deepEqual(extra, {})
  assert.equal(sent[0].url, 'https://readwise.io/api/v2/auth/')
  assert.equal(sent[0].options.headers.Authorization, `Token ${TOKEN}`)
  await assert.rejects(verifyReadwise({ token: TOKEN, fetch: async () => ({ status: 401, ok: false }) }), /did not accept this token/)
  await assert.rejects(verifyReadwise({ token: TOKEN, fetch: async () => { throw new Error('down') } }), /Could not reach Readwise/)
})
