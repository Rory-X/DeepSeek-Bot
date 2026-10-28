// A module's `close` may take a moment (a long poll aborting, a socket draining): an unmount
// and the shutdown/reload cleanup wait for it, within one deadline, and old synchronous
// closes stay as fast as they were.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createConnectorHost } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'

function hostSetup({ close } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-connector-close-'))
  const statePath = join(dir, 'state.json')
  const state = { connectors: { demo: { level: 'read' } } }
  writeFileSync(statePath, JSON.stringify(state))
  const ctx = fakeContext()
  const warns = []
  const store = { DEMO_TOKEN: 'token' }
  const rt = {
    ctx,
    state,
    config: {},
    home: dir,
    statePath,
    warn: (...args) => warns.push(args.map(String).join(' ')),
    redactSecrets: text => String(text),
    readOnly: () => undefined,
    save: async () => writeFileSync(statePath, JSON.stringify(state)),
    load: async () => {},
    loadSecrets: async () => {},
    secretValue: name => store[name],
    secretEndpoint: async () => {},
    diagnostics: { record: () => {} },
    botOf: () => ({ name: 'Chief' }),
    roomOf: () => undefined,
    selfOf: () => 'm1',
  }
  const demo = {
    displayName: 'Demo',
    mode: 'custom',
    levels: ['read', 'write'],
    defaultLevel: 'read',
    credentials: [{ name: 'DEMO_TOKEN', label: 'Token', required: false }],
    mount: () => ({ tools: [], close }),
  }
  Object.assign(rt, createConnectorHost(rt, { demo }))
  return { ctx, rt, dir, warns }
}

async function until(check, label) {
  for (let count = 0; count < 300; count += 1) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out: ${label}`)
}

const rowOf = rt => rt.connectorsView().find(row => row.id === 'demo')
const stop = ({ dir }) => rmSync(dir, { recursive: true, force: true, maxRetries: 5 })

test('a synchronous close is awaited without adding a wait', async (t) => {
  let closed = 0
  const host = hostSetup({ close: () => { closed += 1 } })
  t.after(() => stop(host))
  await until(() => (rowOf(host.rt)?.state === 'ready' ? true : undefined), 'the mount')

  const started = Date.now()
  await host.rt.connectorEndpoint('connector-set-level', { id: 'demo', level: 'write' })
  assert.equal(closed, 1)
  assert.ok(Date.now() - started < 500, 'a synchronous close keeps an unmount immediate')
  assert.deepEqual(host.warns, [])
})

test('an asynchronous close is awaited before the unmount returns', async (t) => {
  let settled = false
  const host = hostSetup({ close: () => new Promise((resolve) => { setTimeout(() => { settled = true; resolve() }, 60) }) })
  t.after(() => stop(host))
  await until(() => (rowOf(host.rt)?.state === 'ready' ? true : undefined), 'the mount')

  await host.rt.connectorEndpoint('connector-set-level', { id: 'demo', level: 'write' })
  assert.equal(settled, true, 'the module finished closing before the endpoint answered')
  assert.deepEqual(host.warns, [])
})

test('a close that rejects is a warning, not a failed shutdown', async (t) => {
  const host = hostSetup({ close: async () => { throw new Error('close failed') } })
  t.after(() => stop(host))
  await until(() => (rowOf(host.rt)?.state === 'ready' ? true : undefined), 'the mount')

  await host.rt.connectorEndpoint('connector-set-level', { id: 'demo', level: 'write' })
  assert.equal(rowOf(host.rt).state, 'ready')
  assert.ok(host.warns.some(line => /demo/.test(line) && /unmount/.test(line) && /close failed/.test(line)))
})

test('a close that never finishes cannot hold the shutdown past the deadline', async (t) => {
  const host = hostSetup({ close: () => new Promise(() => {}) })
  t.after(() => stop(host))
  await until(() => (rowOf(host.rt)?.state === 'ready' ? true : undefined), 'the mount')

  const started = Date.now()
  await host.ctx.dispose()
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 1900, `the host waited about the deadline (${elapsed}ms)`)
  assert.ok(elapsed < 3500, `the host did not wait indefinitely (${elapsed}ms)`)
  assert.ok(host.warns.some(line => /demo/.test(line) && /shutdown/.test(line)))
})
