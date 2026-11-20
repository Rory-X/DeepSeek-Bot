import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatIdOf, createNotifyTool, DEFAULT_CHAT_ID_HINT, parseChatId } from '../src/host/notify.js'
import { NOTIFY_KEY, badgeOf, noticeText, notificationRows, notifyKind, readNotifyPrefs, writeNotifyPrefs } from '../src/client/notify.js'

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

test('a notify tool asks the approval hook before it sends', async () => {
  const sent = []
  let asked
  const built = tool({
    send: async text => { sent.push(text) },
    approve: async request => { asked = request },
  })
  assert.equal(await built.execute({ text: 'hello' }, { agent: { id: 'm1' } }), 'Sent.')
  assert.deepEqual(sent, ['hello'])
  assert.equal(asked.text, 'hello')
  assert.equal(asked.exec.agent.id, 'm1')
  assert.equal(asked.tool, 'notify_demo')

  const refused = tool({
    send: async () => { sent.push('must not') },
    approve: async () => { throw new Error('The user denied it; nothing was sent.') },
  })
  await assert.rejects(refused.execute({ text: 'nope' }, {}), /denied/)
  assert.ok(!sent.includes('must not'))
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

// #1504: a window the user is not looking at says a Bot answered, or a card waits on
// them. What may leave the app is the conversation's name and one line, never the message.
const base = { enabled: true, muted: false, group: false, viewing: false, focused: false }

test('a reply notifies only when the conversation is not being watched', () => {
  const reply = { before: { completionUnread: false }, after: { completionUnread: true } }
  assert.equal(notifyKind({ ...base, ...reply }), 'reply')
  // Looking at it in a focused window is enough on its own.
  assert.equal(notifyKind({ ...base, ...reply, viewing: true, focused: true }), undefined)
  // Looking at it in a background window is not: the window may be behind another app.
  assert.equal(notifyKind({ ...base, ...reply, viewing: true }), 'reply')
  // Unread already set: a second status update says nothing new.
  assert.equal(notifyKind({ ...base, before: { completionUnread: true }, after: { completionUnread: true } }), undefined)
})

test('a card waiting on the user notifies in a group too, and once', () => {
  const question = { before: {}, after: { pendingInteraction: { id: 'q1' } } }
  assert.equal(notifyKind({ ...base, group: true, ...question }), 'question')
  // The same card still pending is not a second notification.
  assert.equal(notifyKind({ ...base, group: true, before: question.after, after: question.after }), undefined)
})

test('a group says nothing for an ordinary reply: that is @-mentions (#945), not this', () => {
  assert.equal(notifyKind({ ...base, group: true, before: {}, after: { completionUnread: true } }), undefined)
})

test('the switches and the mute win over the event', () => {
  const reply = { before: {}, after: { completionUnread: true } }
  assert.equal(notifyKind({ ...base, ...reply, enabled: false }), undefined)
  assert.equal(notifyKind({ ...base, ...reply, muted: true }), undefined)
})

test('what goes out is the name and one line', () => {
  assert.deepEqual(noticeText({ title: 'Writer', kind: 'reply' }), { title: 'Writer', body: 'A new reply is waiting' })
  assert.deepEqual(noticeText({ title: 'Ops', kind: 'question' }), { title: 'Ops', body: 'Waiting for your answer' })
  assert.equal(noticeText({ title: '   ', kind: 'reply' }).title, 'DS Bot')
  assert.equal(noticeText({ title: 'x'.repeat(200), kind: 'reply' }).title.length, 60)
})

test('the switches default to on with nothing muted, and survive bad storage', () => {
  assert.deepEqual(readNotifyPrefs(null), { enabled: true, muted: {} })
  assert.deepEqual(readNotifyPrefs('not json'), { enabled: true, muted: {} })
  assert.deepEqual(readNotifyPrefs('{"enabled":false,"muted":{"s-1":true,"s-2":false}}'), { enabled: false, muted: { 's-1': true } })
  const off = writeNotifyPrefs({ enabled: true, muted: {} }, { enabled: false })
  assert.deepEqual(off, { enabled: false, muted: {} })
  const muted = writeNotifyPrefs(off, { mute: { id: 's-9', on: true } })
  assert.deepEqual(muted, { enabled: false, muted: { 's-9': true } })
  assert.deepEqual(writeNotifyPrefs(muted, { mute: { id: 's-9', on: false } }), { enabled: false, muted: {} })
  assert.equal(NOTIFY_KEY, 'ds-bot:notify')
})

test('the badge counts conversations with something new', () => {
  assert.equal(badgeOf([]), 0)
  assert.equal(badgeOf([{ unread: true }, {}, { pending: true }, { unread: false }]), 2)
  assert.equal(badgeOf(undefined), 0)
})


test('initial unread and pending snapshots do not replay notifications', () => {
  assert.equal(notifyKind({ ...base, after: { completionUnread: true } }), undefined)
  assert.equal(notifyKind({ ...base, after: { pendingInteraction: 'existing-card' } }), undefined)
})

test('questions and group approvals use stable conversation ids after part switches', () => {
  const roster = { bots: [{ id: 'bot', sessionId: 'part-2', name: 'Bot' }], rooms: [{ id: 'room', sessionId: 'room-2', name: 'Group' }],
    questions: { 'part-2': { id: 'q1' } } }
  const statuses = new Map([['part-2', { completionUnread: true }], ['part-1', { completionUnread: true }], ['room-2', {}]])
  const rows = notificationRows({ roster, statuses, approvals: [{ id: 'a1', botId: 'bot', roomId: 'room' }] })
  assert.deepEqual(rows.map(row => [row.id, row.sessionId, row.pending]), [['bot', 'part-2', true], ['room', 'room-2', true]])
  const prefs = readNotifyPrefs('{"muted":{"bot":true}}')
  assert.equal(notifyKind({ ...base, before: {}, after: rows[0].status, muted: prefs.muted[rows[0].id] }), undefined)
  assert.equal(notifyKind({ ...base, before: {}, after: rows[1].status, group: true }), 'question')
  assert.equal(badgeOf(rows), 2)
})
