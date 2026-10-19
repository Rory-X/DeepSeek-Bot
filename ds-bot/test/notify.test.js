import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkSlackWebhook,
  createSlackTool,
  createTelegramTool,
  discoverTelegramChat,
  NOTIFY_TEST_TEXT,
  sendSlack,
  sendTelegram,
  SLACK_TEXT_MAX,
  TELEGRAM_TEXT_MAX,
  verifySlack,
  verifyTelegram,
} from '../src/host/notify.js'

const output = { schema: { type: 'string' }, render: () => [] }
const answer = (status, body, ok = status >= 200 && status < 300) => ({
  status,
  ok,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body ?? {}),
})
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/secret'
const TOKEN = '123456:telegram-token'
const redact = value => String(value).split(TOKEN).join('[secret]').split(WEBHOOK).join('[secret]')

test('a Slack webhook must look like one', () => {
  assert.equal(checkSlackWebhook(WEBHOOK), undefined)
  assert.match(checkSlackWebhook(''), /incoming webhook URL/)
  assert.match(checkSlackWebhook('http://hooks.slack.com/services/T/B/X'), /incoming webhook URL/)
  assert.match(checkSlackWebhook('https://example.com/services/T/B/X'), /incoming webhook URL/)
  assert.match(checkSlackWebhook('https://hooks.slack.com/other/T/B/X'), /incoming webhook URL/)
})

test('verifySlack refuses a bad URL and accepts a webhook without a request', async () => {
  await assert.rejects(verifySlack('not a url'), /incoming webhook URL/)
  assert.deepEqual(await verifySlack(WEBHOOK), {})
})

test('sending to Slack reports success and failure truthfully', async () => {
  const seen = []
  await sendSlack({ webhook: WEBHOOK, text: 'hello', fetch: async (url, init) => { seen.push([url, JSON.parse(init.body)]); return answer(200, 'ok') } })
  assert.deepEqual(seen, [[WEBHOOK, { text: 'hello' }]])
  await assert.rejects(sendSlack({ webhook: WEBHOOK, text: 'hello', fetch: async () => answer(400, 'invalid_payload') }), /Slack answered 400: invalid_payload/)
  await assert.rejects(sendSlack({ webhook: WEBHOOK, text: 'hello', fetch: async () => { throw new Error('offline') } }), /Could not reach Slack/)
  await assert.rejects(sendSlack({ webhook: WEBHOOK, text: 'x'.repeat(SLACK_TEXT_MAX + 1), fetch: async () => answer(200, 'ok') }), /limited to 40000 characters/)
})

test('verifyTelegram asks who the bot is', async () => {
  let seen
  const account = await verifyTelegram(TOKEN, { fetch: async (url) => { seen = url; return answer(200, { ok: true, result: { username: 'ds_bot' } }) } })
  assert.deepEqual(account, { username: 'ds_bot' })
  assert.equal(seen, `https://api.telegram.org/bot${TOKEN}/getMe`)
  await assert.rejects(verifyTelegram(TOKEN, { fetch: async () => answer(401, { ok: false }) }), /did not accept this token/)
  await assert.rejects(verifyTelegram(TOKEN, { fetch: async () => answer(200, { ok: false }) }), /did not accept this token/)
  await assert.rejects(verifyTelegram(TOKEN, { fetch: async () => { throw new Error('offline') } }), /Could not reach Telegram/)
})

const updates = (...messages) => ({ ok: true, result: messages.map(message => ({ update_id: 1, message })) })
const privateChat = (id, username, first_name = 'Ann') => ({ id, type: 'private', username, first_name })

test('chat discovery finds the one private chat that wrote to the bot', async () => {
  let seen
  const found = await discoverTelegramChat({
    token: TOKEN,
    fetch: async (url) => { seen = url; return answer(200, updates({ chat: privateChat(42, 'ann') }, { chat: privateChat(42, 'ann') })) },
  })
  assert.deepEqual(found, { chatId: '42', username: 'ann', name: 'Ann' })
  assert.match(seen, /\/bot.*\/getUpdates\?timeout=0&limit=100&allowed_updates=/)
  assert.match(seen, /%5B%22message%22%5D/)
})

test('chat discovery does not guess: no chat, several chats, or only groups', async () => {
  assert.deepEqual(await discoverTelegramChat({ token: TOKEN, fetch: async () => answer(200, updates()) }), {})
  const many = await discoverTelegramChat({ token: TOKEN, fetch: async () => answer(200, updates({ chat: privateChat(1, 'a') }, { chat: privateChat(2, 'b') })) })
  assert.equal(many.chatId, undefined)
  assert.deepEqual(many.candidates.map(candidate => candidate.chatId), ['1', '2'])
  const groupsOnly = await discoverTelegramChat({ token: TOKEN, fetch: async () => answer(200, updates({ chat: { id: -100, type: 'group', title: 'Group' } })) })
  assert.deepEqual(groupsOnly, {})
  await assert.rejects(discoverTelegramChat({ token: TOKEN, fetch: async () => answer(401, { ok: false }) }), /did not accept this token/)
  await assert.rejects(discoverTelegramChat({ token: TOKEN, fetch: async () => { throw new Error('offline') } }), /Could not reach Telegram/)
})

test('sending to Telegram needs a chat id and reports failures truthfully', async () => {
  const seen = []
  await sendTelegram({ token: TOKEN, chatId: ' -100200 ', text: 'hi', fetch: async (url, init) => { seen.push([url, JSON.parse(init.body)]); return answer(200, { ok: true }) } })
  assert.deepEqual(seen, [[`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: '-100200', text: 'hi', disable_web_page_preview: true }]])
  await assert.rejects(sendTelegram({ token: TOKEN, chatId: '', text: 'hi', fetch: async () => answer(200, { ok: true }) }), /chat id/)
  await assert.rejects(sendTelegram({ token: TOKEN, chatId: '1', text: 'x'.repeat(TELEGRAM_TEXT_MAX + 1), fetch: async () => answer(200, { ok: true }) }), /limited to 4096 characters/)
  await assert.rejects(sendTelegram({ token: TOKEN, chatId: '1', text: 'hi', fetch: async () => answer(400, { ok: false, description: 'Bad Request: chat not found' }) }), /Telegram answered 400: Bad Request: chat not found/)
  await assert.rejects(sendTelegram({ token: TOKEN, chatId: '1', text: 'hi', fetch: async () => answer(401, { ok: false }) }), /did not accept this token/)
  await assert.rejects(sendTelegram({ token: TOKEN, chatId: '1', text: 'hi', fetch: async () => answer(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } }) }), /rate-limited; try again in 7s/)
  await assert.rejects(sendTelegram({ token: TOKEN, chatId: '1', text: 'hi', fetch: async () => { throw new Error('offline') } }), /Could not reach Telegram/)
})

test('the Telegram tool reads the token and chat id on every call', async () => {
  const seen = []
  let token = 'first'
  let chatId = '1'
  const tool = createTelegramTool({
    tokenOf: () => token,
    chatIdOf: () => chatId,
    output,
    redact,
    fetch: async (url, init) => { seen.push([url, JSON.parse(init.body)]); return answer(200, { ok: true }) },
  })
  assert.equal(tool.name, 'notify_telegram')
  assert.equal(await tool.execute({ text: ' hi ' }), 'Sent to Telegram.')
  token = 'second'
  chatId = '2'
  await tool.execute({ text: 'again' })
  assert.deepEqual(seen.map(([url, body]) => [url.split('/bot')[1].split('/')[0], body.chat_id]), [['first', '1'], ['second', '2']])
  await assert.rejects(tool.execute({ text: '   ' }), /Write the message/)
  assert.equal(NOTIFY_TEST_TEXT, 'DS Bot: the connection works.')
})

test('a Telegram error keeps the token out of its message', async () => {
  const tool = createTelegramTool({
    tokenOf: () => TOKEN,
    chatIdOf: () => '1',
    output,
    redact,
    fetch: async () => answer(400, { ok: false, description: `bad ${TOKEN}` }),
  })
  await assert.rejects(tool.execute({ text: 'hi' }), error => !error.message.includes(TOKEN) && error.message.includes('[secret]'))
})

test('the Slack tool still sends, for a later release', async () => {
  let webhook = WEBHOOK
  const tool = createSlackTool({ webhookOf: () => webhook, output, redact, fetch: async url => (url === webhook ? answer(200, 'ok') : answer(404, 'no')) })
  assert.equal(await tool.execute({ text: 'hi' }), 'Sent to Slack.')
  webhook = `${WEBHOOK}/other`
  assert.equal(await tool.execute({ text: 'hi' }), 'Sent to Slack.')
})
