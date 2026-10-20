// Telegram notifications: a bot of the user's own sends one message a Bot was asked for.
// The token lives in Secrets, the chat id in the team file; neither reaches a tool result,
// a view or a log.
import {
  checkTelegramChatId,
  createTelegramTool,
  discoverTelegramChat,
  sendTelegram,
  TELEGRAM_TEST_TEXT,
  verifyTelegram,
} from './_telegram.js'

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
  // The framework shows the account the verify hook returns on the card; for Telegram
  // that is the bot's own username, which is what the user recognizes in @BotFather.
  verify: async ({ token, api }) => {
    const found = await verifyTelegram(token, { api })
    return found.username === undefined ? {} : { account: found.username }
  },
  notify: {
    testText: TELEGRAM_TEST_TEXT,
    noChat: 'Send the bot a message in Telegram first, then press Test again.',
    severalChats: 'Telegram sees several chats: type the chat id you want.',
    send: ({ token, chatId, text, api, fetch }) => sendTelegram({ token, chatId, text, api, fetch }),
    discover: ({ token, api, fetch }) => discoverTelegramChat({ token, api, fetch }),
    checkChatId: checkTelegramChatId,
    tool: ({ tokenOf, chatIdOf, api, output, redact, fetch }) => createTelegramTool({ tokenOf, chatIdOf, api, output, redact, fetch }),
  },
}
