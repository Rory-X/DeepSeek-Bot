// Test doubles for the WeChat connector: a loopback webhook receiver for outbound calls and
// a signer for inbound requests. Nothing here touches the plugin, so the fakes can be used
// before the module exists and stay useful once it does.
import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export const WECHAT_SIGNATURE_HEADER = 'x-wechat-signature'
export const WECHAT_TIMESTAMP_HEADER = 'x-wechat-timestamp'
export const WECHAT_NONCE_HEADER = 'x-wechat-nonce'

// The one signing rule both directions use: HMAC-SHA256 over `timestamp.nonce.body`.
export function signWechat({ secret, timestamp, nonce, body }) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex')
  return `sha256=${digest}`
}

export function wechatHeaders({ secret, body, timestamp = Math.floor(Date.now() / 1000), nonce = randomBytes(8).toString('hex') }) {
  return {
    'content-type': 'application/json',
    [WECHAT_TIMESTAMP_HEADER]: String(timestamp),
    [WECHAT_NONCE_HEADER]: nonce,
    [WECHAT_SIGNATURE_HEADER]: signWechat({ secret, timestamp, nonce, body }),
  }
}

// A webhook receiver on loopback: records every request (headers + parsed JSON) and answers
// with whatever the test scripts — a status, a delay, or a refused connection by closing.
export async function startWebhookReceiver({ secret, reply = () => ({ status: 200, body: '{"ok":true}' }) } = {}) {
  const requests = []
  let answer = reply
  const server = createServer((request, res) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const entry = { method: request.method, headers: request.headers, body, json: undefined }
      try { entry.json = JSON.parse(body) } catch { entry.json = undefined }
      if (secret !== undefined) {
        const expected = signWechat({
          secret,
          timestamp: request.headers[WECHAT_TIMESTAMP_HEADER],
          nonce: request.headers[WECHAT_NONCE_HEADER],
          body,
        })
        entry.signatureOk = request.headers[WECHAT_SIGNATURE_HEADER] === expected
      }
      requests.push(entry)
      Promise.resolve(answer(entry))
        .then(({ status = 200, body: replyBody = '' } = {}) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(replyBody)
        })
        .catch(() => {
          res.writeHead(500)
          res.end()
        })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    port,
    requests,
    setReply: (next) => { answer = next },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

// One inbound request as the gateway would send it: signed when a secret is given.
export async function postInbound({ url, token, secret, msgId, sender = 'creator', text = 'hello', timestamp, nonce, headers = {} }) {
  const body = JSON.stringify({ msgId, sender_id: sender, text })
  const signed = secret === undefined ? {} : wechatHeaders({ secret, body, ...(timestamp === undefined ? {} : { timestamp }), ...(nonce === undefined ? {} : { nonce }) })
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...signed,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body,
  })
  let json
  try { json = await response.json() } catch { json = undefined }
  return { status: response.status, headers: Object.fromEntries(response.headers), json }
}

// Waits for a condition the plugin reaches in the background, the way the other connector
// tests wait for a mount.
export async function until(check, label) {
  for (let count = 0; count < 300; count += 1) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out: ${label}`)
}
