import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BLOCKED_TOOL_PATTERNS,
  buildCloudflareToolIndex,
  classifyCloudflareTool,
  CLOUDFLARE_TOOLBOX_TOOLS,
  createCloudflareCallTool,
  createCloudflareSearchTool,
  isBlockedCloudflareTool,
  searchCloudflareIndex,
  searchCloudflareResultText,
} from '../src/host/cloudflare-toolbox.js'

const tool = (name, properties = {}, required) => ({
  name,
  description: `Cloudflare ${name}`,
  inputSchema: { type: 'object', properties, ...(required === undefined ? {} : { required }) },
})

const listed = [
  tool('get_zones', { page: { type: 'integer' } }),
  tool('get_zones_by_zone_id', { zone_id: { type: 'string' } }, ['zone_id']),
  tool('get_zones_dns_records', { zone_id: { type: 'string' }, account_id: { type: 'string' } }, ['zone_id']),
  tool('post_zones_dns_records', { zone_id: { type: 'string' }, body: { type: 'object' } }, ['zone_id', 'body']),
  tool('patch_zones_dns_records_by_dns_record_id', { zone_id: { type: 'string' }, dns_record_id: { type: 'string' } }),
  tool('delete_zones_by_zone_id', { zone_id: { type: 'string' } }),
  tool('get_accounts_workers_scripts', { account_id: { type: 'string' } }),
  tool('whoami'),
  tool('docs'),
  // Never offered.
  tool('post_user_tokens', {}),
  tool('get_accounts_tokens', {}),
  tool('get_accounts_workers_scripts_secrets', {}),
  tool('get_accounts_secrets_store', {}),
  tool('get_accounts_members', {}),
  tool('delete_accounts_sso_connectors_by_sso_connector_id', {}),
  tool('get_certificates', {}),
  tool('post_accounts_mtls_certificates', {}),
  tool('get_user_tokens_by_token_id_value', {}),
]

test('Cloudflare tools are classified by HTTP method, and credentials never enter', () => {
  assert.equal(classifyCloudflareTool({ name: 'get_zones' }), 'read')
  assert.equal(classifyCloudflareTool({ name: 'head_zones' }), 'read')
  assert.equal(classifyCloudflareTool({ name: 'post_zones_dns_records' }), 'write')
  assert.equal(classifyCloudflareTool({ name: 'put_zones_dns_records_by_dns_record_id' }), 'write')
  assert.equal(classifyCloudflareTool({ name: 'patch_zones_dns_records_by_dns_record_id' }), 'write')
  assert.equal(classifyCloudflareTool({ name: 'delete_zones_by_zone_id' }), 'write')
  assert.equal(classifyCloudflareTool({ name: 'whoami' }), 'read')
  assert.equal(classifyCloudflareTool({ name: 'docs' }), 'read')
  // A tool this code does not recognize asks rather than running.
  assert.equal(classifyCloudflareTool({ name: 'execute' }), 'write')
})

test('the blocked list covers token, secret, key, member and certificate families', () => {
  for (const name of ['post_user_tokens', 'get_user_tokens_by_token_id_value', 'post_accounts_tokens', 'get_accounts_tokens_permission_groups']) {
    assert.equal(isBlockedCloudflareTool(name), true, name)
  }
  for (const name of ['get_accounts_workers_scripts_secrets', 'get_accounts_workers_dispatch_namespaces_scripts_secrets_by_secret_name', 'get_accounts_secrets_store_stores_by_store_id_secrets']) {
    assert.equal(isBlockedCloudflareTool(name), true, name)
  }
  for (const name of ['get_accounts_members', 'delete_accounts_members_by_member_id', 'get_memberships', 'get_accounts_sso_connectors']) {
    assert.equal(isBlockedCloudflareTool(name), true, name)
  }
  for (const name of ['get_certificates', 'delete_certificates_by_certificate_id', 'post_accounts_mtls_certificates', 'get_zones_client_certificates']) {
    assert.equal(isBlockedCloudflareTool(name), true, name)
  }
  for (const name of ['get_accounts_access_keys', 'post_accounts_images_v1_keys', 'get_accounts_stream_keys', 'post_accounts_calls_turn_keys']) {
    assert.equal(isBlockedCloudflareTool(name), true, name)
  }
  // Ordinary reads and writes stay offered.
  for (const name of ['get_zones', 'post_zones_dns_records', 'get_accounts_workers_scripts', 'get_zones_dns_records']) {
    assert.equal(isBlockedCloudflareTool(name), false, name)
  }
  assert.ok(BLOCKED_TOOL_PATTERNS.length > 10)
})

test('the index keeps the method classes and leaves every blocked tool out', () => {
  const index = buildCloudflareToolIndex(listed)
  const names = index.map(entry => entry.name)
  assert.deepEqual(names, ['get_zones', 'get_zones_by_zone_id', 'get_zones_dns_records', 'post_zones_dns_records', 'patch_zones_dns_records_by_dns_record_id', 'delete_zones_by_zone_id', 'get_accounts_workers_scripts', 'whoami', 'docs'])
  const dns = index.find(entry => entry.name === 'get_zones_dns_records')
  assert.equal(dns.class, 'read')
  assert.deepEqual(dns.required, ['zone_id'])
  assert.deepEqual(dns.types, { zone_id: 'string', account_id: 'string' })
  assert.equal(dns.hasAccountId, true)
  assert.equal(index.find(entry => entry.name === 'get_zones').hasAccountId, false)
  assert.equal(index.find(entry => entry.name === 'post_zones_dns_records').class, 'write')
})

test('search ranks names over descriptions, respects the limit and never shows blocked tools', () => {
  const index = buildCloudflareToolIndex(listed)
  assert.deepEqual(searchCloudflareIndex(index, 'dns', 3).map(entry => entry.name), ['get_zones_dns_records', 'patch_zones_dns_records_by_dns_record_id', 'post_zones_dns_records'])
  assert.equal(searchCloudflareIndex(index, 'dns', 20).length, 3)
  assert.equal(searchCloudflareIndex(index, 'tokens').length, 0)
  assert.equal(searchCloudflareIndex(index, 'secrets').length, 0)
  assert.match(searchCloudflareResultText(index, 'dns'), /Found 3 Cloudflare tools/)
  assert.match(searchCloudflareResultText(index, 'dns'), /\[write: needs approval\]/)
  assert.match(searchCloudflareResultText(index, 'dns'), /\[read\]/)
  assert.match(searchCloudflareResultText(index, 'tokens'), /No Cloudflare tool matches/)
  assert.match(searchCloudflareResultText(index, ''), /Give a keyword/)
})

test('a long search answer stays inside its byte budget', () => {
  const many = Array.from({ length: 40 }, (_, index) => tool(`get_zone_widgets_${index}`, Object.fromEntries(Array.from({ length: 12 }, (_, slot) => [`param${slot}`, { type: 'string' }]))))
  const index = buildCloudflareToolIndex(many)
  const text = searchCloudflareResultText(index, 'widgets', 20)
  assert.ok(Buffer.byteLength(text) <= 2_000, `${Buffer.byteLength(text)} bytes`)
  assert.match(text, /cloudflare_call/)
})

const callTool = ({ client, index, approve, accountId }) => createCloudflareCallTool({ client, index, approve, accountId })

test('a read target runs directly and a write asks before it runs', async () => {
  const calls = []
  const client = { callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: `result of ${name}` }] } } }
  const index = buildCloudflareToolIndex(listed)
  const approvals = []
  const run = callTool({ client, index, approve: async target => { approvals.push(target) } })
  assert.equal(await run.execute({ tool: 'get_zones' }, { agent: { id: 'm1' } }), 'result of get_zones')
  assert.deepEqual(approvals, [])
  assert.equal(await run.execute({ tool: 'post_zones_dns_records', args: { zone_id: 'z1', body: {} } }, { agent: { id: 'm1' } }), 'result of post_zones_dns_records')
  assert.deepEqual(approvals, ['post_zones_dns_records'])
  // A refusal from the card stops the call before the MCP client sees it.
  const refusing = callTool({ client, index, approve: async () => { throw new Error('The user denied it') } })
  await assert.rejects(refusing.execute({ tool: 'delete_zones_by_zone_id', args: { zone_id: 'z1' } }, { agent: { id: 'm1' } }), /denied/)
  assert.equal(calls.length, 2)
})

test('blocked, unknown and malformed calls never reach the server', async () => {
  const calls = []
  const client = { callTool: async (name) => { calls.push(name); return { content: [{ type: 'text', text: 'x' }] } } }
  const index = buildCloudflareToolIndex(listed)
  const run = callTool({ client, index })
  await assert.rejects(run.execute({ tool: 'post_user_tokens' }, { agent: { id: 'm1' } }), /does not run it/)
  await assert.rejects(run.execute({ tool: 'nope' }, { agent: { id: 'm1' } }), /No Cloudflare tool named/)
  await assert.rejects(run.execute({ tool: 'get_zones', args: 'x' }, { agent: { id: 'm1' } }), /must be an object/)
  await assert.rejects(run.execute({ tool: 'get_zones_dns_records' }, { agent: { id: 'm1' } }), /needs: zone_id/)
  await assert.rejects(run.execute({ tool: 'get_zones', args: { page: 'one' } }, { agent: { id: 'm1' } }), /expects "page" to be integer/)
  assert.equal(calls.length, 0)
})

test('the connected account answers account-scoped calls unless an argument wins', async () => {
  const calls = []
  const client = { callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: 'ok' }] } } }
  const index = buildCloudflareToolIndex(listed)
  const accountId = '0123456789abcdef0123456789abcdef'
  const run = callTool({ client, index, accountId })
  await run.execute({ tool: 'get_zones_dns_records', args: { zone_id: 'z1' } }, { agent: { id: 'm1' } })
  assert.deepEqual(calls.at(-1).args, { zone_id: 'z1', account_id: accountId })
  await run.execute({ tool: 'get_zones_dns_records', args: { zone_id: 'z1', account_id: 'other' } }, { agent: { id: 'm1' } })
  assert.deepEqual(calls.at(-1).args, { zone_id: 'z1', account_id: 'other' })
  // A tool without the parameter never gets one.
  await run.execute({ tool: 'get_zones' }, { agent: { id: 'm1' } })
  assert.deepEqual(calls.at(-1).args, {})
})

test('results are redacted and cut at 20,000 characters', async () => {
  const long = `secret tok_1234567890 ${'x'.repeat(30_000)}`
  const client = { callTool: async () => ({ content: [{ type: 'text', text: long }] }) }
  const index = buildCloudflareToolIndex(listed)
  const run = createCloudflareCallTool({ client, index, redact: text => text.replace(/tok_1234567890/g, '[secret]') })
  const text = await run.execute({ tool: 'get_zones' }, { agent: { id: 'm1' } })
  assert.ok(!text.includes('tok_1234567890'))
  assert.match(text, /\[secret\]/)
  assert.match(text, /result cut: \d+ characters in all/)
  assert.ok(text.length <= 20_000 + 200, `${text.length} characters`)
})

test('the search tool takes its own limit and clamps it', async () => {
  const index = buildCloudflareToolIndex(listed)
  const search = createCloudflareSearchTool({ index })
  assert.equal(search.name, CLOUDFLARE_TOOLBOX_TOOLS[0])
  assert.match(await search.execute({ query: 'dns' }), /Found 3 Cloudflare tools/)
  assert.match(await search.execute({ query: 'dns', limit: 1 }), /showing 1/)
  assert.match(await search.execute({ query: 'dns', limit: 99 }), /showing 3/)
})
