import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'
import { membersOf } from './board-workflow.js'
import { installScheduler } from './board-scheduler.js'

export const BOARD_TOOLS = ['read_project_board', 'create_requirement', 'plan_requirement', 'update_requirement_step', 'resume_requirement_step', 'ask_requirement_user', 'submit_requirement', 'reconcile_requirement_work']
const str = description => ({ type: 'string', required: true, description })
const id = str('Requirement id from read_project_board')
const version = { type: 'integer', required: true, description: 'Current requirement version; read again after any conflict' }
const READ_TOOLS = new Set(['read', 'read_file', 'read_image', 'glob', 'grep', 'read_own_chat', 'read_group_chat', 'read_browser', 'list_bots', 'list_models', 'list_capabilities', 'list_secrets', 'recall', 'web_search', 'web_fetch', 'list_agents', 'job_list', 'job_output'])

export function boardToolGuard(card, botId, name) {
  if (card.status !== 'active' && !READ_TOOLS.has(name) && name !== 'read_project_board') return 'This requirement is paused, stopping or cancelled. Do not execute more work.'
  if (BOARD_TOOLS.includes(name) || READ_TOOLS.has(name)) return
  if (['message_bot', 'post_to_group', 'create_group', 'update_group', 'delete_group', 'create_bot', 'update_bot', 'stop_bot', 'ask_user', 'save_capability', 'delete_capability', 'attach_capability', 'detach_capability'].includes(name)) return 'Keep requirement work in its task conversation and board tools. The assigned members and project are fixed by the user.'
  const writable = card.status === 'active' && card.approvedPlan === card.planVersion
    && ['implementation', 'validation'].includes(card.stage)
    && card.steps.some(step => step.assigneeId === botId && step.phase === card.stage && step.status === 'running')
  if (!writable) return 'Only read-only research and board tools are available until the user approves the plan and your step is dispatched.'
}

const jobPrompt = (card, job) => [
  `[Project requirement ${card.id}] ${job.reason}`,
  `Execution attempt: ${job.id}.`,
  job.recovery ? `Recovery checkpoint: ${job.checkpoint}\nOnly read tools are enabled. Inspect existing files and saved progress, then call reconcile_requirement_work with observations and references before any mutation. Do not repeat completed writes, messages or deployments. If effects cannot be established, report a blocker instead of guessing.` : '',
  `Title: ${card.title}\nProject directory: ${card.projectPath}\nStage: ${card.stage}`,
  `Your role: ${job.botId === card.leadId ? 'lead: coordinate, propose the plan, and submit evidence' : 'collaborator: execute only your assigned step'}.`,
  job.stepId ? `Assigned step: ${job.stepId}. Work only within its scope.` : '',
  'Read the latest requirement with read_project_board before changing it; use its current version. Save progress using board tools. A normal reply does not update the board.',
  'Collect background shell results using job_output and job_list before reporting completion. Keep processes managed by DSH; do not detach daemons with nohup, disown or an external supervisor. A pause stops processes, not their previous effects; continuation must inspect saved results.',
  'Clarify only decisions that change product scope, behavior or acceptance. Use ask_requirement_user for these; routine implementation choices are yours. Propose implementation and validation steps with explicit scopes using plan_requirement, then end your turn and wait for user approval. Do not implement before that approval.',
  'When dispatched to a step, do the work now. Use update_requirement_step with evidence when finished; report blockers honestly. Do not use message_bot or @mentions to dispatch duplicate work: the board dispatches the approved steps. The lead is recalled when all validation is done and submits artifacts and evidence for every criterion using submit_requirement.',
  'Never change global Bot settings or claim final acceptance. Merge, publish, production restart or scope expansion requires explicit authorization in the requirement. A returned delivery requires a revised plan. Do not restart work merely because the process reconnects.',
  `Brief: ${card.description}\nAcceptance criteria:\n${card.acceptance}`,
].filter(Boolean).join('\n\n')

export function install(rt) {
  const { ctx } = rt
  const contextOf = sessionId => {
    const owner = rt.groupOwners.get(sessionId) ?? rt.pastOwners?.get(sessionId)
    const room = rt.roomOf(owner?.roomId)
    const card = room?.boardCardId && rt.own(rt.state.board?.cards ?? {}, room.boardCardId)
    return card ? { card, botId: owner.botId } : undefined
  }
  ctx.tools.guard(exec => {
    const context = contextOf(exec.agent?.id)
    if (!context) {
      const room = rt.roomOf(exec.agent?.id)
      const card = room?.boardCardId && rt.own(rt.state.board?.cards ?? {}, room.boardCardId)
      return card && card.status !== 'active' ? 'This requirement is stopped; no group work can start.' : undefined
    }
    const refusal = boardToolGuard(context.card, context.botId, exec.name)
    if (refusal) return refusal
    if (READ_TOOLS.has(exec.name) || exec.name === 'read_project_board') return
    const execution = rt.boardExecution?.(exec.agent?.id)
    if (!execution) return 'No work is assigned to this session by the global queue. Wait for dispatch.'
    if (execution.job.outcome) return 'This attempt already reported its result. Wait for the next assigned step before starting more work.'
    if (execution.job.recovery && !execution.job.reconciled && !['reconcile_requirement_work', 'ask_requirement_user', 'update_requirement_step'].includes(exec.name)) return 'Inspect the saved progress and call reconcile_requirement_work before making changes.'
  })
  const register = (name, description, parameters, action) => ctx.tools.register(defineTool({
    name, description, parameters, output,
    async execute(args, exec) {
      try {
        await rt.load()
        const actor = rt.selfOf(exec.agent?.id)
        if (!rt.botOf(actor)) throw new Error('Only a team Bot can use requirement tools')
        return JSON.stringify(await action(args, actor, exec))
      } catch (error) { return JSON.stringify({ error: error.message }) }
    },
  }))
  const mutate = (operation, args, actor, exec) => {
    const context = contextOf(exec.agent?.id)
    if (!context || context.card.id !== args.id || context.botId !== actor) throw new Error('Update this requirement from its assigned task conversation')
    const execution = rt.boardExecution?.(exec.agent?.id)
    if (!execution) throw new Error('This execution attempt is no longer assigned')
    if (execution.job.recovery && !execution.job.reconciled && operation !== 'board-question' && !(operation === 'board-step' && args.status === 'blocked')) throw new Error('Reconcile saved progress before changing this requirement')
    return rt.boardMutate(operation, args, actor, { sessionId: exec.agent.id, jobId: execution.job.id })
  }
  register('read_project_board', 'Read assigned requirements, their current versions, plan, decisions, progress and acceptance criteria. Pass id for one card.', { id: { type: 'string' } }, (args, actor) => {
    const data = rt.boardView()
    const cards = data.cards.filter(card => membersOf(card).includes(actor) && (!args.id || card.id === args.id))
    return { projects: data.projects, cards }
  })
  register('create_requirement', 'Create a draft only. The user must review it and click Start; saving never dispatches work.', {
    projectId: str('Registered DSH project id'), requestId: str('Unique retry identifier'), title: str('Requirement title'), description: str('Requirement brief'), acceptance: str('One acceptance criterion per line'),
    collaboratorIds: { type: 'array', items: { type: 'string' } },
  }, (args, actor) => rt.boardMutate('board-create', { ...args, leadId: actor }, actor))
  register('plan_requirement', 'Lead only. Submit a concrete plan for user approval. Implementation remains blocked until approved. Multi-Bot plans require an independent reviewer.', {
    id, version, summary: str('Solution, tradeoffs and implementation plan'),
    steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      id: str('Unique short step id'), title: str('Step title'), assigneeId: str('Assigned member Bot id'),
      phase: { type: 'string', required: true, enum: ['implementation', 'validation'] }, scope: str('Explicit files to change or scope to review'),
      dependsOn: { type: 'array', items: { type: 'string' }, description: 'Earlier step ids that must finish first' },
    } } },
  }, (args, actor, exec) => mutate('board-plan', args, actor, exec))
  register('update_requirement_step', 'Update your dispatched step. Mark done only with actual deliverables or verification evidence. The board starts the next approved steps.', {
    id, version, stepId: str('Step id'), status: { type: 'string', required: true, enum: ['running', 'blocked', 'done'] }, summary: str('Progress or blocker'), evidence: { type: 'string', description: 'Required for done: actual artifact or test details' },
  }, (args, actor, exec) => mutate('board-step', args, actor, exec))
  register('ask_requirement_user', 'Lead only. Ask a product, scope or acceptance decision that needs the user. Independent approved work can continue. End your turn instead of polling.', {
    id, version, question: str('Decision needed'), recommendation: str('Recommended answer and reason'), impact: str('What waits for this decision and what can continue'),
  }, (args, actor, exec) => mutate('board-question', args, actor, exec))
  register('resume_requirement_step', 'Lead only. Resume a blocked step after resolving its blocker. The approved scope and assignee remain unchanged.', {
    id, version, stepId: str('Blocked step id'), instructions: str('How the blocker was resolved and what the assigned Bot should do next'),
  }, (args, actor, exec) => mutate('board-resume-step', args, actor, exec))
  register('submit_requirement', 'Lead only. Submit completed work for final user acceptance. Does not mark Done. All steps and criteria must pass; never invent verification.', {
    id, version, summary: str('Delivery summary'),
    evidence: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      result: { type: 'string', required: true, enum: ['passed', 'failed', 'not-run'] }, detail: str('Actual check and observed result'), reference: str('Test report, command result or artifact reference'),
    } } },
    artifacts: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { title: str('Deliverable title'), summary: str('What was delivered'), reference: str('File path or URL') } } },
  }, (args, actor, exec) => mutate('board-submit', args, actor, exec))

  register('reconcile_requirement_work', 'After an interruption, record what already happened using file or history evidence. This enables continuation of the assigned attempt; it never marks a step complete.', {
    observations: str('Observed saved progress, existing effects and what remains'), references: { type: 'array', required: true, items: { type: 'string' } },
  }, (args, _actor, exec) => rt.boardReconcileWork(exec.agent.id, args.observations, args.references))
  installScheduler(rt, jobPrompt)
}
