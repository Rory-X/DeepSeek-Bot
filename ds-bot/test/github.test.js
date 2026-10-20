import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import github, { ACTION_TOOLS, BLOCKED_TOOLS, READ_TOOLS } from '../src/host/connectors/github.js'
import { fakeContext } from './fake-ctx.js'

const TOKEN = 'ghp_test_token'
const githubTool = (name, properties = {}) => ({ name, description: `GitHub ${name}`, inputSchema: { type: 'object', properties } })
const PUSH_FILES_SCHEMA = { branch: { type: 'string' }, files: { type: 'array' }, message: { type: 'string' }, owner: { type: 'string' }, repo: { type: 'string' } }

// The server's own list for the four toolsets DS Bot asks for (GitHub's official MCP tool
// reference). It carries the sensitive reads and delete_repository, which DS Bot never
// mounts, so the allow-list is proven against the real surface rather than a short one.
const SERVER_TOOLS = [
  'get_me', 'get_teams', 'get_team_members',
  'list_issues', 'issue_read', 'search_issues', 'get_label', 'list_issue_types', 'list_issue_fields',
  'add_issue_comment', 'issue_write', 'sub_issue_write', 'update_issue_comment',
  'list_pull_requests', 'pull_request_read', 'search_pull_requests', 'create_pull_request',
  'merge_pull_request', 'pull_request_review_write', 'update_pull_request', 'update_pull_request_branch',
  'add_comment_to_pending_review', 'add_reply_to_pull_request_comment',
  'get_commit', 'get_file_contents', 'list_branches', 'list_commits', 'list_releases', 'get_latest_release',
  'get_release_by_tag', 'get_tag', 'list_tags', 'list_repository_collaborators', 'search_code',
  'search_commits', 'search_repositories', 'create_branch', 'create_or_update_file', 'create_repository',
  'delete_file', 'delete_repository', 'fork_repository', 'push_files', 'ui_get',
]

// One fetch for both the REST account check and the MCP endpoint, recording every call.
function githubBench({ callResult } = {}) {
  const mcp = []
  const answer = (id, result, headers = {}) => ({
    status: 200,
    ok: true,
    headers: { get: name => headers[String(name).toLowerCase()] ?? 'application/json' },
    text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }),
  })
  const empty = () => ({ status: 202, ok: true, headers: { get: () => null }, text: async () => '' })
  const fetch = async (url, init = {}) => {
    const address = String(url)
    if (address === 'https://gh.test/user') return { status: 200, ok: true, json: async () => ({ login: 'octo' }) }
    if (address !== 'https://mcp.github.test/') throw new Error(`unexpected fetch ${address}`)
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') return answer(body.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'GitHub', version: '1' } }, { 'mcp-session-id': 'session-1' })
    if (body.method === 'notifications/initialized') return empty()
    if (body.method === 'tools/list') return answer(body.id, { tools: SERVER_TOOLS.map(name => githubTool(name, name === 'push_files' ? PUSH_FILES_SCHEMA : {})) })
    if (body.method === 'tools/call') {
      mcp.push({ name: body.params.name, args: body.params.arguments })
      if (callResult !== undefined) return answer(body.id, callResult)
      return answer(body.id, { content: [{ type: 'text', text: `called ${body.params.name}` }] })
    }
    throw new Error(`unexpected method ${body.method}`)
  }
  return { fetch, calls: mcp, count: name => mcp.filter(entry => name === undefined || entry.name === name).length }
}

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

const teamHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-github-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  return home
}

// github is a module now; the profile names another address for the bench, which is the
// same override mechanism a deployment uses.
function setup({ config = {}, state = TEAM, secrets = [], locked = false } = {}) {
  const home = teamHome(state)
  if (secrets.length > 0) {
    writeFileSync(join(home, 'secrets.json'), JSON.stringify({ version: 1, secrets: secrets.map(entry => ({ name: entry.name, value: entry.value, purpose: entry.purpose ?? '', scope: entry.scope ?? 'all' })) }))
  }
  // A live holder on the same host makes this host read-only, as a second dsh would.
  if (locked) writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 1, host: hostname(), token: 'another-dsh' }))
  const registered = []
  const disposed = []
  const ctx = fakeContext()
  const register = ctx.tools.register
  ctx.tools.register = (tool) => {
    registered.push(tool.name)
    const undo = register(tool)
    // The fake context's undo is a no-op; a real one takes the tool out of the surface.
    return () => { disposed.push(tool.name); ctx.registeredTools.delete(tool.name); undo() }
  }
  const route = ctx.connection.fetch.register
  ctx.connection.fetch.register = (handled) => { ctx.route = handled; return route(handled) }
  apply(ctx, { home, github: { url: 'https://mcp.github.test/', api: 'https://gh.test' }, ...config })
  registered.length = 0
  disposed.length = 0
  return { ctx, home, registered, disposed }
}

async function call(ctx, endpoint, payload) {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}
async function until(check, label) {
  for (let index = 0; index < 300; index += 1) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out: ${label}`)
}
const card = async (ctx) => (await call(ctx, 'state', {})).value.questions.m1
const answer = (ctx, questionId, selected) => call(ctx, 'answer-question', { sessionId: 'm1', questionId, answer: { selected } })
const rowOf = async (ctx) => (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'github')

const connect = async (ctx) => {
  const connected = await call(ctx, 'connector-connect', { id: 'github', token: TOKEN })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  return until(async () => (ctx.registeredTools.has('github_get_me') ? true : undefined), 'the read mount')
}
const toWrite = async (ctx) => {
  assert.equal((await call(ctx, 'connector-set-level', { id: 'github', level: 'write' })).ok, true)
  return until(async () => (ctx.registeredTools.has('github_add_issue_comment') ? true : undefined), 'the write mount')
}

test('GitHub connects at read level and mounts only the 23 read tools', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = githubBench().fetch
  const { ctx, home, registered } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await connect(ctx)
  const row = await rowOf(ctx)
  assert.deepEqual([row.state, row.level, row.levels, row.account], ['ready', 'read', ['read', 'write'], 'octo'])
  assert.deepEqual([...registered].filter(name => name.startsWith('github_')).sort(), READ_TOOLS.map(name => `github_${name}`).sort())
  // No write tool and no blocked name is registered at read level.
  for (const name of ACTION_TOOLS) assert.equal(registered.includes(`github_${name}`), false, name)
  for (const name of BLOCKED_TOOLS) assert.equal(registered.includes(`github_${name}`), false, name)
  // The card carries the display lists, and the sensitive reads are not among them.
  assert.equal(row.capabilities.length, 7)
  assert.match(row.permissions.summary, /every write asks/i)
  assert.equal(registered.includes('github_get_team_members'), false)
  assert.equal(registered.includes('github_list_repository_collaborators'), false)
})

test('the write level mounts all 17 write tools, and read again removes them', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = githubBench().fetch
  const { ctx, home, registered } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await connect(ctx)
  await toWrite(ctx)
  const mounted = () => [...ctx.registeredTools.keys()].filter(name => name.startsWith('github_')).sort()
  assert.deepEqual(mounted(), [...READ_TOOLS, ...ACTION_TOOLS].map(name => `github_${name}`).sort())
  await call(ctx, 'connector-set-level', { id: 'github', level: 'read' })
  await until(async () => (ctx.registeredTools.has('github_add_issue_comment') ? undefined : true), 'the write unmount')
  assert.equal(ctx.registeredTools.has('github_create_branch'), false)
  assert.equal((await rowOf(ctx)).level, 'read')
  assert.ok(registered.includes('github_add_issue_comment'))
})

test('an approved write asks with its target and runs once', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = githubBench()
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await connect(ctx)
  await toWrite(ctx)
  const args = { owner: 'octo', repo: 'demo', issue_number: 12, body: 'shh-do-not-show' }
  const pending = ctx.registeredTools.get('github_add_issue_comment').execute(args, { agent: { id: 'm1' } })
  const shown = await until(() => card(ctx), 'the approval card')
  assert.match(shown.question, /GitHub's add_issue_comment/)
  assert.deepEqual([shown.target, shown.change, shown.reversible], ['octo/demo#12', 'adds a comment', true])
  assert.ok(shown.detail.length <= 200 && shown.detail.includes('octo/demo#12'))
  assert.equal(bench.count(), 0)
  await answer(ctx, shown.id, ['Allow once'])
  assert.equal(await pending, 'called add_issue_comment')
  assert.equal(bench.count('add_issue_comment'), 1)
  // The arguments stay out of the diagnostics log.
  assert.equal((await call(ctx, 'diagnostics-log')).value.includes('shh-do-not-show'), false)
})

test('deny, dismiss, timeout and cancel leave the write unrun', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = githubBench()
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup({ config: { connectorApprovalTimeoutMs: 80 } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connect(ctx)
  await toWrite(ctx)
  const run = (name, args = { owner: 'octo', repo: 'demo', issue_number: 1, body: 'x' }, init) => ctx.registeredTools.get(`github_${name}`).execute(args, { agent: { id: 'm1' }, ...init })

  const denied = run('add_issue_comment')
  await answer(ctx, (await until(() => card(ctx), 'deny card')).id, ['Deny'])
  await assert.rejects(denied, /denied GitHub's add_issue_comment/)

  const dismissed = run('update_issue_comment', { owner: 'octo', repo: 'demo', comment_id: 3, body: 'x' })
  await call(ctx, 'dismiss-question', { sessionId: 'm1' })
  await assert.rejects(dismissed, /denied GitHub's update_issue_comment/)

  const timedOut = run('create_branch', { owner: 'octo', repo: 'demo', branch: 'topic' })
  await until(() => card(ctx), 'timeout card')
  await assert.rejects(timedOut, /did not answer in time/)

  const controller = new AbortController()
  const cancelled = run('fork_repository', { owner: 'octo', repo: 'demo' }, { signal: controller.signal })
  await until(() => card(ctx), 'cancel card')
  controller.abort()
  await assert.rejects(cancelled, /cancelled/)
  assert.equal(bench.count(), 0)
})

test('the irreversible rows say what changes and where it could be undone', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = githubBench()
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connect(ctx)
  await toWrite(ctx)
  const showCard = async (name, args) => {
    const pending = ctx.registeredTools.get(`github_${name}`).execute(args, { agent: { id: 'm1' } })
    const shown = await until(() => card(ctx), name)
    return { pending, shown, done: async () => { await answer(ctx, shown.id, ['Deny']); await assert.rejects(pending) } }
  }

  const merge = await showCard('merge_pull_request', { owner: 'octo', repo: 'demo', pullNumber: 7, base: 'main' })
  assert.deepEqual([merge.shown.reversible, merge.shown.danger], [false, true])
  assert.match(merge.shown.change, /cannot be undone/)
  assert.equal(merge.shown.target, 'octo/demo#7')
  await merge.done()

  const removal = await showCard('delete_file', { owner: 'octo', repo: 'demo', path: 'src/app.js', branch: 'main' })
  assert.deepEqual([removal.shown.reversible, removal.shown.danger], [true, true])
  assert.match(removal.shown.change, /commit history keeps the old content/)
  assert.ok(removal.shown.detail.includes('src/app.js'))
  await removal.done()

  const branch = await showCard('create_branch', { owner: 'octo', repo: 'demo', branch: 'topic' })
  assert.deepEqual([branch.shown.reversible, branch.shown.danger], [false, undefined])
  assert.match(branch.shown.change, /only GitHub web can delete it/)
  await branch.done()

  const created = await showCard('issue_write', { owner: 'octo', repo: 'demo', method: 'create', title: 'Bug' })
  assert.deepEqual([created.shown.reversible, created.shown.target], [false, 'octo/demo'])
  await created.done()

  const deletePending = await showCard('pull_request_review_write', { owner: 'octo', repo: 'demo', pullNumber: 7, method: 'delete_pending' })
  assert.deepEqual([deletePending.shown.reversible, deletePending.shown.danger], [false, undefined])
  assert.equal(deletePending.shown.target, 'octo/demo#7 (delete_pending)')
  assert.match(deletePending.shown.change, /deletes the pending review/)
  await deletePending.done()

  const subIssue = await showCard('sub_issue_write', { owner: 'octo', repo: 'demo', issue_number: 5, sub_issue_id: 99, method: 'remove' })
  assert.equal(subIssue.shown.target, 'octo/demo#5 + sub-issue 99')
  assert.ok(subIssue.shown.detail.includes('sub-issue 99'))
  await subIssue.done()
})

test('per-method rows name the action and the object', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = githubBench().fetch
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connect(ctx)
  await toWrite(ctx)
  const shown = async (name, args) => {
    const pending = ctx.registeredTools.get(`github_${name}`).execute(args, { agent: { id: 'm1' } })
    const shown = await until(() => card(ctx), name)
    await answer(ctx, shown.id, ['Deny'])
    await assert.rejects(pending)
    return shown
  }
  const closed = await shown('issue_write', { owner: 'octo', repo: 'demo', issue_number: 5, method: 'update', state: 'closed' })
  assert.deepEqual([closed.target, closed.reversible], ['octo/demo#5', true])
  assert.match(closed.detail, /Close issue/)
  const pushed = await shown('push_files', { owner: 'octo', repo: 'demo', branch: 'topic', files: [{ path: 'a' }, { path: 'b' }], message: 'x' })
  assert.ok(pushed.detail.includes('2 files') && pushed.detail.includes('topic'))
  assert.deepEqual([pushed.reversible, pushed.danger], [true, true])
})

test('push_files exposes no force parameter and blocked tools are absent from the mount', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = githubBench().fetch
  const { ctx, home, registered } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connect(ctx)
  await toWrite(ctx)
  const push = ctx.registeredTools.get('github_push_files')
  assert.equal(Object.hasOwn(push.parameters.properties, 'force'), false)
  assert.deepEqual(Object.keys(push.parameters.properties).sort(), ['branch', 'files', 'message', 'owner', 'repo'])
  for (const name of BLOCKED_TOOLS) {
    assert.equal(registered.includes(`github_${name}`), false, name)
    assert.equal(ctx.registeredTools.has(`github_${name}`), false, name)
  }
  assert.equal(BLOCKED_TOOLS.length, 10)
  // No blocked name hides inside a declared list.
  for (const name of BLOCKED_TOOLS) {
    assert.equal(READ_TOOLS.includes(name) || ACTION_TOOLS.includes(name), false, name)
  }
})

test('every blocked name is denied before it runs, without a card or a request', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = githubBench()
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const gate = ctx.listeners.get('tools/pre-execute').at(-1)
  let passed = 0
  const next = () => { passed += 1; return Promise.resolve({ kind: 'allow' }) }
  for (const name of BLOCKED_TOOLS) {
    for (const called of [name, `github_${name}`]) {
      const denied = await gate({ name: called, arguments: {} }, next)
      assert.equal(denied.kind, 'deny', called)
      assert.match(denied.reason, /does not run/)
    }
  }
  assert.equal(passed, 0)
  assert.equal(await card(ctx), undefined)
  assert.equal(bench.count(), 0)
  // A name that is not blocked still reaches the tool.
  assert.deepEqual(await gate({ name: 'github_get_me', arguments: {} }, next), { kind: 'allow' })
  assert.equal(passed, 1)
})

test('the declared lists stay inside the server list, and the read ones skip sensitive names', () => {
  for (const name of [...READ_TOOLS, ...ACTION_TOOLS]) assert.ok(SERVER_TOOLS.includes(name), name)
  assert.equal(READ_TOOLS.length, 23)
  assert.equal(ACTION_TOOLS.length, 17)
  assert.equal(READ_TOOLS.includes('get_team_members'), false)
  assert.equal(READ_TOOLS.includes('list_repository_collaborators'), false)
  assert.equal(ACTION_TOOLS.includes('delete_repository'), false)
  assert.equal(github.blockedTools.length, 10)
  assert.deepEqual(github.levels, ['read', 'write'])
  assert.equal(github.defaultLevel, 'read')
})

test('a write the server refuses reports the service error and changes nothing', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bench = githubBench({ callResult: { content: [{ type: 'text', text: 'no pending review' }], isError: true } })
  globalThis.fetch = bench.fetch
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await connect(ctx)
  await toWrite(ctx)
  const pending = ctx.registeredTools.get('github_pull_request_review_write').execute(
    { owner: 'octo', repo: 'demo', pullNumber: 7, method: 'delete_pending' },
    { agent: { id: 'm1' } },
  )
  await answer(ctx, (await until(() => card(ctx), 'the approval card')).id, ['Allow once'])
  await assert.rejects(pending, /no pending review/)
  assert.equal(bench.count('pull_request_review_write'), 1)
})

test('a read-only host keeps GitHub at read level and refuses writes', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = githubBench().fetch
  const saved = { ...TEAM, connectors: { github: { login: 'octo', level: 'write', connectedAt: 1 } } }
  const { ctx, home } = setup({ state: saved, secrets: [{ name: 'GITHUB_TOKEN', value: TOKEN }], locked: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => (ctx.registeredTools.has('github_get_me') ? true : undefined), 'the read mount')
  assert.equal((await rowOf(ctx)).level, 'read')
  assert.equal(ctx.registeredTools.has('github_add_issue_comment'), false)
  const raised = await call(ctx, 'connector-set-level', { id: 'github', level: 'write' })
  assert.equal(raised.ok, false)
  assert.match(raised.error.message, /another dsh/i)
  assert.equal(ctx.registeredTools.has('github_add_issue_comment'), false)
})
