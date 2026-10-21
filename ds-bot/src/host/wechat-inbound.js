// The inbound half of the WeChat connector: one loopback listener shared by every channel
// instance, the checks a gateway must pass, and the queue that hands an accepted message to
// the module. P2 speaks a plain JSON + HMAC contract for a same-machine sidecar; the
// enterprise WeChat application callback (XML + AES) is a different contract and stays out.
//
// The listener belongs to the plugin, not to one instance: every channel has its own path,
// its own secret and its own rate budget. A channel without an HMAC secret is not attached:
// its card keeps working for outbound notices and the listener simply has no path for it.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const PATH = /^\/wechat\/([a-z][a-z0-9-]{0,39})\/inbound$/
const SIGNATURE_HEADER = 'x-wechat-signature'
const TIMESTAMP_HEADER = 'x-wechat-timestamp'
const NONCE_HEADER = 'x-wechat-nonce'
const BODY_MAX = 64 * 1024
const TEXT_MAX = 8 * 1024
const CLOCK_SKEW_SECONDS = 300
const REQUESTS_PER_MINUTE = 30
const BURST = 10
const NONCE_MAX = 1_000
const SEEN_MAX = 200
const SAVE_MERGE_MS = 5_000
const DEFAULT_PORT = 8_799
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const trim = value => (typeof value === 'string' ? value.trim() : '')
const senderHashOf = (sender) => createHash('sha256').update(String(sender)).digest('hex').slice(0, 16)
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

// The HMAC both directions use: `timestamp.nonce.body`.
const signatureOf = (secret, timestamp, nonce, body) => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex')}`

const errorText = {
  'bad-request': 'The request body is not valid JSON.',
  'bad-signature': 'The request signature did not match.',
  'bad-token': 'The inbound token did not match.',
  'stale-timestamp': 'The request timestamp is outside the accepted window.',
  'replayed-nonce': 'This request was already seen.',
  'sender-not-allowed': 'This sender is not allowed to talk to this channel.',
  'rate-limited': 'Too many messages; try again later.',
  'too-large': 'The request body is too large.',
  'not-found': 'Not found.',
}

const hubs = new WeakMap()

/** The inbound hub of one plugin host; created on first use and kept for the host's life. */
export function inboundFor(rt) {
  let hub = hubs.get(rt)
  if (hub === undefined) {
    hub = new InboundHub(rt)
    hubs.set(rt, hub)
  }
  return hub
}

class InboundHub {
  constructor(rt) {
    this.rt = rt
    // instance id -> the channel's route: its secret, its budget and its seen messages.
    this.routes = new Map()
    this.server = undefined
    this.port = undefined
    this.starting = undefined
    this.error = undefined
    this.sockets = new Set()
    this.saveTimers = new Map()
    this.stopped = false
  }

  // The profile may carry one set of listener numbers for the whole module:
  // `wechat: { listenPort: 8799, publicBaseUrl: 'https://...', bearerRequired: true }`.
  // Nothing here may turn the bind address into anything but loopback.
  config() {
    const value = this.rt.config?.wechat
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }

  listenPort() {
    const port = this.config().listenPort
    return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : DEFAULT_PORT
  }

  bearerRequired() {
    return this.config().bearerRequired === true
  }

  publicBaseUrl() {
    const value = trim(this.config().publicBaseUrl)
    if (value === '') return undefined
    try {
      const url = new URL(value)
      return url.origin
    } catch {
      return undefined
    }
  }

  attach({ instance, botId, settings, secret, secretName }) {
    const id = trim(instance)
    if (id === '') throw new Error('An inbound channel needs an instance id')
    this.stopped = false
    const route = {
      id,
      botId: trim(botId),
      settings: settings !== null && typeof settings === 'object' ? settings : {},
      secret: String(secret),
      token: undefined,
      nonces: new Map(),
      bucket: { tokens: BURST, at: Date.now() },
      queue: [],
      error: undefined,
    }
    this.routes.set(id, route)
    void this.ensureToken(route, secretName)
    this.ensureStarted().catch((error) => {
      route.error = error
      this.error = error
    })
    return route
  }

  async detach(instance) {
    const id = trim(instance)
    const route = this.routes.get(id)
    if (route === undefined) return
    this.routes.delete(id)
    this.flush(id)
    if (this.routes.size > 0) return
    await this.stop()
  }

  // One token per instance, stored under the same per-instance credential name the framework
  // reads (WECHAT_INBOUND_TOKEN, _2 for the second channel). The card may show it: it is an
  // inbound gateway credential, not a secret the user typed.
  async ensureToken(route, secretName) {
    if (!this.bearerRequired()) return
    if (typeof secretName !== 'function') return
    let name
    try {
      name = secretName('WECHAT_INBOUND_TOKEN')
    } catch {
      return
    }
    const existing = this.rt.secretValue?.(name)
    if (typeof existing === 'string' && existing !== '') {
      route.token = existing
      return
    }
    const token = randomBytes(32).toString('base64url')
    route.token = token
    try {
      await this.rt.secretEndpoint('secret-set', { name, value: token, purpose: 'WeChat inbound token', scope: [] })
    } catch (error) {
      this.rt.warn?.('ds-bot: could not store the WeChat inbound token of %s: %s', route.id, error?.message ?? error)
    }
  }

  ensureStarted() {
    if (this.server?.listening === true) return Promise.resolve()
    if (this.starting !== undefined) return this.starting
    this.starting = this.start().finally(() => { this.starting = undefined })
    return this.starting
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => { void this.handle(request, response) })
      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
      })
      const failed = (error) => {
        this.error = error
        try { server.close() } catch { /* not listening yet */ }
        reject(this.portError(error))
      }
      server.once('error', failed)
      const port = this.listenPort()
      server.listen(port, '127.0.0.1', () => {
        server.off('error', failed)
        if (this.routes.size === 0) {
          server.close(() => resolve())
          return
        }
        server.on('error', (error) => {
          this.error = error
          this.rt.warn?.('ds-bot: the WeChat inbound listener failed: %s', error?.message ?? error)
        })
        this.server = server
        this.port = server.address().port
        resolve()
      })
    })
  }

  portError(error) {
    const code = String(error?.code ?? '')
    if (code === 'EADDRINUSE') {
      return new Error(`The inbound port ${this.listenPort()} is already in use. Change wechat.listenPort in the profile or stop the process using that port.`)
    }
    if (code === 'EACCES') {
      return new Error(`The inbound port ${this.listenPort()} cannot be opened. Change wechat.listenPort in the profile to a port this user may bind.`)
    }
    return new Error(`The inbound listener could not start: ${error?.message ?? error}`)
  }

  async stop() {
    const server = this.server
    this.server = undefined
    this.port = undefined
    this.error = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server === undefined) return
    await new Promise((resolve) => server.close(resolve))
  }

  // The card draws the inbound address only while this channel's path is really served.
  ready(instance) {
    const route = this.routes.get(trim(instance))
    return route !== undefined && route.error === undefined && this.server?.listening === true
  }

  viewOf(instance) {
    const id = trim(instance)
    if (!this.ready(id)) return {}
    const base = this.publicBaseUrl() ?? `http://127.0.0.1:${this.port}`
    const route = this.routes.get(id)
    return {
      inbound: {
        url: `${base}/wechat/${id}/inbound`,
        ...(route.token === undefined ? {} : { token: route.token }),
      },
    }
  }

  statusOf(instance) {
    const id = trim(instance)
    const route = this.routes.get(id)
    if (route === undefined) return {}
    if (route.error !== undefined) return { status: { inbound: 'error', inboundError: route.error.message } }
    if (this.error !== undefined) return { status: { inbound: 'error', inboundError: this.error.message } }
    if (!this.ready(id)) return { status: { inbound: this.starting === undefined ? 'off' : 'starting' } }
    return { status: { inbound: 'listening' } }
  }

  reply(response, status, payload) {
    if (response.writableEnded) return
    const body = JSON.stringify(payload)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  }

  refuse(response, status, code, message = errorText[code]) {
    this.reply(response, status, { ok: false, code, message })
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const match = PATH.exec(url.pathname)
    // Everything outside the one path, method and media type is not ours: a bare 404, with
    // no hint about which channel or path this host serves.
    if (match === null || request.method !== 'POST') return this.refuse(response, 404, 'not-found')
    const type = String(request.headers['content-type'] ?? '').toLowerCase()
    if (!type.startsWith('application/json')) return this.refuse(response, 404, 'not-found')
    const route = this.routes.get(match[1])
    if (route === undefined) return this.refuse(response, 404, 'not-found')

    let body
    try {
      body = await this.readBody(request, response)
    } catch (error) {
      if (error?.code !== 'too-large') throw error
      return this.refuse(response, 413, 'too-large')
    }
    if (body === undefined) return // the request was already answered while streaming

    const timestamp = String(request.headers[TIMESTAMP_HEADER] ?? '')
    const nonce = trim(request.headers[NONCE_HEADER])
    const signature = String(request.headers[SIGNATURE_HEADER] ?? '')
    if (timestamp === '' || nonce === '' || signature === '') return this.refuse(response, 401, 'bad-signature')
    const expected = signatureOf(route.secret, timestamp, nonce, body)
    if (!safeEqual(signature, expected)) return this.refuse(response, 401, 'bad-signature')
    const at = Number(timestamp)
    if (!Number.isFinite(at) || Math.abs(Date.now() - at * 1000) > CLOCK_SKEW_SECONDS * 1000) {
      return this.refuse(response, 401, 'stale-timestamp')
    }
    if (this.replayed(route, nonce)) return this.refuse(response, 401, 'replayed-nonce')
    if (this.bearerRequired() && (route.token === undefined || !safeEqual(bearerOf(request), route.token))) {
      return this.refuse(response, 401, 'bad-token')
    }

    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      return this.refuse(response, 400, 'bad-request')
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return this.refuse(response, 400, 'bad-request', 'The request body must be one JSON object.')
    }
    const sender = trim(payload.sender_id) === '' ? undefined : trim(payload.sender_id)
    if (sender === undefined) return this.refuse(response, 400, 'bad-request', 'The message needs a sender_id.')
    const hash = senderHashOf(sender)
    if (!this.allowed(route, hash)) return this.refuse(response, 403, 'sender-not-allowed')

    const budget = this.take(route)
    if (budget !== undefined) {
      response.setHeader('retry-after', String(budget))
      return this.reply(response, 429, { ok: false, code: 'rate-limited', message: errorText['rate-limited'], retry_after: budget })
    }

    const text = typeof payload.text === 'string' ? payload.text : ''
    if (Buffer.byteLength(text, 'utf8') > TEXT_MAX) {
      return this.refuse(response, 413, 'too-large', 'The message text is too large.')
    }
    const callbackUrl = this.callbackOf(payload)
    if (callbackUrl === 'invalid') {
      return this.refuse(response, 400, 'bad-request', 'The callback URL must be https or a loopback address.')
    }
    const msgId = trim(payload.msgId)
    if (msgId === '') return this.refuse(response, 400, 'bad-request', 'The message needs a msgId.')
    if (this.seen(route, msgId)) {
      return this.reply(response, 200, { ok: true, duplicate: true, msgId })
    }

    this.remember(route, hash, msgId)
    route.queue.push({ msgId, sender: hash, text, callbackUrl, wait: payload.wait, at: Date.now() })
    this.reply(response, 202, { ok: true, accepted: true, msgId, instance: route.id })
  }

  // The body is read with a hard cap, including a chunked request: past the limit the
  // request is answered and torn down, so a caller cannot make the host buffer megabytes.
  readBody(request, response) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let done = false
      const finish = (value, error) => {
        if (done) return
        done = true
        if (error === undefined) resolve(value)
        else reject(error)
      }
      request.on('data', (chunk) => {
        if (done) return
        size += chunk.length
        if (size > BODY_MAX) {
          finish(undefined, Object.assign(new Error('too large'), { code: 'too-large' }))
          this.refuse(response, 413, 'too-large')
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
      request.on('error', (error) => finish(undefined, error))
    })
  }

  // v1 keeps one conversation per channel: the first accepted sender owns it, and a later
  // different sender is refused. The hash is the only form of the sender id that is kept.
  allowed(route, hash) {
    const inbound = channelOf(this.rt.state, route.id).inbound
    if (inbound === undefined || typeof inbound.creator !== 'string' || inbound.creator === '') return true
    return inbound.creator === hash
  }

  callbackOf(payload) {
    const value = trim(payload.callbackUrl)
    if (value === '') return undefined
    let url
    try {
      url = new URL(value)
    } catch {
      return 'invalid'
    }
    if (url.protocol === 'https:') return url.toString()
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url.toString()
    return 'invalid'
  }

  replayed(route, nonce) {
    if (route.nonces.has(nonce)) return true
    route.nonces.set(nonce, Date.now())
    if (route.nonces.size > NONCE_MAX) {
      const oldest = route.nonces.keys().next().value
      route.nonces.delete(oldest)
    }
    return false
  }

  // A token bucket per channel: 30 requests a minute, at most 10 in one burst. Returns the
  // whole seconds to wait when the budget is empty.
  take(route) {
    const now = Date.now()
    const bucket = route.bucket
    const gained = ((now - bucket.at) / 60_000) * REQUESTS_PER_MINUTE
    bucket.tokens = Math.min(BURST, bucket.tokens + gained)
    bucket.at = now
    if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) * (60_000 / REQUESTS_PER_MINUTE / 1000)))
    bucket.tokens -= 1
    return undefined
  }

  seen(route, msgId) {
    const seen = channelOf(this.rt.state, route.id).seenMsgIds
    return Array.isArray(seen) && seen.some(entry => entry?.id === msgId)
  }

  remember(route, hash, msgId) {
    const channel = channelOf(this.rt.state, route.id)
    channel.seenMsgIds = [{ id: msgId, at: Date.now() }, ...(Array.isArray(channel.seenMsgIds) ? channel.seenMsgIds : [])].slice(0, SEEN_MAX)
    const inbound = channel.inbound !== null && typeof channel.inbound === 'object' ? channel.inbound : {}
    channel.inbound = {
      ...inbound,
      ...(typeof inbound.creator === 'string' && inbound.creator !== '' ? {} : { creator: hash }),
      lastInboundAt: Date.now(),
    }
    this.scheduleSave(route.id)
  }

  scheduleSave(instance) {
    if (this.saveTimers.has(instance)) return
    const timer = setTimeout(() => {
      this.saveTimers.delete(instance)
      void this.rt.save().catch(error => this.rt.warn?.('ds-bot: WeChat inbound state not saved: %s', error?.message ?? error))
    }, SAVE_MERGE_MS)
    timer.unref?.()
    this.saveTimers.set(instance, timer)
  }

  // A turn end, a detach or a plugin stop may not wait five seconds: flush now.
  flush(instance) {
    const timer = this.saveTimers.get(instance)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.saveTimers.delete(instance)
    }
    void this.rt.save().catch(error => this.rt.warn?.('ds-bot: WeChat inbound state not saved: %s', error?.message ?? error))
  }

  flushAll() {
    for (const instance of this.saveTimers.keys()) this.flush(instance)
  }

  async dispose() {
    this.stopped = true
    this.flushAll()
    for (const id of this.routes.keys()) this.routes.delete(id)
    await this.stop()
  }
}

const bearerOf = (request) => {
  const header = String(request.headers.authorization ?? '')
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
}

const channelOf = (state, instance) => {
  const channels = state.channels ?? (state.channels = {})
  const channel = channels[instance] ?? (channels[instance] = {})
  if (channel.seenMsgIds === undefined) channel.seenMsgIds = []
  return channel
}
