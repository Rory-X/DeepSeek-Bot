// A module's status hook is a display override for its card row, never a mount decision.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createConnectorHost } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'

function hostSetup({ state = { connectors: {} }, definition, secrets = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-row-status-'))
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
    config: {},
    home: dir,
    statePath,
    warn: () => {},
    redactSecrets: text => String(text),
    readOnly: () => undefined,
    save: async () => writeFileSync(statePath, JSON.stringify(state)),
    loadSecrets: async () => {},
    secretValue: name => store[name],
    secretEndpoint: async () => {},
    diagnostics: { record: () => {} },
    botOf: () => undefined,
    roomOf: () => undefined,
    selfOf: () => 'm1',
  }
  Object.assign(rt, createConnectorHost(rt, { demo: definition }))
  return { ctx, rt, dir, registered }
}

async function until(check, label) {
  for (let count = 0; count < 200; count += 1) {
    const value = check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out: ${label}`)
}

const rowOf = rt => rt.connectorsView().find(row => row.id === 'demo')
const stop = ({ ctx, dir }) => {
  ctx.dispose()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}

const channel = (status, overrides = {}) => ({
  displayName: 'Channel',
  mode: 'custom',
  tokenSecret: 'CHANNEL_TOKEN',
  levels: ['read'],
  defaultLevel: 'read',
  mount: () => ({ tools: [{ name: 'channel_ping', description: 'Ping', parameters: { type: 'object', properties: {} }, execute: async () => 'pong' }] }),
  ...(status === undefined ? {} : { status }),
  ...overrides,
})

const ready = () => ({ connectors: { demo: { level: 'read', settings: {} } } })

test('an expired login turns the row into an error without touching the mount', async (t) => {
  const host = hostSetup({
    state: ready(),
    definition: channel(() => ({ state: 'error', error: 'The ClawBot login expired. Scan the QR code again.', lastInboundAt: 7 })),
    secrets: { CHANNEL_TOKEN: 'token' },
  })
  t.after(() => stop(host))
  await until(() => (host.registered.includes('channel_ping') ? true : undefined), 'the mounted tool')
  const row = rowOf(host.rt)
  assert.equal(row.state, 'error')
  assert.match(row.error, /login expired/)
  // The display data still rides along, and the mount is unaffected.
  assert.equal(row.status.lastInboundAt, 7)
  assert.equal(host.registered.includes('channel_ping'), true)
})

test('a protocol error that reports no row state stays in the view only', async (t) => {
  const host = hostSetup({
    state: ready(),
    definition: channel(() => ({ protocolError: 'unexpected frame 0x2f' })),
    secrets: { CHANNEL_TOKEN: 'token' },
  })
  t.after(() => stop(host))
  await until(() => (rowOf(host.rt)?.state === 'ready' ? true : undefined), 'the ready row')
  const row = rowOf(host.rt)
  assert.equal(row.state, 'ready')
  assert.equal(row.error, undefined)
  assert.equal(row.status.protocolError, 'unexpected frame 0x2f')
})

test('a module without a status hook keeps the row exactly as before', async (t) => {
  const host = hostSetup({ state: ready(), definition: channel(undefined), secrets: { CHANNEL_TOKEN: 'token' } })
  t.after(() => stop(host))
  await until(() => (rowOf(host.rt)?.state === 'ready' ? true : undefined), 'the ready row')
  const row = rowOf(host.rt)
  assert.equal(row.state, 'ready')
  assert.equal(row.error, undefined)
  assert.equal(row.status, undefined)
})

test('a status hook that throws hides only its data', async (t) => {
  const host = hostSetup({
    state: ready(),
    definition: channel(() => { throw new Error('status broke') }),
    secrets: { CHANNEL_TOKEN: 'token' },
  })
  t.after(() => stop(host))
  await until(() => (rowOf(host.rt)?.state === 'ready' ? true : undefined), 'the ready row')
  const row = rowOf(host.rt)
  assert.equal(row.state, 'ready')
  assert.equal(row.status, undefined)
})
