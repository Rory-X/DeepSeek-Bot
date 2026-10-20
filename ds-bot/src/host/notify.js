// Notification connectors: the shared part of a connector that sends one message the user
// asked for. A module brings the service (its token check, its chat and its send call); the
// framework owns the tool, its limit and its errors, and the card's chat id. The token and
// the chat id are read on every call, so a changed secret reaches the next message.
export const NOTIFY_TEST_TEXT = 'DS Bot: the connection works.'
export const NOTIFY_ERROR_MAX = 300
export const DEFAULT_CHAT_ID_PATTERN = /^-?\d+$/
export const DEFAULT_CHAT_ID_HINT = 'A chat id is a number, such as 123456789 or -1001234567890.'

const trim = text => (typeof text === 'string' ? text.trim() : '')

// One tool per notification connector, registered only while there is a chat to send to.
// `send` throws on a failed send; the message never contains the token, and whatever it
// does say is redacted and short.
export function createNotifyTool({ name, description, maxText, output, redact = text => String(text), send }) {
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
      if (Number.isFinite(maxText) && text.length > maxText) throw new Error(`Messages are limited to ${maxText} characters.`)
      try {
        await send(text)
      } catch (error) {
        throw new Error(String(redact(String(error?.message ?? error))).slice(0, NOTIFY_ERROR_MAX))
      }
      return 'Sent.'
    },
  }
}

// The chat id a connector stores in the team file: a manually typed one, or the one its
// service named when the token was saved.
export function chatIdOf(state, id) {
  const chatId = state?.connectors?.[id]?.chatId
  return typeof chatId === 'string' && chatId !== '' ? chatId : undefined
}

// A typed chat id is checked before it is stored, so a typo is caught on the card instead
// of on the next send. An empty string clears it.
export function parseChatId(connector, raw) {
  const value = trim(raw)
  if (value === '') return undefined
  const declared = connector?.notify?.chatIdPattern
  const pattern = declared === undefined
    ? DEFAULT_CHAT_ID_PATTERN
    : declared instanceof RegExp ? new RegExp(declared.source, declared.flags.replace(/g/g, '')) : new RegExp(declared)
  if (!pattern.test(value)) throw new Error(connector?.notify?.chatIdHint ?? DEFAULT_CHAT_ID_HINT)
  return value
}
