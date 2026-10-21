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
const textOfContent = content => (Array.isArray(content)
  ? content.filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
  : '')
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

const botUnavailableText = 'The Bot is not available right now; try again later.'
const errorTextTimeout = 'The Bot did not answer in time.'
const errorTextRebound = 'This channel was rebound to another Bot; send the message again.'
const needsUserText = 'Open DS Bot to handle this request.'

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
    this.waits = new Map()
    this.toolState = new Map()
    // A mount that never finishes starting is the only thing the watchdog watches: a
    // listener that attached fine must never be detached by age, or a healthy channel would
    // lose its address a few seconds after it connected.
    this.pendingMounts = new Map()
    this.watchdog = setInterval(() => {
      const now = Date.now()
      for (const [id, startedAt] of this.pendingMounts) {
        if (now - startedAt <= 5_000) continue
        this.pendingMounts.delete(id)
        if (this.routes.has(id)) void this.detach(id)
      }
    }, 1_000)
    this.watchdog.unref?.()
    this.idleTimer = undefined
    this.stopped = false
    const ctx = rt.ctx
    // DSH resolves an agent per turn, including for a conversation that survived a restart or
    // a remount. Restrict it here, once for the whole plugin, from the owner map F2a keeps:
    // the allow-list follows the channel's latest settings without any per-turn bookkeeping.
    if (typeof ctx?.on === 'function') {
      this.offAgentCreated = ctx.on('agent/created', ({ agent }) => {
        void Promise.resolve().then(() => {
          const sessionId = agent?.session?.id
          const owner = sessionId === undefined ? undefined : this.rt.channelOwners?.get(sessionId)
          if (owner === undefined) return
          const route = this.routes.get(owner.instance)
          if (route === undefined) return
          const wanted = route.settings?.allowReadTools === true ? ['web_search'] : []
          const served = typeof ctx.tools?.schemas === 'function' ? (ctx.tools.schemas(agent) ?? []).map(schema => schema.name) : []
          const allow = wanted.filter(name => served.includes(name))
          const restrict = agent?.ctx?.tools?.restrict
          if (typeof restrict === 'function') restrict.call(agent.ctx.tools, { allow })
        }).catch(error => this.rt.warn?.('ds-bot: channel tools restrict on agent/created failed: %s', error?.message ?? error))
      })
    }
    // While the channels are mounted a listener may idle for a moment between a remove and
    // an add; when the plugin itself goes away the port must close with it.
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => { void this.dispose() }, 'ds-bot: WeChat inbound listener')
    }
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => { this.offAgentCreated?.() }, 'ds-bot: WeChat channel tools restrict')
    }
    if (typeof ctx?.on === 'function') {
      ctx.on('approval/request', (request, next) => {
        const sessionId = request?.agent?.session?.id ?? request?.agent?.id
        const waiting = sessionId === undefined ? undefined : this.waits.get(sessionId)
        if (waiting !== undefined) waiting.finish({ code: 'needs-user', message: needsUserText })
        return typeof next === 'function' ? next() : undefined
      })
    }
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

  async attach({ instance, botId, settings, secret, secretName, title }) {
    const id = trim(instance)
    if (id === '') throw new Error('An inbound channel needs an instance id')

    this.stopped = false
    // A channel that arrives while the listener is about to close keeps it open: a remove
    // followed at once by an add must not hit a closing port.
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    const route = {
      id,
      botId: trim(botId),
      title: trim(title) === '' ? undefined : trim(title),
      settings: settings !== null && typeof settings === 'object' ? settings : {},
      running: false,
      pending: new Set(),
      rebound: false,
      secret: String(secret),
      token: undefined,
      nonces: new Map(),
      bucket: { tokens: BURST, at: Date.now() },
      queue: [],
      error: undefined,
    }
    this.routes.set(id, route)
    this.pendingMounts.set(id, Date.now())
    await this.ensureToken(route, secretName)
    try {
      await this.ensureStarted()
    } catch (error) {
      // The mount contract lets a module fail here: the host puts the message on the row.
      this.routes.delete(id)
      this.pendingMounts.delete(id)
      throw error
    }
    // The listener is up: this mount is no longer pending, and the route stays until its
    // channel is unmounted.
    this.pendingMounts.delete(id)
    return route
  }

  async detach(instance) {
    const id = trim(instance)
    const route = this.routes.get(id)
    if (route === undefined) return
    this.routes.delete(id)
    this.pendingMounts.delete(id)
    this.flush(id)
    if (this.routes.size > 0) return
    // The last channel leaves: close soon, not instantly, so a new channel mounted in the
    // same moment can reuse the open listener instead of racing a half-closed port.
    this.scheduleIdleStop()
  }

  scheduleIdleStop() {
    if (this.idleTimer !== undefined) return
    const timer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.routes.size === 0) void this.stop()
    }, 500)
    timer.unref?.()
    this.idleTimer = timer
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
    if (this.routes.size === 0 && this.watchdog !== undefined) {
      clearInterval(this.watchdog)
      this.watchdog = undefined
    }
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
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

  // A channel that has everything but its HMAC secret is still an outbound channel; the
  // card says the inbound half waits for the secret instead of drawing a dead address.
  needsSecret() {
    return { status: { inbound: 'needs-secret' } }
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

  waitOf(value) {
    const ms = Number(value)
    if (!Number.isFinite(ms) || ms <= 0) return 0
    return Math.min(20_000, Math.floor(ms))
  }

  turnTimeoutMs() {
    const value = this.config().turnTimeoutMs
    return Number.isInteger(value) && value >= 0 ? value : 120_000
  }

  callbackDelays() {
    const value = this.config().callbackRetryDelays
    return Array.isArray(value) && value.every(item => Number.isInteger(item) && item >= 0) ? value : [1_000, 5_000, 25_000]
  }

  // One message at a time per channel: the next one waits for this turn to end, its reply to
  // arrive, its approval to show, or the turn timeout to pass.
  enqueue(route, message) {
    route.queue.push(message)
    if (route.running) return
    route.running = true
    void this.drain(route).finally(() => { route.running = false })
  }

  async drain(route) {
    while (route.queue.length > 0) {
      const message = route.queue.shift()
      if (route.rebound) {
        this.settle(route, message, { code: 'channel-rebound', message: errorTextRebound })
        continue
      }
      let result
      try {
        result = await this.runOne(route, message)
      } catch (error) {
        result = { code: 'bot-unavailable', message: botUnavailableText, error: error?.message ?? String(error) }
      }
      this.settle(route, message, result)
    }
  }

  // Narrow the tools of the conversation's current Session without archiving it: the
  // framework's restriction can only remove, so this covers tools being turned off.
  // Only web_search is ever offered; the restriction is applied again for every delivery
  // because the agent this turn runs may be a fresh one.
  async applyTurnTools(route, sessionId) {
    // A test can switch this safety net off to prove the agent/created path alone restricts.
    if (this.config().turnToolsRestrict === false) return
    const wanted = route.settings?.allowReadTools === true ? ['web_search'] : []
    route.lastAllow = wanted
    if (typeof this.rt.resolveAgent !== 'function') return
    try {
      const agent = await this.rt.resolveAgent(sessionId)
      const restrict = agent?.ctx?.tools?.restrict
      if (typeof restrict === 'function') restrict.call(agent.ctx.tools, { allow: wanted })
    } catch (error) {
      this.rt.warn?.('ds-bot: the tools of the WeChat Session %s were not restricted: %s', sessionId, error?.message ?? error)
    }
  }

  async narrowTools(route) {
    if (typeof this.rt.resolveAgent !== 'function') return false
    const conversations = this.rt.state?.channels?.[route.id]?.conversations
    const sessionId = Object.values(conversations ?? {}).map(entry => entry?.sessionId).find(value => typeof value === 'string')
    if (sessionId === undefined) return false
    try {
      const agent = await this.rt.resolveAgent(sessionId)
      if (typeof agent?.ctx?.tools?.restrict !== 'function') return false
      agent.ctx.tools.restrict({ allow: [] })
      return true
    } catch {
      return false
    }
  }

  async runOne(route, message) {
    if (typeof this.rt.channelSessionFor !== 'function' || typeof this.rt.deliver !== 'function') {
      return { code: 'bot-unavailable', message: botUnavailableText }
    }
    // The framework pins a Session's tool allow-list when the Session is made (F2a). Apply a
    // changed read-tools switch on the next message: turning tools off narrows the existing
    // Session in place (restrictions only narrow), turning them on needs a fresh conversation
    // because F2a's empty allow-list cannot be widened. This never runs during a mount.
    const wanted = route.settings?.allowReadTools === true
    const applied = this.toolState.get(route.id)
    if (applied !== undefined && applied !== wanted) {
      if (wanted === false && await this.narrowTools(route)) {
        this.toolState.set(route.id, false)
      } else {
        if (typeof this.rt.rebindChannel === 'function') {
          const priorSession = Object.values(this.rt.state?.channels?.[route.id]?.conversations ?? {}).map(entry => entry?.sessionId).find(value => typeof value === 'string')
          const failure = await this.rt.rebindChannel(route.id, { reason: 'tools-changed' }).then(() => undefined).catch(error => error)
          if (failure !== undefined) this.rt.warn?.('ds-bot: channel %s could not rebind after a tools change (session %s): %s', route.id, priorSession ?? 'unknown', failure?.message ?? failure)
        }
        this.toolState.set(route.id, wanted)
      }
    } else if (applied === undefined) {
      this.toolState.set(route.id, wanted)
    }
    let sessionId
    try {
      sessionId = await this.rt.channelSessionFor({
        instance: route.id,
        botId: route.botId,
        conversationId: `dm:${message.sender}`,
        ...(route.title === undefined ? {} : { title: route.title }),
        settings: route.settings,
      })
    } catch {
      return { code: 'bot-unavailable', message: botUnavailableText }
    }
    // Every turn restricts the agent that is about to run: an agent rebuilt per turn must
    // not come back with the Harness's full tool surface.
    await this.applyTurnTools(route, sessionId)
    let exchangeId
    try {
      exchangeId = await this.rt.deliver({ toId: route.botId, sessionId, text: message.text, role: 'request', untrusted: true, sender: { name: 'WeChat', id: message.sender } })
    } catch {
      return { code: 'bot-unavailable', message: botUnavailableText }
    }
    return await this.awaitTurn(route, sessionId, exchangeId)
  }

  // The reply is the text of the turn that answers this exchange: `deliver` returns the
  // exchange id, the user message carries it, and the turn id that follows is the one whose
  // end closes this message. A later turn in the same Session is never mistaken for it.
  awaitTurn(route, sessionId, exchangeId) {
    const timeout = this.turnTimeoutMs()
    return new Promise((resolve) => {
      let awaiting = false
      let turnId
      let settled = false
      const texts = []
      let entry
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (entry !== undefined) route.pending.delete(entry)
        this.waits.delete(sessionId)
        unsubscribe?.()
        resolve(value)
      }
      const timer = setTimeout(() => finish({ code: 'timeout', message: errorTextTimeout }), timeout)
      timer.unref?.()
      const listener = (session, event) => {
        if (session?.id !== sessionId) return
        if (event.type === 'user/message') {
          if (event.data?.source?.exchangeId === exchangeId) awaiting = true
          return
        }
        if (!awaiting) return
        if (event.type === 'turn/start') { turnId = event.data?.turn; return }
        if (event.type === 'assistant/message' && turnId !== undefined) {
          const text = textOfContent(event.data?.message?.content)
          if (text !== '') texts.push(text)
          return
        }
        if (event.type !== 'turn/end') return
        if (turnId !== undefined && event.data?.turn !== turnId) return
        const reason = event.data?.reason
        if (reason?.kind === 'error') return finish({ code: 'bot-unavailable', message: botUnavailableText, error: reason.error?.message })
        if (reason?.kind === 'aborted') return finish({ code: 'timeout', message: errorTextTimeout })
        if (reason?.kind === 'blocked') return finish({ code: 'needs-user', message: needsUserText })
        finish({ text: texts.join('\n\n').trim() })
      }
      const unsubscribe = this.rt.ctx.on('session/event', listener)
      entry = { fail: finish }
      route.pending.add(entry)
      this.waits.set(sessionId, { route, finish })
    })
  }

  settle(route, message, result) {
    if (message.response !== undefined) {
      // A synchronous caller hears the turn's own answer, a fixed failure, or a 504 when its
      // wait runs out; an approval never becomes its own code here, and its wait timer keeps
      // running so the caller still gets the 504 it was promised.
      if (result.code === 'needs-user') return
      if (message.timer !== undefined) {
        clearTimeout(message.timer)
        message.timer = undefined
      }
      this.answerSync(message, result)
      return
    }
    if (message.timer !== undefined) {
      clearTimeout(message.timer)
      message.timer = undefined
    }
    if (message.callbackUrl === undefined) return
    const payload = result.text === undefined
      ? { ok: false, msgId: message.msgId, instance: message.instance ?? '', code: result.code ?? 'bot-unavailable', message: result.message ?? botUnavailableText }
      : { ok: true, msgId: message.msgId, reply: result.text, completedAt: Date.now() }
    void this.sendCallback(message.callbackUrl, payload, route.secret)
  }

  answerTimeout(message) {
    if (message.response === undefined) return
    const response = message.response
    message.response = undefined
    this.reply(response, 504, { ok: false, code: 'timeout', message: errorTextTimeout })
  }

  answerSync(message, result) {
    const response = message.response
    if (response === undefined) return
    message.response = undefined
    if (result.text !== undefined) return this.reply(response, 200, { ok: true, msgId: message.msgId, reply: result.text })
    if (result.code === 'channel-rebound') return this.reply(response, 503, { ok: false, code: 'channel-rebound', message: errorTextRebound })
    if (result.code === 'timeout') return this.reply(response, 504, { ok: false, code: 'timeout', message: errorTextTimeout })
    this.reply(response, 502, { ok: false, code: 'bot-unavailable', message: botUnavailableText })
  }

  // The gateway gets the same signed contract back, on the address it named. Only a network
  // error, a 5xx, a 408 or a 429 is retried; another 4xx is a configuration error.
  async sendCallback(url, payload, secret) {
    const body = JSON.stringify(payload)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = randomBytes(8).toString('hex')
    const headers = {
      'content-type': 'application/json',
      'x-wechat-timestamp': timestamp,
      'x-wechat-nonce': nonce,
      'x-wechat-signature': signatureOf(secret, timestamp, nonce, body),
      'x-wechat-callback': '1',
    }
    for (let attempt = 0; ; attempt += 1) {
      let status
      try {
        const response = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
        status = response.status
      } catch {
        status = undefined
      }
      const retry = status === undefined || status >= 500 || status === 408 || status === 429
      const delays = this.callbackDelays()
      if (!retry || attempt >= delays.length) return
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }

  // Rebind or close: every waiting message is answered at once with the rebound code, and
  // the queue is emptied so the new Bot's binding starts clean.
  rebound(instance, reason = 'rebind') {
    const id = trim(instance)
    const route = this.routes.get(id)
    if (route !== undefined) route.rebound = true
    for (const [sessionId, waiting] of this.waits) {
      if (waiting.route.id !== id) continue
      this.waits.delete(sessionId)
      waiting.finish({ code: 'channel-rebound', message: errorTextRebound })
    }
    if (route === undefined) return
    for (const entry of route.pending) entry.fail({ code: 'channel-rebound', message: errorTextRebound })
    for (const message of route.queue.splice(0)) this.settle(route, message, { code: 'channel-rebound', message: errorTextRebound })
    if (typeof this.rt.rebindChannel === 'function') void this.rt.rebindChannel(route.id, { reason }).catch(() => {})
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

    const wait = this.waitOf(payload.wait)
    this.remember(route, hash, msgId)
    const message = { msgId, sender: hash, text, callbackUrl, wait, at: Date.now() }
    if (wait > 0) {
      // A synchronous caller keeps the response open; the queue still owns the message.
      message.response = response
      message.timer = setTimeout(() => this.answerTimeout(message), wait)
      message.timer.unref?.()
      this.enqueue(route, message)
      return
    }
    this.reply(response, 202, { ok: true, accepted: true, msgId, instance: route.id })
    this.enqueue(route, message)
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
