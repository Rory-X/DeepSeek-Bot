// WeChat channels: one connector card per channel, each bound 1:1 to a Bot. P1 is the
// outbound half — a channel posts a notice to a webhook (an enterprise WeChat group bot or
// any HTTP receiver). The inbound listener, channel Sessions and ClawBot login land in P2/P3.
import { createHmac, randomBytes } from 'node:crypto'
import { inboundFor } from '../wechat-inbound.js'
import { createRequire } from 'node:module'
import { qrPngDataUrl } from '../qr-image.js'
import { createIlinkClient, maskAccount, qrStateOf } from '../wechat-ilink.js'

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
const rememberConsent = (rt, id) => {
  const channels = rt.state.channels ?? (rt.state.channels = {})
  const channel = channels[id] ?? (channels[id] = {})
  channel.ilink = { ...(channel.ilink ?? {}), consent: { at: Date.now(), version: CONSENT_VERSION } }
  void rt.save().catch(() => {})
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

function outboundError(status, body) {
  if (status === 401 || status === 403) return new Error('The webhook refused the credential.')
  if (status === 404) return new Error('The webhook URL was not found.')
  if (status === 429) {
    let retry = undefined
    try { retry = JSON.parse(body)?.retry_after } catch { retry = undefined }
    return new Error(`The webhook is rate-limited${Number.isFinite(retry) ? `; try again in ${retry}s` : ''}.`)
  }
  return new Error(`The webhook answered ${status}.`)
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


function notifyTool({ channel, settings, secretOf, approve }) {
  const toolName = channel === 'wechat' ? 'wechat_notify' : `${channel.replaceAll('-', '_')}_notify`
  return {
    name: toolName,
    description: 'Send a notice to this WeChat channel\'s webhook. Every call asks the user first.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The notice to send; keep it short and specific.' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const text = trim(args?.text)
      if (text === '') throw new Error('Write the notice to send first.')
      const limit = textLimit(settings.webhookFormat)
      if (text.length > limit) throw new Error(`WeChat messages are limited to ${limit} characters.`)
      const address = webhookOf(settings)
      if (address === undefined) throw new Error('Add the push webhook URL for this channel.')
      const host = address.host
      await approve({
        tool: toolName,
        line: `Send a notice through ${channel} (webhook ${host})`,
        target: host,
        change: 'posts a notice to the configured webhook',
        reversible: false,
        exec,
      })
      await postNotice({ address, format: settings.webhookFormat, text, secret: secretOf() })
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
  ],
  normalizeSettings: normalizeWechatSettings,
  readiness: wechatReadiness,
  capabilities: [
    { key: 'notify', title: 'Send notices through the webhook', risk: 'write' },
  ],
  permissions: {
    summary: 'Sends notices through this channel, and every notice asks for your approval first.',
  },
  card: {
    glyph: 'wechat',
    about: 'A WeChat channel bound to one Bot: it can post notices, and incoming messages arrive in a later update. This release supports Webhook; ClawBot comes in the next batch.',
    docsUrl: 'https://github.com/Tencent/openclaw-weixin',
    levelChoice: false,
  },
  // What the card draws besides the settings: the level descriptions, whether Test can run,
  // and (P2) the inbound address. Display only, so a failing hook never breaks the card.
  // The ClawBot login steps: the QR is fetched only by these commands, never by the view,
  // and consent is required once per risk-text version before any code is requested.
  commands: {
    'login-start': { transport: 'clawbot', args: ['consent'] },
    'login-refresh': { transport: 'clawbot', args: [] },
    'login-cancel': { transport: 'clawbot', args: [] },
    'login-poll': { transport: 'clawbot', args: [] },
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
    if (login.state === 'login-expired') {
      return { state: 'error', error: 'The WeChat login expired. Webhook channels are not affected; scan the QR code again.' }
    }
    return {}
  },
  async command({ id, rt, action, args, secretName }) {
    const login = loginOf(rt, id)
    const config = rt.config?.wechat !== null && typeof rt.config?.wechat === 'object' ? rt.config.wechat : {}
    const client = createIlinkClient({
      base: trim(config.ilinkBase) === '' ? undefined : trim(config.ilinkBase),
      pauseMs: Number.isInteger(config.ilinkPauseMs) ? config.ilinkPauseMs : undefined,
      backoffMaxMs: Number.isInteger(config.ilinkBackoffMaxMs) ? config.ilinkBackoffMaxMs : undefined,
    })
    if (action === 'login-cancel') {
      loginOf(rt, id).state = 'logged-out'
      Object.assign(login, { state: 'logged-out', qr: null, scanned: false, account: null, error: null, expiresAt: null, qrcode: null })
      return
    }
    if (action === 'login-start' || action === 'login-refresh') {
      if (!consentCurrent(rt, id) && args?.consent !== true) {
        throw Object.assign(new Error('Confirm the ClawBot login risks first'), { code: 'bot/invalid' })
      }
      if (args?.consent === true) rememberConsent(rt, id)
      if (action === 'login-poll') {
        // handled below
      }
      try {
        const answer = await client.getQrCode()
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
        Object.assign(login, { state: 'protocol-error', qr: null, scanned: false, error: String(error?.message ?? error) })
      }
      return
    }
    if (action === 'login-poll') {
      if (login.qrcode === null) return
      try {
        const answer = await client.pollQrStatus(login.qrcode)
        const mapped = qrStateOf(answer?.status)
        if (mapped === 'confirmed' || mapped === 'bound') {
          const token = typeof answer?.bot_token === 'string' ? answer.bot_token : ''
          if (mapped === 'confirmed' && token === '') {
            // The phone confirmed but the answer carries no credential: say so instead of
            // pretending the channel is connected.
            Object.assign(login, { state: 'confirm-failed', qr: null, scanned: true, error: 'The phone did not confirm the login. Scan again.' })
            return
          }
          if (token !== '') {
            const name = secretName(ILINK_TOKEN)
            await rt.secretEndpoint('secret-set', { name, value: token, purpose: 'WeChat ClawBot login', scope: [] })
          }
          Object.assign(login, { state: 'logged-in', qr: null, scanned: false, account: maskAccount(answer?.ilink_user_id) ?? null, error: null, expiresAt: null, qrcode: null })
        } else if (mapped === 'scanned') {
          Object.assign(login, { state: 'qr', scanned: true })
        } else if (mapped === 'verified-needed') {
          Object.assign(login, { state: 'verified-needed' })
        } else if (mapped === 'blocked') {
          Object.assign(login, { state: 'blocked' })
        } else if (mapped === 'expired') {
          Object.assign(login, { state: 'expired', qr: null, scanned: false, qrcode: null })
        }
      } catch (error) {
        const auth = Number(error?.status) === 401 || Number(error?.status) === 403
        Object.assign(login, auth
          ? { state: 'login-expired', qr: null, scanned: false, qrcode: null, error: 'The WeChat login expired. Webhook channels are not affected; scan the QR code again.' }
          : { state: 'protocol-error', error: String(error?.message ?? error) })
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
      canTest: webhook && webhookUrlOf(values, secrets) !== '',
      levels: [
        { id: 'write', title: 'Full access', description: 'Send notices for you; every notice asks for your approval first.' },
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
  // without turning the channel off.
  async test({ settings, secrets, secretValue }) {
    const values = { ...(settings !== null && typeof settings === 'object' ? settings : {}), webhookUrl: webhookUrlOf(settings, secrets) }
    const address = webhookOf(values)
    if (address === undefined) throw new Error('Add the push webhook URL for this channel.')
    const secret = (typeof secrets?.[SECRET_NAME] === 'string' && secrets[SECRET_NAME] !== '')
      ? secrets[SECRET_NAME]
      : (typeof secretValue === 'function' ? secretValue(SECRET_NAME) : undefined)
    await postNotice({ address, format: values.webhookFormat, text: TEST_TEXT, secret })
  },
  async mount({ rt, settings, instance, level, approve, secrets, token, secretName }) {
    const values = settings !== null && typeof settings === 'object' ? settings : {}
    const id = instance?.id ?? 'wechat'
    const botId = trim(values.botId)
    if (botId === '') throw new Error('Choose a Bot for this channel.')
    if (rt.botOf(botId) === undefined) throw new Error('The Bot this channel is bound to no longer exists. Choose another Bot.')
    if (trim(values.transport) === 'clawbot') {
      // A connect or settings change starts a fresh login card: the state carries an epoch,
      // so an in-memory QR from an earlier mount can never be shown again.
      const channels = rt.state.channels ?? (rt.state.channels = {})
      const channel = channels[id] ?? (channels[id] = {})
      channel.ilink = { ...(channel.ilink ?? {}), epoch: (channel.ilink?.epoch ?? 0) + 1 }
      ilinkLogins.get(rt)?.delete(id)
      void rt.save().catch(() => {})
      // The inbound half is a 35s long poll; the cursor lives in the channel state so a
      // restart continues where it stopped. There is no webhook URL or HMAC secret here.
      const token = secrets !== null && typeof secrets === 'object' ? secrets[ILINK_TOKEN] : undefined
      const controller = new AbortController()
      const config = rt.config?.wechat !== null && typeof rt.config?.wechat === 'object' ? rt.config.wechat : {}
      if (typeof token === 'string' && token !== '') {
        const client = createIlinkClient({
          base: trim(config.ilinkBase) === '' ? undefined : trim(config.ilinkBase),
          pauseMs: Number.isInteger(config.ilinkPauseMs) ? config.ilinkPauseMs : undefined,
          backoffMaxMs: Number.isInteger(config.ilinkBackoffMaxMs) ? config.ilinkBackoffMaxMs : undefined,
        })
        void (async () => {
          while (!controller.signal.aborted) {
            try {
              const answer = await client.getUpdates({ token, cursor: channel.ilink?.cursor, signal: controller.signal })
              if (controller.signal.aborted) return
              if (typeof answer?.get_updates_buf === 'string') {
                channel.ilink.cursor = answer.get_updates_buf
                void rt.save().catch(() => {})
              }
            } catch (error) {
              if (controller.signal.aborted) return
              const paused = client.noteError(error?.body?.errcode ?? error?.errcode)
              await new Promise(resolve => setTimeout(resolve, paused.paused ? Math.min(paused.pauseMs, 1_000) : client.backoffMs()))
            }
          }
        })()
      }
      return { tools: [], close: () => { controller.abort(); ilinkLogins.get(rt)?.delete(id) } }
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
      tools.push(notifyTool({ channel: id, settings: effective, secretOf, approve }))
    }
    return { tools, close: () => { void inboundFor(rt).detach(id) } }
  },
}
