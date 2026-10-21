// WeChat channels: one connector card per channel, each bound 1:1 to a Bot. P1 is the
// outbound half — a channel posts a notice to a webhook (an enterprise WeChat group bot or
// any HTTP receiver). The inbound listener, channel Sessions and ClawBot login land in P2/P3.
import { createHmac, randomBytes } from 'node:crypto'
import { inboundFor } from '../wechat-inbound.js'

const TIMEOUT_MS = 10_000
const GENERIC_TEXT_MAX = 4_000
const WECOM_TEXT_MAX = 2_048
const SECRET_NAME = 'WECHAT_WEBHOOK_SECRET'
const URL_SECRET = 'WECHAT_WEBHOOK_URL'
const TEST_TEXT = 'DS Bot: the WeChat channel works.'
const TRANSPORTS = ['webhook', 'clawbot']
const FORMATS = ['generic', 'wecom']

const trim = value => (typeof value === 'string' ? value.trim() : '')
const textLimit = format => (format === 'wecom' ? WECOM_TEXT_MAX : GENERIC_TEXT_MAX)

// The card's settings. A secret is a credential, not a setting: the framework stores it in
// DSH's credential store and the card only ever sees saved/not-saved. P1 shows the Webhook
// transport only; the ClawBot option opens with P3, and the validation still accepts it.
export const WECHAT_SETTINGS = [
  { name: 'label', label: 'Name' },
  { name: 'transport', label: 'Transport', kind: 'segmented', options: [{ value: 'webhook', label: 'Webhook' }] },
  { name: 'botId', label: 'Bot', kind: 'bot', required: true },
  // The push webhook URL carries its own key (a WeCom group bot URL), so it is stored as a
  // credential: the card only ever sees saved/replace/remove, never the value.
  { name: 'webhookUrl', label: 'Push webhook URL', kind: 'secret', secret: URL_SECRET },
  { name: 'webhookFormat', label: 'Format', kind: 'segmented', options: [{ value: 'generic', label: 'Generic JSON' }, { value: 'wecom', label: 'WeCom group bot' }] },
  { name: 'webhookSecret', label: 'Webhook secret', kind: 'secret', secret: SECRET_NAME },
]

// Mirrors the framework's F2b per-instance naming (base for the first instance, `_2` for
// `wechat-2`). It is used only to ask the credential store whether this instance already has
// a URL: the framework remains the only writer and the value is never read out here.
const secretNameFor = (instanceId, base) => {
  const id = trim(instanceId)
  if (id === '' || id === 'wechat') return base
  const match = /^wechat-([1-9][0-9]*)$/.exec(id)
  return match === null ? base : `${base}_${match[1]}`
}

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
export function wechatReadiness({ settings, rt, instance } = {}) {
  const values = settings !== null && typeof settings === 'object' ? settings : {}
  if (trim(values.transport) === 'clawbot') return 'ClawBot is not available in this release. Use the Webhook transport.'
  const botId = trim(values.botId)
  if (botId === '') return 'Choose a Bot for this channel.'
  if (typeof rt?.botOf === 'function' && rt.botOf(botId) === undefined) return 'The Bot this channel is bound to no longer exists. Choose another Bot.'
  // Readiness runs often and may run before the credential store has loaded: a value that is
  // merely unknown (undefined) is not an answer, so only an explicitly empty store counts as
  // missing. A real "no URL" is refused by the mount, which runs after the store loaded.
  const stored = typeof rt?.secretValue === 'function'
    ? rt.secretValue(secretNameFor(instance?.id, URL_SECRET))
    : undefined
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

const webhookUrlOf = (settings, secrets) => {
  const values = settings !== null && typeof settings === 'object' ? settings : {}
  const legacy = trim(values.webhookUrl)
  if (legacy !== '') return legacy
  const stored = secrets !== null && typeof secrets === 'object' ? secrets[URL_SECRET] : undefined
  return typeof stored === 'string' ? stored : ''
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
  levels: ['read', 'write'],
  defaultLevel: 'read',
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
    summary: 'Read level receives and answers messages; write level also posts notices, and every notice asks for your approval first.',
  },
  card: {
    glyph: 'wechat',
    about: 'A WeChat channel bound to one Bot: it can post notices, and incoming messages arrive in a later update. This release supports Webhook; ClawBot comes in the next batch.',
    docsUrl: 'https://github.com/Tencent/openclaw-weixin',
  },
  // What the card draws besides the settings: the level descriptions, whether Test can run,
  // and (P2) the inbound address. Display only, so a failing hook never breaks the card.
  view({ id, settings, rt, secrets }) {
    const values = settings !== null && typeof settings === 'object' ? settings : {}
    const hub = inboundFor(rt)
    const inbound = hub.viewOf(id)
    const webhook = trim(values.transport) !== 'clawbot'
    return {
      transport: webhook ? 'webhook' : 'clawbot',
      canTest: webhook && webhookUrlOf(values, secrets) !== '',
      levels: [
        { id: 'read', title: 'Read', description: 'Only receive and answer the messages this channel brings in.' },
        { id: 'write', title: 'Full access', description: 'Also send notices for you; every notice asks for your approval first.' },
      ],
      // An outbound-only channel says why it has no address yet: the inbound half needs the
      // HMAC secret, and the card should not look broken while it is missing.
      ...(Object.keys(inbound).length === 0 && webhook ? hub.needsSecret() : {}),
      ...inbound,
      ...hub.statusOf(id),
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
    if (trim(values.transport) === 'clawbot') throw new Error('ClawBot is not available in this release. Use the Webhook transport.')
    const botId = trim(values.botId)
    if (botId === '') throw new Error('Choose a Bot for this channel.')
    if (rt.botOf(botId) === undefined) throw new Error('The Bot this channel is bound to no longer exists. Choose another Bot.')
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
      await hub.attach({ instance: id, botId, settings: values, secret: secrets[SECRET_NAME], secretName })
    }
    const tools = []
    if (level === 'write') {
      tools.push(notifyTool({ channel: id, settings: effective, secretOf, approve }))
    }
    return { tools, close: () => { void inboundFor(rt).detach(id) } }
  },
}
