import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDraft, emptyBoard } from '../src/host/board.js'
import { workflowChange } from '../src/host/board-workflow.js'
import { BOARD_TOOLS, boardToolGuard, install } from '../src/host/board-bots.js'
import { fakeContext } from './fake-ctx.js'
import { install as installGroups } from '../src/host/groups.js'

const projects = [{ id: 'p', path: '/project' }]
const bots = { lead: { id: 'lead' }, dev: { id: 'dev' }, outsider: { id: 'outsider' } }
const draft = () => createDraft(emptyBoard(), { projectId: 'p', requestId: 'r', title: 'Filter projects', description: 'Filter the list', acceptance: 'Projects are isolated\nEmpty results work', leadId: 'lead', collaboratorIds: ['dev'] }, { projects, bots, id: 'card' }).board
const plan = {
  summary: 'Filter by project, then independently verify.', steps: [
    { id: 'build', title: 'Build', phase: 'implementation', assigneeId: 'dev', scope: 'filter.js', dependsOn: [] },
    { id: 'verify', title: 'Verify', phase: 'validation', assigneeId: 'lead', scope: 'Read and test filter.js', dependsOn: ['build'] },
  ],
}
const change = (board, command, actor = 'user', args = {}) => workflowChange(board, command, { id: 'card', version: board.cards.card.version, ...args }, { actor, bots, projects })
const start = () => change(draft(), 'board-start').board
const proposed = () => change(start(), 'board-plan', 'lead', plan).board
const decide = (board, choice = 'approve', answer = '') => {
  const decision = board.cards.card.decisions.findLast(item => item.status === 'open')
  return change(board, 'board-decide', 'user', { decisionId: decision.id, decisionVersion: decision.version, choice, answer })
}
const approved = () => { const board = decide(proposed()).board; board.cards.card.steps[0].status = 'running'; return board }
const completed = () => {
  const built = change(approved(), 'board-step', 'dev', { stepId: 'build', status: 'done', summary: 'Built', evidence: 'filter.js' }).board
  built.cards.card.steps[1].status = 'running'
  return change(built, 'board-step', 'lead', { stepId: 'verify', status: 'done', summary: 'Passed', evidence: '2 assertions passed' }).board
}
const submission = { summary: 'Ready', evidence: [0, 1].map(() => ({ result: 'passed', detail: 'Assertion passed', reference: 'test report' })), artifacts: [{ title: 'Filter', summary: 'Project filter', reference: '/project/filter.js' }] }

test('only user start dispatches the lead, and draft content/project/member changes fail closed', () => {
  const before = draft()
  assert.equal(before.cards.card.deliveries, undefined)
  assert.throws(() => change(before, 'board-start', 'lead'), /Only the user/)
  const result = change(before, 'board-start')
  assert.equal(result.card.stage, 'clarification')
  assert.equal(result.effects.length, 1)
  assert.equal(result.effects[0].botId, 'lead')
  assert.throws(() => workflowChange(before, 'board-start', { id: 'card', version: 1 }, { bots, projects: [] }), /project moved/)
  assert.throws(() => change(result.board, 'board-start'), /already started/)
})

test('only lead plans; design approval is a hard gate and tools cannot bypass it', () => {
  assert.throws(() => change(start(), 'board-plan', 'dev', plan), /Only the lead/)
  const board = proposed()
  assert.equal(board.cards.card.deliveries.length, 1)
  assert.match(boardToolGuard(board.cards.card, 'dev', 'bash'), /read-only/)
  assert.match(boardToolGuard(board.cards.card, 'dev', 'read_and_modify'), /read-only/)
  assert.equal(boardToolGuard(board.cards.card, 'dev', 'read'), undefined)
  assert.throws(() => change(board, 'board-step', 'dev', { stepId: 'build', status: 'done', summary: 'done', evidence: 'x' }), /not approved/)
  assert.throws(() => change(board, 'board-decide', 'lead', {}), /Only the user/)
  const result = decide(board)
  assert.equal(result.card.stage, 'implementation')
  assert.deepEqual(result.effects.map(job => job.stepId), ['build'])
  assert.match(boardToolGuard(result.card, 'dev', 'bash'), /dispatched/)
  result.card.steps[0].status = 'running'
  assert.equal(boardToolGuard(result.card, 'dev', 'bash'), undefined)
  assert.match(boardToolGuard(result.card, 'lead', 'bash'), /read-only/)
  assert.match(boardToolGuard(result.card, 'dev', 'message_bot'), /Keep requirement work/)
})

test('plans reject cycles, wrong members, and review without independence', () => {
  assert.throws(() => change(start(), 'board-plan', 'lead', { ...plan, steps: plan.steps.map(step => ({ ...step, assigneeId: 'dev' })) }), /independent/)
  assert.throws(() => change(start(), 'board-plan', 'lead', { ...plan, steps: plan.steps.map(step => ({ ...step, assigneeId: 'outsider' })) }), /member/)
  assert.throws(() => change(start(), 'board-plan', 'lead', { ...plan, steps: [{ ...plan.steps[0], dependsOn: ['verify'] }, plan.steps[1]] }), /cannot depend/)
  assert.throws(() => change(start(), 'board-plan', 'lead', { ...plan, steps: [plan.steps[0], { ...plan.steps[0] }] }), /unique/)
})

test('coordinator staffing is scoped, versioned and does not dispatch collaborators', () => {
  const board = start()
  const input = { collaboratorIds: ['lead', 'outsider', 'outsider'], summary: 'Outsider implements, the coordinator independently verifies.' }
  assert.throws(() => change(board, 'board-assign', 'dev', input), /lead Bot/)
  assert.throws(() => change(board, 'board-assign', 'user', input), /lead Bot/)
  for (const collaboratorIds of [['missing'], ['__proto__'], [3], 'dev']) assert.throws(() => change(board, 'board-assign', 'lead', { ...input, collaboratorIds }), /collaborator/)
  assert.throws(() => change(board, 'board-assign', 'lead', { ...input, version: 1 }), /changed/)
  const result = change(board, 'board-assign', 'lead', input)
  assert.deepEqual(result.card.collaboratorIds, ['outsider'])
  assert.equal(result.card.leadId, 'lead')
  assert.equal(result.card.projectPath, '/project')
  assert.equal(result.card.staffing.summary, input.summary)
  assert.equal(result.effects.length, 0)
  assert.equal(result.card.deliveries.length, 1)
  assert.match(boardToolGuard(result.card, 'dev', 'read'), /no longer assigned/)
  assert.match(boardToolGuard(result.card, 'outsider', 'bash'), /read-only/)
  assert.deepEqual(change(result.board, 'board-assign', 'lead', { collaboratorIds: [], summary: 'Small solo change; self-review is explicit.' }).card.collaboratorIds, [])
  assert.throws(() => change(proposed(), 'board-assign', 'lead', input), /open decision/)
  assert.throws(() => change(approved(), 'board-assign', 'lead', input), /before submitting/)
  const paused = start(); paused.cards.card.status = 'paused'
  assert.throws(() => change(paused, 'board-assign', 'lead', input), /not active/)
  const revised = decide(proposed(), 'reject', 'Use another implementer').board
  assert.deepEqual(change(revised, 'board-assign', 'lead', input).card.collaboratorIds, ['outsider'])
  revised.cards.card.deliveries.push({ id: 'old', stepId: 'build', status: 'interrupted' }, { id: 'recovery', parentId: 'old', stepId: 'build', status: 'running' })
  assert.throws(() => change(revised, 'board-assign', 'lead', input), /previous step executions/)
  revised.cards.card.deliveries.at(-1).status = 'finished'
  assert.deepEqual(change(revised, 'board-assign', 'lead', input).card.collaboratorIds, ['outsider'])
})

test('a collaborator cannot forge another step or mark work done without evidence', () => {
  const board = approved()
  assert.throws(() => change(board, 'board-step', 'lead', { stepId: 'build' }), /assigned Bot/)
  assert.throws(() => change(board, 'board-step', 'outsider', { stepId: 'build' }), /not assigned/)
  assert.throws(() => change(board, 'board-step', 'dev', { stepId: 'build', status: 'done', summary: 'done' }), /evidence/)
  const next = change(board, 'board-step', 'dev', { stepId: 'build', status: 'done', summary: 'Built', evidence: 'filter.js' })
  assert.equal(next.card.stage, 'validation')
  assert.deepEqual(next.effects.map(job => job.stepId), ['verify'])
  assert.throws(() => change(next.board, 'board-step', 'dev', { stepId: 'build', status: 'done' }), /not ready/)
})

test('evidence must cover all criteria and only user acceptance makes Done', () => {
  const board = completed()
  assert.equal(board.cards.card.status, 'active')
  assert.throws(() => change(board, 'board-submit', 'dev', submission), /lead Bot/)
  assert.throws(() => change(board, 'board-submit', 'lead', { ...submission, evidence: [] }), /every acceptance/)
  assert.throws(() => change(board, 'board-submit', 'lead', { ...submission, evidence: submission.evidence.map(item => ({ ...item, result: 'not-run' })) }), /unexecuted/)
  const submitted = change(board, 'board-submit', 'lead', submission).board
  assert.equal(submitted.cards.card.status, 'active')
  assert.equal(decide(submitted).card.status, 'done')
})

test('a stale decision and concurrent update cannot silently override new work', () => {
  const board = proposed()
  const old = board.cards.card.decisions[0]
  const rejected = decide(board, 'reject', 'Add a test for empty projects').board
  const revised = change(rejected, 'board-plan', 'lead', plan).board
  assert.throws(() => change(revised, 'board-decide', 'user', { decisionId: old.id, decisionVersion: old.version, choice: 'approve' }), /outdated/)
  assert.throws(() => change(revised, 'board-question', 'lead', { version: 1 }), /changed/)
  assert.equal(revised.cards.card.planVersion, 2)
})

test('clarification preserves the work phase and rejection recalls the lead for a new plan', () => {
  const board = change(approved(), 'board-question', 'lead', { question: 'Use labels?', recommendation: 'Keep labels', impact: 'Label decisions wait; isolation test can continue.' }).board
  assert.equal(board.cards.card.stage, 'implementation')
  const answer = decide(board, 'answer', 'Keep labels')
  assert.equal(answer.card.stage, 'implementation')
  assert.equal(answer.effects[0].botId, 'lead')
  const rejected = decide(change(completed(), 'board-submit', 'lead', submission).board, 'reject', 'Also show the empty state')
  assert.equal(rejected.card.stage, 'design')
  assert.equal(rejected.card.approvedPlan, undefined)
  assert.equal(rejected.card.submissions.length, 1)
  assert.equal(rejected.card.submissions[0].planVersion, 1)
  assert.equal(rejected.card.submissions[0].evidence.length, 2)
  assert.match(boardToolGuard(rejected.card, 'dev', 'bash'), /read-only/)
})

test('tool mutations require the assigned task conversation, including for a Main Bot', async t => {
  const ctx = fakeContext()
  const card = start().cards.card
  const rt = { ctx, state: { board: { cards: { card } } }, load: async () => {}, own: (obj, key) => Object.hasOwn(obj, key) ? obj[key] : undefined,
    botOf: id => bots[id], selfOf: session => session === 'lead-chat' || session === 'task' ? 'lead' : undefined,
    roomOf: id => id === 'room' ? { boardCardId: 'card' } : undefined, groupOwners: new Map([['task', { botId: 'lead', roomId: 'room' }]]),
    boardMutate: async () => ({ updated: true }), warn() {} }
  install(rt); t.after(() => ctx.dispose())
  rt.boardExecution = sessionId => sessionId === 'task' ? { card, job: { id: 'job' } } : undefined
  const tool = ctx.registeredTools.get('plan_requirement')
  assert.equal(BOARD_TOOLS.length, 9)
  assert.ok(BOARD_TOOLS.every(name => ctx.registeredTools.has(name)))
  const assign = ctx.registeredTools.get('assign_requirement_bots')
  assert.match(await assign.execute({ id: 'card', version: 2, collaboratorIds: [], summary: 'Solo' }, { agent: { id: 'lead-chat' } }), /task conversation/)
  assert.deepEqual(JSON.parse(await assign.execute({ id: 'card', version: 2, collaboratorIds: [], summary: 'Solo' }, { agent: { id: 'task' } })), { updated: true })
  assert.match(await tool.execute({ id: 'card', version: 2, ...plan }, { agent: { id: 'lead-chat' } }), /task conversation/)
  assert.deepEqual(JSON.parse(await tool.execute({ id: 'card', version: 2, ...plan }, { agent: { id: 'task' } })), { updated: true })
})

test('a second project plan can be approved and queued without executing immediately', () => {
  const first = approved().cards.card
  const second = proposed()
  second.cards.other = { ...first, id: 'other' }
  const result = decide(second)
  assert.equal(result.card.stage, 'implementation')
  assert.equal(result.card.steps[0].status, 'queued')
  assert.equal(result.effects[0].status, 'pending')
})

test('a failed dispatch can retry, but an ambiguous delivery is never replayed blindly', () => {
  const board = start()
  const job = board.cards.card.deliveries[0]
  job.status = 'failed'; job.error = 'Project folder unavailable'
  board.cards.card.deliveryError = job.error
  const retried = change(board, 'board-retry').card
  assert.equal(retried.deliveries[0].status, 'interrupted')
  assert.equal(retried.deliveries[1].recovery, true)
  job.mayHaveSent = true
  assert.throws(() => change(board, 'board-retry'), /reconciled/)
  assert.equal(job.status, 'failed')
})

test('a lead can resume a blocked step without changing its assignment or scope', () => {
  const blocked = change(approved(), 'board-step', 'dev', { stepId: 'build', status: 'blocked', summary: 'Need a product choice' }).board
  assert.throws(() => change(blocked, 'board-resume-step', 'dev', { stepId: 'build', instructions: 'Continue' }), /lead Bot/)
  const resumed = change(blocked, 'board-resume-step', 'lead', { stepId: 'build', instructions: 'The user confirmed the existing filter behavior' })
  assert.equal(resumed.card.steps[0].assigneeId, 'dev')
  assert.equal(resumed.card.steps[0].scope, 'filter.js')
  assert.equal(resumed.effects[0].stepId, 'build')
})

test('a task can create its first member session before any group relay ran', async t => {
  const ctx = fakeContext()
  const room = { id: 'room', members: ['lead'], boardCardId: 'card' }
  const rt = { ctx, home: '/unused', groupOwners: new Map(), roomOf: () => room, botOf: () => bots.lead,
    workDirOf: () => '/project', createSession: async (_title, options) => { assert.equal(options.strictDir, true); return 'task' },
    desiredModel: async () => undefined, applyPermission: async () => {}, save: async () => {}, ensureCapabilities: async () => {}, ownChatBrief: async () => undefined }
  installGroups(rt); t.after(() => ctx.dispose())
  assert.deepEqual(await rt.groupSessionFor(room, { ...bots.lead, name: 'Lead' }), { id: 'task', brief: undefined })
  assert.deepEqual(room.seen, {})
  assert.equal(room.sessions.lead, 'task')
  assert.equal((await rt.groupSessionFor(room, bots.lead)).id, 'task')
})
