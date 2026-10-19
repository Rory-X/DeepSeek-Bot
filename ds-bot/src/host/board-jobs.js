import { randomUUID } from 'node:crypto'

export const LIVE_JOBS = new Set(['sending', 'sent', 'running', 'settling', 'stopping', 'recovering'])
export const jobsOf = board => Object.values(board?.cards ?? {}).flatMap(card => (card.deliveries ?? []).map(job => ({ card, job })))
export const orderedJobs = board => jobsOf(board).sort((a, b) => (a.job.sequence ?? a.job.at) - (b.job.sequence ?? b.job.at) || a.job.id.localeCompare(b.job.id))
export function normalizeQueue(board) {
  let next = jobsOf(board).reduce((next, { job }) => Math.max(next, Number.isSafeInteger(job.sequence) ? job.sequence + 1 : 1), board.nextJobSequence ?? 1)
  for (const { job } of orderedJobs(board)) if (!Number.isSafeInteger(job.sequence)) job.sequence = next++
  board.nextJobSequence = next
  board.botLeases ??= {}; board.projectLeases ??= {}
}
export const ownsProject = card => ['active', 'pausing', 'cancelling'].includes(card.status)
  && card.approvedPlan === card.planVersion && ['implementation', 'validation'].includes(card.stage)

export function appendJob(board, card, botId, reason, stepId, extra = {}) {
  board.nextJobSequence ??= 1
  const job = { id: randomUUID(), sequence: board.nextJobSequence++, botId, reason, status: 'pending', at: Date.now(),
    epoch: card.runEpoch ?? 0, planVersion: card.planVersion ?? 0, baselineVersion: card.version,
    ...(stepId ? { stepId } : {}), ...extra }
  ;(card.deliveries ??= []).push(job)
  return job
}

export function jobSatisfied(card, job) {
  if (job.outcome) return true
  if (card.status === 'done' || (job.planVersion ?? 0) < (card.planVersion ?? 0)) return true
  if (job.stepId) return card.steps.some(step => step.id === job.stepId && ['done', 'blocked'].includes(step.status))
  // Compatibility with deliveries made before explicit completion receipts existed.
  if (job.baselineVersion === undefined) return card.decisions.some(item => item.status === 'open')
  return false
}

export function refreshProjectLeases(board) {
  board.projectLeases ??= {}
  for (const [path, id] of Object.entries(board.projectLeases)) {
    if (!board.cards[id] || (!ownsProject(board.cards[id]) && !(board.cards[id].deliveries ?? []).some(job => LIVE_JOBS.has(job.status)))) delete board.projectLeases[path]
  }
  for (const card of Object.values(board.cards).filter(ownsProject).sort((a, b) => (a.approvedAt ?? a.createdAt) - (b.approvedAt ?? b.createdAt) || a.number - b.number)) {
    board.projectLeases[card.projectPath] ??= card.id
  }
}

export function queueView(board, busyBots = new Set()) {
  const jobs = orderedJobs(board).filter(({ card, job }) => !['done', 'cancelled'].includes(card.status) && ['pending', 'held', 'paused', ...LIVE_JOBS].includes(job.status))
  const positions = new Map()
  return jobs.map(({ card, job }) => {
    const held = card.status === 'paused' || ['held', 'paused'].includes(job.status)
    const position = held ? 0 : (positions.get(job.botId) ?? 0) + 1
    if (!held) positions.set(job.botId, position)
    const owner = board.projectLeases?.[card.projectPath]
    const botOwner = board.botLeases?.[job.botId]
    const blockedBy = card.status !== 'active' ? undefined : owner && owner !== card.id ? 'project' : botOwner && botOwner !== job.id ? 'bot' : busyBots.has(job.botId) && job.status === 'pending' ? 'chat' : undefined
    return { id: job.id, cardId: card.id, number: card.number, title: card.title, projectId: card.projectId, botId: job.botId,
      step: card.steps.find(step => step.id === job.stepId)?.title ?? job.reason, state: card.status === 'paused' ? 'held' : job.status,
      position, blockedBy, ...(blockedBy === 'project' ? { waitingNumber: board.cards[owner]?.number } : {}),
      ...(job.recovery && !job.reconciled ? { recovery: true } : {}), ...(job.checkpoint ? { checkpoint: job.checkpoint } : {}) }
  })
}

export function controlRequirement(board, card, command, input, now) {
  if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 100) throw new Error('Provide a control request identifier')
  const earlier = (card.controls ?? []).find(item => item.id === input.requestId)
  if (earlier) {
    if (earlier.command !== command) throw new Error('This control identifier was already used')
    return undefined
  }
  if (command === 'board-pause') {
    if (['paused', 'pausing'].includes(card.status)) return undefined
    if (card.status !== 'active') throw new Error('Only active requirements can pause')
    card.status = 'pausing'; card.runEpoch = (card.runEpoch ?? 0) + 1
    card.summary = 'Stopping work before pausing'
  } else if (command === 'board-cancel') {
    if (['cancelled', 'cancelling'].includes(card.status)) return undefined
    if (card.status === 'done') throw new Error('An accepted delivery cannot be cancelled')
    card.status = 'cancelling'; card.runEpoch = (card.runEpoch ?? 0) + 1
    card.summary = 'Stopping work before cancellation'
  } else {
    if (card.status === 'active') return undefined
    if (card.status !== 'paused') throw new Error('Wait until running work has stopped before resuming')
    card.status = 'active'; card.summary = 'Resuming from saved progress'; delete card.deliveryError
    if (ownsProject(card)) card.approvedAt = now
    for (const job of card.deliveries ?? []) {
      if (job.status === 'held') {
        job.status = 'pending'; job.epoch = card.runEpoch; job.sequence = board.nextJobSequence++
      } else if (job.status === 'paused' && !jobSatisfied(card, job)) {
        job.status = 'interrupted'
        appendJob(board, card, job.botId, job.reason, job.stepId, { recovery: true, parentId: job.id, checkpoint: 'The user resumed this requirement. Inspect saved progress and existing files before continuing.' })
      }
    }
    for (const step of card.steps) if (step.status === 'paused') step.status = 'queued'
  }
  if (['pausing', 'cancelling'].includes(card.status)) {
    for (const job of card.deliveries ?? []) {
      if (['pending', 'held'].includes(job.status)) job.status = card.status === 'pausing' ? 'held' : 'cancelled'
      else if (LIVE_JOBS.has(job.status)) job.status = 'stopping'
      else if (job.status === 'paused' && card.status === 'cancelling') job.status = 'cancelled'
    }
  }
  card.controls = [...(card.controls ?? []), { id: input.requestId, command, at: now }].slice(-100)
  return command === 'board-pause' ? 'Pause requested' : command === 'board-cancel' ? 'Cancellation requested' : 'Requirement resumed'
}
