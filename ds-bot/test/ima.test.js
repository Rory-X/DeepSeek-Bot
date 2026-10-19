import assert from 'node:assert/strict'
import { test } from 'node:test'
import connector, {
  IMA_API_KEY_SECRET,
  IMA_BASE,
  IMA_CLIENT_ID_SECRET,
  IMA_ENVELOPE,
  IMA_REST_TOOLS,
  IMA_WRITE_PATHS,
  auth,
  imaError,
  verifyIma,
} from '../src/host/connectors/ima.js'

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
  assert.equal(connector.restTools, IMA_REST_TOOLS)
  assert.equal(connector.verify, verifyIma)
  assert.equal(typeof connector.auth, 'function')
  assert.deepEqual(connector.credentials, [
    { name: IMA_CLIENT_ID_SECRET, label: 'Client ID' },
    { name: IMA_API_KEY_SECRET, label: 'API key' },
  ])
})

test('the declaration covers exactly the nine read calls, all POST and read-only', () => {
  assert.deepEqual(IMA_REST_TOOLS.map(tool => tool.name).sort(), [
    'get_kb',
    'get_media',
    'get_note',
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

test('the envelope names ima\'s own status fields and maps the refusal codes', () => {
  assert.equal(IMA_ENVELOPE.ok, 'code')
  assert.equal(IMA_ENVELOPE.success, 0)
  assert.equal(IMA_ENVELOPE.data, 'data')
  assert.equal(IMA_ENVELOPE.error, 'msg')
  assert.match(IMA_ENVELOPE.errors[20002], /rate limiting/)
  assert.match(IMA_ENVELOPE.errors[20004], /did not accept this client id or API key/)
  assert.match(IMA_ENVELOPE.errors[200002], /did not accept this client id or API key/)
  assert.match(IMA_ENVELOPE.errors[110030], /may not read that/)
  assert.equal(imaError(999, ''), 'ima answered 999')
  assert.equal(imaError(210001, '参数非法'), 'ima answered 210001: 参数非法')
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
  await assert.rejects(verifyIma({ secrets: SECRETS, fetch: async () => answer(200, { code: 20004, msg: 'auth failed', data: {} }) }), /did not accept this client id or API key/)
  await assert.rejects(verifyIma({ secrets: SECRETS, fetch: async () => answer(200, { code: 210001, msg: '参数非法', data: {} }) }), /ima answered code 210001: 参数非法/)
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

test('the card hints describe a read-only, account-less connector', () => {
  assert.equal(connector.glyph, 'ima')
  assert.match(connector.about, /notes and knowledge bases/)
  assert.match(connector.docsUrl, /^https:\/\/ima\.qq\.com\//)
  assert.match(connector.readOnlyNote, /only read/)
  assert.equal(connector.actions, undefined)
  assert.equal(connector.toolbox, undefined)
})
