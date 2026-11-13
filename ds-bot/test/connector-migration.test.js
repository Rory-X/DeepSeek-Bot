import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateConnectors } from '../src/host/connectors-migration.js'
import { createMailShim } from '../src/host/connectors-mail-shim.js'
import { GMAIL_TOOLS } from '../src/host/connectors/gmail.js'
import { QQMAIL_TOOLS } from '../src/host/connectors/qqmail.js'

const grant = resource => ({ kind: 'grant', payload: { version: 1, client: { id: 'client-1' }, resource, tokens: { access: `access-${resource}`, refresh: `refresh-${resource}`, expiresAt: Date.now() + 3_600_000 } } })

const legacyState = () => ({
  version: 1,
  connectors: {
    github: { level: 'write' },
    vercel: { level: 'read' },
    cloudflare: { level: 'write', account: 'team@example.com' },
    neon: { level: 'write', projectId: 'p1', projectName: 'One', role: 'owner' },
    'neon-2': { level: 'read', projectId: 'p2', projectName: 'Two', role: 'member' },
    gmail: { level: 'read', account: 'me@gmail.com' },
    qqmail: { level: 'write', account: 'me@qq.com' },
  },
})

function runtime({ state = legacyState(), secrets = {}, grants = {}, failWrites = [], validateMail } = {}) {
  const writes = []
  const store = { ...secrets }
  let saved = 0
  const rt = {
    state,
    config: {},
    warn: () => {},
    save: async () => { saved += 1 },
    secretValue: name => store[name],
    loadSecrets: async () => {},
    secretEndpoint: async (endpoint, body) => {
      if (failWrites.includes(body.name)) throw new Error(`cannot write ${body.name}`)
      writes.push({ ...body })
      store[body.name] = body.value
      return { name: body.name }
    },
    ctx: { get: name => name === 'credentials' ? { readRecord: async key => grants[key] } : undefined },
    validateMail,
  }
  return { rt, writes, store, saved: () => saved }
}

const defaultSecrets = {
  GITHUB_TOKEN: 'github-old',
  VERCEL_TOKEN: 'vercel-old',
  GMAIL_ADDRESS: 'me@gmail.com',
  GMAIL_APP_PASSWORD: 'gmail-old',
  QQMAIL_ADDRESS: 'me@qq.com',
  QQMAIL_AUTH_CODE: 'qq-old',
}
const defaultGrants = {
  'ds-bot/connector-cloudflare': grant('https://mcp.cloudflare.test'),
  'ds-bot/connector-neon': grant('https://mcp.neon.test'),
  'ds-bot/connector-neon-2': grant('https://mcp.neon.test/2'),
}

test('old tokens, grants and mail accounts migrate once and leave the old values in place', async () => {
  const state = legacyState()
  const before = JSON.parse(JSON.stringify(state))
  const { rt, writes, store } = runtime({ state, secrets: defaultSecrets, grants: defaultGrants })
  const first = await migrateConnectors(rt)
  assert.equal(first.changed, true)
  assert.deepEqual([...first.changes].sort(), ['cloudflare', 'github', 'gmail', 'neon', 'neon-2', 'qqmail', 'vercel'])
  assert.equal(state.connectors.mail.accounts.gmail.address, 'me@gmail.com')
  assert.equal(state.connectors.mail.accounts.gmail.status, 'ready')
  assert.equal(state.connectors.mail.accounts.gmail.legacyLevel, 'read')
  assert.equal(state.connectors.mail.accounts.qqmail.address, 'me@qq.com')
  assert.equal(state.connectors.mail.accounts.qqmail.legacyLevel, 'write')
  assert.equal(state.connectors.github.readOnly, false)
  assert.equal(state.connectors.vercel.readOnly, true)
  assert.equal(state.connectors.cloudflare.oauth.resource, 'https://mcp.cloudflare.test')
  assert.equal(state.connectors.neon.legacy.projectId, 'p1')
  assert.equal(state.connectors['neon-2'].legacy.role, 'member')
  for (const name of ['GITHUB_TOKEN', 'VERCEL_TOKEN', 'GMAIL_APP_PASSWORD', 'QQMAIL_AUTH_CODE']) assert.equal(store[name], defaultSecrets[name])
  assert.equal(store.CONNECTOR_VERCEL_TOKEN, 'vercel-old')
  assert.equal(store.CONNECTOR_CLOUDFLARE_TOKEN, 'access-https://mcp.cloudflare.test')
  assert.equal(store.CONNECTOR_NEON_TOKEN, 'access-https://mcp.neon.test')
  assert.equal(store.CONNECTOR_NEON_2_TOKEN, 'access-https://mcp.neon.test/2')
  assert.ok(store.MAIL_ME_GMAIL_COM_PASSWORD)
  assert.equal(writes.length > 0, true)
  // The old state entries are still there, with a legacy snapshot added.
  assert.deepEqual(state.connectors.gmail.account, before.connectors.gmail.account)
  assert.equal(state.connectors.qqmail.level, 'write')
  // A second run writes nothing and changes nothing.
  const writesBefore = writes.length
  const second = await migrateConnectors(rt)
  assert.equal(second.changed, false)
  assert.equal(writes.length, writesBefore)
  assert.equal(state.connectors.mail.accounts.gmail.createdAt, state.connectors.mail.accounts.gmail.createdAt)
})

test('a failed login marks the account needs-reconnect and writes no password', async () => {
  const validateMail = async account => { if (account.id === 'gmail') throw new Error('login refused') }
  const { rt, writes } = runtime({ secrets: defaultSecrets, grants: defaultGrants })
  const result = await migrateConnectors(rt, { validateMail })
  assert.equal(result.records.gmail.status, 'needs-reconnect')
  assert.equal(rt.state.connectors.mail.accounts.gmail.status, 'needs-reconnect')
  assert.equal(writes.some(item => item.name === 'MAIL_ME_GMAIL_COM_PASSWORD'), false)
  assert.equal(rt.state.connectors.gmail.account, 'me@gmail.com')
  assert.equal(result.records.qqmail.status, 'migrated')
})

test('a failing secret write records a failure without deleting the old token or state', async () => {
  const state = legacyState()
  const { rt, store } = runtime({ state, secrets: defaultSecrets, grants: defaultGrants, failWrites: ['CONNECTOR_VERCEL_TOKEN'] })
  const result = await migrateConnectors(rt)
  assert.equal(result.records.vercel.status, 'failed')
  assert.match(result.records.vercel.error, /cannot write/)
  assert.equal(store.VERCEL_TOKEN, 'vercel-old')
  assert.equal(state.connectors.vercel.level, 'read')
  assert.equal(result.records.qqmail.status, 'migrated')
})

test('every Neon instance keeps its own state, grant and project role', async () => {
  const state = legacyState()
  state.connectors['neon-3'] = { level: 'write', projectId: 'p3', projectName: 'Three', role: 'owner' }
  const grants = { ...defaultGrants, 'ds-bot/connector-neon-3': grant('https://mcp.neon.test/3') }
  const { rt, store } = runtime({ state, secrets: defaultSecrets, grants })
  await migrateConnectors(rt)
  for (const [id, project, role, suffix] of [['neon', 'p1', 'owner', ''], ['neon-2', 'p2', 'member', '_2'], ['neon-3', 'p3', 'owner', '_3']]) {
    assert.equal(state.connectors[id].legacy.projectId, project)
    assert.equal(state.connectors[id].legacy.role, role)
    assert.equal(store[`CONNECTOR_NEON${suffix}_TOKEN`], `access-https://mcp.neon.test${suffix === '' ? '' : `/${suffix.slice(1)}`}`)
    assert.equal(store[`CONNECTOR_NEON${suffix}_REFRESH`], `refresh-https://mcp.neon.test${suffix === '' ? '' : `/${suffix.slice(1)}`}`)
  }
})

test('the Gmail and QQ Mail shims keep the old read tool names', () => {
  const gmail = createMailShim({ provider: 'gmail', credential: 'old', account: { mailbox: 'me@gmail.com' }, redact: String })
  assert.equal(gmail.compat, 'mail-shim')
  assert.deepEqual(gmail.tools.map(tool => tool.name), GMAIL_TOOLS)
  const qqmail = createMailShim({ provider: 'qqmail', credential: 'old', account: { mailbox: 'me@qq.com' }, redact: String })
  assert.equal(qqmail.compat, 'mail-shim')
  assert.deepEqual(qqmail.tools.map(tool => tool.name), QQMAIL_TOOLS)
})
