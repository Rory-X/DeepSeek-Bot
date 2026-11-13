import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const boot = (state = TEAM, config = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-bridge-install-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = route => { ctx.route = route; return register(route) }
  apply(ctx, { home, ...config })
  return { ctx, home }
}
const stateOf = async ctx => {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', headers: {}, body: JSON.stringify({ endpoint: 'state', payload: {} }),
  }))
  return (await response.json()).value
}

test('legacy keeps the old array view while bridge gives the upstream {connectors, mail} shape', async (t) => {
  const state = {
    ...TEAM,
    connectors: {
      neon: { level: 'write', projectId: 'p1', role: 'owner' },
      'neon-2': { level: 'read', projectId: 'p2', projectName: 'Two', role: 'member' },
    },
  }
  const legacy = boot(state)
  t.after(async () => { await legacy.ctx.dispose(); rmSync(legacy.home, { recursive: true, force: true, maxRetries: 5 }) })
  await new Promise(resolve => setTimeout(resolve, 100))
  const oldView = (await stateOf(legacy.ctx)).connectors
  assert.equal(Array.isArray(oldView), true)
  assert.deepEqual(oldView.filter(row => row.id.startsWith('neon')).map(row => row.id), ['neon', 'neon-2'])

  const bridge = boot(state, { connectorFramework: 'bridge' })
  t.after(async () => { await bridge.ctx.dispose(); rmSync(bridge.home, { recursive: true, force: true, maxRetries: 5 }) })
  await new Promise(resolve => setTimeout(resolve, 300))
  const view = (await stateOf(bridge.ctx)).connectors
  assert.equal(Array.isArray(view.connectors), true)
  assert.ok(Array.isArray(view.mail.accounts))
  const neon = view.connectors.filter(row => row.id === 'neon' || row.id === 'neon-2')
  assert.deepEqual(neon.map(row => row.name), ['Neon', 'Two'])
  assert.ok(view.connectors.some(row => row.id === 'telegram'))
  assert.ok(view.connectors.some(row => row.id === 'weread'))
})
