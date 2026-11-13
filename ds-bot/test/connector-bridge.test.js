import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBridgeHost } from '../src/host/connectors-bridge.js'
import { connectorFrameworkOf } from '../src/host/connectors-choice.js'

test('the connector framework defaults to legacy and refuses an unknown mode', () => {
  assert.equal(connectorFrameworkOf({}), 'legacy')
  assert.equal(connectorFrameworkOf({ connectorFramework: 'bridge' }), 'bridge')
  assert.throws(() => connectorFrameworkOf({ connectorFramework: 'upstream' }), /Unknown connector framework/)
})

test('the bridge view gives the upstream shape while the legacy host has no upstream', () => {
  const rt = { mailView: () => ({ accounts: [{ id: 'mail-1' }], google: false }) }
  const legacy = { ids: undefined, view: () => [{ id: 'vercel', name: 'Vercel' }], endpoint: () => 'legacy', approvals: {} }
  const bridge = createBridgeHost(rt, { legacy })
  assert.deepEqual(bridge.connectorsView(), { connectors: [{ id: 'vercel', name: 'Vercel' }], mail: { accounts: [{ id: 'mail-1' }], google: false } })
  assert.equal(bridge.connectorEndpoint('connector-connect', { id: 'vercel' }), 'legacy')
})

test('a bridge with an upstream host appends only the fork-only rows and routes by id', () => {
  const rt = { mailView: () => ({ accounts: [], google: false }) }
  const legacy = {
    ids: ['telegram', 'ima', 'weread'],
    view: () => [{ id: 'telegram', name: 'Telegram' }, { id: 'ima', name: 'ima' }],
    endpoint: (...args) => ['legacy', ...args],
    approvals: { answer: () => 'legacy-answer', dismiss: () => 'legacy-dismiss', cancel: () => 'legacy-cancel' },
  }
  const upstream = {
    view: () => ({ connectors: [{ id: 'github', name: 'GitHub' }, { id: 'telegram', name: 'GitHub Telegram?' }], mail: { accounts: [{ id: 'mail-1' }], google: true } }),
    endpoint: (...args) => ['upstream', ...args],
  }
  const bridge = createBridgeHost(rt, { upstream, legacy })
  assert.deepEqual(bridge.connectorsView(), {
    connectors: [{ id: 'github', name: 'GitHub' }, { id: 'telegram', name: 'GitHub Telegram?' }, { id: 'ima', name: 'ima' }],
    mail: { accounts: [{ id: 'mail-1' }], google: true },
  })
  assert.deepEqual(bridge.connectorEndpoint('connector-set', { id: 'telegram' }), ['legacy', 'connector-set', { id: 'telegram' }, undefined])
  assert.deepEqual(bridge.connectorEndpoint('connector-set', { id: 'github' }), ['upstream', 'connector-set', { id: 'github' }, undefined])
  assert.deepEqual(bridge.connectorEndpoint('connector-add', { name: 'x' }), ['upstream', 'connector-add', { name: 'x' }, undefined])
})
