// Telegram's notifications: verify the bot token, find the private chat the bot already
// hears from, and send one message. The token travels in the request URL, so every error
// is built from the status and Telegram's own description, never from the request.
const TIMEOUT_MS = 20_000
export const TELEGRAM_TEXT_MAX = 4_096
export const TELEGRAM_TEST_TEXT = 'DS Bot: the connection works.'

const trim = text => (typeof text === 'string' ? text.trim() : '')
const url = (api, token, method) => `${api.replace(/\/$/, '')}/bot${token}/${method}`

const telegramError = (status, body) => {
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 160) : ''
  if (status === 401 || status === 404) return new Error('Telegram did not accept this token.')
  if (status === 429) {
    const retryAfter = body?.parameters?.retry_after
    return new Error(`Telegram is rate-limited${Number.isFinite(retryAfter) ? `; try again in ${retryAfter}s` : ''}.`)
  }
  return new Error(`Telegram answered ${status}${description === '' ? '' : `: ${description}`}`)
}

export async function verifyTelegram(token, { api = 'https://api.telegram.org', fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(url(api, token, 'getMe'), { signal: AbortSignal.timeout(TIMEOUT_MS) })
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

// The chat a test or a notification goes to. Telegram only shows chats the bot has heard
// from, so the user is told to write the bot first when there is none.
export async function discoverTelegramChat({ token, api = 'https://api.telegram.org', fetch: request = fetch } = {}) {
  const address = `${url(api, token, 'getUpdates')}?timeout=0&limit=100&allowed_updates=${encodeURIComponent('["message"]')}`
  let response
  try {
    response = await request(address, { signal: AbortSignal.timeout(TIMEOUT_MS) })
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
    response = await request(url(api, token, 'sendMessage'), {
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
