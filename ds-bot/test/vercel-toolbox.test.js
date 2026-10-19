import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BLOCKED_TOOLS, CALL_RESULT_MAX, SEARCH_RESULT_MAX, TOOLBOX_TOOLS,
  buildToolIndex, classifyTool, createCallTool, createSearchTool, searchResultText, searchToolIndex,
} from '../src/host/vercel-toolbox.js'

const output = { schema: { type: 'string' }, render: () => [] }
const tool = (name, { annotations, description = `Vercel ${name}`, properties = {}, required } = {}) => ({
  name,
  description,
  ...(annotations === undefined ? {} : { annotations }),
  inputSchema: { type: 'object', properties, ...(required === undefined ? {} : { required }) },
})
const read = { readOnlyHint: true, destructiveHint: false }
const write = { readOnlyHint: false, destructiveHint: true }

test('tool classification follows annotations, with a safe fallback', () => {
  assert.equal(classifyTool(tool('list_projects', { annotations: read })), 'read')
  assert.equal(classifyTool(tool('create_deployment', { annotations: write })), 'write')
  // A destructive hint wins over a contradictory read hint.
  assert.equal(classifyTool(tool('odd_tool', { annotations: { readOnlyHint: true, destructiveHint: true } })), 'write')
  assert.equal(classifyTool(tool('create_git_project', { annotations: { readOnlyHint: false, destructiveHint: false } })), 'write')
  // Name traps: the annotations decide, not the verb.
  assert.equal(classifyTool(tool('create_observability_query', { annotations: read })), 'read')
  assert.equal(classifyTool(tool('read_session_file', { annotations: write })), 'write')
  // Missing annotations: read verbs only, everything else is a write.
  assert.equal(classifyTool(tool('list_domains')), 'read')
  assert.equal(classifyTool(tool('get_project')), 'read')
  assert.equal(classifyTool(tool('create_project')), 'write')
  assert.equal(classifyTool(tool('deploy_everything')), 'write')
})

test('environment-value and credential tools are blocked', () => {
  for (const name of BLOCKED_TOOLS) assert.equal(classifyTool(tool(name, { annotations: read })), 'blocked', name)
  // Fallback for tools this release does not name.
  assert.equal(classifyTool(tool('get_project_secret', { annotations: read })), 'blocked')
  assert.equal(classifyTool(tool('list_env_vars', { annotations: read })), 'blocked')
  // A write that merely mentions environment variables is still a write, not blocked.
  assert.equal(classifyTool(tool('create_project_env', { annotations: write })), 'write')
})

const INDEX = buildToolIndex([
  tool('list_projects', { annotations: read, properties: { teamId: { type: 'string' } } }),
  tool('create_deployment', { annotations: write, properties: { name: { type: 'string' }, project: { type: 'string' } }, required: ['name', 'project'] }),
  tool('get_runtime_logs', { annotations: read, description: 'Read runtime logs of a deployment', properties: { projectId: { type: 'string' }, teamId: { type: 'string' } }, required: ['projectId', 'teamId'] }),
  tool('get_project_env', { annotations: read }),
  tool('buy_domain', { annotations: write, description: 'Buy a domain for the account' }),
])

test('the index keeps one bounded entry per tool', () => {
  const [entry] = buildToolIndex([tool('list_projects', { annotations: read, description: `  Lots\nof   space ${'x'.repeat(400)}`, properties: { teamId: { type: 'string' }, limit: { type: 'integer' } }, required: ['teamId'] })])
  assert.equal(entry.name, 'list_projects')
  assert.equal(entry.class, 'read')
  assert.equal(entry.description.includes('\n'), false)
  assert.equal(entry.description.length, 240)
  assert.deepEqual(entry.required, ['teamId'])
  assert.deepEqual(entry.params, ['teamId', 'limit'])
  assert.equal(entry.hasTeamId, true)
  assert.deepEqual(entry.types, { teamId: 'string', limit: 'integer' })
})

test('search ranks names over descriptions and leaves blocked tools out', () => {
  const byName = searchToolIndex(INDEX, 'deploy')
  assert.equal(byName.tools[0].name, 'create_deployment')
  assert.ok(byName.tools.every(entry => entry.name !== 'get_project_env'))
  const ranked = searchToolIndex(INDEX, 'project')
  assert.ok(ranked.tools.length >= 1)
  assert.equal(ranked.tools[0].name, 'list_projects')
  // A blocked tool matches the query but is counted, not returned.
  const env = searchToolIndex(INDEX, 'env')
  assert.equal(env.total, 0)
  assert.equal(env.blocked, 1)
  assert.deepEqual(env.tools, [])
  assert.match(searchResultText(env, 'env'), /does not offer them/)
  assert.deepEqual(searchToolIndex(INDEX, 'project', 1).tools.length, 1)
  assert.match(searchResultText(searchToolIndex(INDEX, 'nothing-matches-this'), 'nothing-matches-this'), /No Vercel tool matches/)
})

test('a search answer stays under its byte budget', () => {
  const many = buildToolIndex(Array.from({ length: 40 }, (_, index) => tool(`list_thing_${index}`, { annotations: read, description: `Thing ${index} lists project deployments ${'y'.repeat(200)}` })))
  const result = searchToolIndex(many, 'thing', 20)
  const text = searchResultText(result, 'thing')
  assert.ok(Buffer.byteLength(text, 'utf8') <= SEARCH_RESULT_MAX, `${Buffer.byteLength(text, 'utf8')} bytes`)
  assert.match(text, /^Found 40 tools/)
  assert.match(text, /params: none/)
})

const clientFor = (text = 'ok') => ({
  calls: [],
  async callTool(name, args) {
    this.calls.push([name, args])
    return { content: [{ type: 'text', text }] }
  },
})

test('the search tool answers from its index', async () => {
  const search = createSearchTool({ index: INDEX, output })
  assert.equal(search.name, TOOLBOX_TOOLS[0])
  assert.match(await search.execute({ query: 'deploy' }), /create_deployment \[write: needs approval\]/)
  await assert.rejects(search.execute({ query: '   ' }), /needs a keyword/)
})

test('the call tool runs a read tool and fills in the default team', async () => {
  const client = clientFor('projects')
  const call = createCallTool({ client, index: INDEX, output, teamId: 'team_1' })
  assert.equal(call.name, TOOLBOX_TOOLS[1])
  assert.equal(await call.execute({ tool: 'list_projects', args: {} }), 'projects')
  assert.deepEqual(client.calls, [['list_projects', { teamId: 'team_1' }]])
  await call.execute({ tool: 'get_runtime_logs', args: { projectId: 'p1', teamId: 'team_2' } })
  assert.deepEqual(client.calls.at(-1), ['get_runtime_logs', { projectId: 'p1', teamId: 'team_2' }])
})

test('the call tool refuses unknown, blocked and malformed calls', async () => {
  const client = clientFor()
  const call = createCallTool({ client, index: INDEX, output, teamId: 'team_1' })
  await assert.rejects(call.execute({ tool: 'no_such_tool' }), /No Vercel tool named "no_such_tool"/)
  await assert.rejects(call.execute({ tool: 'get_project_env' }), /environment values or credentials/)
  await assert.rejects(call.execute({ tool: 'list_projects', args: 'nope' }), /must be an object/)
  await assert.rejects(call.execute({ tool: 'create_deployment', args: { name: 'site' } }), /Missing: project/)
  assert.equal(client.calls.length, 0)
  // Without a known default team, a required team id is reported like any other gap.
  const noTeam = createCallTool({ client, index: INDEX, output })
  await assert.rejects(noTeam.execute({ tool: 'get_runtime_logs', args: { projectId: 'p1' } }), /Missing: teamId/)
  assert.equal(client.calls.length, 0)
})

test('argument types are checked before the server sees them', async () => {
  const client = clientFor()
  const call = createCallTool({ client, index: INDEX, output })
  await assert.rejects(call.execute({ tool: 'create_deployment', args: { name: 'site', project: 7 } }), /expects "project" to be string/)
  assert.equal(client.calls.length, 0)
})

test('a long result is cut, a token is redacted, and an error is short', async () => {
  const long = 'z'.repeat(CALL_RESULT_MAX + 500)
  const call = createCallTool({ client: clientFor(long), index: INDEX, output })
  const text = await call.execute({ tool: 'list_projects' })
  assert.equal(text.startsWith('z'.repeat(CALL_RESULT_MAX)), true)
  assert.match(text, /result cut: \d+ characters in all/)

  const secret = 'tok_super_secret'
  const redacted = createCallTool({ client: clientFor(`token ${secret}`), index: INDEX, output, redact: value => value.split(secret).join('[secret:VERCEL_TOKEN]') })
  const answer = await redacted.execute({ tool: 'list_projects' })
  assert.equal(answer, 'token [secret:VERCEL_TOKEN]')

  const failing = { async callTool() { throw new Error(`refused ${secret}`) } }
  const failingCall = createCallTool({ client: failing, index: INDEX, output, redact: value => value.split(secret).join('[secret:VERCEL_TOKEN]') })
  await assert.rejects(failingCall.execute({ tool: 'list_projects' }), error => error.message === 'refused [secret:VERCEL_TOKEN]')
})

test('an error result from the server becomes a tool error', async () => {
  const failing = { async callTool() { return { isError: true, content: [{ type: 'text', text: 'no such project' }] } } }
  const call = createCallTool({ client: failing, index: INDEX, output })
  await assert.rejects(call.execute({ tool: 'list_projects' }), /no such project/)
})
