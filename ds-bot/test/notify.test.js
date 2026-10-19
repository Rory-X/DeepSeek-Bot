import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SLACK_TEXT_MAX, TELEGRAM_TEXT_MAX, checkSlackWebhook, createSlackTool, createTelegramTool, sendSlack, sendTelegram, verifySlack, verifyTelegram,
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
  await assert.rejects(verifyTelegram(TOKEN, { fetch: async () => answer(401, { ok: false }) }), /Telegram did not accept this token/)
  await assert.rejects(verifyTelegram(TOKEN, { fetch: async () => answer(200, { ok: false }) }), /Telegram did not accept this token/)
  await assert.rejects(verifyTelegram(TOKEN, { fetch: async () => { throw new Error('offline') } }), /Could not reach Telegram/)
})

test('sending to Telegram needs a chat id and reports failures', async () => {
  const seen = []
  await sendTelegram({ token: TOKEN, chatId: ' -100200 ', text: 'hi', fetch: async (url, init) => { seen.push([url, JSON.parse(init.body)]); return answer(200, { ok: true }) } })
  assert.deepEqual(seen, [[`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: '-100200', text: 'hi', disable_web_page_preview: true }]])
  await assert.rejects(sendTelegram({ token: TOKEN, chatId: '', text: 'hi', fetch: async () => answer(200, { ok: true }) }), /chat id/)
  await assert.rejects(sendTelegram({ token: TOKEN, chatId: '1', text: 'x'.repeat(TELEGRAM_TEXT_MAX + 1), fetch: async () => answer(200, { ok: true }) }), /limited to 4096 characters/)
  await assert.rejects(sendTelegram({ token: TOKEN, chatId: '1', text: 'hi', fetch: async () => answer(400, { ok: false, description: 'chat not found' }) }), /Telegram answered 400: chat not found/)
})

test('the Slack tool sends its text and keeps secrets out of an error', async () => {
  const tool = createSlackTool({ webhook: WEBHOOK, output, fetch: async () => answer(400, `bad ${WEBHOOK}`), redact })
  assert.equal(tool.name, 'notify_slack')
  await assert.rejects(tool.execute({ text: 'hi' }), error => !error.message.includes(WEBHOOK) && error.message.includes('[secret]'))
  await assert.rejects(tool.execute({ text: '   ' }), /Write the message/)
  const ok = createSlackTool({ webhook: WEBHOOK, output, fetch: async () => answer(200, 'ok') })
  assert.equal(await ok.execute({ text: 'hi' }), 'Sent to Slack.')
})

test('the Telegram tool sends its text and keeps the token out of an error', async () => {
  const tool = createTelegramTool({ token: TOKEN, chatId: '1', output, fetch: async () => answer(401, { ok: false, description: `bad ${TOKEN}` }), redact })
  assert.equal(tool.name, 'notify_telegram')
  await assert.rejects(tool.execute({ text: 'hi' }), error => !error.message.includes(TOKEN) && error.message.includes('[secret]'))
  const ok = createTelegramTool({ token: TOKEN, chatId: '1', output, fetch: async () => answer(200, { ok: true }) })
  assert.equal(await ok.execute({ text: 'hi' }), 'Sent to Telegram.')
})
