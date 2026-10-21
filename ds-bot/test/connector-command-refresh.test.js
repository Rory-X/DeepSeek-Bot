// A connector command may write a credential; the mount must see it right after the command,
// while a command that changes nothing must not remount the connector.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createConnectorHost } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'

function hostSetup({ definition, state = { connectors: { demo: { level: 'read', settings: {} } } }, secrets = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-command-refresh-'))
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
    secretEndpoint: async (endpoint, body) => {
      if (typeof body?.name !== 'string') return
      if (endpoint === 'secret-set') store[body.name] = body.value
      if (endpoint === 'secret-delete') delete store[body.name]
    },
    diagnostics: { record: () => {} },
    botOf: () => undefined,
    roomOf: () => undefined,
    selfOf: () => 'm1',
  }
  Object.assign(rt, createConnectorHost(rt, { demo: definition }))
  return { ctx, rt, dir, registered, store }
}

async function until(check, label) {
  for (let count = 0; count < 200; count += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out: ${label}`)
}

const stop = ({ ctx, dir }) => {
  ctx.dispose()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}

const definition = (mounts, command) => ({
  displayName: 'Channel',
  mode: 'custom',
  credentials: [{ name: 'DEMO_TOKEN', required: false }],
  levels: ['read'],
  defaultLevel: 'read',
  commands: { 'login-save': { args: [] }, noop: { args: [] } },
  command,
  mount: (context) => {
    mounts.push({ token: context.secrets?.DEMO_TOKEN, secretName: context.secretName?.('DEMO_TOKEN') })
    return { tools: [{ name: 'channel_ping', description: 'Ping', parameters: { type: 'object', properties: {} }, execute: async () => 'pong' }] }
  },
})

test('a command that writes a credential makes the mount see it', async (t) => {
  const mounts = []
  const host = hostSetup({
    definition: definition(mounts, async context => {
      await context.rt.secretEndpoint('secret-set', { name: context.secretName('DEMO_TOKEN'), value: 'token-1' })
    }),
  })
  t.after(() => stop(host))
  await until(() => mounts.length === 1, 'the first mount')
  assert.equal(mounts[0].token, undefined)

  const rows = await host.rt.connectorEndpoint('connector-command', { id: 'demo', action: 'login-save' })
  assert.equal(rows.find(row => row.id === 'demo').state, 'ready')
  await until(() => mounts.length === 2, 'the remount after the credential was written')
  assert.equal(mounts[1].token, 'token-1')
  assert.equal(mounts[1].secretName, 'DEMO_TOKEN')
  assert.equal(host.store.DEMO_TOKEN, 'token-1')
})

test('a command that changes no credential does not remount', async (t) => {
  const mounts = []
  const host = hostSetup({ definition: definition(mounts, async () => {}) })
  t.after(() => stop(host))
  await until(() => mounts.length === 1, 'the first mount')
  await host.rt.connectorEndpoint('connector-command', { id: 'demo', action: 'noop' })
  assert.equal(mounts.length, 1)
  assert.equal(host.rt.connectorsView().find(row => row.id === 'demo').state, 'ready')
})
