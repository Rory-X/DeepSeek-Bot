import { randomUUID } from 'node:crypto'
import { own } from './store.js'
import { appendJob, controlRequirement } from './board-jobs.js'
import { BOARD_STAGES, EXECUTION_STAGES, executionComplete, stageSkipped } from '../shared/board-stages.js'

const fail = message => { throw Object.assign(new Error(message), { code: 'bot/invalid' }) }
const text = (value, name, max = 12000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('Provide ' + name)
  return value.trim()
}
export const membersOf = card => [card.leadId, ...card.collaboratorIds]
export const criteriaOf = card => card.acceptance.split('\n').map(line => line.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)
const active = card => { if (card.status !== 'active') fail('This requirement is not active') }
const openDecision = (card, kind, question, recommendation, extra = {}) => ({
  id: randomUUID(), version: 1, status: 'open', kind, question, recommendation,
  scopeVersion: card.scopeVersion, planVersion: card.planVersion ?? 0, ...extra,
})
const userOnly = actor => { if (actor !== 'user') fail('Only the user can start or approve a requirement') }
const leadOnly = (card, actor) => { if (actor !== card.leadId) fail('Only the lead Bot can change the requirement plan or submit it') }
const requireVersion = (card, input) => { if (input.version !== card.version) fail('This requirement changed. Read it again before continuing.') }
const noOpen = card => { if (card.decisions.some(item => item.status === 'open')) fail('Resolve the open decision first') }

export function workflowChange(board, command, input, { actor = 'user', bots, projects, now = Date.now() }) {
  const before = own(board.cards, input.id)
  if (!before) fail('This requirement no longer exists')
  if (actor !== 'user' && !membersOf(before).includes(actor)) fail('You are not assigned to this requirement')
  const card = structuredClone(before)
  const next = { ...board, nextJobSequence: board.nextJobSequence ?? 1, cards: { ...board.cards, [card.id]: card } }
  const effects = []
  let activity
  const dispatch = (botId, reason, stepId) => {
    const entry = appendJob(next, card, botId, reason, stepId, { at: now })
    effects.push(entry)
  }
  const scheduleSteps = () => {
    const implementation = card.steps.filter(step => step.phase === 'implementation')
    if (implementation.every(step => step.status === 'done')) card.stage = 'validation'
    for (const step of card.steps) {
      if (step.status !== 'queued' || step.phase !== card.stage || !step.dependsOn.every(id => card.steps.find(other => other.id === id)?.status === 'done')) continue
      if (card.deliveries?.some(job => job.stepId === step.id && job.planVersion === card.planVersion && ['pending', 'sending', 'sent', 'running'].includes(job.status))) continue
      dispatch(step.assigneeId, 'Execute your assigned step', step.id)
    }
    if (executionComplete(card)) {
      card.summary = 'Preparing delivery and verification evidence'
      dispatch(card.leadId, 'Review the evidence and submit for user acceptance')
    }
  }
  const control = ['board-pause', 'board-resume', 'board-cancel'].includes(command)
  if (command !== 'board-decide' && !control) requireVersion(card, input)
  if (control) {
    userOnly(actor)
    activity = controlRequirement(next, card, command, input, now)
    if (!activity) return { board, card: before, effects: [] }
  } else {
  switch (command) {
    case 'board-retry': {
      userOnly(actor); active(card)
      const failed = (card.deliveries ?? []).filter(job => job.status === 'failed')
      if (!failed.length) fail('There is no failed delivery to retry')
      if (failed.some(job => job.mayHaveSent)) fail('Delivery is being reconciled. Wait until its session can be inspected.')
      for (const job of failed) {
        job.status = 'interrupted'
        appendJob(next, card, job.botId, job.reason, job.stepId, { recovery: true, parentId: job.id, checkpoint: 'Retry requested after failure. Inspect the previous attempt before continuing.' })
      }
      delete card.deliveryError
      activity = 'Task delivery retried'
      break
    }
    case 'board-start': {
      userOnly(actor)
      if (card.status !== 'backlog') fail('This requirement has already started')
      text(card.description, 'a requirement brief')
      text(card.acceptance, 'acceptance criteria')
      const project = projects.find(project => project.id === card.projectId)
      if (!project || project.path !== card.projectPath) fail('The project moved or is no longer registered')
      if (membersOf(card).some(id => !own(bots, id))) fail('An assigned Bot is no longer on the team')
      card.status = 'active'; card.stage = 'clarification'; card.scopeVersion = 1
      dispatch(card.leadId, 'Clarify the requirement and propose a plan')
      activity = 'Requirement started'
      break
    }
    case 'board-assign': {
      active(card); leadOnly(card, actor); noOpen(card)
      if (!['clarification', 'design'].includes(card.stage) || card.approvedPlan !== undefined) fail('Assign collaborators before submitting the implementation plan')
      if (!Array.isArray(input.collaboratorIds)) fail('Provide the complete collaborator list, or an empty list for solo work')
      const collaborators = [...new Set(input.collaboratorIds)].filter(id => id !== card.leadId)
      if (collaborators.length > 11 || collaborators.some(id => typeof id !== 'string' || !own(bots, id))) fail('Choose up to 11 collaborators from this team')
      if ((card.deliveries ?? []).some(job => job.stepId && !['finished', 'cancelled'].includes(job.status)
        && !(job.status === 'interrupted' && card.deliveries.some(child => child.parentId === job.id)))) fail('Wait for previous step executions to settle before changing the team')
      card.collaboratorIds = collaborators
      card.staffing = { summary: text(input.summary, 'the assignment rationale and responsibilities', 4000), at: now, actor }
      activity = 'Requirement team assigned'
      break
    }
    case 'board-plan': {
      active(card); leadOnly(card, actor); noOpen(card)
      if (!['clarification', 'design'].includes(card.stage)) fail('Implementation needs a new reviewed revision before replacing its plan')
      const summary = text(input.summary, 'the proposed plan')
      if (!Array.isArray(input.steps) || input.steps.length > 30) fail('Plan up to 30 steps and explain any skipped stages')
      if (input.stages !== undefined && (!Array.isArray(input.stages) || input.stages.length > 5)) fail('Provide up to five stage outcomes')
      // A new plan must opt into skips again; old execution outcomes never carry over.
      const outcomes = Object.fromEntries(['confirmation', 'clarification'].filter(stage => card.stageOutcomes?.[stage]).map(stage => [stage, card.stageOutcomes[stage]]))
      const seenStages = new Set()
      for (const outcome of input.stages ?? []) {
        if (!outcome || !BOARD_STAGES.includes(outcome.stage) || seenStages.has(outcome.stage)) fail('Choose each development stage at most once')
        if (!['completed', 'skipped'].includes(outcome.status)) fail('Stage outcomes must be completed or skipped')
        if (outcome.status === 'completed' && EXECUTION_STAGES.includes(outcome.stage)) fail('Execution stages complete through their steps and evidence, not a plan declaration')
        seenStages.add(outcome.stage)
        outcomes[outcome.stage] = { status: outcome.status, reason: text(outcome.reason, 'the stage outcome reason or completion evidence', 2000), actor, at: now }
      }
      card.stageOutcomes = outcomes
      const ids = new Set()
      const steps = input.steps.map(step => {
        const id = text(step.id, 'a unique step id', 80)
        if (ids.has(id)) fail('Step ids must be unique')
        ids.add(id)
        if (!membersOf(card).includes(step.assigneeId) || !own(bots, step.assigneeId)) fail('Assign each step to a requirement member')
        if (!['implementation', 'validation'].includes(step.phase)) fail('Choose implementation or validation for each step')
        return { id, title: text(step.title, 'a step title', 240), assigneeId: step.assigneeId, phase: step.phase,
          scope: text(step.scope, 'the files or review scope of each step', 2000), dependsOn: step.dependsOn ?? [], status: 'queued' }
      })
      for (const step of steps) {
        if (!Array.isArray(step.dependsOn) || step.dependsOn.some(id => !ids.has(id) || id === step.id)) fail('Invalid step dependencies')
        if (step.phase === 'implementation' && step.dependsOn.some(id => steps.find(other => other.id === id).phase === 'validation')) fail('Implementation cannot depend on validation')
      }
      const visited = new Set()
      const visit = (id, path = new Set()) => {
        if (path.has(id)) fail('Step dependencies contain a cycle')
        if (visited.has(id)) return
        for (const dependency of steps.find(step => step.id === id).dependsOn) visit(dependency, new Set([...path, id]))
        visited.add(id)
      }
      steps.forEach(step => visit(step.id))
      const implementers = new Set(steps.filter(step => step.phase === 'implementation').map(step => step.assigneeId))
      const reviewers = steps.filter(step => step.phase === 'validation')
      for (const phase of EXECUTION_STAGES) {
        const count = steps.filter(step => step.phase === phase).length
        if (stageSkipped(card, phase) && count) fail('A skipped stage cannot contain execution steps')
        if (!stageSkipped(card, phase) && !count) fail('The plan needs implementation and validation, or an explicit skip reason for each omitted stage')
      }
      if (implementers.size && reviewers.length && card.collaboratorIds.length && !reviewers.some(step => !implementers.has(step.assigneeId))) fail('Assign independent validation to a Bot that does not implement this requirement')
      card.planVersion = (card.planVersion ?? 0) + 1
      card.plan = summary; card.steps = steps; card.stage = 'design'; card.summary = 'Waiting for plan approval'
      card.decisions.push(openDecision(card, 'design', stageSkipped(card, 'design') ? 'Approve this execution scope?' : 'Approve this implementation plan?', summary, { stageOutcomes: structuredClone(card.stageOutcomes) }))
      activity = 'Plan submitted for approval'
      break
    }
    case 'board-question': {
      active(card); leadOnly(card, actor)
      if (card.decisions.some(item => item.status === 'open' && item.kind === 'acceptance')) fail('The requirement is awaiting final acceptance')
      if (card.decisions.filter(item => item.status === 'open').length >= 5) fail('Resolve the existing decisions first')
      card.decisions.push(openDecision(card, 'clarification', text(input.question, 'a question', 1000), text(input.recommendation, 'a recommendation', 4000), { impact: text(input.impact, 'the impact of this decision', 2000) }))
      activity = 'User decision requested'
      break
    }
    case 'board-step': {
      active(card)
      if (card.approvedPlan !== card.planVersion || !['implementation', 'validation'].includes(card.stage)) fail('The user has not approved implementation')
      const step = card.steps.find(step => step.id === input.stepId)
      if (!step || step.assigneeId !== actor) fail('Only the assigned Bot can update this step')
      if (!['running', 'blocked'].includes(step.status) || step.phase !== card.stage) fail('This step is not ready to execute')
      if (!['running', 'blocked', 'done'].includes(input.status)) fail('Invalid step status')
      step.summary = text(input.summary, 'a progress summary', 4000)
      if (input.status === 'done') step.evidence = text(input.evidence, 'verification evidence or a deliverable reference', 8000)
      step.status = input.status
      activity = input.status === 'done' ? 'Step completed' : input.status === 'blocked' ? 'Step blocked' : 'Step progress updated'
      if (input.status === 'done') {
        scheduleSteps()
      } else if (input.status === 'blocked') dispatch(card.leadId, 'Resolve the blocked step or ask the user')
      break
    }
    case 'board-submit': {
      active(card); leadOnly(card, actor); noOpen(card)
      if (card.stage !== 'validation' || card.planVersion === undefined || card.approvedPlan !== card.planVersion || !executionComplete(card)) fail('Complete implementation and validation before submitting, or explicitly skip in the approved plan')
      const criteria = criteriaOf(card)
      if (!Array.isArray(input.evidence) || input.evidence.length !== criteria.length) fail('Provide evidence for every acceptance criterion, in order')
      card.evidence = input.evidence.map((entry, index) => {
        if (!['passed', 'failed', 'not-run'].includes(entry.result)) fail('Evidence must say passed, failed, or not-run')
        return { criterion: criteria[index], result: entry.result, detail: text(entry.detail, 'verification details', 4000), reference: text(entry.reference, 'a verification reference', 2000) }
      })
      if (card.evidence.some(entry => entry.result !== 'passed')) fail('Failed or unexecuted checks must be resolved before final acceptance')
      if (!Array.isArray(input.artifacts) || !input.artifacts.length || input.artifacts.length > 20) fail('Provide 1 to 20 deliverables')
      card.artifacts = input.artifacts.map(entry => ({ id: randomUUID(), title: text(entry.title, 'a deliverable title', 240), summary: text(entry.summary, 'a deliverable summary', 4000), reference: text(entry.reference, 'a deliverable reference', 2000) }))
      card.summary = text(input.summary, 'a delivery summary', 4000)
      card.deliveryPlanVersion = card.planVersion
      card.submissions = [...(card.submissions ?? []), { id: randomUUID(), at: now, planVersion: card.planVersion, summary: card.summary, artifacts: card.artifacts, evidence: card.evidence, stageOutcomes: structuredClone(card.stageOutcomes) }].slice(-20)
      card.decisions.push(openDecision(card, 'acceptance', 'Accept this delivery?', card.summary))
      activity = 'Delivery submitted for acceptance'
      break
    }
    case 'board-resume-step': {
      active(card); leadOnly(card, actor)
      const step = card.steps.find(step => step.id === input.stepId)
      if (!step || step.status !== 'blocked' || step.phase !== card.stage || card.approvedPlan !== card.planVersion) fail('Only a blocked step in the approved plan can resume')
      step.summary = text(input.instructions, 'how the blocker was resolved', 4000)
      step.status = 'queued'
      dispatch(step.assigneeId, 'Resume the step: ' + step.summary, step.id)
      activity = 'Blocked step resumed'
      break
    }
    case 'board-decide': {
      userOnly(actor); active(card)
      const decision = card.decisions.find(item => item.id === input.decisionId)
      if (!decision || decision.status !== 'open' || decision.version !== input.decisionVersion || decision.scopeVersion !== card.scopeVersion || decision.planVersion !== (card.planVersion ?? 0)) fail('This decision is outdated. Reopen the requirement.')
      if (!['approve', 'reject', 'answer'].includes(input.choice)) fail('Invalid decision')
      if (decision.kind === 'clarification' && input.choice !== 'answer') fail('Answer the clarification in writing')
      if (decision.kind !== 'clarification' && input.choice === 'answer') fail('Approve or request changes')
      decision.answer = input.choice === 'approve' ? String(input.answer ?? '').trim().slice(0, 4000) : text(input.answer, 'your answer or requested changes', 4000)
      decision.status = 'answered'; decision.choice = input.choice; decision.answeredAt = now
      if (decision.kind === 'design' && input.choice === 'approve') {
        if (card.decisions.some(item => item.status === 'open')) fail('Answer the remaining questions before approving the plan')
        card.approvedPlan = card.planVersion; card.approvedAt = now; card.stage = 'implementation'; card.summary = 'Approved and queued for execution'
        scheduleSteps(); activity = 'Plan approved'
      } else if (decision.kind === 'acceptance' && input.choice === 'approve') {
        if (!executionComplete(card) || card.approvedPlan !== card.planVersion || card.evidence?.some(entry => entry.result !== 'passed')) fail('The delivery changed. Review it again.')
        card.status = 'done'; card.completedAt = now; card.summary = 'Accepted by the user'; activity = 'Delivery accepted'
      } else {
        if (decision.kind === 'design') {
          card.stage = 'design'
          if (card.stageOutcomes) for (const stage of ['design', ...EXECUTION_STAGES]) delete card.stageOutcomes[stage]
        }
        if (decision.kind === 'acceptance') {
          card.stage = 'design'; delete card.approvedPlan
          // Keep prior outcomes in the submission, not on the revised work ahead.
          if (card.stageOutcomes) for (const stage of ['design', ...EXECUTION_STAGES]) delete card.stageOutcomes[stage]
          card.summary = 'Changes requested; preparing a revised plan'
        }
        dispatch(card.leadId, 'Read the user decision and continue within the approved scope')
        activity = input.choice === 'reject' ? 'Changes requested' : 'User decision answered'
      }
      break
    }
    default: fail('Unknown board operation')
  }
  }
  card.version++; card.updatedAt = now
  card.activity = [...card.activity, { id: randomUUID(), at: now, actor, text: activity }].slice(-200)
  return { board: next, card, effects }
}
