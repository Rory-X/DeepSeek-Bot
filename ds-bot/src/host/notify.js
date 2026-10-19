// Notification connectors: a Telegram bot (wired) and a Slack incoming webhook (kept for a
// later release, not wired into a connector yet). They send one message the user asked for;
// nothing else. The token and webhook URL live in Secrets, are used only here, and never
// appear in a result, a view or a log — Telegram carries the token in its URL, so errors are
// built from status codes and Telegram's own description only, never from the request.
const TIMEOUT_MS = 20_000
export const SLACK_TEXT_MAX = 40_000
export const TELEGRAM_TEXT_MAX = 4_096
export const NOTIFY_ERROR_MAX = 300
export const NOTIFY_TEST_TEXT = 'DS Bot: the connection works.'

const trim = text => (typeof text === 'string' ? text.trim() : '')

const telegramError = (status, body) => {
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 160) : ''
  if (status === 401 || status === 404) return new Error('Telegram did not accept this token.')
  if (status === 429) {
    const retryAfter = body?.parameters?.retry_after
    return new Error(`Telegram is rate-limited${Number.isFinite(retryAfter) ? `; try again in ${retryAfter}s` : ''}.`)
  }
  return new Error(`Telegram answered ${status}${description === '' ? '' : `: ${description}`}`)
}

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
    throw new Error('Could not reach Slack.')
  }
  const body = await response.text().catch(() => '')
  if (!response.ok) throw new Error(`Slack answered ${response.status}${body.trim() === '' ? '' : `: ${body.trim().slice(0, 160)}`}`)
}

const telegramUrl = (api, token, method) => `${api.replace(/\/$/, '')}/bot${token}/${method}`

export async function verifyTelegram(token, { api = 'https://api.telegram.org', fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(telegramUrl(api, token, 'getMe'), { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new Error('Could not reach Telegram.')
  }
  if (response.status === 401 || response.status === 404) throw new Error('Telegram did not accept this token.')
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw telegramError(response.status, body)
  // getMe only fails on the credential, so an ok:false answer here is the token too.
  if (body?.ok !== true) throw new Error('Telegram did not accept this token.')
  return typeof body?.result?.username === 'string' ? { username: body.result.username } : {}
}

// The chat a test or a notification should go to. Telegram only shows chats the bot has
// heard from, so the user is told to send the bot a message first when none is there.
export async function discoverTelegramChat({ token, api = 'https://api.telegram.org', fetch: request = fetch } = {}) {
  const url = `${telegramUrl(api, token, 'getUpdates')}?timeout=0&limit=100&allowed_updates=${encodeURIComponent('["message"]')}`
  let response
  try {
    response = await request(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new Error('Could not reach Telegram.')
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body?.ok !== true) throw telegramError(response.status, body)
  const chats = new Map()
  for (const update of Array.isArray(body?.result) ? body.result : []) {
    const chat = update?.message?.chat
    if (chat === null || typeof chat !== 'object' || chat.type !== 'private') continue
    const id = typeof chat.id === 'number' || typeof chat.id === 'string' ? String(chat.id) : ''
    if (id === '') continue
    chats.set(id, {
      chatId: id,
      ...(typeof chat.username === 'string' && chat.username !== '' ? { username: chat.username } : {}),
      ...(typeof chat.first_name === 'string' && chat.first_name !== '' ? { name: chat.first_name } : {}),
    })
  }
  const found = [...chats.values()]
  if (found.length === 1) return found[0]
  if (found.length > 1) return { candidates: found }
  return {}
}

export async function sendTelegram({ token, chatId, text, api = 'https://api.telegram.org', fetch: request = fetch }) {
  if (trim(chatId) === '') throw new Error('Add the Telegram chat id first.')
  if (text.length > TELEGRAM_TEXT_MAX) throw new Error(`Telegram messages are limited to ${TELEGRAM_TEXT_MAX} characters.`)
  let response
  try {
    response = await request(telegramUrl(api, token, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: trim(chatId), text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Telegram.')
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body?.ok !== true) throw telegramError(response.status, body)
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

export function createSlackTool({ webhookOf, output, redact = text => String(text), fetch: request = fetch }) {
  return notifyTool({
    name: 'notify_slack',
    description: `Send a message to the Slack channel this connector is set up for. Messages are limited to ${SLACK_TEXT_MAX} characters. Use it for notifications the user asked for.`,
    output,
    redact,
    send: text => sendSlack({ webhook: webhookOf(), text, fetch: request }),
  })
}

// The token and the chat id are read on every call, so a changed secret or a manually
// added chat id reaches the next message without a restart.
export function createTelegramTool({ tokenOf, chatIdOf, api, output, redact = text => String(text), fetch: request = fetch }) {
  return notifyTool({
    name: 'notify_telegram',
    description: `Send a message to the Telegram chat this connector is set up for. Messages are limited to ${TELEGRAM_TEXT_MAX} characters. Use it for notifications the user asked for.`,
    output,
    redact,
    send: text => sendTelegram({ token: tokenOf(), chatId: chatIdOf(), text, api, fetch: request }),
  })
}
