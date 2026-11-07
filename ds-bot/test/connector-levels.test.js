// Messaging connectors hide the level choice: they only send, so they declare one write
// level and a team file that still stores `read` must not lose their send tool.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createConnectorHost } from '../src/host/connectors.js'
import gmail from '../src/host/connectors/gmail.js'
import telegram from '../src/host/connectors/telegram.js'
import { fakeContext } from './fake-ctx.js'

function hostSetup({ state = { connectors: {} }, definitions = {}, secrets = {}, config = {}, readOnly = () => undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-levels-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify(state))
  const ctx = fakeContext()
  const registered = []
  const register = ctx.tools.register
  ctx.tools.register = (tool) => { registered.push(tool.name); return register(tool) }
  const store = { ...secrets }
  const rt = {
    ctx,
    state,
    config,
    home: dir,
    statePath,
    warn: () => {},
    redactSecrets: text => String(text),
    readOnly,
    save: async () => writeFileSync(statePath, JSON.stringify(state)),
    loadSecrets: async () => {},
    secretValue: name => store[name],
    secretEndpoint: async (endpoint, body) => {
      if (typeof body?.name !== 'string') return
      if (endpoint === 'secret-set') store[body.name] = body.value
      if (endpoint === 'secret-delete') delete store[body.name]
    },
    diagnostics: { record: () => {} },
    botOf: id => (id === 'm1' ? { id: 'm1', name: 'Chief' } : undefined),
    roomOf: () => undefined,
    selfOf: () => 'm1',
  }
  Object.assign(rt, createConnectorHost(rt, definitions))
  return { ctx, rt, dir, registered, store }
}

async function until(check, label) {
  for (let count = 0; count < 200; count += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out: ${label}`)
}

const rowOf = (rt, id) => rt.connectorsView().find(row => row.id === id)
const stop = ({ ctx, dir }) => {
  ctx.dispose()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}

const writeTool = name => ({ name, description: 'Send', parameters: { type: 'object', properties: {} }, execute: async () => 'sent' })
const writeOnly = (overrides = {}) => ({
  displayName: 'Pager',
  mode: 'custom',
  tokenSecret: 'PAGER_TOKEN',
  levels: ['write'],
  defaultLevel: 'write',
  mount: ({ level }) => ({ tools: level === 'write' ? [writeTool('pager_send')] : [] }),
  ...overrides,
})
const twoLevels = (overrides = {}) => ({
  displayName: 'Two',
  mode: 'custom',
  tokenSecret: 'TWO_TOKEN',
  levels: ['read', 'write'],
  defaultLevel: 'read',
  mount: () => ({ tools: [] }),
  ...overrides,
})

test('a stored read level runs at write when the connector only declares write', async (t) => {
  const host = hostSetup({
    state: { connectors: { demo: { level: 'read', settings: {} } } },
    definitions: { demo: writeOnly() },
    secrets: { PAGER_TOKEN: 'token' },
  })
  t.after(() => stop(host))
  await until(() => host.registered.includes('pager_send'), 'the send tool')
  const row = rowOf(host.rt, 'demo')
  assert.equal(row.level, 'write')
  assert.deepEqual(row.levels, ['write'])
  // The old team file is left alone: only the resolution is write.
  assert.equal(host.rt.state.connectors.demo.level, 'read')
  assert.deepEqual(JSON.parse(readFileSync(join(host.dir, 'state.json'), 'utf8')).connectors.demo.level, 'read')
})

test('a read-only host keeps its rule even for a write-only connector', async (t) => {
  const host = hostSetup({
    state: { connectors: { demo: { level: 'read', settings: {} } } },
    definitions: { demo: writeOnly() },
    secrets: { PAGER_TOKEN: 'token' },
    readOnly: () => 'this DS Bot is read-only',
  })
  t.after(() => stop(host))
  assert.equal(rowOf(host.rt, 'demo').level, 'read')
  assert.equal(host.registered.includes('pager_send'), false)
})

test('a messaging connector declares one write level and hides the level choice', async (t) => {
  assert.deepEqual(telegram.levels, ['write'])
  assert.equal(telegram.defaultLevel, 'write')
  assert.equal(telegram.card.levelChoice, false)

  const telegramHost = hostSetup({
    state: { connectors: { telegram: { level: 'read', settings: {}, chatId: '123' } } },
    definitions: { telegram },
    secrets: { TELEGRAM_BOT_TOKEN: 'token' },
  })
  t.after(() => stop(telegramHost))
  await until(() => telegramHost.registered.includes('notify_telegram'), 'the Telegram send tool')
  const telegramRow = rowOf(telegramHost.rt, 'telegram')
  assert.equal(telegramRow.level, 'write')
  assert.deepEqual(telegramRow.levels, ['write'])
  assert.equal(telegramRow.card.levelChoice, false)

  // Any write-only module draws the same row: one level, named write, and no read choice.
  const pagerHost = hostSetup({
    state: { connectors: { pager: { level: 'read', settings: {} } } },
    definitions: { pager: writeOnly({ card: { levelChoice: false } }) },
    secrets: { PAGER_TOKEN: 'token' },
  })
  t.after(() => stop(pagerHost))
  await until(() => pagerHost.registered.includes('pager_send'), 'the Pager send tool')
  const pagerRow = rowOf(pagerHost.rt, 'pager')
  assert.equal(pagerRow.level, 'write')
  assert.deepEqual(pagerRow.levels, ['write'])
  assert.equal(pagerRow.card.levelChoice, false)
  assert.equal(JSON.stringify(pagerRow.levels).includes('"read"'), false)
})

test('other connectors keep their levels and stored value', async (t) => {
  const readHost = hostSetup({
    state: { connectors: { demo: { level: 'read', settings: {} } } },
    definitions: { demo: twoLevels() },
    secrets: { TWO_TOKEN: 'token' },
  })
  t.after(() => stop(readHost))
  assert.equal(rowOf(readHost.rt, 'demo').level, 'read')
  assert.deepEqual(rowOf(readHost.rt, 'demo').levels, ['read', 'write'])

  const writeHost = hostSetup({
    state: { connectors: { demo: { level: 'write', settings: {} } } },
    definitions: { demo: twoLevels() },
    secrets: { TWO_TOKEN: 'token' },
  })
  t.after(() => stop(writeHost))
  assert.equal(rowOf(writeHost.rt, 'demo').level, 'write')

  // A connector that keeps both levels is untouched: it still starts and stays at read.
  assert.deepEqual(gmail.levels, ['read', 'write'])
  assert.equal(gmail.defaultLevel, 'read')
  const gmailHost = hostSetup({
    state: { connectors: { gmail: { level: 'read', settings: {} } } },
    definitions: { gmail },
    secrets: {},
  })
  t.after(() => stop(gmailHost))
  assert.equal(rowOf(gmailHost.rt, 'gmail').level, 'read')
  assert.equal(rowOf(gmailHost.rt, 'gmail').card?.levelChoice, undefined)
})
