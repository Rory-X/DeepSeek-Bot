import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAliasHost } from '../src/host/connectors-alias.js'

const tool = (name, extra = {}) => ({ name, description: `run ${name}`, inputSchema: { type: 'object', properties: {} }, ...extra })

function runtime({ state, secrets = {} }) {
  const registered = new Map()
  const rt = {
    state,
    secretValue: name => secrets[name],
    loadSecrets: async () => {},
    save: async () => {},
    readOnly: () => undefined,
    warn: () => {},
    redactSecrets: text => String(text),
    ctx: {
      tools: {
        register(definition) {
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
      },
    },
  }
  return { rt, registered }
}

function fakeClient(id, tools, calls) {
  return {
    listTools: async () => tools,
    callTool: async (name, args) => {
      calls.push([id, name, args])
      return { content: [{ type: 'text', text: `${id}:${name}` }] }
    },
    close: () => {},
  }
}

test('write aliases keep the old GitHub names and ask before reaching the gateway', async () => {
  const { rt, registered } = runtime({
    state: { connectors: { github: { level: 'write' } } },
    secrets: { GITHUB_TOKEN: 'old-token' },
  })
  const calls = []
  const asked = []
  let outcome = 'deny'
  const alias = createAliasHost(rt, {
    makeClient: async id => fakeClient(id, [tool('get_me'), tool('merge_pull_request')], calls),
    approval: { approve: async request => { asked.push(request); return outcome } },
  })
  await alias.sync({ force: true })
  assert.deepEqual([...registered.keys()].sort(), ['github_get_me', 'github_merge_pull_request'])
  assert.equal(await registered.get('github_get_me').execute({}, { agent: { id: 'm1' } }), 'github:get_me')
  assert.equal(asked.length, 0)
  await assert.rejects(registered.get('github_merge_pull_request').execute({ owner: 'o', repo: 'r', pullNumber: 4 }, { agent: { id: 'm1' } }), /denied/)
  assert.equal(calls.length, 1)
  assert.equal(asked[0].connector, 'GitHub')
  assert.equal(asked[0].tool, 'github_merge_pull_request')
  assert.equal(asked[0].sessionId, 'm1')
  outcome = 'allow'
  assert.equal(await registered.get('github_merge_pull_request').execute({ owner: 'o', repo: 'r', pullNumber: 4 }, { agent: { id: 'm1' } }), 'github:merge_pull_request')
  assert.deepEqual(calls.at(-1), ['github', 'merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 4 }])
  await alias.dispose()
  assert.equal(registered.size, 0)
})

test('Neon instances mount their own alias names and only expose writes at the write level', async () => {
  const { rt, registered } = runtime({
    state: {
      connectors: {
        neon: { level: 'read', legacy: { projectId: 'p1', role: 'owner' } },
        'neon-2': { level: 'write', legacy: { projectId: 'p2', role: 'member' } },
      },
    },
    secrets: { CONNECTOR_NEON_TOKEN: 'n1', CONNECTOR_NEON_2_TOKEN: 'n2' },
  })
  const tools = [tool('list_projects'), tool('delete_branch'), tool('run_sql')]
  const alias = createAliasHost(rt, {
    makeClient: async id => fakeClient(id, tools, []),
    approval: { approve: async () => 'allow' },
  })
  await alias.sync({ force: true })
  assert.ok(registered.has('neon_list_projects'))
  assert.ok(registered.has('neon-2_list_projects'))
  assert.equal(registered.has('neon_delete_branch'), false)
  assert.ok(registered.has('neon-2_delete_branch'))
  assert.ok(registered.has('neon-2_run_sql'))
  await alias.dispose()
})

test('Vercel keeps its toolbox at the write level and its named actions when the toolbox is off', async () => {
  const tools = [tool('list_projects', { annotations: { readOnlyHint: true } }), tool('create_deployment', { annotations: { destructiveHint: true } })]
  const { rt, registered } = runtime({ state: { connectors: { vercel: { level: 'write' } } }, secrets: { CONNECTOR_VERCEL_TOKEN: 'v' } })
  const alias = createAliasHost(rt, { makeClient: async id => fakeClient(id, tools, []), approval: { approve: async () => 'allow' } })
  await alias.sync({ force: true })
  assert.ok(registered.has('vercel_search_tools'))
  assert.ok(registered.has('vercel_call'))
  assert.equal(registered.has('vercel_create_deployment'), false)
  await alias.dispose()

  const second = runtime({ state: { connectors: { vercel: { level: 'write', toolbox: false, actions: true } } }, secrets: { CONNECTOR_VERCEL_TOKEN: 'v' } })
  const named = createAliasHost(second.rt, { makeClient: async id => fakeClient(id, tools, []), approval: { approve: async () => 'allow' } })
  await named.sync({ force: true })
  assert.ok(second.registered.has('vercel_create_deployment'))
  assert.equal(second.registered.has('vercel_call'), false)
  await named.dispose()
})

test('the mail shim mounts the old Gmail names at the migrated account level', async () => {
  const { rt, registered } = runtime({
    state: {
      connectors: {
        gmail: { level: 'read' },
        mail: { accounts: { gmail: { id: 'gmail', address: 'me@gmail.com', provider: 'gmail', status: 'ready', compat: 'mail-shim', legacyLevel: 'write' } } },
      },
    },
    secrets: { MAIL_ME_GMAIL_COM_PASSWORD: 'app-password' },
  })
  const specs = []
  const alias = createAliasHost(rt, {
    makeClient: async id => fakeClient(id, [], []),
    createShim: (spec) => {
      specs.push(spec)
      return { tools: [{ name: 'gmail_search' }, { name: 'gmail_send_email' }], close: () => {} }
    },
    approval: { approve: async () => 'allow' },
  })
  await alias.sync({ force: true })
  assert.equal(specs.length, 1)
  assert.equal(specs[0].provider, 'gmail')
  assert.equal(specs[0].level, 'write')
  assert.deepEqual(specs[0].secrets, { GMAIL_ADDRESS: 'me@gmail.com', GMAIL_APP_PASSWORD: 'app-password' })
  assert.deepEqual([...registered.keys()].sort(), ['gmail_search', 'gmail_send_email'])
  await alias.dispose()
})

test('a resync at the same level keeps the mounted set and dispose removes every alias', async () => {
  const { rt, registered } = runtime({ state: { connectors: { github: { level: 'read' } } }, secrets: { GITHUB_TOKEN: 't' } })
  const alias = createAliasHost(rt, { makeClient: async id => fakeClient(id, [tool('get_me')], []), approval: { approve: async () => 'allow' } })
  await alias.sync({ force: true })
  const first = registered.get('github_get_me')
  await alias.sync()
  assert.equal(registered.get('github_get_me'), first)
  await alias.dispose()
  assert.equal(registered.size, 0)
  // The old state and secrets are untouched by mounting and unmounting aliases.
  assert.deepEqual(rt.state.connectors.github, { level: 'read' })
})
