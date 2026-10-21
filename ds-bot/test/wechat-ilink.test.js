// The iLink client speaks to a local mock server: no real account, no network beyond loopback.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { clientVersionOf, createIlinkClient, maskAccount, qrImageOf, qrStateOf } from '../src/host/wechat-ilink.js'

const serve = async (handler) => {
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const { status = 200, json = {}, hang = false } = handler({ method: request.method, url: request.url, headers: request.headers, body })
      // A hung request is how a stuck service looks: the client must end it on its own.
      if (hang) return
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(json))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}

test('iLink constants: version packing, QR states, images and masked accounts', () => {
  assert.equal(clientVersionOf({ major: 2, minor: 4, patch: 10 }), 0x0002040a)
  assert.deepEqual(
    ['wait', 'scaned', 'scaned_but_redirect', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect', 'other'].map(qrStateOf),
    ['wait', 'scanned', 'scanned', 'confirmed', 'expired', 'verified-needed', 'blocked', 'bound', 'unknown'],
  )
  assert.equal(qrImageOf('https://example.com/qr.png'), 'https://example.com/qr.png')
  assert.equal(qrImageOf('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(qrImageOf('data:image/svg+xml;base64,PHN2Zz4='), undefined)
  assert.equal(qrImageOf('plain-login-token'), undefined)
  assert.equal(maskAccount('ilink_user_123456'), 'ilin…56')
  assert.equal(maskAccount('abc'), 'a…')
})

test('the QR request carries the documented headers and the poll only the app headers', async (t) => {
  const seen = []
  const mock = await serve((request) => {
    seen.push(request)
    if (request.url.startsWith('/ilink/bot/get_bot_qrcode')) return { json: { qrcode: 'qr-1', qrcode_img_content: 'https://cdn.test/qr.png' } }
    return { json: { status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot-1', baseurl: 'https://example.test' } }
  })
  t.after(() => mock.close())
  const client = createIlinkClient({ base: mock.base, uin: () => 7 })
  const qr = await client.getQrCode()
  assert.equal(qr.qrcode, 'qr-1')
  const status = await client.pollQrStatus(qr.qrcode)
  assert.equal(status.status, 'confirmed')
  const [qrRequest, pollRequest] = seen
  assert.equal(qrRequest.headers['authorizationtype'], 'ilink_bot_token')
  assert.equal(qrRequest.headers['x-wechat-uin'], Buffer.from('7', 'utf8').toString('base64'))
  assert.equal('authorization' in qrRequest.headers, false)
  assert.equal('base_info' in qrRequest, false)
  assert.equal(pollRequest.method, 'GET')
  assert.equal('authorizationtype' in pollRequest.headers, false)
  assert.equal('x-wechat-uin' in pollRequest.headers, false)
})

test('the bot API carries the cursor in the body and sends the documented message shape', async (t) => {
  const seen = []
  const mock = await serve((request) => {
    seen.push(request)
    return { json: { ret: 0 } }
  })
  t.after(() => mock.close())
  const client = createIlinkClient({ base: mock.base })
  await client.getUpdates({ token: 'tok', cursor: 'cursor-1' })
  await client.sendMessage({ token: 'tok', toUserId: 'user-1', clientId: 'c-1', contextToken: 'ctx-1', text: 'hello' })
  const updateBody = JSON.parse(seen[0].body)
  assert.equal(updateBody.get_updates_buf, 'cursor-1')
  assert.equal(seen[0].url.includes('get_updates_buf'), false)
  const message = JSON.parse(seen[1].body).msg
  // The bot's identity is the bearer token: the request leaves `from_user_id` empty, and the
  // scanned account is the target.
  assert.deepEqual(
    [message.from_user_id, message.to_user_id, message.client_id, message.message_type, message.message_state, message.context_token],
    ['', 'user-1', 'c-1', 2, 2, 'ctx-1'],
  )
  assert.deepEqual(message.item_list, [{ type: 1, text_item: { text: 'hello' } }])
  assert.equal(typeof message.client_id, 'string')
  assert.ok(message.client_id.length > 0)
})

test('a -14 business answer rejects even with HTTP 200 and carries the pause marker', async (t) => {
  const mock = await serve(() => ({ status: 200, json: { ret: 0, errcode: -14, errmsg: 'session timeout' } }))
  t.after(() => mock.close())
  const client = createIlinkClient({ base: mock.base })
  await assert.rejects(client.getUpdates({ token: 'tok' }), error => error.paused === true && /paused this login/.test(error.message))
})

test('a -14 in `ret` is the same answer as in `errcode`, for a send too', async (t) => {
  const mock = await serve(() => ({ status: 200, json: { ret: -14, errmsg: 'session timeout' } }))
  t.after(() => mock.close())
  const client = createIlinkClient({ base: mock.base })
  await assert.rejects(client.sendMessage({ token: 'tok', toUserId: 'user-1', text: 'hello' }), error => error.paused === true)
})

test('a -14 answer pauses the client for the configured time', async (t) => {
  const mock = await serve(() => ({ status: 200, json: { errcode: -14 } }))
  t.after(() => mock.close())
  let clock = 0
  const client = createIlinkClient({ base: mock.base, pauseMs: 50, now: () => clock })
  const result = client.noteError(-14)
  assert.equal(result.paused, true)
  assert.equal(result.pauseMs, 50)
})

test('every call has a deadline: a stuck answer ends with a timeout', async (t) => {
  const mock = await serve(() => ({ hang: true }))
  t.after(() => mock.close())
  const client = createIlinkClient({ base: mock.base, timeouts: { qr: 40, poll: 40, send: 40, updates: 40 } })
  const calls = [
    () => client.getQrCode(),
    () => client.pollQrStatus('qr-1'),
    () => client.sendMessage({ token: 'tok', toUserId: 'user-1', text: 'hello' }),
    () => client.getUpdates({ token: 'tok' }),
  ]
  for (const call of calls) await assert.rejects(call(), error => error.name === 'TimeoutError')
})

test('the long poll also ends when the mount cancels it, not only on its deadline', async (t) => {
  const mock = await serve(() => ({ hang: true }))
  t.after(() => mock.close())
  const client = createIlinkClient({ base: mock.base })
  const controller = new AbortController()
  const pending = client.getUpdates({ token: 'tok', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
})
