import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatIdOf, createNotifyTool, DEFAULT_CHAT_ID_HINT, parseChatId } from '../src/host/notify.js'

const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const tool = (overrides = {}) => createNotifyTool({
  name: 'notify_demo',
  description: 'Send a message through Demo.',
  output,
  send: async () => {},
  ...overrides,
})

test('a notify tool trims the message, sends it and reports that it was sent', async () => {
  const sent = []
  const built = tool({ send: async text => { sent.push(text) } })
  assert.equal(built.name, 'notify_demo')
  assert.deepEqual(Object.keys(built.parameters.properties), ['text'])
  assert.deepEqual(built.parameters.required, ['text'])
  assert.equal(await built.execute({ text: '  build finished  ' }), 'Sent.')
  assert.deepEqual(sent, ['build finished'])
})

test('a notify tool refuses an empty message and one past its limit', async () => {
  const sent = []
  const built = tool({ maxText: 5, send: async text => { sent.push(text) } })
  await assert.rejects(built.execute({ text: '   ' }), /Write the message to send first/)
  await assert.rejects(built.execute({}), /Write the message to send first/)
  await assert.rejects(built.execute({ text: '123456' }), /limited to 5 characters/)
  assert.deepEqual(sent, [])
})

test('a notify tool redacts and shortens what the service said', async () => {
  const built = tool({
    send: async () => { throw new Error(`Telegram answered 401 for bot SECRET_TOKEN ${'x'.repeat(500)}`) },
    redact: text => String(text).replace('SECRET_TOKEN', '***'),
  })
  const error = await built.execute({ text: 'hello' }).then(() => undefined, reason => reason)
  assert.ok(error instanceof Error)
  assert.ok(!error.message.includes('SECRET_TOKEN'))
  assert.ok(error.message.includes('***'))
  assert.ok(error.message.length <= 300)
})

test('a stored chat id is read only when it is a non-empty string', () => {
  assert.equal(chatIdOf({ connectors: { telegram: { chatId: '-1001234' } } }, 'telegram'), '-1001234')
  assert.equal(chatIdOf({ connectors: { telegram: { chatId: '' } } }, 'telegram'), undefined)
  assert.equal(chatIdOf({ connectors: { telegram: {} } }, 'telegram'), undefined)
  assert.equal(chatIdOf({}, 'telegram'), undefined)
})

test('a typed chat id is checked before it is stored, and an empty one clears it', () => {
  const telegram = { notify: { chatIdPattern: /^-?\d+$/, chatIdHint: 'A Telegram chat id is a number.' } }
  assert.equal(parseChatId(telegram, ' 123456789 '), '123456789')
  assert.equal(parseChatId(telegram, '-1001234567890'), '-1001234567890')
  assert.equal(parseChatId(telegram, ''), undefined)
  assert.throws(() => parseChatId(telegram, '@someone'), /A Telegram chat id is a number/)
  const plain = {}
  assert.equal(parseChatId(plain, '42'), '42')
  assert.throws(() => parseChatId(plain, 'nope'), new RegExp(DEFAULT_CHAT_ID_HINT.slice(0, 20)))
})
