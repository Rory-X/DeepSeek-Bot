// WeChat channels: one connector card per channel, each bound 1:1 to a Bot. P1 is the
// outbound half — a channel posts a notice to a webhook (an enterprise WeChat group bot or
// any HTTP receiver). The inbound listener, channel Sessions and ClawBot login land in P2/P3.
import { createHmac, randomBytes } from 'node:crypto'
import { inboundFor } from '../wechat-inbound.js'
import { createRequire } from 'node:module'
import { qrPngDataUrl } from '../qr-image.js'
import { botBaseOf, createIlinkClient, maskAccount, qrStateOf } from '../wechat-ilink.js'

const TIMEOUT_MS = 10_000
// v0.2.0 refuses a tool without an output contract; a notice renders as its text.
const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const GENERIC_TEXT_MAX = 4_000
const WECOM_TEXT_MAX = 2_048
const SECRET_NAME = 'WECHAT_WEBHOOK_SECRET'
const URL_SECRET = 'WECHAT_WEBHOOK_URL'
const TEST_TEXT = 'DS Bot: the WeChat channel works.'
const TRANSPORTS = ['webhook', 'clawbot']
const FORMATS = ['generic', 'wecom']

const trim = value => (typeof value === 'string' ? value.trim() : '')
const SENT_PER_MINUTE = 20
const sentAt = new WeakMap()
const takeSend = (rt, channel) => {
  let byChannel = sentAt.get(rt)
  if (byChannel === undefined) { byChannel = new Map(); sentAt.set(rt, byChannel) }
  const now = Date.now()
  const list = (byChannel.get(channel) ?? []).filter(at => now - at < 60_000)
  if (list.length >= SENT_PER_MINUTE) {
    byChannel.set(channel, list)
    throw new Error(`This WeChat channel has sent ${SENT_PER_MINUTE} messages in the last minute; wait a moment and try again.`)
  }
  list.push(now)
  byChannel.set(channel, list)
}
const auditSend = (rt, channel, length, result) => {
  rt.diagnostics?.record?.({ source: 'wechat-notify', text: `${channel} sent ${length} chars, result ${result}` })
}
// The audit line names a result code, never a message and never a body.
const resultCodeOf = (error) => {
  const status = Number(error?.status)
  if (Number.isInteger(status) && status >= 100) return String(status)
  const errcode = Number(error?.body?.errcode)
  if (Number.isFinite(errcode) && errcode !== 0) return String(errcode)
  const ret = Number(error?.body?.ret)
  if (Number.isFinite(ret) && ret !== 0) return String(ret)
  return 'error'
}

const ILINK_TOKEN = 'WECHAT_ILINK_TOKEN'
export const CONSENT_VERSION = 1
// Login state lives in memory only: the QR and its poll belong to the open card, the token
// (once confirmed) lives in the credential store.
const ilinkLogins = new WeakMap()
const loginOf = (rt, id) => {
  let byId = ilinkLogins.get(rt)
  if (byId === undefined) { byId = new Map(); ilinkLogins.set(rt, byId) }
  const epoch = rt.state?.channels?.[id]?.ilink?.epoch ?? 0
  let login = byId.get(id)
  if (login === undefined || login.epoch !== epoch) {
    login = { epoch, state: 'logged-out', qr: null, scanned: false, account: null, error: null, expiresAt: null, qrcode: null }
    byId.set(id, login)
  }
  return login
}
const consentOf = (rt, id) => rt.state?.channels?.[id]?.ilink?.consent
const consentCurrent = (rt, id) => consentOf(rt, id)?.version === CONSENT_VERSION
// After a login, `-14` is WeChat's "session timeout": the stored token is dead. Colour the
// channel's row and wait for a new scan; never re-login on the user's behalf. During the QR
// phase the same answer stays retryable (see `command`).
const LOGIN_EXPIRED = 'The WeChat login expired. Webhook channels are not affected; scan the QR code again.'
const expireLogin = (rt, id) => {
  Object.assign(loginOf(rt, id), { state: 'login-expired', qr: null, scanned: false, qrcode: null, error: LOGIN_EXPIRED })
}
const ilinkFailure = (rt, id, error) => {
  const status = Number(error?.status)
  if (error?.paused === true || status === 401 || status === 403) {
    expireLogin(rt, id)
    return new Error(LOGIN_EXPIRED)
  }
  if (status === 429) return new Error('WeChat is rate-limited; try again in a moment.')
  return new Error('Could not reach WeChat.')
}
// The Bot API host the confirmed login named, kept with the scanned identity. Older state
// has none: those channels keep the configured base.
const ilinkBaseurlOf = (rt, id) => botBaseOf(rt.state?.channels?.[id]?.ilink?.baseurl)
const rememberConsent = (rt, id) => {
  const channels = rt.state.channels ?? (rt.state.channels = {})
  const channel = channels[id] ?? (channels[id] = {})
  channel.ilink = { ...(channel.ilink ?? {}), consent: { at: Date.now(), version: CONSENT_VERSION } }
  void rt.save().catch(() => {})
}
// QR status is a 30s long poll while the card asks every 2s. One poll per channel and login
// epoch may be in flight: a duplicate returns the state the running poll will update, and a
// poll whose code was replaced meanwhile is dropped. The epoch in the key keeps a reconnect's
// fresh login from adopting an answer meant for the previous one.
const pollsInFlight = new WeakMap()
const pollsOf = (rt) => {
  let byKey = pollsInFlight.get(rt)
  if (byKey === undefined) { byKey = new Map(); pollsInFlight.set(rt, byKey) }
  return byKey
}
// A call deadline is what keeps a stuck socket from pinning a command; the release values
// live in the iLink client, and `wechat.ilinkTimeouts` is the test/diagnostic override.
const ilinkTimeoutsOf = (config) => {
  const given = config?.ilinkTimeouts
  if (given === null || typeof given !== 'object') return undefined
  const timeouts = {}
  for (const key of ['qr', 'poll', 'send', 'updates']) {
    if (Number.isInteger(given[key]) && given[key] > 0) timeouts[key] = given[key]
  }
  return Object.keys(timeouts).length === 0 ? undefined : timeouts
}
// A Bot answer is sent back as texts: WeChat has no long-message type, and one turn should
// not become an unbounded burst, so the answer stops after four parts with an ellipsis.
const REPLY_CHUNK = 4_000
const REPLY_MAX_CHUNKS = 4
const FALLBACK_REPLY = 'The Bot could not answer this message.'
const replyChunks = (text) => {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return []
  const pieces = []
  for (let at = 0; at < value.length; at += REPLY_CHUNK) pieces.push(value.slice(at, at + REPLY_CHUNK))
  if (pieces.length <= REPLY_MAX_CHUNKS) return pieces
  const kept = pieces.slice(0, REPLY_MAX_CHUNKS)
  kept[kept.length - 1] = `${kept[kept.length - 1].slice(0, REPLY_CHUNK - 1)}…`
  return kept
}
// The live iLink answer is a page URL, not an image: encode that URL into a QR ourselves
// with the vendored MIT encoder and a tiny zlib PNG writer (no runtime dependency). A PNG
// data URL is passed through; anything else is not renderable on the card.
const require = createRequire(import.meta.url)
const qrcode = require('../vendor/qrcode.js')
const qrForCard = (value) => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/i.test(text)) return text
  if (/^https:\/\//i.test(text)) return qrPngDataUrl(text, qrcode)
  return undefined
}

const loginViewOf = (rt, id, secrets) => {
  const login = loginOf(rt, id)
  const token = secrets !== null && typeof secrets === 'object' ? secrets[ILINK_TOKEN] : undefined
  const stored = typeof token === 'string' && token !== '' ? token : undefined
  const state = login.qrcode === null && login.state === 'logged-out' && stored !== undefined ? 'logged-in' : login.state
  return {
    state,
    qr: login.qr,
    scanned: login.scanned === true,
    account: login.account,
    error: login.error,
    expiresAt: login.expiresAt,
    consentRequired: login.state === 'logged-out' && !consentCurrent(rt, id),
  }
}

const textLimit = format => (format === 'wecom' ? WECOM_TEXT_MAX : GENERIC_TEXT_MAX)

// The card's settings. A secret is a credential, not a setting: the framework stores it in
// DSH's credential store and the card only ever sees saved/not-saved. P1 shows the Webhook
// transport only; the ClawBot option opens with P3, and the validation still accepts it.
export const WECHAT_SETTINGS = [
  { name: 'label', label: 'Name' },
  { name: 'transport', label: 'Transport', kind: 'segmented', options: [{ value: 'webhook', label: 'Webhook' }, { value: 'clawbot', label: 'ClawBot (beta)' }] },
  { name: 'botId', label: 'Bot', kind: 'bot', required: true },
  // The push webhook URL carries its own key (a WeCom group bot URL), so it is stored as a
  // credential: the card only ever sees saved/replace/remove, never the value.
  { name: 'webhookUrl', label: 'Push webhook URL', kind: 'secret', secret: URL_SECRET },
  { name: 'webhookFormat', label: 'Format', kind: 'segmented', options: [{ value: 'generic', label: 'Generic JSON' }, { value: 'wecom', label: 'WeCom group bot' }] },
  // A channel Session carries no tools by default; turning this on allows only web_search.
  { name: 'allowReadTools', label: 'Read tools', kind: 'segmented', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] },
  { name: 'webhookSecret', label: 'Webhook secret', kind: 'secret', secret: SECRET_NAME },
]

const webhookOf = (settings) => {
  const raw = trim(settings?.webhookUrl)
  if (raw === '') return undefined
  let address
  try {
    address = new URL(raw)
  } catch {
    throw new Error('The push webhook URL must be an http or https URL.')
  }
  if (address.protocol !== 'http:' && address.protocol !== 'https:') throw new Error('The push webhook URL must be an http or https URL.')
  return address
}

// A channel is ready once it knows which Bot it speaks for and where to post. P1 keeps the
// secret optional: a receiver that cannot verify a signature still gets its notice.
export function wechatReadiness({ settings, rt, secretName, secretValue } = {}) {
  const values = settings !== null && typeof settings === 'object' ? settings : {}
  // A ClawBot channel is ready while logged out too: the card walks the login states, and
  // only the inbound/outbound halves depend on the token.
  if (trim(values.transport) === 'clawbot') return undefined
  const botId = trim(values.botId)
  if (botId === '') return 'Choose a Bot for this channel.'
  if (typeof rt?.botOf === 'function' && rt.botOf(botId) === undefined) return 'The Bot this channel is bound to no longer exists. Choose another Bot.'
  // The framework's own per-instance helper names the credential (F11); a value that is
  // merely unknown (undefined) is not an answer, so readiness stays lenient and only an
  // explicitly empty store counts as missing. The mount, which runs after the store loaded,
  // refuses a real "no URL" with the same sentence.
  const name = typeof secretName === 'function' ? secretName(URL_SECRET) : undefined
  const stored = name !== undefined && typeof secretValue === 'function' ? secretValue(name) : undefined
  if (trim(values.webhookUrl) === '' && stored === '') return 'Add the push webhook URL for this channel.'
  return undefined
}

// The URL a read or send path should use: the legacy plain setting (before migration, or
// after a failed migration) first, then the credential the framework resolved per instance.
const secretValueOfField = (rt, secrets, secretName, name) => {
  const fromMount = secrets !== null && typeof secrets === 'object' ? secrets[name] : undefined
  if (typeof fromMount === 'string') return fromMount
  if (typeof secretName !== 'function' || typeof rt?.secretValue !== 'function') return undefined
  try {
    const value = rt.secretValue(secretName(name))
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

// The credential comes first: a Replace on the card must win even while the old plain value
// is still around (migration pending, failed, or restored from an older state); legacy is
// only the fallback.
const webhookUrlOf = (settings, secrets) => {
  const stored = secrets !== null && typeof secrets === 'object' ? secrets[URL_SECRET] : undefined
  if (typeof stored === 'string' && stored !== '') return stored
  return trim(settings?.webhookUrl)
}

// A URL saved by an older release lives in the settings as plain text. Move it into the
// credential store once, and only clear the plain value after the write succeeded: a failed
// write keeps the URL usable for outbound posts and is retried by the next mount.
async function migrateWebhookUrl({ rt, id, settings, secretName }) {
  const legacy = trim(settings?.webhookUrl)
  if (legacy === '') return
  await rt.loadSecrets?.()
  const name = secretName(URL_SECRET)
  if (rt.secretValue?.(name) === undefined) {
    await rt.secretEndpoint('secret-set', { name, value: legacy, purpose: 'WeChat push webhook URL', scope: [] })
  }
  const prior = rt.state.connectors?.[id]?.settings
  if (prior === null || typeof prior !== 'object' || typeof prior.webhookUrl !== 'string') return
  const next = { ...prior }
  delete next.webhookUrl
  rt.state.connectors = { ...rt.state.connectors, [id]: { ...rt.state.connectors[id], settings: next } }
  await rt.save()
}

export function normalizeWechatSettings(values = {}, context = {}) {
  const given = values !== null && typeof values === 'object' ? values : {}
  const normalized = {}
  const label = trim(given.label).slice(0, 60)
  if (label !== '') normalized.label = label
  const transport = trim(given.transport)
  if (transport !== '') {
    if (!TRANSPORTS.includes(transport)) throw new Error('The transport is webhook or clawbot.')
    // A connected channel keeps its transport: switching would leave the other transport's
    // settings and messages dangling, so the user disconnects first. An off or never
    // connected channel may switch freely.
    const stateName = typeof context?.state === 'string' ? context.state : 'off'
    const saved = trim(context?.settings?.transport) === 'clawbot' ? 'clawbot' : 'webhook'
    if ((stateName === 'ready' || stateName === 'error') && saved !== transport) {
      throw new Error('Disconnect this channel before changing the transport.')
    }
    normalized.transport = transport
  }
  const botId = trim(given.botId)
  if (botId !== '') normalized.botId = botId
  const webhookUrl = trim(given.webhookUrl)
  if (webhookUrl !== '') {
    webhookOf({ webhookUrl })
    normalized.webhookUrl = webhookUrl
  }
  const allowReadTools = trim(given.allowReadTools)
  if (allowReadTools === 'on' || allowReadTools === 'off') normalized.allowReadTools = allowReadTools
  const webhookFormat = trim(given.webhookFormat)
  if (webhookFormat !== '') {
    if (!FORMATS.includes(webhookFormat)) throw new Error('The webhook format is generic or wecom.')
    normalized.webhookFormat = webhookFormat
  }
  return normalized
}

const signatureHeaders = (secret, body) => {
  if (secret === undefined || secret === '') return {}
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(8).toString('hex')
  const digest = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex')
  return {
    'x-wechat-timestamp': timestamp,
    'x-wechat-nonce': nonce,
    'x-wechat-signature': `sha256=${digest}`,
  }
}

// The status rides on the error so the audit line can name it as a code.
function outboundError(status, body) {
  const failed = (message) => Object.assign(new Error(message), { status })
  if (status === 401 || status === 403) return failed('The webhook refused the credential.')
  if (status === 404) return failed('The webhook URL was not found.')
  if (status === 429) {
    let retry = undefined
    try { retry = JSON.parse(body)?.retry_after } catch { retry = undefined }
    return failed(`The webhook is rate-limited${Number.isFinite(retry) ? `; try again in ${retry}s` : ''}.`)
  }
  return failed(`The webhook answered ${status}.`)
}

async function postNotice({ address, format, text, secret, fetch: request = fetch }) {
  const body = JSON.stringify(format === 'wecom' ? { msgtype: 'text', text: { content: text } } : { text })
  let response
  try {
    response = await request(address, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signatureHeaders(secret, body) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach the webhook.')
  }
  if (!response.ok) throw outboundError(response.status, await response.text().catch(() => ''))
}


function notifyToolClawbot({ channel, token, account, client, rt }) {
  const toolName = channel === 'wechat' ? 'wechat_notify' : `${channel.replaceAll('-', '_')}_notify`
  return {
    name: toolName,
    description: 'Send a message the user asked for to this WeChat channel\'s owner. Do not use it to send unprompted chatter.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The message to send.' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args) {
      const text = trim(args?.text)
      if (text === '') throw new Error('Write the message to send first.')
      if (text.length > 4_096) throw new Error('WeChat messages are limited to 4096 characters.')
      takeSend(rt, channel)
      try {
        await client.sendMessage({ token, toUserId: account, contextToken: undefined, text })
      } catch (error) {
        auditSend(rt, channel, text.length, resultCodeOf(error))
        throw ilinkFailure(rt, channel, error)
      }
      auditSend(rt, channel, text.length, 'ok')
      return 'Sent.'
    },
  }
}

function notifyTool({ channel, settings, secretOf, rt }) {
  const toolName = channel === 'wechat' ? 'wechat_notify' : `${channel.replaceAll('-', '_')}_notify`
  return {
    name: toolName,
    description: 'Send a notice the user asked for to this WeChat channel. Do not use it to send unprompted chatter or to repeat the same notice.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The notice to send; keep it short and specific.' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args) {
      const text = trim(args?.text)
      if (text === '') throw new Error('Write the notice to send first.')
      const limit = textLimit(settings.webhookFormat)
      if (text.length > limit) throw new Error(`WeChat messages are limited to ${limit} characters.`)
      const address = webhookOf(settings)
      if (address === undefined) throw new Error('Add the push webhook URL for this channel.')
      takeSend(rt, channel)
      try {
        await postNotice({ address, format: settings.webhookFormat, text, secret: secretOf() })
      } catch (error) {
        auditSend(rt, channel, text.length, resultCodeOf(error))
        throw error
      }
      auditSend(rt, channel, text.length, 'ok')
      return 'Sent.'
    },
  }
}

export default {
  id: 'wechat',
  displayName: 'WeChat',
  mode: 'custom',
  instances: { prefix: 'wechat', min: 1, max: 8 },
  // A messaging channel only sends: the level choice is hidden and write is the only level.
  levels: ['write'],
  defaultLevel: 'write',
  settings: WECHAT_SETTINGS.map(field => ({ ...field })),
  // A base name only: the framework's per-instance naming (F2b) adds the `_2` suffix, so
  // two channels never share one secret. Until F5 adds optional secret fields to the
  // settings form, Connect must carry one value; readiness still treats signing as optional.
  credentials: [
    { name: SECRET_NAME, label: 'Webhook secret', required: false },
    { name: URL_SECRET, label: 'Push webhook URL', required: false },
    { name: ILINK_TOKEN, label: 'ClawBot login', required: false },
  ],
  normalizeSettings: normalizeWechatSettings,
  readiness: wechatReadiness,
  capabilities: [
    { key: 'notify', title: 'Send messages through this channel', risk: 'write' },
  ],
  permissions: {
    summary: 'Sends a message through this channel when a Bot is asked to. Each channel is limited to 20 messages a minute, and every send is audited.',
  },
  card: {
    glyph: 'wechat',
    about: 'A WeChat channel bound to one Bot: it sends messages to the channel owner and takes the messages they send back. Both the Webhook and the ClawBot (beta) transport are supported.',
    docsUrl: 'https://github.com/Tencent/openclaw-weixin',
    levelChoice: false,
  },
  // What the card draws besides the settings: the level descriptions, whether Test can run,
  // and (P2) the inbound address. Display only, so a failing hook never breaks the card.
  // The ClawBot login steps: the QR is fetched only by these commands, never by the view,
  // and consent is required once per risk-text version before any code is requested.
  // `concurrent` keeps a poll out of the connector queue: the status call is a 30s long poll,
  // so queueing one per 2s card beat would stall every other button behind it. It is safe
  // because this module runs one poll per channel, and a confirmed login only writes a
  // credential: the framework then runs its own `serialise(() => refresh(id))`, which is the
  // one change that may remount, so the remount cannot race the poll that asked for it.
  commands: {
    'login-start': { transport: 'clawbot', args: ['consent'] },
    'login-refresh': { transport: 'clawbot', args: [] },
    'login-cancel': { transport: 'clawbot', args: [] },
    'login-poll': { transport: 'clawbot', args: [], concurrent: true },
  },
  // The row's display state only: a ClawBot login that expired errors its own row, while a
  // protocol error stays a retryable note inside the login block (no row error).
  status({ id, rt, settings }) {
    const values = settings !== null && typeof settings === 'object' ? settings : {}
    if (trim(values.transport) !== 'clawbot') {
      // The webhook half keeps its listener status in the row (same shape the view draws);
      // with no route at all the secret is what is missing.
      const hub = inboundFor(rt)
      return hub.statusOf(id).status ?? { inbound: 'needs-secret' }
    }
    const login = loginOf(rt, id)
    if (login.state === 'login-expired') return { state: 'error', error: LOGIN_EXPIRED }
    return {}
  },
  async command({ id, rt, action, args, secretName }) {
    const login = loginOf(rt, id)
    const config = rt.config?.wechat !== null && typeof rt.config?.wechat === 'object' ? rt.config.wechat : {}
    const client = createIlinkClient({
      base: trim(config.ilinkBase) === '' ? undefined : trim(config.ilinkBase),
      botBase: ilinkBaseurlOf(rt, id),
      pauseMs: Number.isInteger(config.ilinkPauseMs) ? config.ilinkPauseMs : undefined,
      backoffMaxMs: Number.isInteger(config.ilinkBackoffMaxMs) ? config.ilinkBackoffMaxMs : undefined,
      timeouts: ilinkTimeoutsOf(config),
    })
    if (action === 'login-cancel') {
      loginOf(rt, id).state = 'logged-out'
      Object.assign(login, { state: 'logged-out', qr: null, scanned: false, account: null, error: null, expiresAt: null, qrcode: null })
      return
    }
    // Ask for a code. A failure leaves a retryable protocol error and no code: the card's
    // Retry then asks again instead of polling a QR it never received.
    const requestQr = async () => {
      try {
        const answer = await client.getQrCode()
        // A remount replaced this login while the code was asked for: that card is gone.
        if (loginOf(rt, id) !== login) return
        const image = qrForCard(answer?.qrcode_img_content)
        Object.assign(login, {
          state: 'qr',
          qrcode: typeof answer?.qrcode === 'string' ? answer.qrcode : null,
          qr: image ?? null,
          scanned: false,
          account: null,
          error: image === undefined ? 'The QR code was returned in an unsupported form; update DS Bot.' : null,
          expiresAt: typeof answer?.expires_at === 'string' ? answer.expires_at : null,
        })
      } catch (error) {
        if (loginOf(rt, id) !== login) return
        Object.assign(login, { state: 'protocol-error', qrcode: null, qr: null, scanned: false, error: String(error?.message ?? error) })
      }
    }
    if (action === 'login-start' || action === 'login-refresh') {
      if (!consentCurrent(rt, id) && args?.consent !== true) {
        throw Object.assign(new Error('Confirm the ClawBot login risks first'), { code: 'bot/invalid' })
      }
      if (args?.consent === true) rememberConsent(rt, id)
      await requestQr()
      return
    }
    // One poll answer for the code this call started with. A refresh, a cancel or a reconnect
    // can replace that code while the 30s call waits; the late answer then belongs to an older
    // card and must not revive it (or log in a login the user already cancelled).
    const pollQr = async (startedWith) => {
      const current = () => loginOf(rt, id) === login && login.qrcode === startedWith
      try {
        const answer = await client.pollQrStatus(startedWith)
        if (!current()) return
        const mapped = qrStateOf(answer?.status)
        if (mapped === 'confirmed' || mapped === 'bound') {
          const token = typeof answer?.bot_token === 'string' ? answer.bot_token : ''
          if (mapped === 'confirmed' && token === '') {
            // The phone confirmed but the answer carries no credential: say so instead of
            // pretending the channel is connected.
            Object.assign(login, { state: 'confirm-failed', qr: null, scanned: true, error: 'The phone did not confirm the login. Scan again.' })
            return
          }
          // The credential write remounts the channel (a new login epoch), so the scanned
          // identity goes into state first: the remount must already know who the owner is.
          // The confirmed answer also names the Bot API host this login belongs to; without it
          // every Bot API call would go to the default host and be answered with -14.
          const channels = rt.state.channels ?? (rt.state.channels = {})
          const channel = channels[id] ?? (channels[id] = {})
          const botBase = botBaseOf(answer?.baseurl)
          const ilink = {
            ...(channel.ilink ?? {}),
            ...(typeof answer?.ilink_user_id === 'string' ? { ilinkUserId: answer.ilink_user_id } : {}),
            ...(typeof answer?.ilink_bot_id === 'string' ? { ilinkBotId: answer.ilink_bot_id } : {}),
          }
          if (botBase === undefined) delete ilink.baseurl
          else ilink.baseurl = botBase
          channel.ilink = ilink
          // A login event names the host it will talk to; the token never reaches diagnostics.
          let host = ''
          try { host = botBase === undefined ? '' : new URL(botBase).host } catch { host = '' }
          rt.diagnostics?.record?.({ source: 'wechat-login', text: `${id} signed in${host === '' ? '' : `, bot api ${host}`}` })
          // Keep the identity on disk before the token, in case the process stops in between.
          await rt.save().catch(() => {})
          if (token !== '') {
            const name = secretName(ILINK_TOKEN)
            await rt.secretEndpoint('secret-set', { name, value: token, purpose: 'WeChat ClawBot login', scope: [] })
          }
          // Never write through the old reference after the remount; the token alone makes the
          // view read as logged-in, this only adds the masked account to a login still ours.
          if (current()) {
            Object.assign(login, { state: 'logged-in', qr: null, scanned: false, account: maskAccount(answer?.ilink_user_id) ?? null, error: null, expiresAt: null, qrcode: null })
          }
          void rt.save().catch(() => {})
        } else if (mapped === 'wait') {
          Object.assign(login, { state: 'qr', scanned: false, error: null })
        } else if (mapped === 'scanned') {
          Object.assign(login, { state: 'qr', scanned: true, error: null })
        } else if (mapped === 'verified-needed') {
          Object.assign(login, { state: 'verified-needed' })
        } else if (mapped === 'blocked') {
          Object.assign(login, { state: 'blocked' })
        } else if (mapped === 'expired') {
          Object.assign(login, { state: 'expired', qr: null, scanned: false, qrcode: null })
        }
      } catch (error) {
        if (!current()) return
        // A code that expired or a login that already existed: only 401/403 means expired.
        // While signing in, `-14` stays a retryable protocol error.
        const auth = Number(error?.status) === 401 || Number(error?.status) === 403
        Object.assign(login, auth
          ? { state: 'login-expired', qr: null, scanned: false, qrcode: null, error: LOGIN_EXPIRED }
          : { state: 'protocol-error', error: String(error?.message ?? error) })
      }
    }
    if (action === 'login-poll') {
      // Retry of a protocol error (or of a phone that did not confirm) has no code to poll:
      // ask for a fresh one. With a code, the answer decides the next state, and a `wait`
      // after a pause must put the card back into the QR state rather than leave it stuck.
      const retryCode = login.qrcode === null
      if (retryCode) {
        if (login.state !== 'protocol-error' && login.state !== 'confirm-failed') return
        if (!consentCurrent(rt, id)) return
      }
      // The card asks every 2s and one answer may take 30s: keep one login step per channel
      // and epoch in flight, and let duplicates answer with the state the running one updates.
      const polls = pollsOf(rt)
      const key = `${id}\u0000${login.epoch}`
      if (polls.has(key)) return
      const startedWith = login.qrcode
      const task = retryCode ? requestQr() : pollQr(startedWith)
      polls.set(key, task)
      try {
        await task
      } finally {
        if (polls.get(key) === task) polls.delete(key)
      }
    }
  },
  view({ id, settings, rt, secrets }) {
    const values = settings !== null && typeof settings === 'object' ? settings : {}
    const hub = inboundFor(rt)
    const inbound = hub.viewOf(id)
    const webhook = trim(values.transport) !== 'clawbot'
    return {
      transport: webhook ? 'webhook' : 'clawbot',
      canTest: webhook
        ? webhookUrlOf(values, secrets) !== ''
        : loginViewOf(rt, id, secrets).state === 'logged-in' || (typeof secrets?.[ILINK_TOKEN] === 'string' && secrets[ILINK_TOKEN] !== ''),
      levels: [
        { id: 'write', title: 'Full access', description: 'Send messages for you; a Bot only sends when it is asked to.' },
      ],
      // An outbound-only channel says why it has no address yet: the inbound half needs the
      // HMAC secret, and the card should not look broken while it is missing.
      ...(Object.keys(inbound).length === 0 && webhook ? hub.needsSecret() : {}),
      ...inbound,
      ...hub.statusOf(id),
      ...(webhook ? {} : { login: loginViewOf(rt, id, secrets) }),
    }
  },
  // One test notice through the same path a real notice takes. A failure stays on the card
  // without turning the channel off, and the audit line records what actually happened.
  async test({ id, rt, settings, secrets, secretValue }) {
    const values = { ...(settings !== null && typeof settings === 'object' ? settings : {}), webhookUrl: webhookUrlOf(settings, secrets) }
    if (trim(values.transport) === 'clawbot') {
      const token = secrets !== null && typeof secrets === 'object' ? secrets[ILINK_TOKEN] : undefined
      const ilink = rt.state?.channels?.[id]?.ilink ?? {}
      if (typeof token !== 'string' || token === '' || typeof ilink.ilinkUserId !== 'string') {
        throw new Error('Scan the QR code to connect this ClawBot channel first.')
      }
      const config = rt.config?.wechat !== null && typeof rt.config?.wechat === 'object' ? rt.config.wechat : {}
      const client = createIlinkClient({
        base: trim(config.ilinkBase) === '' ? undefined : trim(config.ilinkBase),
        botBase: ilinkBaseurlOf(rt, id),
        timeouts: ilinkTimeoutsOf(config),
      })
      try {
        await client.sendMessage({ token, toUserId: ilink.ilinkUserId, text: TEST_TEXT })
      } catch (error) {
        auditSend(rt, id, TEST_TEXT.length, resultCodeOf(error))
        throw ilinkFailure(rt, id, error)
      }
      auditSend(rt, id, TEST_TEXT.length, 'ok')
      return
    }
    const address = webhookOf(values)
    if (address === undefined) throw new Error('Add the push webhook URL for this channel.')
    const secret = (typeof secrets?.[SECRET_NAME] === 'string' && secrets[SECRET_NAME] !== '')
      ? secrets[SECRET_NAME]
      : (typeof secretValue === 'function' ? secretValue(SECRET_NAME) : undefined)
    try {
      await postNotice({ address, format: values.webhookFormat, text: TEST_TEXT, secret })
    } catch (error) {
      auditSend(rt, id, TEST_TEXT.length, resultCodeOf(error))
      throw error
    }
    auditSend(rt, id, TEST_TEXT.length, 'ok')
  },
  async mount({ rt, settings, instance, level, secrets, token, secretName }) {
    const values = settings !== null && typeof settings === 'object' ? settings : {}
    const id = instance?.id ?? 'wechat'
    const botId = trim(values.botId)
    if (botId === '') throw new Error('Choose a Bot for this channel.')
    if (rt.botOf(botId) === undefined) throw new Error('The Bot this channel is bound to no longer exists. Choose another Bot.')
    if (trim(values.transport) === 'clawbot') {
      // A connect or settings change starts a fresh login card: the state carries an epoch,
      // so an in-memory QR from an earlier mount can never be shown again. The token stays in
      // the credential store and the scanned ids stay in the channel state, so a restart
      // returns as logged-in and the long poll below resumes on mount.
      const channels = rt.state.channels ?? (rt.state.channels = {})
      const channel = channels[id] ?? (channels[id] = {})
      channel.ilink = { ...(channel.ilink ?? {}), epoch: (channel.ilink?.epoch ?? 0) + 1 }
      ilinkLogins.get(rt)?.delete(id)
      void rt.save().catch(() => {})
      // The inbound half is a 35s long poll; the cursor lives in the channel state so a
      // restart continues where it stopped. There is no webhook URL or HMAC secret here.
      const token = secrets !== null && typeof secrets === 'object' ? secrets[ILINK_TOKEN] : undefined
      const config = rt.config?.wechat !== null && typeof rt.config?.wechat === 'object' ? rt.config.wechat : {}
      const ilink = channel.ilink ?? {}
      const account = typeof ilink.ilinkUserId === 'string' ? ilink.ilinkUserId : undefined
      const controller = new AbortController()
      const tools = []
      if (typeof token !== 'string' || token === '') {
        return { tools, close: () => { controller.abort(); ilinkLogins.get(rt)?.delete(id) } }
      }
      const client = createIlinkClient({
        base: trim(config.ilinkBase) === '' ? undefined : trim(config.ilinkBase),
        botBase: ilinkBaseurlOf(rt, id),
        pauseMs: Number.isInteger(config.ilinkPauseMs) ? config.ilinkPauseMs : undefined,
        backoffMaxMs: Number.isInteger(config.ilinkBackoffMaxMs) ? config.ilinkBackoffMaxMs : undefined,
        timeouts: ilinkTimeoutsOf(config),
      })
      if (level === 'write') tools.push(notifyToolClawbot({ channel: id, token, rt, account, client }))
      // Messages: the long poll hands each accepted one to this channel's queue, and the
      // queue answers it behind the poll, one Bot turn at a time. The poll never waits for a
      // turn, because a stopped poll is what makes WeChat drop the session.
      const hub = inboundFor(rt)
      const routeSettings = { ...values, allowReadTools: trim(values.allowReadTools) === 'on' }
      const seen = new Set()
      const deliveries = []
      let delivering = false
      const auditReply = (length, result) => auditSend(rt, id, length, result)
      const sendReply = async (message, reply) => {
        for (const chunk of replyChunks(reply)) {
          // A channel that was disconnected while its turn ran answers nowhere.
          if (controller.signal.aborted) return
          try {
            await client.sendMessage({ token, toUserId: message.fromUserId, text: chunk, contextToken: message.contextToken })
            auditReply(chunk.length, 'ok')
          } catch (error) {
            auditReply(chunk.length, resultCodeOf(error))
            const failure = ilinkFailure(rt, id, error)
            rt.warn?.('ds-bot: WeChat channel %s could not answer a message: %s', id, failure.message)
            return
          }
        }
      }
      const deliverOne = async (message) => {
        let result
        try {
          result = await hub.deliverLocal({
            instance: id,
            botId,
            settings: routeSettings,
            title: typeof values.label === 'string' ? values.label : undefined,
            sender: message.fromUserId,
            text: message.text,
          })
        } catch (error) {
          rt.warn?.('ds-bot: WeChat channel %s could not hand a message to its Bot: %s', id, error?.message ?? error)
          result = { code: 'bot-unavailable', message: FALLBACK_REPLY }
        }
        const answered = typeof result?.text === 'string' && result.text.trim() !== ''
        const reply = answered ? result.text.trim() : String(result?.message ?? FALLBACK_REPLY)
        // A failed or timed-out turn still gets a readable answer in WeChat; the audit keeps
        // the code only, never the words.
        if (!answered) auditReply(reply.length, String(result?.code ?? 'bot-unavailable'))
        await sendReply(message, reply)
      }
      const pump = () => {
        if (delivering) return
        delivering = true
        void (async () => {
          try {
            while (deliveries.length > 0 && !controller.signal.aborted) await deliverOne(deliveries.shift())
          } finally {
            delivering = false
          }
        })()
      }
      const accept = (message) => {
        if (message === null || typeof message !== 'object') return
        if (Number(message.message_type) !== 1) return
        if (message.message_state !== undefined && Number(message.message_state) !== 0) return
        // Only the account that scanned the code talks to this channel; anyone else is
        // ignored without a delivery or a reply.
        if (account === undefined || message.from_user_id !== account) return
        const item = (Array.isArray(message.item_list) ? message.item_list : []).find(entry => Number(entry?.type) === 1 && typeof entry?.text_item?.text === 'string')
        const text = typeof item?.text_item?.text === 'string' ? item.text_item.text.trim() : ''
        if (text === '') {
          rt.diagnostics?.record?.({ source: 'wechat-inbound', text: `${id} ignored a message without text` })
          return
        }
        // A replayed cursor must not start the same turn twice; the ring is memory only and
        // bounded, which is enough for a 35s poll's own replays.
        const key = message.message_id !== undefined ? `id:${message.message_id}` : (message.seq !== undefined ? `seq:${message.seq}` : undefined)
        if (key !== undefined) {
          if (seen.has(key)) return
          seen.add(key)
          if (seen.size > 200) seen.delete(seen.values().next().value)
        }
        deliveries.push({ fromUserId: message.from_user_id, text, contextToken: message.context_token })
        pump()
      }
      // Best effort: WeChat learns the bot is online. A failure only warns.
      void client.notifyStart({ token }).catch(error => rt.warn?.('ds-bot: WeChat channel %s did not report it is online: %s', id, error?.message ?? error))
      // Keep the session alive: WeChat drops a login whose getUpdates loop stops, so a
      // mounted channel with a token always polls. The cursor only advances on a non-empty
      // one, and a `-14` ("session timeout") ends the loop with an expired login.
      void (async () => {
        while (!controller.signal.aborted) {
          try {
            const answer = await client.getUpdates({ token, cursor: channel.ilink?.cursor, signal: controller.signal })
            if (controller.signal.aborted) return
            if (typeof answer?.get_updates_buf === 'string' && answer.get_updates_buf !== '' && answer.get_updates_buf !== channel.ilink.cursor) {
              channel.ilink.cursor = answer.get_updates_buf
              void rt.save().catch(() => {})
            }
            for (const message of Array.isArray(answer?.msgs) ? answer.msgs : []) accept(message)
          } catch (error) {
            if (controller.signal.aborted) return
            if (error?.paused === true || Number(error?.status) === 401 || Number(error?.status) === 403) {
              ilinkFailure(rt, id, error)
              return
            }
            await new Promise(resolve => setTimeout(resolve, client.backoffMs()))
          }
        }
      })()
      return {
        tools,
        close: () => {
          controller.abort()
          hub.forgetLocal(id)
          ilinkLogins.get(rt)?.delete(id)
          void client.notifyStop({ token }).catch(() => {})
        },
      }
    }
    // Older state keeps the URL as a plain setting; move it into the credential store before
    // this mount reads anything, keeping the plain value if the write fails.
    try {
      if (typeof secretName === 'function') await migrateWebhookUrl({ rt, id, settings: values, secretName })
    } catch (error) {
      rt.warn?.('ds-bot: the WeChat push URL of %s was not moved into the credential store: %s', id, error?.message ?? error)
    }
    await rt.loadSecrets?.()
    const effective = { ...values, webhookUrl: webhookUrlOf(values, { ...secrets, [URL_SECRET]: secretValueOfField(rt, secrets, secretName, URL_SECRET) }) }
    if (webhookOf(effective) === undefined) throw new Error('Add the push webhook URL for this channel.')
    const secretValue = (typeof secrets?.[SECRET_NAME] === 'string' && secrets[SECRET_NAME] !== '')
      ? secrets[SECRET_NAME]
      : (typeof token === 'string' && token !== '' ? token : undefined)
    // The framework resolved this instance's credential into `secrets`; reading the bare
    // name through rt here would sign with the first instance's secret.
    const secretOf = () => secretValue
    // A channel with an HMAC secret gets its inbound path; without one it keeps working for
    // outbound notices and has no inbound path at all. The listener is shared by every
    // channel of this plugin, so a mount only adds or removes its own route.
    const hub = inboundFor(rt)
    // A different Bot on the same channel is a rebind: the old Bot's Session is archived and
    // every message waiting on it hears the rebound code before the new binding starts.
    const bound = Object.values(rt.state?.channels?.[id]?.conversations ?? {}).map(entry => entry?.botId).find(value => typeof value === 'string')
    if (bound !== undefined && bound !== botId) {
      hub.rebound(id, 'rebind')
      if (typeof rt.rebindChannel === 'function') await rt.rebindChannel(id, { reason: 'rebind' }).catch(() => {})
    }
    if (typeof secrets?.[SECRET_NAME] === 'string' && secrets[SECRET_NAME] !== '') {
      // The Session half wants the boolean, the card stores the segmented word.
      await hub.attach({ instance: id, botId, settings: { ...values, allowReadTools: trim(values.allowReadTools) === 'on' }, secret: secrets[SECRET_NAME], secretName })
    }
    const tools = []
    if (level === 'write') {
      tools.push(notifyTool({ channel: id, settings: effective, secretOf, rt }))
    }
    return { tools, close: () => { void inboundFor(rt).detach(id) } }
  },
}
