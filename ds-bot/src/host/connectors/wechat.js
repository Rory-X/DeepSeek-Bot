// WeChat channels: one connector card per channel, each bound 1:1 to a Bot. P1 is the
// outbound half — a channel posts a notice to a webhook (an enterprise WeChat group bot or
// any HTTP receiver). The inbound listener, channel Sessions and ClawBot login land in P2/P3.
import { createHmac, randomBytes } from 'node:crypto'

const TIMEOUT_MS = 10_000
const GENERIC_TEXT_MAX = 4_000
const WECOM_TEXT_MAX = 2_048
const SECRET_NAME = 'WECHAT_WEBHOOK_SECRET'
const TEST_TEXT = 'DS Bot: the WeChat channel works.'
const TRANSPORTS = ['webhook', 'clawbot']
const FORMATS = ['generic', 'wecom']

const trim = value => (typeof value === 'string' ? value.trim() : '')
const textLimit = format => (format === 'wecom' ? WECOM_TEXT_MAX : GENERIC_TEXT_MAX)

// The card's settings. A secret is a credential, not a setting: the framework stores it in
// DSH's credential store and the card only ever sees saved/not-saved.
export const WECHAT_SETTINGS = [
  { name: 'label', label: 'Name' },
  { name: 'transport', label: 'Transport', kind: 'segmented', options: [{ value: 'webhook', label: 'Webhook' }, { value: 'clawbot', label: 'ClawBot' }] },
  { name: 'botId', label: 'Bot', kind: 'bot', required: true },
  { name: 'webhookUrl', label: 'Push webhook URL' },
  { name: 'webhookFormat', label: 'Format', kind: 'segmented', options: [{ value: 'generic', label: 'Generic JSON' }, { value: 'wecom', label: 'WeCom group bot' }] },
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
export function wechatReadiness({ settings } = {}) {
  const values = settings !== null && typeof settings === 'object' ? settings : {}
  if (trim(values.transport) === 'clawbot') return 'This ClawBot channel is not logged in. Paste its bot token in the channel settings.'
  if (trim(values.botId) === '') return 'Choose a Bot for this channel.'
  if (trim(values.webhookUrl) === '') return 'Add the push webhook URL for this channel.'
  return undefined
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
  credentials: [{ name: SECRET_NAME, label: 'Webhook secret', required: false }],
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
    about: 'A WeChat channel bound to one Bot: it can post notices, and in P2 it receives messages.',
    docsUrl: 'https://github.com/Tencent/openclaw-weixin',
  },
  // What the card draws besides the settings: the level descriptions, whether Test can run,
  // and (P2) the inbound address. Display only, so a failing hook never breaks the card.
  view({ settings }) {
    const values = settings !== null && typeof settings === 'object' ? settings : {}
    return {
      transport: trim(values.transport) === 'clawbot' ? 'clawbot' : 'webhook',
      canTest: trim(values.transport) !== 'clawbot' && trim(values.webhookUrl) !== '',
      levels: [
        { id: 'read', title: 'Read', description: 'Only receive and answer the messages this channel brings in.' },
        { id: 'write', title: 'Full access', description: 'Also send notices for you; every notice asks for your approval first.' },
      ],
    }
  },
  // One test notice through the same path a real notice takes. A failure stays on the card
  // without turning the channel off.
  async test({ settings, secrets, secretValue }) {
    const values = settings !== null && typeof settings === 'object' ? settings : {}
    const address = webhookOf(values)
    if (address === undefined) throw new Error('Add the push webhook URL for this channel.')
    const secret = (typeof secrets?.[SECRET_NAME] === 'string' && secrets[SECRET_NAME] !== '')
      ? secrets[SECRET_NAME]
      : (typeof secretValue === 'function' ? secretValue(SECRET_NAME) : undefined)
    await postNotice({ address, format: values.webhookFormat, text: TEST_TEXT, secret })
  },
  mount({ rt, settings, instance, level, approve, secrets, token }) {
    const values = settings !== null && typeof settings === 'object' ? settings : {}
    const id = instance?.id ?? 'wechat'
    if (trim(values.transport) === 'clawbot') throw new Error('This ClawBot channel is not logged in. Paste its bot token in the channel settings.')
    const botId = trim(values.botId)
    if (botId === '') throw new Error('Choose a Bot for this channel.')
    if (rt.botOf(botId) === undefined) throw new Error('The Bot this channel is bound to no longer exists. Choose another Bot.')
    if (webhookOf(values) === undefined) throw new Error('Add the push webhook URL for this channel.')
    const secretValue = (typeof secrets?.[SECRET_NAME] === 'string' && secrets[SECRET_NAME] !== '')
      ? secrets[SECRET_NAME]
      : (typeof token === 'string' && token !== '' ? token : undefined)
    // The framework resolved this instance's credential into `secrets`; reading the bare
    // name through rt here would sign with the first instance's secret.
    const secretOf = () => secretValue
    const tools = []
    if (level === 'write') {
      tools.push(notifyTool({ channel: id, settings: values, secretOf, approve }))
    }
    return { tools }
  },
}
