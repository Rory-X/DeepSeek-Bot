// A connector whose credentials are all optional can connect with nothing to paste: the
// ClawBot channel logs in later, so Connect clears the off mark and mounts it.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createConnectorHost } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'

function hostSetup({ state, definition }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-optional-connect-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify(state))
  const ctx = fakeContext()
  const secretCalls = []
  const registered = []
  const register = ctx.tools.register
  ctx.tools.register = (tool) => { registered.push(tool.name); return register(tool) }
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
    secretValue: () => undefined,
    secretEndpoint: async (endpoint, body) => { secretCalls.push({ endpoint, ...body }) },
    diagnostics: { record: () => {} },
    botOf: () => undefined,
    roomOf: () => undefined,
    selfOf: () => 'm1',
  }
  Object.assign(rt, createConnectorHost(rt, { demo: definition }))
  return { ctx, rt, dir, secretCalls, registered }
}

const definition = {
  displayName: 'Channel',
  mode: 'custom',
  credentials: [{ name: 'CHANNEL_TOKEN', required: false }],
  levels: ['read'],
  defaultLevel: 'read',
  mount: () => ({ tools: [{ name: 'channel_ping', description: 'Ping', parameters: { type: 'object', properties: {} }, execute: async () => 'pong' }] }),
}

test('a disconnected channel with only optional credentials connects again', async (t) => {
  const host = hostSetup({ state: { connectors: { demo: { level: 'read', settings: {}, off: true } } }, definition })
  t.after(async () => { await host.ctx.dispose(); rmSync(host.dir, { recursive: true, force: true, maxRetries: 5 }) })
  const rows = await host.rt.connectorEndpoint('connector-connect', { id: 'demo' })
  const row = rows.find(entry => entry.id === 'demo')
  assert.equal(row.state, 'ready')
  assert.equal(host.rt.state.connectors.demo.off, undefined)
  assert.equal(host.registered.includes('channel_ping'), true)
  assert.deepEqual(host.secretCalls, [])
  assert.deepEqual(JSON.parse(readFileSync(join(host.dir, 'state.json'), 'utf8')).connectors.demo.off, undefined)
})
