// A notification connector sends without asking until the user turns that off, and its
// minute is its own: one connector's burst never blocks another's sends.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createConnectorHost } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'

// One notification connector: a token in the credential store and a send this test records.
const notifyConnector = ({ displayName, tokenSecret, toolName, send }) => ({
  displayName,
  mode: 'notify',
  tokenSecret,
  levels: ['write'],
  defaultLevel: 'write',
  needsChatId: false,
  notify: { toolName, send },
})

function hostSetup({ state, connectors, secrets }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-notify-default-'))
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
    botOf: () => ({ name: 'Chief' }),
    roomOf: () => undefined,
    selfOf: () => 'm1',
  }
  const api = createConnectorHost(rt, connectors)
  return { ctx, rt, api, dir, registered }
}

async function until(check, label) {
  for (let count = 0; count < 200; count += 1) {
    const value = check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out: ${label}`)
}

const stop = ({ ctx, dir }) => {
  ctx.dispose()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}

const rowOf = (api, id) => api.connectorsView().find(row => row.id === id)

const oneConnector = (state = {}, sends = []) => hostSetup({
  state: { connectors: { demo: { level: 'write', ...state } } },
  secrets: { DEMO_TOKEN: 'token-1' },
  connectors: {
    demo: notifyConnector({
      displayName: 'Demo',
      tokenSecret: 'DEMO_TOKEN',
      toolName: 'notify_demo',
      send: async ({ text }) => { sends.push(text); return { ok: true } },
    }),
  },
})

test('a send is automatic while the switch is unset, and the card reports that value', async (t) => {
  const sends = []
  const setup = oneConnector({}, sends)
  t.after(() => stop(setup))
  await until(() => (setup.registered.includes('notify_demo') ? true : undefined), 'the notify tool')

  // Unset is the default the user sees: the card shows automatic sends as on.
  assert.equal(rowOf(setup.api, 'demo').autoPush, true)

  // No session and no card: the send goes out once, and one audit entry records it without
  // the message.
  assert.equal(await setup.ctx.registeredTools.get('notify_demo').execute({ text: 'build done' }, {}), 'Sent.')
  assert.deepEqual(sends, ['build done'])
  const audit = setup.rt.state.connectors.demo.audit
  assert.deepEqual(audit.map(entry => [entry.source, entry.result]), [['auto-push', 'sent']])
  assert.ok(!JSON.stringify(audit).includes('build done'))
  assert.deepEqual(setup.rt.state.questions ?? {}, {})
})

test('an explicit autoPush false asks on the card first, and a refusal sends nothing', async (t) => {
  const sends = []
  const setup = oneConnector({ autoPush: false }, sends)
  t.after(() => stop(setup))
  await until(() => (setup.registered.includes('notify_demo') ? true : undefined), 'the notify tool')
  assert.equal(rowOf(setup.api, 'demo').autoPush, false)

  const sending = setup.ctx.registeredTools.get('notify_demo').execute({ text: 'ship it' }, { agent: { id: 'm1' } })
  const card = await until(() => setup.rt.state.questions?.m1, 'the send approval card')
  assert.equal(card.kind, 'connector-approval')
  await setup.api.answerConnectorApproval('m1', card.id, { selected: ['Deny'] })
  await assert.rejects(sending, /denied/)
  assert.deepEqual(sends, [])
})

test('one connector sends at most 20 messages a minute and never blocks another', async (t) => {
  const demoSends = []
  const otherSends = []
  const setup = hostSetup({
    state: { connectors: { demo: { level: 'write' }, other: { level: 'write' } } },
    secrets: { DEMO_TOKEN: 'token-1', OTHER_TOKEN: 'token-2' },
    connectors: {
      demo: notifyConnector({
        displayName: 'Demo',
        tokenSecret: 'DEMO_TOKEN',
        toolName: 'notify_demo',
        send: async ({ text }) => { demoSends.push(text) },
      }),
      other: notifyConnector({
        displayName: 'Other',
        tokenSecret: 'OTHER_TOKEN',
        toolName: 'notify_other',
        send: async ({ text }) => { otherSends.push(text) },
      }),
    },
  })
  t.after(() => stop(setup))
  await until(() => (setup.registered.includes('notify_demo') && setup.registered.includes('notify_other') ? true : undefined), 'both notify tools')

  const demoTool = setup.ctx.registeredTools.get('notify_demo')
  for (let n = 0; n < 20; n += 1) assert.equal(await demoTool.execute({ text: `demo ${n}` }, {}), 'Sent.')
  assert.equal(demoSends.length, 20)

  // The 21st send is refused in words, nothing reaches the service, and the attempt is on
  // the audit trail as a failure without the message.
  await assert.rejects(demoTool.execute({ text: 'demo 20' }, {}), /has sent 20 messages in the last minute/)
  assert.equal(demoSends.length, 20)
  const audit = setup.rt.state.connectors.demo.audit
  assert.deepEqual(audit.filter(entry => entry.result === 'failed').map(entry => entry.source), ['auto-push'])
  assert.ok(!JSON.stringify(audit).includes('demo 20'))

  // Another connector has its own minute.
  assert.equal(await setup.ctx.registeredTools.get('notify_other').execute({ text: 'other 0' }, {}), 'Sent.')
  assert.deepEqual(otherSends, ['other 0'])
})
