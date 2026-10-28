import assert from 'node:assert/strict'
import { test } from 'node:test'
import connector, {
  IMA_API_KEY_SECRET,
  IMA_BASE,
  IMA_CAPABILITIES,
  IMA_CLIENT_ID_SECRET,
  IMA_PERMISSIONS,
  IMA_REST_TOOLS,
  IMA_WRITE_PATHS,
  IMA_URL_RULES,
  assertImportUrls,
  auth,
  validateWriteArgs,
  imaAnswer,
  imaError,
  verifyIma,
} from '../src/host/connectors/ima.js'
// The declaration is standalone, so it loads on a mainline that has no connector base yet.
// When the shared REST adapter is in the tree, the assertions below also run the nine tools
// through it (the way the host mounts them); otherwise they wait for the base.
const { createRestTools } = await import('../src/host/rest-tools.js').catch(() => ({}))
const noAdapter = createRestTools === undefined ? 'the shared connector base is not in this tree' : false

const CLIENT_ID = 'client_id_for_ima_test'
const API_KEY = 'api_key_for_ima_test'
const SECRETS = { [IMA_CLIENT_ID_SECRET]: CLIENT_ID, [IMA_API_KEY_SECRET]: API_KEY }

const answer = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
})
const envelope = data => ({ code: 0, msg: 'success', data })

test('the module is a rest-tools connector the registry can load by its default export', () => {
  assert.equal(connector.id, 'ima')
  assert.equal(connector.mode, 'rest-tools')
  assert.equal(connector.displayName, 'ima')
  assert.equal(connector.api, IMA_BASE)
  assert.equal(connector.restTools.length, 14)
  assert.deepEqual(connector.restTools.slice(0, IMA_REST_TOOLS.length), IMA_REST_TOOLS)
  assert.equal(connector.verify, verifyIma)
  assert.equal(typeof connector.auth, 'function')
  assert.deepEqual(connector.credentials, [
    { name: IMA_CLIENT_ID_SECRET, label: 'Client ID' },
    { name: IMA_API_KEY_SECRET, label: 'API key' },
  ])
})

test('the declaration covers exactly the ten read calls, all POST and read-only', () => {
  assert.deepEqual(IMA_REST_TOOLS.map(tool => tool.name).sort(), [
    'get_kb',
    'get_media',
    'get_note',
    'list_addable_kb',
    'list_kb',
    'list_notebooks',
    'list_notes',
    'search_kb',
    'search_kb_list',
    'search_notes',
  ])
  for (const tool of IMA_REST_TOOLS) {
    assert.equal(tool.method, 'POST', tool.name)
    assert.equal(tool.readOnly, true, tool.name)
    assert.match(tool.path, /^\/openapi\/(note|wiki)\/v1\//, tool.name)
    assert.ok(tool.description.length > 20, tool.name)
  }
})

test('no write endpoint is reachable through the declaration', () => {
  const declared = new Set(IMA_REST_TOOLS.map(tool => tool.path))
  for (const path of IMA_WRITE_PATHS) assert.equal(declared.has(path), false, path)
  for (const tool of IMA_REST_TOOLS) {
    for (const word of ['import_doc', 'append_doc', 'create_media', 'add_knowledge', 'import_urls']) {
      assert.equal(tool.path.includes(word), false, `${tool.name} reaches ${word}`)
    }
  }
})

test('every body field comes from a declared argument or a constant', () => {
  for (const tool of IMA_REST_TOOLS) {
    const properties = tool.parameters.properties ?? {}
    assert.deepEqual(tool.parameters.type, 'object', tool.name)
    for (const [field, mapping] of Object.entries(tool.body ?? {})) {
      if (mapping !== null && typeof mapping === 'object') {
        assert.ok(Object.hasOwn(mapping, 'const'), `${tool.name}.${field} is a constant`)
        continue
      }
      assert.equal(typeof mapping, 'string', `${tool.name}.${field} names an argument`)
      assert.ok(Object.hasOwn(properties, mapping), `${tool.name}.${field} sends the declared argument "${mapping}"`)
    }
    for (const name of tool.parameters.required ?? []) assert.ok(Object.hasOwn(properties, name), `${tool.name} requires "${name}"`)
  }
})

test('the search call nests query_info under its argument without widening the body', () => {
  const search = IMA_REST_TOOLS.find(tool => tool.name === 'search_notes')
  assert.deepEqual(search.body, {
    search_type: 'search_type',
    sort_type: 'sort_type',
    'query_info.title': 'query',
    'query_info.content': 'query',
    start: 'start',
    end: 'end',
  })
  // The same phrase fills both nested fields; ima reads the one search_type selects.
  assert.equal(search.parameters.properties.query.type, 'string')
  assert.deepEqual(search.parameters.required, ['query', 'start', 'end'])
})

test('the two credential headers and the skill context travel on every call', () => {
  const headers = auth({ secrets: SECRETS })
  assert.equal(headers['ima-openapi-clientid'], CLIENT_ID)
  assert.equal(headers['ima-openapi-apikey'], API_KEY)
  assert.equal(headers['ima-openapi-ctx'], 'skill_version=1.1.10')
  // A missing credential is left out instead of sent as the string "undefined".
  assert.deepEqual(auth({}), { 'ima-openapi-ctx': 'skill_version=1.1.10' })
  assert.deepEqual(auth({ secrets: { [IMA_CLIENT_ID_SECRET]: CLIENT_ID } }), { 'ima-openapi-clientid': CLIENT_ID, 'ima-openapi-ctx': 'skill_version=1.1.10' })
})

test('a business failure and a refusal each keep their own sentence', () => {
  assert.equal(imaAnswer({ status: 200, body: envelope({ info_list: [] }) }), '{"info_list":[]}')
  assert.equal(imaAnswer({ status: 200, body: { code: 0 } }), '{}')
  assert.throws(() => imaAnswer({ status: 200, body: { code: 20004, msg: 'auth failed' } }), /did not accept this client id or API key/)
  assert.throws(() => imaAnswer({ status: 200, body: { code: 20002, msg: 'slow down' } }), /rate limiting/)
  assert.throws(() => imaAnswer({ status: 200, body: { code: 110030, msg: '无权限' } }), /may not read that: 无权限/)
  assert.throws(() => imaAnswer({ status: 200, body: { code: 210001, msg: '参数非法' } }), /ima answered 210001: 参数非法/)
  // A body that is not an ima envelope is refused, never guessed at.
  assert.throws(() => imaAnswer({ status: 200, body: 'gateway error' }), /cannot read/)
  assert.throws(() => imaAnswer({ status: 200, body: { not: 'an envelope' } }), /cannot read/)
  assert.equal(imaError(999, ''), 'ima answered 999')
})

test('verify confirms the pair with one empty knowledge base search', async () => {
  const seen = []
  const ok = await verifyIma({
    secrets: SECRETS,
    fetch: async (url, init) => {
      seen.push([url, init])
      return answer(200, envelope({ info_list: [], is_end: true }))
    },
  })
  assert.deepEqual(ok, { ok: true })
  const [url, init] = seen[0]
  assert.equal(url, `${IMA_BASE}/openapi/wiki/v1/search_knowledge_base`)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['ima-openapi-clientid'], CLIENT_ID)
  assert.equal(init.headers['ima-openapi-apikey'], API_KEY)
  assert.equal(init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(init.body), { query: '', cursor: '', limit: 1 })
})

test('verify turns a refusal, a timeout and a dead network into clear errors', async () => {
  await assert.rejects(verifyIma({ secrets: SECRETS, fetch: async () => answer(401, { code: 200002, msg: 'skill auth failed' }) }), /did not accept this client id or API key/)
  await assert.rejects(verifyIma({ secrets: SECRETS, fetch: async () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error } }), /did not answer in time/)
  await assert.rejects(verifyIma({ secrets: SECRETS, fetch: async () => { throw new Error('offline') } }), /Could not reach ima/)
  await assert.rejects(verifyIma({ secrets: SECRETS, fetch: async () => answer(500, {}) }), /ima answered 500/)
  await assert.rejects(verifyIma({ secrets: SECRETS, fetch: async () => answer(429, {}) }), /rate limiting/)
  await assert.rejects(verifyIma({ secrets: SECRETS, fetch: async () => answer(200, { code: 20004, msg: 'auth failed', data: {} }) }), /did not accept this client id or API key/)
  await assert.rejects(verifyIma({ secrets: SECRETS, fetch: async () => answer(200, { code: 210001, msg: '参数非法', data: {} }) }), /ima answered 210001: 参数非法/)
  // The credentials never appear in an error message.
  try {
    await verifyIma({ secrets: SECRETS, fetch: async () => answer(401, {}) })
    assert.fail('should have failed')
  } catch (error) {
    assert.equal(String(error.message).includes(API_KEY), false)
    assert.equal(String(error.message).includes(CLIENT_ID), false)
  }
})

test('verify refuses a half-filled card without a request', async () => {
  let asked = false
  const fetch = async () => { asked = true; return answer(200, envelope({})) }
  await assert.rejects(verifyIma({ secrets: { [IMA_API_KEY_SECRET]: API_KEY }, fetch }), /missing IMA_OPENAPI_CLIENTID/)
  await assert.rejects(verifyIma({ secrets: { [IMA_CLIENT_ID_SECRET]: CLIENT_ID }, fetch }), /missing IMA_OPENAPI_APIKEY/)
  await assert.rejects(verifyIma({ fetch }), /missing IMA_OPENAPI_CLIENTID and IMA_OPENAPI_APIKEY/)
  assert.equal(asked, false)
})

test('the card copy lives under card, where the client reads it', () => {
  // The connector view calls cardText(connector, key), which reads connector.card[key] only,
  // so a top-level glyph/about/docsUrl/readOnlyNote would never reach the card.
  assert.equal(connector.card.glyph, 'ima')
  assert.match(connector.card.about, /notes and knowledge bases/)
  // The copy names the write level: it would contradict the four write tools otherwise.
  assert.match(connector.card.about, /Full capabilities/)
  assert.match(connector.card.docsUrl, /^https:\/\/ima\.qq\.com\//)
  assert.match(connector.card.readOnlyNote, /read level nothing is changed/)
  assert.match(connector.card.readOnlyNote, /none can be undone/)
  for (const key of ['glyph', 'about', 'docsUrl', 'readOnlyNote']) assert.equal(connector[key], undefined, key)
  assert.equal(connector.actions, undefined)
  assert.equal(connector.toolbox, undefined)
})

// The connector mounted through the shared adapter: these are the declarations the host
// actually registers, so the endpoint, method and body each tool sends are checked here.
const mounted = (fetch, secrets = { [IMA_CLIENT_ID_SECRET]: CLIENT_ID, [IMA_API_KEY_SECRET]: API_KEY }) =>
  createRestTools('ima', connector, { secrets, output: { schema: { type: 'string' }, render: () => [] }, fetch })

test('the adapter mounts all ten read tools under the ima id', { skip: noAdapter }, () => {
  const names = mounted(async () => answer(200, envelope({}))).map(tool => tool.name)
  assert.deepEqual(names, [
    'ima_search_notes',
    'ima_list_notebooks',
    'ima_list_notes',
    'ima_get_note',
    'ima_get_kb',
    'ima_list_kb',
    'ima_search_kb',
    'ima_search_kb_list',
    'ima_get_media',
    'ima_list_addable_kb',
  ])
  for (const tool of mounted(async () => answer(200, envelope({})))) {
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.description.length > 20, tool.name)
  }
})

test('each mounted tool POSTs to ima.qq.com with both headers and only its mapped body', { skip: noAdapter }, async () => {
  const calls = []
  const tools = mounted(async (url, init) => { calls.push([url, init]); return answer(200, envelope({ notes: [] })) })
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
  const callsOf = [
    ['ima_search_notes', { query: '周报', start: 0, end: 20 }, { query_info: { title: '周报', content: '周报' }, start: 0, end: 20 }],
    ['ima_list_notebooks', { cursor: '0', limit: 20 }, { cursor: '0', limit: 20 }],
    ['ima_list_notes', { cursor: '', limit: 20 }, { cursor: '', limit: 20 }],
    ['ima_get_note', { note_id: 'n1' }, { note_id: 'n1', target_content_format: 0 }],
    ['ima_get_kb', { ids: ['kb1', 'kb2'] }, { ids: ['kb1', 'kb2'] }],
    ['ima_list_kb', { knowledge_base_id: 'kb1', cursor: '', limit: 10 }, { knowledge_base_id: 'kb1', cursor: '', limit: 10 }],
    ['ima_search_kb', { query: 'q', cursor: '', knowledge_base_id: 'kb1' }, { query: 'q', cursor: '', knowledge_base_id: 'kb1' }],
    ['ima_search_kb_list', { query: '', cursor: '', limit: 1 }, { query: '', cursor: '', limit: 1 }],
    ['ima_get_media', { media_id: 'm1' }, { media_id: 'm1' }],
    ['ima_list_addable_kb', { cursor: '', limit: 1 }, { cursor: '', limit: 1 }],
  ]
  for (const [name, args] of callsOf) assert.equal(await byName[name].execute(args), '{"notes":[]}', name)
  assert.equal(calls.length, callsOf.length)
  for (const [index, [url, init]] of calls.entries()) {
    const [name, , expected] = callsOf[index]
    assert.equal(url.origin, IMA_BASE, name)
    assert.match(url.pathname, /^\/openapi\/(note|wiki)\/v1\//, name)
    assert.equal(init.method, 'POST', name)
    assert.equal(init.headers['ima-openapi-clientid'], CLIENT_ID, name)
    assert.equal(init.headers['ima-openapi-apikey'], API_KEY, name)
    assert.equal(init.headers['ima-openapi-ctx'], 'skill_version=1.1.10', name)
    assert.equal(init.headers['content-type'], 'application/json', name)
    assert.deepEqual(JSON.parse(init.body), expected, name)
  }
})

test('the adapter unwraps ima answers, and a 429 stays a rate limit whatever the body', async () => {
  const [ok] = mounted(async () => answer(200, envelope({ info_list: [] })))
  assert.equal(await ok.execute({ query: '', cursor: '', limit: 1 }), '{"info_list":[]}')
  const [auth] = mounted(async () => answer(200, { code: 20004, msg: 'auth failed', data: {} }))
  await assert.rejects(auth.execute({ cursor: '0', limit: 20 }), /did not accept this client id or API key/)
  const [rate] = mounted(async () => answer(200, { code: 20002, msg: 'slow down', data: {} }))
  await assert.rejects(rate.execute({ cursor: '0', limit: 20 }), /rate limiting/)
  // An unmapped code keeps the service's own message, so the model still learns why.
  const [unknown] = mounted(async () => answer(200, { code: 210001, msg: '参数非法', data: {} }))
  await assert.rejects(unknown.execute({ cursor: '0', limit: 20 }), /参数非法/)
  // Probe's regression: HTTP 429 with an empty body, or with a body that is not an
  // envelope, must say "rate limit" instead of "code undefined".
  for (const body of ['', '{}', '{"code":20002,"msg":"too many"}']) {
    const [throttled] = mounted(async () => ({ status: 429, ok: false, text: async () => body }))
    await assert.rejects(throttled.execute({ cursor: '0', limit: 20 }), /rate limited/, JSON.stringify(body))
  }
})

// Third batch: the four write tools are declared with `write: true` and mounted by the shared
// adapter only at the write level; the approval hook names the call and refuses bad URLs.
test('the adapter mounts ten read tools at read level and fourteen at write level', () => {
  const namesAt = level => createRestTools('ima', connector, {
    secrets: { [IMA_CLIENT_ID_SECRET]: CLIENT_ID, [IMA_API_KEY_SECRET]: API_KEY },
    output: { schema: { type: 'string' }, render: () => [] },
    level,
    approve: async () => {},
    fetch: async () => answer(200, envelope({})),
  }).map(tool => tool.name)
  const read = namesAt('read')
  assert.equal(read.length, 10)
  assert.deepEqual(read.filter(name => name.includes('_create_note') || name.includes('_append_note') || name.includes('_add_note_to_kb') || name.includes('_import_url')), [])
  const write = namesAt('write')
  assert.equal(write.length, 14)
  for (const name of ['ima_create_note', 'ima_append_note', 'ima_add_note_to_kb', 'ima_import_url']) assert.ok(write.includes(name), name)
  // The mounted list is the declaration list: capability display must match what is wired.
  assert.equal(connector.restTools.length, 14)
  assert.equal(connector.restTools.filter(tool => tool.write === true).length, 4)
})

const writeTools = (approve, fetch) => Object.fromEntries(createRestTools('ima', connector, {
  secrets: { [IMA_CLIENT_ID_SECRET]: CLIENT_ID, [IMA_API_KEY_SECRET]: API_KEY },
  output: { schema: { type: 'string' }, render: () => [] },
  level: 'write',
  approve,
  fetch,
}).map(tool => [tool.name, tool]))

test('every write asks with its target, change, reversibility and the irreversible sentence', async () => {
  const cards = []
  const tools = writeTools(async summary => { cards.push(summary) }, async () => answer(200, envelope({ note_id: 'n-new' })))
  await tools.ima_create_note.execute({ content: '# Weekly' })
  await tools.ima_append_note.execute({ note_id: 'n-1', content: 'more' })
  await tools.ima_add_note_to_kb.execute({ knowledge_base_id: 'kb-1', note_id: 'n-1', title: 'Weekly' })
  await tools.ima_import_url.execute({ knowledge_base_id: 'kb-1', folder_id: 'kb-1', urls: ['https://example.com/a', 'https://example.com/b'] })
  assert.equal(cards.length, 4)
  for (const card of cards) {
    assert.match(card.summary.line, /cannot be undone through the API/)
    assert.equal(card.summary.reversible, false)
    assert.equal(card.summary.danger, false)
    assert.equal(typeof card.summary.change, 'string')
  }
  assert.equal(cards[0].tool, 'ima_create_note')
  assert.equal(cards[0].summary.change, 'creates a new note')
  assert.equal(cards[1].summary.target, 'n-1')
  assert.match(cards[1].summary.line, /Append 4 characters to ima note n-1/)
  assert.equal(cards[2].summary.target, 'kb-1')
  assert.match(cards[2].summary.line, /Add ima note n-1 to knowledge base kb-1/)
  assert.equal(cards[3].summary.target, 'kb-1')
  assert.match(cards[3].summary.line, /Import 2 URLs into knowledge base kb-1/)
})

test('a refused write sends nothing', async () => {
  let fetched = 0
  const tools = writeTools(async () => { throw new Error('denied') }, async () => { fetched += 1; return answer(200, envelope({})) })
  await assert.rejects(tools.ima_create_note.execute({ content: '# x' }), /denied/)
  assert.equal(fetched, 0)
})

test('import URLs are refused before the card and before the request', async () => {
  // Direct rules first: nothing here needs a network.
  assert.deepEqual(assertImportUrls(['https://example.com/a', 'http://example.com/b']), ['https://example.com/a', 'http://example.com/b'])
  assert.deepEqual(IMA_URL_RULES.protocols, ['http:', 'https:'])
  assert.ok(IMA_URL_RULES.deniedHosts.includes('bilibili.com'))
  assert.ok(IMA_URL_RULES.deniedHosts.includes('youtube.com'))
  const refused = [
    'file:///etc/passwd',
    'ftp://example.com/a',
    'javascript:alert(1)',
    'https://www.bilibili.com/video/BV1',
    'https://b23.tv/abc',
    'https://www.youtube.com/watch?v=1',
    'https://youtu.be/abc',
    'http://localhost/a',
    'http://localhost.localdomain/a',
    'http://127.0.0.1/a',
    'http://10.1.2.3/a',
    'http://192.168.1.1/a',
    'http://172.20.1.1/a',
    'http://169.254.1.1/a',
    'http://[::1]/a',
    'http://host.local/a',
    'not a url at all',
    '',
  ]
  for (const url of refused) assert.throws(() => assertImportUrls([url]), /ima cannot import|ima imports|Not a URL|URL to import/, url)
  assert.throws(() => assertImportUrls([]), /at least one URL/)
  assert.throws(() => assertImportUrls(Array.from({ length: 11 }, (_, index) => `https://example.com/${index}`)), /at most 10/)
  assert.throws(() => validateWriteArgs('import_url', { urls: ['file:///etc/passwd'] }), /http\(s\) URLs only/)
  assert.doesNotThrow(() => validateWriteArgs('create_note', { content: 'x' }))

  // Through the adapter: the approval hook refuses, so the card is never asked and nothing
  // leaves the host.
  let cards = 0
  let fetched = 0
  const tools = writeTools(
    async () => { cards += 1 },
    async () => { fetched += 1; return answer(200, envelope({})) },
  )
  for (const url of ['file:///etc/passwd', 'https://www.youtube.com/watch?v=1', 'http://127.0.0.1/a']) {
    await assert.rejects(tools.ima_import_url.execute({ knowledge_base_id: 'kb', folder_id: 'kb', urls: [url] }))
  }
  assert.equal(cards, 0)
  assert.equal(fetched, 0)
  await tools.ima_import_url.execute({ knowledge_base_id: 'kb', folder_id: 'kb', urls: ['https://example.com/a'] })
  assert.equal(cards, 1)
  assert.equal(fetched, 1)
})

test('a write sends only the mapped body fields', async () => {
  const calls = []
  const tools = writeTools(async () => {}, async (url, init) => { calls.push([url, init]); return answer(200, envelope({ note_id: 'n-new' })) })
  assert.equal(await tools.ima_create_note.execute({ content: '# Weekly', folder_id: 'f-1', admin: true }), '{"note_id":"n-new"}')
  assert.deepEqual(JSON.parse(calls[0][1].body), { content_format: 1, content: '# Weekly', folder_id: 'f-1' })
  await tools.ima_append_note.execute({ note_id: 'n-1', content: 'more', injected: 'no' })
  assert.deepEqual(JSON.parse(calls[1][1].body), { note_id: 'n-1', content_format: 1, content: 'more' })
  await tools.ima_add_note_to_kb.execute({ knowledge_base_id: 'kb-1', note_id: 'n-1', title: 'Weekly', path: '/etc' })
  assert.deepEqual(JSON.parse(calls[2][1].body), { media_type: 11, title: 'Weekly', knowledge_base_id: 'kb-1', note_info: { content_id: 'n-1' } })
  await tools.ima_import_url.execute({ knowledge_base_id: 'kb-1', folder_id: 'kb-1', urls: ['https://example.com/a'] })
  assert.deepEqual(JSON.parse(calls[3][1].body), { knowledge_base_id: 'kb-1', folder_id: 'kb-1', urls: ['https://example.com/a'] })
  for (const [url, init] of calls) {
    assert.equal(url.origin, IMA_BASE)
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['ima-openapi-clientid'], CLIENT_ID)
    assert.equal(init.headers['ima-openapi-apikey'], API_KEY)
  }
})

test('a write maps HTTP and business failures the way the read path does', async () => {
  const send = response => writeTools(async () => {}, async () => response)
  await assert.rejects(send({ status: 429, ok: false, text: async () => '' }).ima_create_note.execute({ content: 'x' }), /rate limited/)
  await assert.rejects(send(answer(200, { code: 100009, msg: '内容过大' })).ima_create_note.execute({ content: 'x' }), /split it into smaller parts/)
  await assert.rejects(send(answer(200, { code: 310001, msg: '' })).ima_create_note.execute({ content: 'x' }), /notebook does not exist/)
  assert.equal(await send(answer(200, envelope({ note_id: 'n-1' }))).ima_create_note.execute({ content: 'x' }), '{"note_id":"n-1"}')
})

test('imaError covers the notes table as well as the reference table', () => {
  assert.match(imaError(100001, 'bad'), /^ima rejected the request parameters: bad$/)
  assert.match(imaError(100002, ''), /ids is not valid/)
  assert.match(imaError(100003, ''), /internal error/)
  assert.match(imaError(100004, ''), /rejected the size/)
  assert.match(imaError(100005, ''), /may not do that/)
  assert.match(imaError(100006, ''), /no longer exists/)
  assert.match(imaError(100008, ''), /read it again before writing/)
  assert.match(imaError(100009, ''), /split it into smaller parts/)
  assert.match(imaError(310001, ''), /notebook does not exist/)
  assert.match(imaError(210008, ''), /read it again before writing/)
  assert.match(imaError(210009, ''), /split it into smaller parts/)
  assert.match(imaError(210035, ''), /notebook does not exist/)
  assert.match(imaError(219999, '参数非法'), /219999: 参数非法/)
})

test('capabilities describe the write batch without registering a tool', () => {
  assert.deepEqual(connector.capabilities, IMA_CAPABILITIES)
  assert.equal(connector.permissions, IMA_PERMISSIONS)
  // Every write of this connector is irreversible, so its approval metadata makes it
  // destructive rather than write.
  for (const item of IMA_CAPABILITIES.filter(entry => entry.risk !== 'read')) assert.match(item.description, /cannot be undone/, item.key)
  const risks = new Set(IMA_CAPABILITIES.map(item => item.risk))
  assert.deepEqual([...risks].sort(), ['destructive', 'read'])
  for (const item of IMA_CAPABILITIES) {
    assert.equal(typeof item.key, 'string')
    assert.equal(typeof item.title, 'string')
    assert.equal(typeof item.description, 'string')
    if (item.risk !== 'read') {
      assert.equal(item.preview.reversible, false, item.key)
      assert.equal(typeof item.preview.change, 'string', item.key)
    }
  }
  assert.match(IMA_PERMISSIONS.summary, /after your approval/)
  assert.deepEqual(connector.levels, ['read', 'write'])
  assert.equal(connector.defaultLevel, 'read')
})
