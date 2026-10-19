import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardColumn, createDraft, editDraft, emptyBoard, install } from '../src/host/board.js'

const projects = [{ id: 'workspace-a', title: 'Alpha', path: '/projects/alpha' }, { id: 'workspace-b', title: 'Beta', path: '/projects/beta' }]
const bots = { lead: { name: 'Chief' }, writer: { name: 'Writer' } }
const input = { projectId: 'workspace-a', requestId: 'draft-1', title: 'Project board', description: 'Deliver a board', acceptance: 'Drafts survive refresh', leadId: 'lead', collaboratorIds: ['writer'] }
const context = { projects, bots, now: 100, id: 'card-1' }

test('drafts bind to registered projects and do not accept execution fields', () => {
  const { card } = createDraft(emptyBoard(), { ...input, projectPath: '/elsewhere', status: 'done', stage: 'implementation' }, context)
  assert.equal(card.projectPath, '/projects/alpha')
  assert.equal(card.status, 'backlog')
  assert.equal(card.stage, 'confirmation')
  assert.throws(() => createDraft(emptyBoard(), { ...input, projectId: '/unregistered/path' }, context), /registered DSH project/)
})

test('retrying a creation does not duplicate or redirect the requirement', () => {
  const result = createDraft(emptyBoard(), input, context)
  const retry = createDraft(result.board, input, { ...context, id: 'ignored' })
  assert.equal(retry.board, result.board)
  assert.equal(retry.card.id, 'card-1')
  assert.equal(retry.board.nextNumber, 2)
  assert.throws(() => createDraft(result.board, { ...input, projectId: 'workspace-b' }, context), /already used/)
})

test('lead and collaborators must be real team members, including prototype-like names', () => {
  for (const leadId of ['missing', '__proto__', 'toString']) assert.throws(() => createDraft(emptyBoard(), { ...input, leadId }, context), /lead Bot/)
  assert.throws(() => createDraft(emptyBoard(), { ...input, collaboratorIds: ['missing'] }, context), /collaborators/)
  assert.deepEqual(createDraft(emptyBoard(), { ...input, collaboratorIds: ['lead', 'writer', 'writer'] }, context).card.collaboratorIds, ['writer'])
})

test('optimistic editing protects another window and an already started requirement', () => {
  const { board } = createDraft(emptyBoard(), input, context)
  const update = { ...input, id: 'card-1', version: 1, title: 'Better project board' }
  const edited = editDraft(board, update, context)
  assert.equal(edited.card.version, 2)
  assert.equal(board.cards['card-1'].title, input.title)
  assert.throws(() => editDraft(edited.board, update, context), /another window/)
  assert.throws(() => editDraft({ ...board, cards: { 'card-1': { ...board.cards['card-1'], status: 'active' } } }, update, context), /reviewed revision/)
})

test('needs-you is independent of the work stage and has precedence over active', () => {
  assert.equal(boardColumn({ status: 'active', stage: 'design', decisions: [{ status: 'open' }] }), 'needs-you')
  assert.equal(boardColumn({ status: 'active', decisions: [{ status: 'answered' }] }), 'in-progress')
  assert.equal(boardColumn({ status: 'done', decisions: [] }), 'done')
})

test('concurrent writes serialize, and failed persistence leaves no phantom card', async () => {
  let fail = false
  const rt = { state: { bots, revision: 0 }, ctx: { workspaceRegistry: { list: () => projects } }, refresh: async () => {}, readOnly: () => undefined,
    save: async () => { await new Promise(resolve => setTimeout(resolve, 2)); if (fail) throw new Error('disk full'); rt.state.revision++ } }
  install(rt)
  const [a, b] = await Promise.all([rt.boardMutate('board-create', input), rt.boardMutate('board-create', { ...input, requestId: 'draft-2', projectId: 'workspace-b' })])
  assert.deepEqual([a.number, b.number], [1, 2])
  assert.equal(rt.boardView().cards.length, 2)
  fail = true
  await assert.rejects(rt.boardMutate('board-create', { ...input, requestId: 'draft-3' }), /disk full/)
  assert.equal(rt.boardView().cards.length, 2)
  rt.readOnly = () => 'Another host owns this team'
  await assert.rejects(rt.boardMutate('board-create', { ...input, requestId: 'draft-4' }), /Another host/)
})
