// A command marked concurrent does its own waiting and stays out of the change queue;
// every other command keeps the queue's one-at-a-time order.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createConnectorHost } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function hostSetup({ definitions, state }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-concurrent-command-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify(state))
  const ctx = fakeContext()
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
    secretEndpoint: async () => {},
    diagnostics: { record: () => {} },
    botOf: () => undefined,
    roomOf: () => undefined,
    selfOf: () => 'm1',
  }
  Object.assign(rt, createConnectorHost(rt, definitions))
  return { ctx, rt, dir }
}

async function until(check, label) {
  for (let count = 0; count < 200; count += 1) {
    if (check()) return
    await pause(10)
  }
  throw new Error(`timed out: ${label}`)
}

const stop = ({ ctx, dir }) => {
  ctx.dispose()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}

const channel = ({ commands, command }) => ({
  displayName: 'Channel',
  mode: 'custom',
  credentials: [{ name: 'CHANNEL_TOKEN', required: false }],
  levels: ['read'],
  defaultLevel: 'read',
  commands,
  command,
  mount: () => ({ tools: [] }),
})

test('a concurrent command does not hold the change queue', async (t) => {
  const slow = channel({
    commands: { poll: { concurrent: true, args: [] } },
    command: async () => { await pause(300) },
  })
  const fast = channel({ commands: { noop: { args: [] } }, command: async () => {} })
  const host = hostSetup({
    definitions: { slow, fast },
    state: { connectors: { slow: { level: 'read', settings: {} }, fast: { level: 'read', settings: {} } } },
  })
  t.after(() => stop(host))
  await until(() => (host.rt.connectorsView().every(row => row.state === 'ready') ? true : undefined), 'both connectors mounted')

  const started = Date.now()
  const slowRun = host.rt.connectorEndpoint('connector-command', { id: 'slow', action: 'poll' })
  await pause(20)
  const fastStarted = Date.now()
  await host.rt.connectorEndpoint('connector-command', { id: 'fast', action: 'noop' })
  const fastElapsed = Date.now() - fastStarted
  assert.ok(fastElapsed < 100, `the fast command took ${fastElapsed}ms`)
  await slowRun
  assert.ok(Date.now() - started >= 290, 'the slow command still waited its own time')
})

test('a command without concurrent still runs through the queue, one at a time', async (t) => {
  const steps = []
  const queued = channel({
    commands: { work: { args: [] } },
    command: async () => {
      steps.push('start')
      await pause(60)
      steps.push('end')
    },
  })
  const host = hostSetup({ definitions: { queued }, state: { connectors: { queued: { level: 'read', settings: {} } } } })
  t.after(() => stop(host))
  await until(() => (host.rt.connectorsView()[0]?.state === 'ready' ? true : undefined), 'the connector mounted')

  await Promise.all([
    host.rt.connectorEndpoint('connector-command', { id: 'queued', action: 'work' }),
    host.rt.connectorEndpoint('connector-command', { id: 'queued', action: 'work' }),
  ])
  assert.deepEqual(steps, ['start', 'end', 'start', 'end'])
})
