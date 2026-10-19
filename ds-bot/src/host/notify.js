// Notification connectors: a Slack incoming webhook and a Telegram bot. They send a
// message the user asked for; nothing else. The webhook URL and the bot token live in
// Secrets, are used only here, and never appear in a tool result or a log.
const TIMEOUT_MS = 20_000
export const SLACK_TEXT_MAX = 40_000
export const TELEGRAM_TEXT_MAX = 4_096
export const NOTIFY_ERROR_MAX = 300

const trim = text => (typeof text === 'string' ? text.trim() : '')

// A Slack incoming webhook has one shape; checking it saves a request and tells the user
// what to paste instead of a generic failure.
export function checkSlackWebhook(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    return 'Paste the Slack incoming webhook URL from Slack (https://hooks.slack.com/services/…).'
  }
  if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com' || !url.pathname.startsWith('/services/')) {
    return 'Paste the Slack incoming webhook URL from Slack (https://hooks.slack.com/services/…).'
  }
  return undefined
}

export async function verifySlack(token) {
  const problem = checkSlackWebhook(token)
  if (problem !== undefined) throw new Error(problem)
  return {}
}

export async function sendSlack({ webhook, text, fetch: request = fetch }) {
  if (text.length > SLACK_TEXT_MAX) throw new Error(`Slack messages are limited to ${SLACK_TEXT_MAX} characters.`)
  let response
  try {
    response = await request(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Slack')
  }
  const body = await response.text().catch(() => '')
  if (!response.ok) throw new Error(`Slack answered ${response.status}${body.trim() === '' ? '' : `: ${body.trim().slice(0, 160)}`}`)
}

export async function verifyTelegram(token, { api = 'https://api.telegram.org', fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(`${api.replace(/\/$/, '')}/bot${token}/getMe`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new Error('Could not reach Telegram')
  }
  if (response.status === 401 || response.status === 404) throw new Error('Telegram did not accept this token')
  if (!response.ok) throw new Error(`Telegram answered ${response.status}`)
  const body = await response.json().catch(() => ({}))
  if (body?.ok !== true) throw new Error('Telegram did not accept this token')
  return typeof body?.result?.username === 'string' ? { username: body.result.username } : {}
}

export async function sendTelegram({ token, chatId, text, api = 'https://api.telegram.org', fetch: request = fetch }) {
  if (trim(chatId) === '') throw new Error('Add the Telegram chat id first.')
  if (text.length > TELEGRAM_TEXT_MAX) throw new Error(`Telegram messages are limited to ${TELEGRAM_TEXT_MAX} characters.`)
  let response
  try {
    response = await request(`${api.replace(/\/$/, '')}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: trim(chatId), text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Telegram')
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body?.ok !== true) {
    const description = typeof body?.description === 'string' ? `: ${body.description.slice(0, 160)}` : ''
    throw new Error(`Telegram answered ${response.status}${description}`)
  }
}

const safe = (redact, error) => new Error(String(redact(String(error?.message ?? error))).slice(0, NOTIFY_ERROR_MAX))

function notifyTool({ name, description, output, send, redact }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The message to send; keep it short and specific.' } },
      required: ['text'],
      additionalProperties: false,
    },
    output,
    async execute(args) {
      const text = trim(args?.text)
      if (text === '') throw new Error('Write the message to send first.')
      try {
        await send(text)
        return name === 'notify_slack' ? 'Sent to Slack.' : 'Sent to Telegram.'
      } catch (error) {
        throw safe(redact, error)
      }
    },
  }
}

export function createSlackTool({ webhook, output, redact = text => String(text), fetch: request = fetch }) {
  return notifyTool({
    name: 'notify_slack',
    description: `Send a message to the Slack channel this connector is set up for. Messages are limited to ${SLACK_TEXT_MAX} characters. Use it for notifications the user asked for.`,
    output,
    redact,
    send: text => sendSlack({ webhook, text, fetch: request }),
  })
}

export function createTelegramTool({ token, chatId, api, output, redact = text => String(text), fetch: request = fetch }) {
  return notifyTool({
    name: 'notify_telegram',
    description: `Send a message to the Telegram chat this connector is set up for. Messages are limited to ${TELEGRAM_TEXT_MAX} characters. Use it for notifications the user asked for.`,
    output,
    redact,
    send: text => sendTelegram({ token, chatId, text, api, fetch: request }),
  })
}
