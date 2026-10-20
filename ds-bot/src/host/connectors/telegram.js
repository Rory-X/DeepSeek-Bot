// Telegram notifications: a bot of the user's own sends one message a Bot was asked for.
// The token lives in Secrets, the chat id in the team file; neither reaches a tool result,
// a view or a log.
import { discoverTelegramChat, sendTelegram, TELEGRAM_TEXT_MAX, TELEGRAM_TEST_TEXT, verifyTelegram } from './_telegram.js'

export default {
  id: 'telegram',
  displayName: 'Telegram',
  mode: 'notify',
  api: 'https://api.telegram.org',
  tokenSecret: 'TELEGRAM_BOT_TOKEN',
  // The chat is not known until the bot has heard from it, or the user types its id.
  needsChatId: true,
  card: {
    glyph: 'telegram',
    about: 'Send notifications through a Telegram bot of your own.',
    docsUrl: 'https://t.me/BotFather',
    readOnlyNote: 'The connector only sends the messages a Bot was asked to send.',
  },
  // The framework shows what this returns as the card's account; for Telegram that is the
  // bot's own username, the name the user knows it by in @BotFather.
  verify: async ({ token, api }) => {
    const found = await verifyTelegram(token, { api })
    return found.username === undefined ? {} : { account: found.username }
  },
  notify: {
    maxText: TELEGRAM_TEXT_MAX,
    testText: TELEGRAM_TEST_TEXT,
    toolDescription: `Send a message to the Telegram chat this connector is set up for. Messages are limited to ${TELEGRAM_TEXT_MAX} characters. Use it for notifications the user asked for.`,
    // Telegram only shows chats the bot has heard from, so the card asks for one message
    // first; a typed chat id is a number, negative in a group.
    missingChatText: 'Send the bot a message in Telegram first, then press Test again.',
    multipleChatsText: 'Telegram sees several chats: type the chat id you want.',
    chatIdPattern: /^-?\d+$/,
    chatIdHint: 'A Telegram chat id is a number, such as 123456789 or -1001234567890.',
    send: ({ token, chatId, text, api }) => sendTelegram({ token, chatId, text, api }),
    discoverChatId: ({ token, api }) => discoverTelegramChat({ token, api }),
  },
}
