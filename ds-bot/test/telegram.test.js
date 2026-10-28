import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import {
  discoverTelegramChat,
  sendTelegram,
  TELEGRAM_TEST_TEXT,
  TELEGRAM_TEXT_MAX,
  verifyTelegram,
} from '../src/host/connectors/_telegram.js'
import { fakeContext } from './fake-ctx.js'

const TELEGRAM_TOKEN = '123456789:telegram-secret-token'

// A mock Telegram behind one fetch: getMe, getUpdates and sendMessage, with each request
// recorded so a test can check the body the connector sends.
function telegramBench({ chats = [], send } = {}) {
  const calls = []
  let updates = [...chats]
  const answer = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body ?? {}),
    json: async () => body ?? {},
  })
  const fetch = async (url, init = {}) => {
    const address = String(url)
    calls.push({ url: address, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    if (address.endsWith('/getMe')) return answer(200, { ok: true, result: { id: 1, username: 'ds_test_bot' } })
    if (address.includes('/getUpdates')) {
      const result = updates.map(id => ({ update_id: 1, message: { chat: { id, type: 'private', username: 'ann', first_name: 'Ann' } } }))
      updates = []
      return answer(200, { ok: true, result })
    }
    if (address.endsWith('/sendMessage')) {
      if (send !== undefined) return send()
      return answer(200, { ok: true, result: { message_id: 1 } })
    }
    throw new Error(`unexpected fetch ${address}`)
  }
  return { fetch, calls, answer, setChats: (next) => { updates = [...next] } }
}

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const teamHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-telegram-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  return home
}

function capture(ctx) {
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
}

// Calls the /api/bot route the way the client does.
async function call(ctx, endpoint, payload) {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}

// The plugin connects and mounts in the background; wait for the card to settle.
async function until(check, label) {
  for (let count = 0; count < 300; count += 1) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out: ${label}`)
}

function setup() {
  const home = teamHome()
  const registered = []
  const disposed = []
  const ctx = fakeContext()
  const register = ctx.tools.register
  ctx.tools.register = (tool) => {
    registered.push(tool.name)
    const undo = register(tool)
    return () => { disposed.push(tool.name); undo() }
  }
  capture(ctx)
  apply(ctx, { home })
  registered.length = 0
  disposed.length = 0
  return { ctx, home, registered, disposed }
}

const cardOf = (view, id = 'telegram') => (Array.isArray(view.value) ? view.value : view.value.connectors).find(connector => connector.id === id)

test('Telegram connects, finds the one private chat and sends from the tool and the test button', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = telegramBench({ chats: [4242] })
  globalThis.fetch = bench.fetch
  const { ctx, home, registered, disposed } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const before = await until(async () => {
    const state = await call(ctx, 'state', {})
    const card = state.value?.connectors?.find(connector => connector.id === 'telegram')
    return card !== undefined && card.state !== 'connecting' ? state : undefined
  }, 'the Telegram card')
  assert.deepEqual([cardOf(before).state, cardOf(before).mode, cardOf(before).chatId, cardOf(before).canTest, cardOf(before).account], ['off', 'notify', null, false, null])

  const connected = await call(ctx, 'connector-connect', { id: 'telegram', token: TELEGRAM_TOKEN })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  assert.deepEqual([cardOf(connected).state, cardOf(connected).mode, cardOf(connected).chatId, cardOf(connected).canTest, cardOf(connected).account], ['ready', 'notify', '4242', true, 'ds_test_bot'])
  assert.deepEqual(registered.filter(name => name === 'notify_telegram'), ['notify_telegram'])
  const savedText = readFileSync(join(home, 'state.json'), 'utf8')
  const saved = JSON.parse(savedText).connectors.telegram
  assert.deepEqual([saved.account, saved.chatId], ['ds_test_bot', '4242'])
  assert.ok(!savedText.includes(TELEGRAM_TOKEN))
  assert.ok(!JSON.stringify(await call(ctx, 'state', {})).includes(TELEGRAM_TOKEN))

  // A send is a write: the card names the chat and the message first. Automatic sends are
  // the default now, so turn them off for this connector to see that card.
  assert.equal(cardOf(connected).autoPush, true)
  const manual = await call(ctx, 'connector-set-auto-push', { id: 'telegram', enabled: false })
  assert.equal(cardOf(manual).autoPush, false)
  const sending = ctx.registeredTools.get('notify_telegram').execute({ text: ' deploy done ' }, { agent: { id: 'm1' } })
  const card = await until(async () => (await call(ctx, 'state', {})).value.questions.m1, 'the send approval card')
  assert.equal(card.kind, 'connector-approval')
  assert.match(card.detail, /deploy done/)
  assert.ok(!JSON.stringify(card).includes(TELEGRAM_TOKEN))
  assert.equal((await call(ctx, 'answer-question', { sessionId: 'm1', questionId: card.id, answer: { selected: ['Allow once'] } })).ok, true)
  assert.equal(await sending, 'Sent.')
  assert.deepEqual(bench.calls.at(-1).body, { chat_id: '4242', text: 'deploy done', disable_web_page_preview: true })

  const tested = await call(ctx, 'connector-test', { id: 'telegram' })
  assert.equal(tested.ok, true, JSON.stringify(tested))
  assert.equal(cardOf(tested).state, 'ready')
  assert.equal(bench.calls.at(-1).body.text, TELEGRAM_TEST_TEXT)
  assert.ok(!(await call(ctx, 'diagnostics-log')).value.includes(TELEGRAM_TOKEN))

  const disconnected = await call(ctx, 'connector-disconnect', { id: 'telegram' })
  assert.deepEqual([cardOf(disconnected).state, cardOf(disconnected).chatId, cardOf(disconnected).canTest, cardOf(disconnected).account], ['off', null, false, null])
  // The auto-push switch remounted once, so connect, that remount and Disconnect each took
  // the tool away.
  assert.deepEqual(disposed.filter(name => name === 'notify_telegram'), ['notify_telegram', 'notify_telegram'])
})

test('automatic sends are the default: no card, one audit entry, never the message', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = telegramBench({ chats: [4242] })
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const connected = await call(ctx, 'connector-connect', { id: 'telegram', token: TELEGRAM_TOKEN })
  assert.equal(connected.ok, true)
  // Unset means automatic; the card reports the value in force.
  assert.equal(cardOf(connected).autoPush, true)

  // No session and no card: this connector sends without asking.
  assert.equal(await ctx.registeredTools.get('notify_telegram').execute({ text: 'auto done' }, {}), 'Sent.')
  assert.equal(bench.calls.at(-1).body.text, 'auto done')
  const saved = await until(async () => {
    const telegram = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.telegram
    return Array.isArray(telegram.audit) ? telegram : undefined
  }, 'the automatic-send audit entry')
  assert.deepEqual(saved.audit.map(entry => entry.result), ['sent'])
  assert.ok(!JSON.stringify(saved.audit).includes('auto done'))

  // Turning automatic sends off brings the card back; a refused card sends nothing.
  const disabled = await call(ctx, 'connector-set-auto-push', { id: 'telegram', enabled: false })
  assert.equal(cardOf(disabled).autoPush, false)
  const sending = ctx.registeredTools.get('notify_telegram').execute({ text: 'card done' }, { agent: { id: 'm1' } })
  const card = await until(async () => (await call(ctx, 'state', {})).value.questions.m1, 'the send approval card')
  assert.equal(card.kind, 'connector-approval')
  assert.match(card.detail, /card done/)
  assert.equal((await call(ctx, 'answer-question', { sessionId: 'm1', questionId: card.id, answer: { selected: ['Deny'] } })).ok, true)
  await assert.rejects(sending, /denied/)
  assert.ok(bench.calls.every(call => call.body?.text !== 'card done'))
})

test('Telegram without a chat says what to do, and Test looks again after the user writes the bot', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = telegramBench({ chats: [] })
  globalThis.fetch = bench.fetch
  const { ctx, home, registered } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const connected = await call(ctx, 'connector-connect', { id: 'telegram', token: TELEGRAM_TOKEN })
  assert.deepEqual([cardOf(connected).state, cardOf(connected).chatId, cardOf(connected).canTest, cardOf(connected).account, cardOf(connected).error], ['ready', null, true, 'ds_test_bot', undefined])
  // No chat means no sending tool yet; the card shows the missing chat id.
  assert.deepEqual(registered.filter(name => name === 'notify_telegram'), [])

  // The user writes the bot now; Test discovers the chat and sends.
  bench.setChats([777])
  const tested = await call(ctx, 'connector-test', { id: 'telegram' })
  assert.equal(tested.ok, true, JSON.stringify(tested))
  assert.deepEqual([cardOf(tested).state, cardOf(tested).chatId], ['ready', '777'])
  assert.ok(registered.includes('notify_telegram'))

  // A manually typed chat id wins over discovery, and an empty string clears it.
  const typed = await call(ctx, 'connector-set-chat', { id: 'telegram', chatId: ' -100200 ' })
  assert.equal(cardOf(typed).chatId, '-100200')
  assert.match((await call(ctx, 'connector-set-chat', { id: 'telegram', chatId: 'abc' })).error.message, /chat id is a number/)
  const cleared = await call(ctx, 'connector-set-chat', { id: 'telegram', chatId: '' })
  assert.deepEqual([cardOf(cleared).state, cardOf(cleared).chatId], ['ready', null])
})

test('Telegram reports chat and rate-limit failures without the token', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = telegramBench({ chats: [] })
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const connected = await call(ctx, 'connector-connect', { id: 'telegram', token: TELEGRAM_TOKEN })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  await call(ctx, 'connector-set-chat', { id: 'telegram', chatId: '999' })

  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/sendMessage')) return bench.answer(400, { ok: false, description: 'Bad Request: chat not found' })
    return bench.fetch(url, init)
  }
  const failed = await call(ctx, 'connector-test', { id: 'telegram' })
  assert.equal(failed.ok, true, JSON.stringify(failed))
  assert.deepEqual([cardOf(failed).state, cardOf(failed).chatId], ['ready', '999'])
  assert.match(cardOf(failed).error, /chat not found/)
  assert.ok(!JSON.stringify(failed).includes(TELEGRAM_TOKEN))

  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/sendMessage')) return bench.answer(429, { ok: false, description: `Too Many Requests ${TELEGRAM_TOKEN}`, parameters: { retry_after: 9 } })
    return bench.fetch(url, init)
  }
  const limitedTest = await call(ctx, 'connector-test', { id: 'telegram' })
  assert.equal(limitedTest.ok, true, JSON.stringify(limitedTest))
  assert.match(cardOf(limitedTest).error, /rate-limited; try again in 9s/)
  assert.ok(!JSON.stringify(limitedTest).includes(TELEGRAM_TOKEN))
})

test('verifyTelegram answers who the bot is, and refuses a bad token', async () => {
  const good = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, result: { username: 'ds_test_bot' } }) })
  assert.deepEqual(await verifyTelegram(TELEGRAM_TOKEN, { fetch: good }), { username: 'ds_test_bot' })
  await assert.rejects(verifyTelegram(TELEGRAM_TOKEN, { fetch: async () => ({ status: 401, ok: false, json: async () => ({}) }) }), /did not accept this token/)
  await assert.rejects(verifyTelegram(TELEGRAM_TOKEN, { fetch: async () => ({ status: 500, ok: false, json: async () => ({ description: 'boom' }) }) }), /Telegram answered 500: boom/)
  await assert.rejects(verifyTelegram(TELEGRAM_TOKEN, { fetch: async () => { throw new Error('down') } }), /Could not reach Telegram/)
})

test('discoverTelegramChat finds the one private chat, several, or none', async () => {
  const answer = result => ({ status: 200, ok: true, json: async () => ({ ok: true, result }) })
  const update = (id, type = 'private') => ({ message: { chat: { id, type, username: 'ann', first_name: 'Ann' } } })
  assert.deepEqual(
    await discoverTelegramChat({ token: TELEGRAM_TOKEN, fetch: async () => answer([update(4242)]) }),
    { chatId: '4242', username: 'ann', name: 'Ann' },
  )
  const several = await discoverTelegramChat({ token: TELEGRAM_TOKEN, fetch: async () => answer([update(1), update(2)]) })
  assert.equal(several.candidates.length, 2)
  assert.deepEqual(await discoverTelegramChat({ token: TELEGRAM_TOKEN, fetch: async () => answer([update(1, 'group')]) }), {})
  await assert.rejects(discoverTelegramChat({ token: TELEGRAM_TOKEN, fetch: async () => ({ status: 401, ok: false, json: async () => ({}) }) }), /did not accept this token/)
})

test('sendTelegram posts one message and maps a rate limit', async () => {
  let seen
  const ok = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { status: 200, ok: true, json: async () => ({ ok: true, result: {} }) } }
  await sendTelegram({ token: TELEGRAM_TOKEN, chatId: ' 42 ', text: 'hi', fetch: ok })
  assert.deepEqual(seen.body, { chat_id: '42', text: 'hi', disable_web_page_preview: true })
  await assert.rejects(sendTelegram({ token: TELEGRAM_TOKEN, chatId: '', text: 'hi', fetch: ok }), /Add the Telegram chat id first/)
  await assert.rejects(sendTelegram({ token: TELEGRAM_TOKEN, chatId: '42', text: 'x'.repeat(TELEGRAM_TEXT_MAX + 1), fetch: ok }), /limited to 4096 characters/)
  await assert.rejects(
    sendTelegram({ token: TELEGRAM_TOKEN, chatId: '42', text: 'hi', fetch: async () => ({ status: 429, ok: false, json: async () => ({ parameters: { retry_after: 9 } }) }) }),
    /rate-limited; try again in 9s/,
  )
})

test('the Telegram connector declares the send limits and the chat id rule the framework enforces', async () => {
  const { default: telegram } = await import('../src/host/connectors/telegram.js')
  assert.equal(telegram.mode, 'notify')
  assert.equal(telegram.needsChatId, true)
  assert.equal(telegram.notify.maxText, TELEGRAM_TEXT_MAX)
  assert.match(telegram.notify.toolDescription, /4096 characters/)
  assert.match(telegram.notify.testText, /connection works/)
  assert.equal(telegram.notify.chatIdPattern.test('-1001234567890'), true)
  assert.equal(telegram.notify.chatIdPattern.test('123456789'), true)
  assert.equal(telegram.notify.chatIdPattern.test('abc'), false)
})
