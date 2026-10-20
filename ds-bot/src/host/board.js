// Persistent project requirements. Dispatch is deliberately a separate operation:
// saving a draft must never start a Bot or change its working directory.
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { own } from './store.js'
import { workflowChange } from './board-workflow.js'
import { normalizeQueue, queueView } from './board-jobs.js'
import { stageProgress } from '../shared/board-stages.js'

export const emptyBoard = () => ({ version: 1, nextNumber: 1, nextJobSequence: 1, cards: {} })
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const field = (value, name, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw invalid('Invalid ' + name)
  return value.trim()
}

export function boardColumn(card) {
  if (card.status === 'done') return 'done'
  if (card.status === 'cancelled') return 'backlog'
  if (card.deliveryError) return 'needs-you'
  if (['paused', 'pausing', 'cancelling'].includes(card.status)) return 'in-progress'
  if ((card.decisions ?? []).some(item => item.status === 'open')) return 'needs-you'
  return card.status === 'backlog' ? 'backlog' : 'in-progress'
}

export function draftFields(input, bots) {
  const title = field(input.title, 'requirement title', 180, true)
  const description = field(input.description ?? '', 'description', 12000)
  const acceptance = field(input.acceptance ?? '', 'acceptance criteria', 8000)
  const leadId = field(input.leadId, 'lead Bot', 200, true)
  if (!own(bots, leadId)) throw invalid('Choose a lead Bot from this team')
  if (!Array.isArray(input.collaboratorIds ?? [])) throw invalid('Invalid collaborators')
  const collaboratorIds = [...new Set(input.collaboratorIds ?? [])].filter(id => id !== leadId)
  if (collaboratorIds.length > 11 || collaboratorIds.some(id => typeof id !== 'string' || !own(bots, id))) throw invalid('Choose up to 11 collaborators from this team')
  return { title, description, acceptance, leadId, collaboratorIds }
}

export function createDraft(board, input, { projects, bots, now = Date.now(), id = randomUUID(), actor = 'user' }) {
  const project = projects.find(item => item.id === input.projectId)
  if (!project) throw invalid('Choose a registered DSH project')
  const requestId = field(input.requestId, 'request identifier', 100, true)
  const data = draftFields(input, bots)
  const previous = Object.values(board.cards).find(card => card.requestId === requestId)
  if (previous) {
    if (previous.projectId !== project.id || Object.keys(data).some(key => JSON.stringify(previous[key]) !== JSON.stringify(data[key]))) throw invalid('This request identifier was already used for another draft')
    return { board, card: previous }
  }
  const card = {
    id, number: board.nextNumber, requestId, projectId: project.id, projectPath: project.path,
    ...data, version: 1, status: 'backlog', stage: 'confirmation', createdAt: now, updatedAt: now,
    steps: [], decisions: [], artifacts: [], activity: [{ id: randomUUID(), at: now, actor, text: 'Requirement created' }],
  }
  return { board: { ...board, nextNumber: board.nextNumber + 1, cards: { ...board.cards, [id]: card } }, card }
}

export function editDraft(board, input, { bots, now = Date.now() }) {
  const previous = own(board.cards, input.id)
  if (!previous) throw invalid('This requirement no longer exists')
  if (previous.version !== input.version) throw invalid('This requirement changed in another window. Reopen it before saving.')
  if (previous.status !== 'backlog') throw invalid('Active requirements need a reviewed revision')
  const data = draftFields({ collaboratorIds: previous.collaboratorIds, ...input }, bots)
  const card = {
    ...previous, ...data, version: previous.version + 1, updatedAt: now,
    activity: [...previous.activity, { id: randomUUID(), at: now, actor: 'user', text: 'Draft updated' }],
  }
  return { board: { ...board, cards: { ...board.cards, [card.id]: card } }, card }
}

export function install(rt) {
  let writing = Promise.resolve()
  const current = () => rt.state.board ?? emptyBoard()
  const projects = () => (rt.ctx.workspaceRegistry.list?.() ?? [])
    .filter(project => typeof project.id === 'string' && typeof project.path === 'string')
    .map(project => ({ id: project.id, path: project.path, title: project.title || basename(project.path) || project.path }))
    .sort((a, b) => a.title.localeCompare(b.title))
  const pending = () => Object.values(current().cards).filter(card => boardColumn(card) === 'needs-you').length
  const view = () => {
    const cards = Object.values(current().cards)
    return {
      revision: rt.state.revision, readOnly: rt.readOnly() ?? null,
      projects: projects().map(project => ({
        ...project, pending: cards.filter(card => card.projectId === project.id && boardColumn(card) === 'needs-you').length,
      })),
      cards: cards.map(card => ({ ...card, column: boardColumn(card), stageProgress: stageProgress(card) })),
      queue: queueView(current(), new Set([...(rt.live ?? [])].filter(([, entry]) => entry.turn !== undefined).map(([id]) => rt.selfOf(id)))),
    }
  }
  const write = job => {
    const operation = writing.then(async () => {
      await rt.refresh()
      const reason = rt.readOnly()
      if (reason !== undefined) throw Object.assign(new Error(reason), { code: 'bot/read-only' })
      return job()
    })
    writing = operation.catch(() => {})
    return operation
  }
  const mutate = (kind, body, actor = 'user', execution) => write(async () => {
      if (execution && rt.boardExecution?.(execution.sessionId)?.job.id !== execution.jobId) throw invalid('This execution attempt is no longer assigned')
      const before = current()
      const previous = before.cards[body.id]
      if (previous && (kind === 'board-submit' || (kind === 'board-step' && body.status === 'done')) && rt.boardBackground?.(previous).length) throw invalid('Collect or stop background tasks before reporting completion')
      normalizeQueue(before)
      const context = { projects: projects(), bots: rt.state.bots, actor }
      if (kind === 'board-edit' && actor !== 'user') throw invalid('Only the user can edit a draft')
      const { board, card } = kind === 'board-create' ? createDraft(before, body, context)
        : kind === 'board-edit' ? editDraft(before, body, context)
          : workflowChange(before, kind, body, { ...context, actor })
      if (board === before) return card
      // Team and conversation membership share one durable write. Keep old Sessions
      // for history; membership and execution guards revoke a removed Bot's access.
      const room = kind === 'board-assign' && card.roomId ? rt.roomOf(card.roomId) : undefined
      if (kind === 'board-assign' && card.roomId && (!room || room.boardCardId !== card.id)) throw invalid('The task conversation is no longer available')
      if (kind === 'board-assign' && rt.boardBackground?.(previous).length) throw invalid('Wait for background tasks to stop before changing the team')
      const previousMembers = room?.members
      const members = [card.leadId, ...card.collaboratorIds]
      if (execution) {
        const job = card.deliveries.find(job => job.id === execution.jobId)
        if (job && kind === 'board-question' && job.stepId) {
          const step = card.steps.find(step => step.id === job.stepId)
          if (step?.status === 'running') step.status = 'blocked'
          job.outcome = kind
        } else if (job && ((!job.stepId && ['board-plan', 'board-question', 'board-submit', 'board-resume-step'].includes(kind))
          || (kind === 'board-step' && ['done', 'blocked'].includes(body.status) && (!job.stepId || job.stepId === body.stepId)))) job.outcome = kind
      }
      rt.state.board = board
      if (room) room.members = members
      try { await rt.save() } catch (error) {
        if (rt.state.board === board) rt.state.board = before
        if (room?.members === members) room.members = previousMembers
        throw error
      }
      rt.drainBoard?.()
      return card
    })
  const addProject = body => write(async () => {
    const input = field(body.path, 'project folder', 4000, true)
    const title = field(body.title ?? '', 'project name', 100)
    const path = await rt.cleanWorkDir(input) ?? await rt.real(rt.teamFolder())
    const registry = rt.ctx.workspaceRegistry
    const project = await registry.resolveByPath(path) ?? await registry.create(path, title || basename(path) || path)
    return { id: project.id, path: project.path, title: project.title || basename(project.path) || project.path }
  })
  Object.assign(rt, { boardView: view, boardPending: pending, boardMutate: mutate, boardWrite: write, boardAddProject: addProject })
}
