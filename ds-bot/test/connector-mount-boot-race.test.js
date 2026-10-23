// The connector host mounts only after the team file loaded: a cold start on a large team
// still mounts the channels that team describes, and a secrets file that cannot be read
// never leaves a connector waiting for a sync it will not get.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TOKEN = 'ilink-token-for-the-boot-race-test'
const bot = (id, name) => ({ id, sessionId: id, name, role: 'Bot', instructions: '', createdAt: 1 })

const team = ({ exchanges = [] } = {}) => ({
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: bot('m1', 'Chief'), b1: bot('b1', 'Writer') },
  rooms: {},
  exchanges,
  exchangeTurns: {},
  questions: {},
  connectors: { wechat: { level: 'write', settings: { botId: 'b1', transport: 'clawbot' } } },
  channels: { wechat: { ilink: { epoch: 11, ilinkUserId: 'wx-user-1' } } },
})

const secretsFile = { version: 1, secrets: [{ name: 'WECHAT_ILINK_TOKEN', value: TOKEN, purpose: '', scope: 'all', createdAt: 1, updatedAt: 1 }] }

// A host whose team file is written before it starts, the way a restart finds one. `secrets`
// is either the file's body or `'unreadable'` for a path that exists but cannot be read.
function setup({ state, secrets = secretsFile }) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-boot-race-'))
  const text = JSON.stringify(state)
  writeFileSync(join(home, 'state.json'), text)
  if (secrets === 'unreadable') mkdirSync(join(home, 'secrets.json'))
  else writeFileSync(join(home, 'secrets.json'), JSON.stringify(secrets), { mode: 0o600 })
  const ctx = fakeContext()
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return '' }, async json() { return {} } })
  const rt = createRuntime(ctx, { home, wechat: { listenPort: 0 } })
  return { ctx, rt, home, bytes: text.length, restore: () => { globalThis.fetch = realFetch } }
}

async function until(check, label) {
  for (let count = 0; count < 300; count += 1) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out: ${label}`)
}

const stop = async ({ ctx, home, restore }) => {
  await ctx.dispose()
  restore()
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
}

const wechatRow = rt => rt.connectorsView().find(row => row.id === 'wechat')

test('a cold start on a large team still mounts the channel it describes', async (t) => {
  // A team file of ~1.5 MB: loading and parsing it takes longer than the secrets read, which
  // is exactly the window that used to leave the existing channel off.
  const exchanges = Array.from({ length: 5000 }, (_, n) => ({ from: 'b1', to: 'm1', at: n, kind: 'message', text: 'line '.repeat(60), turn: `t${n}` }))
  const host = setup({ state: team({ exchanges }) })
  t.after(() => stop(host))
  assert.ok(host.bytes >= 1_500_000, `the team file is ${host.bytes} bytes`)

  await until(() => (host.ctx.registeredTools.has('wechat_notify') ? true : undefined), 'the mounted notify tool')
  assert.equal(wechatRow(host.rt).state, 'ready')
  assert.equal(host.rt.state.channels.wechat.ilink.epoch, 12)
})

test('a secrets file that cannot be read leaves the channel mounted, and it mounts once the file is back', async (t) => {
  const host = setup({ state: team(), secrets: 'unreadable' })
  t.after(() => stop(host))

  // The team file still drives the mount: the channel is ready (no Bot is missing), and only
  // the token half waits for the credential store.
  await until(() => (wechatRow(host.rt).state === 'ready' ? true : undefined), 'the channel mounted without its secrets')
  assert.equal(host.rt.state.channels.wechat.ilink.epoch, 12)
  assert.equal(host.ctx.registeredTools.has('wechat_notify'), false)

  // The credential store recovers: the next load remounts with the token and its tool.
  rmSync(join(host.home, 'secrets.json'), { recursive: true, force: true })
  writeFileSync(join(host.home, 'secrets.json'), JSON.stringify(secretsFile), { mode: 0o600 })
  await host.rt.loadSecrets()
  await until(() => (host.ctx.registeredTools.has('wechat_notify') ? true : undefined), 'the notify tool after the secrets file is readable again')
  assert.equal(wechatRow(host.rt).state, 'ready')
  assert.equal(host.rt.state.channels.wechat.ilink.epoch, 13)

  // A file that goes bad again does not touch the mount it never provided: no remount, no
  // tool loss, while the reads keep failing.
  rmSync(join(host.home, 'secrets.json'), { recursive: true, force: true })
  mkdirSync(join(host.home, 'secrets.json'))
  await host.rt.loadSecrets()
  await host.rt.loadSecrets()
  assert.equal(host.ctx.registeredTools.has('wechat_notify'), true)
  assert.equal(host.rt.state.channels.wechat.ilink.epoch, 13)
})
