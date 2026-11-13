import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBridgeHost, createEndpointAdapters, neonCatalogOverlay } from '../src/host/connectors-bridge.js'
import { connectorFrameworkOf } from '../src/host/connectors-choice.js'

const view = rows => ({ connectors: rows, mail: { accounts: [], google: false } })

test('the connector framework defaults to legacy and refuses an unknown mode', () => {
  assert.equal(connectorFrameworkOf({}), 'legacy')
  assert.equal(connectorFrameworkOf({ connectorFramework: 'bridge' }), 'bridge')
  assert.throws(() => connectorFrameworkOf({ connectorFramework: 'upstream' }), /Unknown connector framework/)
})

test('the bridge view gives the upstream shape while the legacy host has no upstream', async () => {
  const rt = { mailView: () => ({ accounts: [{ id: 'mail-1' }], google: false }) }
  const legacy = { ids: undefined, view: () => [{ id: 'vercel', name: 'Vercel' }], endpoint: () => 'legacy', approvals: {} }
  const bridge = createBridgeHost(rt, { legacy })
  assert.deepEqual(bridge.connectorsView(), { connectors: [{ id: 'vercel', name: 'Vercel' }], mail: { accounts: [{ id: 'mail-1' }], google: false } })
  assert.equal(await bridge.connectorEndpoint('connector-connect', { id: 'vercel' }), 'legacy')
})

test('a bridge with an upstream host appends only the fork-only rows and routes by id', async () => {
  const rt = { mailView: () => ({ accounts: [], google: false }) }
  const legacy = {
    ids: ['telegram', 'ima', 'weread'],
    view: () => [{ id: 'telegram', name: 'Telegram' }, { id: 'ima', name: 'ima' }],
    endpoint: (...args) => ['legacy', ...args],
    approvals: { answer: () => 'legacy-answer', dismiss: () => 'legacy-dismiss', cancel: () => 'legacy-cancel' },
  }
  const upstream = {
    view: () => view([{ id: 'github', name: 'GitHub' }, { id: 'telegram', name: 'GitHub Telegram?' }]),
    endpoint: (...args) => ['upstream', ...args],
  }
  const bridge = createBridgeHost(rt, { upstream, legacy })
  assert.deepEqual(bridge.connectorsView(), {
    connectors: [{ id: 'github', name: 'GitHub' }, { id: 'telegram', name: 'GitHub Telegram?' }, { id: 'ima', name: 'ima' }],
    mail: { accounts: [], google: false },
  })
  assert.deepEqual(await bridge.connectorEndpoint('connector-set', { id: 'telegram' }), ['legacy', 'connector-set', { id: 'telegram' }, undefined])
  assert.deepEqual(await bridge.connectorEndpoint('connector-set', { id: 'github' }), ['upstream', 'connector-set', { id: 'github' }, undefined])
  assert.deepEqual(await bridge.connectorEndpoint('connector-add', { name: 'x' }), ['upstream', 'connector-add', { name: 'x' }, undefined])
})

test('old endpoints map onto the mail account model and the upstream level switch', async () => {
  const calls = []
  const rt = {
    state: { connectors: { gmail: { level: 'read' }, vercel: { level: 'read' }, neon: { level: 'read' } } },
    save: async () => {},
  }
  const upstream = {
    view: () => view([]),
    endpoint: async (endpoint, body) => { calls.push([endpoint, body]); return view([]) },
  }
  const adapters = createEndpointAdapters({ rt, upstream, aliasHost: { sync: async () => {} } })
  await adapters['connector-connect']('connector-connect', { id: 'gmail', values: { GMAIL_ADDRESS: 'Me@Gmail.com', GMAIL_APP_PASSWORD: 'secret' } })
  assert.deepEqual(calls.at(-1), ['mail-account-add', { address: 'me@gmail.com', password: 'secret' }])
  await adapters['connector-set-level']('connector-set-level', { id: 'vercel', level: 'write' })
  assert.deepEqual(calls.at(-1), ['connector-set', { id: 'vercel', readOnly: false }])
  assert.equal(rt.state.connectors.vercel.level, 'write')
  await adapters['connector-oauth-start']('connector-oauth-start', { id: 'neon', level: 'write' })
  assert.deepEqual(calls.at(-1), ['connector-connect', { id: 'neon' }])
  assert.equal(rt.state.connectors.neon.readOnly, false)
  await adapters['connector-connect']('connector-connect', { id: 'notion' })
  assert.deepEqual(calls.at(-1), ['connector-connect', { id: 'notion' }])
})

test('Neon keeps one catalog overlay entry per saved instance, with its project and role', () => {
  const rows = neonCatalogOverlay({
    connectors: {
      neon: { level: 'write', projectId: 'p1', role: 'owner' },
      'neon-2': { level: 'read', legacy: { projectId: 'p2', projectName: 'Two', role: 'member' } },
      'neon-3': { level: 'read', projectName: 'Three' },
    },
  })
  assert.deepEqual(rows.map(row => row.id), ['neon', 'neon-2', 'neon-3'])
  assert.equal(rows[0].remote.url, 'https://mcp.neon.tech/mcp?projectId=p1&roleName=owner')
  assert.equal(rows[1].name, 'Two')
  assert.equal(rows[1].remote.url, 'https://mcp.neon.tech/mcp?projectId=p2&roleName=member')
  assert.equal(rows[2].name, 'Three')
  assert.equal(rows[2].remote.url, 'https://mcp.neon.tech/mcp')
})

test('a Neon instance set without its base key still gets the base card', () => {
  const rows = neonCatalogOverlay({ connectors: { 'neon-2': { level: 'read' } } })
  assert.deepEqual(rows.map(row => row.id), ['neon', 'neon-2'])
})

test('the bridge view marks a migrated mail account that needs a new login', () => {
  const rt = {
    state: { connectors: { mail: { accounts: { gmail: { id: 'gmail', status: 'needs-reconnect', compat: 'mail-shim' } } } } },
  }
  const legacy = { ids: ['telegram'], view: () => [], endpoint: () => undefined, approvals: {} }
  const upstream = {
    view: () => ({ connectors: [], mail: { accounts: [{ id: 'gmail', address: 'me@gmail.com', state: 'ready' }], google: false } }),
    endpoint: () => undefined,
  }
  const bridge = createBridgeHost(rt, { upstream, legacy })
  assert.deepEqual(bridge.connectorsView().mail.accounts, [{ id: 'gmail', address: 'me@gmail.com', state: 'error', error: 'Sign in again', compat: 'mail-shim' }])
})
