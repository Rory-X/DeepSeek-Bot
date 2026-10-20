// 微信读书 connector: the declaration it ships with, one mocked call per failure the REST
// adapter can run into, and the POST key check the card uses. All calls are mocked against
// `rest-tools.js`; no test reaches the real gateway. A branch before the adapter lands has
// no `rest-tools.js`, so those cases skip instead of failing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import weread, { verifyWeread } from '../src/host/connectors/weread.js'

const { createRestTools } = await import('../src/host/rest-tools.js').catch(() => ({}))
const adapterTest = createRestTools === undefined ? test.skip : test

const output = { schema: { type: 'string' }, render: () => [] }
const TOKEN = 'wrk_test_secret_value'
const redact = text => String(text).split(TOKEN).join('[secret]')

const answer = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => 'application/json' },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body ?? {}),
})

// A call to the mocked gateway; returns what the tool returned and the request it sent.
async function run(toolName, args = {}, respond = () => answer(200, { books: [] })) {
  const sent = []
  const tools = createRestTools('weread', weread, {
    token: TOKEN,
    output,
    redact,
    fetch: async (url, options) => {
      sent.push({ url: String(url), options })
      return respond()
    },
  })
  const tool = tools.find(item => item.name === `weread_${toolName}`)
  assert.ok(tool !== undefined, `weread_${toolName} is not built`)
  const result = await tool.execute(args)
  return { result, sent: sent[0] }
}

test('declares the official gateway, Bearer key and read-only REST mode', () => {
  assert.equal(weread.id, 'weread')
  assert.equal(weread.mode, 'rest-tools')
  assert.equal(weread.api, 'https://i.weread.qq.com')
  assert.equal(weread.tokenSecret, 'WEREAD_API_KEY')
  assert.deepEqual(weread.auth({ token: TOKEN }), { Authorization: `Bearer ${TOKEN}` })
  assert.equal(typeof weread.verify, 'function')
})

test('every tool is a read-only POST that names its own api_name and skill version', () => {
  assert.equal(weread.restTools.length, 13)
  for (const tool of weread.restTools) {
    assert.equal(tool.method, 'POST', `${tool.name} must be POST`)
    assert.equal(tool.readOnly, true, `${tool.name} must declare readOnly`)
    assert.equal(tool.path, '/api/agent/gateway', `${tool.name} must call the one gateway`)
    assert.equal(tool.body.api_name.const.startsWith('/'), true, `${tool.name} needs a fixed api_name`)
    assert.equal(typeof tool.body.skill_version.const, 'string', `${tool.name} needs skill_version`)
    // Every forwarded field names an argument the tool's own schema declares, so the model
    // cannot widen the body with an argument the definition did not plan for.
    for (const [field, mapping] of Object.entries(tool.body)) {
      if (field === 'api_name' || field === 'skill_version') continue
      assert.equal(typeof mapping, 'string', `${tool.name}.${field} must name an argument`)
      assert.ok(Object.hasOwn(tool.parameters.properties ?? {}, mapping), `${tool.name}.${field} names "${mapping}", which its schema does not declare`)
    }
  }
})

test('the read-only tools are the ones Ada mapped, and no pass-through exists', () => {
  assert.deepEqual(weread.restTools.map(tool => tool.name), [
    'shelf', 'search', 'book', 'chapters', 'progress', 'notebooks', 'highlights',
    'my_notes', 'popular_highlights', 'stats', 'similar', 'reviews', 'chapter_heat',
  ])
  assert.deepEqual(weread.restTools.map(tool => tool.body.api_name.const), [
    '/shelf/sync', '/store/search', '/book/info', '/book/chapterinfo', '/book/getprogress',
    '/user/notebooks', '/book/bookmarklist', '/review/list/mine', '/book/bestbookmarks',
    '/readdata/detail', '/book/similar', '/review/list', '/book/underlines',
  ])
  // Nothing that could write is declared, and no tool takes a free-form api_name, path, method
  // or header: the gateway call is fixed by the definition, not by the model.
  for (const tool of weread.restTools) {
    const properties = Object.keys(tool.parameters.properties ?? {})
    for (const forbidden of ['api_name', 'apiName', 'path', 'url', 'method', 'headers', 'authorization', 'skill_version']) {
      assert.equal(properties.includes(forbidden), false, `${tool.name} must not take "${forbidden}"`)
    }
  }
})

adapterTest('sends the key as a Bearer header and the body flat, as the gateway requires', async () => {
  const { result, sent } = await run('shelf', {}, () => answer(200, { books: [{ title: 'A' }], albums: [] }))
  assert.equal(sent.url, 'https://i.weread.qq.com/api/agent/gateway')
  assert.equal(sent.options.method, 'POST')
  assert.equal(sent.options.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(sent.options.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(sent.options.body), { api_name: '/shelf/sync', skill_version: '1.0.5' })
  assert.equal(result, JSON.stringify({ books: [{ title: 'A' }], albums: [] }))
})

adapterTest('forwards only the arguments the definition names', async () => {
  const { sent } = await run('search', { keyword: '三体', scope: 10, count: 5 }, () => answer(200, { results: [] }))
  assert.deepEqual(JSON.parse(sent.options.body), { api_name: '/store/search', skill_version: '1.0.5', keyword: '三体', scope: 10, count: 5 })
  // A model that tries to smuggle a path or another api through its arguments does not reach him.
  const { sent: second } = await run('search', { keyword: 'x', api_name: '/_list', path: '/evil', url: 'https://evil.example' }, () => answer(200, {}))
  assert.deepEqual(Object.keys(JSON.parse(second.options.body)), ['api_name', 'skill_version', 'keyword'])
})

adapterTest('a rejected key reads as a rejected key, never as the key itself', async () => {
  await assert.rejects(run('shelf', {}, () => answer(401, { errcode: -2013, errmsg: '鉴权失败' })), error => {
    assert.match(error.message, /did not accept this token or key/)
    assert.equal(error.message.includes(TOKEN), false)
    return true
  })
})

adapterTest('a business error carries the service message, not the 499 status', async () => {
  await assert.rejects(
    run('reviews', { bookId: 'CB_x' }, () => answer(499, { errcode: -2003, errmsg: '参数格式错误', errlog: 'CDQ34Je' })),
    /WeRead: 参数格式错误/,
  )
})

adapterTest('an unreachable gateway is one plain error', async () => {
  await assert.rejects(
    run('shelf', {}, () => { throw new Error('socket hang up') }),
    /Could not reach WeRead/,
  )
})

adapterTest('an empty answer is returned, not treated as a failure', async () => {
  const { result } = await run('notebooks', {}, () => answer(200, { synckey: 0, books: [], totalBookCount: 0, hasMore: 0 }))
  assert.equal(result, JSON.stringify({ synckey: 0, books: [], totalBookCount: 0, hasMore: 0 }))
})

test('the key check POSTs to the gateway and accepts a key the shelf answers', async () => {
  const sent = []
  const extra = await verifyWeread({
    token: TOKEN,
    fetch: async (url, options) => {
      sent.push({ url: String(url), options })
      return answer(200, { books: [] })
    },
  })
  assert.deepEqual(extra, {})
  assert.equal(sent[0].url, 'https://i.weread.qq.com/api/agent/gateway')
  assert.equal(sent[0].options.method, 'POST')
  assert.equal(sent[0].options.headers.Authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(JSON.parse(sent[0].options.body), { api_name: '/shelf/sync', skill_version: '1.0.5' })
})

test('the key check refuses a 401, a business code and an unreachable host', async () => {
  await assert.rejects(verifyWeread({ token: TOKEN, fetch: async () => answer(401, { errcode: -2013, errmsg: '鉴权失败' }) }), /did not accept this token or key/)
  await assert.rejects(verifyWeread({ token: TOKEN, fetch: async () => answer(499, { errcode: -2003, errmsg: '参数格式错误' }) }), /WeRead: 参数格式错误/)
  await assert.rejects(verifyWeread({ token: TOKEN, fetch: async () => { throw new Error('down') } }), /Could not reach WeRead/)
})
