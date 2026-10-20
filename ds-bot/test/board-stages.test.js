import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDraft, emptyBoard } from '../src/host/board.js'
import { workflowChange } from '../src/host/board-workflow.js'
import { stageProgress } from '../src/shared/board-stages.js'

const projects = [{ id: 'p', path: '/project' }], bots = { lead: { id: 'lead' }, dev: { id: 'dev' } }
const change = (board, command, actor = 'user', input = {}) => workflowChange(board, command, { id: 'card', version: board.cards.card.version, ...input }, { actor, projects, bots })
const start = () => change(createDraft(emptyBoard(), { projectId: 'p', requestId: 'stage', title: 'Review existing work', description: 'Inspect the existing artifact', acceptance: 'Artifact matches the brief', leadId: 'lead' }, { projects, bots, id: 'card' }).board, 'board-start').board
const skip = stage => ({ stage, status: 'skipped', reason: `${stage} is unnecessary for this scope.` })
const step = phase => ({ id: phase, title: phase, phase, assigneeId: 'lead', scope: 'fixture.json', dependsOn: [] })
const proposed = (stages, steps) => change(start(), 'board-plan', 'lead', { summary: 'Only do applicable work', stages, steps }).board
const decide = (board, choice = 'approve') => {
  const decision = board.cards.card.decisions.findLast(item => item.status === 'open')
  return change(board, 'board-decide', 'user', { decisionId: decision.id, decisionVersion: decision.version, choice, answer: choice === 'reject' ? 'Revise scope' : '' })
}
const submit = board => change(board, 'board-submit', 'lead', { summary: 'Reviewed existing artifact', evidence: [{ result: 'passed', detail: 'Read the artifact; its value matches the criterion', reference: 'fixture.json' }], artifacts: [{ title: 'Existing artifact', summary: 'Inspected only', reference: 'fixture.json' }] })
const progress = card => Object.fromEntries(stageProgress(card).map(item => [item.stage, item.status]))

test('missing stage records and a Done card never imply all five stages completed', () => {
  assert.deepEqual(progress({ status: 'done', stage: 'validation', steps: [] }), { confirmation: 'pending', clarification: 'pending', design: 'pending', implementation: 'pending', validation: 'pending' })
  const card = { status: 'active', stage: 'validation', planVersion: 1, approvedPlan: 1, steps: [{ phase: 'implementation', status: 'done' }] }
  assert.equal(progress(card).implementation, 'pending')
  card.steps[0].evidence = 'Read-back confirms the edit'
  assert.equal(progress(card).implementation, 'completed')
  assert.equal(progress(card).clarification, 'pending')
})

test('the coordinator can skip any preparatory stage, with an explicit reason', () => {
  for (const stage of ['confirmation', 'clarification', 'design']) {
    const board = proposed([skip(stage)], [step('implementation'), step('validation')])
    assert.equal(progress(board.cards.card)[stage], 'skipped')
    const approved = decide(board).card
    assert.equal(progress(approved)[stage], 'skipped')
    assert.equal(approved.stageOutcomes[stage].reason, skip(stage).reason)
    assert.equal(approved.decisions[0].stageOutcomes[stage].status, 'skipped')
  }
})

test('skipping implementation schedules validation directly and retains final user acceptance', () => {
  const board = proposed([skip('implementation'), skip('clarification')], [step('validation')])
  assert.equal(board.cards.card.deliveries.length, 1)
  assert.throws(() => submit(board), /open decision/)
  const approval = decide(board)
  assert.deepEqual(approval.effects.map(job => job.stepId), ['validation'])
  assert.equal(approval.card.stage, 'validation')
  approval.card.steps[0].status = 'running'
  const complete = change(approval.board, 'board-step', 'lead', { stepId: 'validation', status: 'done', summary: 'Read verified', evidence: 'fixture.json read through tool' })
  assert.equal(complete.effects.length, 1)
  assert.equal(complete.effects[0].stepId, undefined)
  const submitted = submit(complete.board)
  assert.equal(submitted.card.status, 'active')
  const accepted = decide(submitted.board).card
  assert.equal(accepted.status, 'done')
  assert.equal(progress(accepted).implementation, 'skipped')
  assert.equal(progress(accepted).validation, 'completed')
})

test('skipping validation does not dispatch a fictional verification step', () => {
  const approved = decide(proposed([skip('validation')], [step('implementation')]))
  approved.card.steps[0].status = 'running'
  const result = change(approved.board, 'board-step', 'lead', { stepId: 'implementation', status: 'done', summary: 'Delivered', evidence: 'Artifact read-back' })
  assert.deepEqual(result.effects.map(job => job.stepId), [undefined])
  assert.equal(result.card.stage, 'validation')
  assert.equal(progress(result.card).validation, 'skipped')
  assert.equal(decide(submit(result.board).board).card.status, 'done')
})

test('a no-execution plan still waits for user approval then recalls the lead once', () => {
  const board = proposed([skip('implementation'), skip('validation'), skip('design')], [])
  assert.equal(board.cards.card.deliveries.length, 1)
  assert.throws(() => submit(board), /open decision/)
  const approved = decide(board)
  assert.equal(approved.effects.length, 1)
  assert.equal(approved.effects[0].botId, 'lead')
  assert.equal(approved.effects[0].stepId, undefined)
  assert.equal(decide(submit(approved.board).board).card.status, 'done')
})

test('invalid or contradictory stage outcomes fail atomically', () => {
  const before = start(), snapshot = structuredClone(before)
  const base = { summary: 'Plan', steps: [step('implementation'), step('validation')] }
  for (const stages of [[skip('other')], [skip('design'), skip('design')], [{ ...skip('design'), reason: '' }], [{ ...skip('design'), status: 'done' }], [{ ...skip('implementation'), status: 'completed' }], [skip('implementation')], null]) {
    assert.throws(() => change(before, 'board-plan', 'lead', { ...base, stages }))
    assert.deepEqual(before, snapshot)
  }
  assert.throws(() => change(before, 'board-plan', 'dev', { ...base, stages: [skip('design')] }), /not assigned/)
  assert.throws(() => proposed([], []), /explicit skip reason/)
  assert.throws(() => change(before, 'board-plan', 'lead', { ...base, version: 0 }), /changed/)
})

test('rejected delivery resets future stages, retains the old snapshot, and needs new skips', () => {
  const board = decide(proposed([skip('implementation'), skip('validation'), skip('design')], [])).board
  const rejected = decide(submit(board).board, 'reject').board
  assert.equal(progress(rejected.cards.card).implementation, 'pending')
  assert.equal(rejected.cards.card.submissions[0].stageOutcomes.implementation.status, 'skipped')
  assert.throws(() => change(rejected, 'board-plan', 'lead', { summary: 'Retry without reason', steps: [] }), /explicit skip reason/)
  const revised = change(rejected, 'board-plan', 'lead', { summary: 'New work', steps: [step('implementation'), step('validation')] }).card
  assert.equal(progress(revised).validation, 'pending')
})

test('stage outcomes survive persisted state and paused requirements without turning into checks', () => {
  const board = proposed([skip('clarification'), skip('implementation')], [step('validation')])
  const paused = change(board, 'board-pause', 'user', { requestId: 'pause' }).board
  const reloaded = JSON.parse(JSON.stringify(paused))
  assert.equal(progress(reloaded.cards.card).clarification, 'skipped')
  assert.equal(progress(reloaded.cards.card).implementation, 'skipped')
  assert.equal(reloaded.cards.card.stageOutcomes.implementation.reason, skip('implementation').reason)
})
