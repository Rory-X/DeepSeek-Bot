import { randomUUID } from 'node:crypto'
import { appendJob, jobSatisfied, jobsOf, LIVE_JOBS, normalizeQueue, orderedJobs, ownsProject, refreshProjectLeases } from './board-jobs.js'
import { membersOf } from './board-workflow.js'
import { installBackground, backgroundUnknownMessage } from './board-background.js'

const waiting = agent => [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
const activeAgent = agent => agent.status !== 'idle' && agent.status !== 'disposed'
const interrupted = reason => reason?.kind === 'interrupted' || (reason?.kind === 'aborted' && ['disposed', 'interrupted'].includes(reason.reason?.kind))

// Read the public Session history, never infer delivery from a local "sent" flag.
export async function deliveryFacts(rt, job, sessionId = job.sessionId) {
  if (!sessionId) return { delivered: false, active: false, queued: false }
  const agent = await rt.resolveAgent(sessionId)
  const queued = waiting(agent).some(message => message.source?.exchangeId === job.id)
  if (queued) return { agent, delivered: false, queued: true, active: false }
  const ends = new Map()
  let newestEnd, latestActivity, latestTrigger, shellCalls = 0
  for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(5000), Infinity)) {
    if (event.type === 'tool/call' && ['bash', 'pwsh'].includes(event.data?.name)) shellCalls++
    if (['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type)) latestActivity ??= event.type
    if (event.type === 'turn/end') { ends.set(event.data?.turn, event); newestEnd ??= event }
    if (event.type === 'user/message' && (event.data?.source?.role === 'board' || event.data?.source?.role === 'room' || event.data?.source?.kind === 'user')) latestTrigger ??= event.data.source
    if (event.type === 'user/message' && event.data?.source?.exchangeId === job.id) {
      const current = latestTrigger?.exchangeId === job.id
      // DSH may finish a generation before its tools finish. Only the final event
      // after those effects can establish a completed attempt.
      const end = current ? latestActivity === 'turn/end' ? newestEnd : undefined : ends.get(event.data.turn) ?? newestEnd
      const active = activeAgent(agent) && current
      return { agent, delivered: true, queued, active, busy: activeAgent(agent), turn: event.data.turn, end, shellCalls }
    }
  }
  return { agent, delivered: false, queued, active: false, busy: activeAgent(agent) }
}

export function installScheduler(rt, prompt) {
  const { ctx } = rt
  const boot = randomUUID()
  installBackground(rt, boot)
  let disposed = false, pumping, initialized = false
  const current = () => rt.state.board
  const find = id => jobsOf(current()).find(entry => entry.job.id === id)
  const note = (card, message) => {
    card.activity = [...card.activity, { id: randomUUID(), actor: 'system', at: Date.now(), text: message }].slice(-200)
    card.updatedAt = Date.now(); card.version++
  }
  const clearLease = job => { if (current().botLeases?.[job.botId] === job.id) delete current().botLeases[job.botId] }
  const finish = (card, job) => { job.status = 'finished'; job.finishedAt = Date.now(); clearLease(job); rt.forgetDelivery?.(job.id) }
  const fail = (card, job, message, uncertain = false) => {
    const changed = job.error !== message || job.status !== 'failed'
    job.status = 'failed'; job.error = message; job.mayHaveSent = uncertain; job.bootId = boot
    job.nextCheckAt = uncertain ? Date.now() + 5000 : undefined
    card.deliveryError = message
    if (!uncertain) {
      clearLease(job)
      const step = card.steps.find(step => step.id === job.stepId)
      if (step?.status === 'running') step.status = 'blocked'
    }
    if (changed) note(card, 'Task needs attention')
  }
  const recover = (card, job, checkpoint) => {
    if ((job.recoveryCount ?? 0) >= 3) { fail(card, job, 'This work was interrupted repeatedly. Review the task conversation before retrying.'); return }
    job.status = 'interrupted'; job.bootId = boot; clearLease(job); rt.forgetDelivery?.(job.id)
    if (!(card.deliveries ?? []).some(next => next.parentId === job.id)) {
      appendJob(current(), card, job.botId, job.reason, job.stepId, { recovery: true, parentId: job.id, checkpoint, sequence: job.sequence, recoveryCount: (job.recoveryCount ?? 0) + 1 })
      const step = card.steps.find(step => step.id === job.stepId)
      if (step && step.status !== 'done') step.status = 'queued'
      note(card, 'Interrupted work queued for reconciliation')
    }
    delete card.deliveryError
  }
  const busy = botId => [...rt.live].some(([id, entry]) => entry.turn !== undefined && rt.selfOf(id) === botId)
    || rt.switchJobs?.().some(job => job.botId === botId)

  async function reconcile(card, job) {
    try {
      const background = rt.boardBackground(card)
      if (rt.boardBackgroundUnknown(card)) { fail(card, job, backgroundUnknownMessage, true); return }
      if (background.length) { job.bootId = boot; job.status = 'settling'; return }
      const lease = current().botLeases[job.botId]
      if (lease && lease !== job.id && jobSatisfied(card, job)) { finish(card, job); return }
      current().botLeases[job.botId] ??= job.id
      const currentSession = rt.roomOf(card.roomId)?.sessions?.[job.botId]
      let facts = await deliveryFacts(rt, job, currentSession ?? job.sessionId)
      if (!facts.delivered && !facts.queued && !facts.busy && job.sessionId && currentSession && currentSession !== job.sessionId) {
        const old = await deliveryFacts(rt, job)
        if (old.delivered || old.queued) facts = old
      }
      job.bootId = boot
      if (facts.active || facts.queued) {
        const owner = current().botLeases[job.botId]
        if (owner && owner !== job.id) throw new Error('Two stored attempts claim the same Bot; stop one task before continuing')
        current().botLeases[job.botId] = job.id
        job.status = facts.queued ? 'sent' : 'running'
        if (facts.agent) job.sessionId = facts.agent.session.id
        if (facts.turn !== undefined) job.turn = facts.turn
        return
      }
      if (facts.busy && !facts.delivered) {
        job.status = 'recovering'; delete job.bootId; job.nextCheckAt = Date.now() + 2000
        return
      }
      if (jobSatisfied(card, job)) { finish(card, job); return }
      if (facts.shellCalls > (card.backgroundJobs ?? []).filter(record => record.attemptId === job.id).length) {
        // A crash can precede the asynchronous registry journal. Session history
        // still fences an unacknowledged shell launch, including timeout promotion.
        card.backgroundJobs ??= []
        card.backgroundJobs.push({ id: 'unconfirmed-shell', owner: job.sessionId, kind: 'shell', attemptId: job.id, status: 'unknown' })
        fail(card, job, backgroundUnknownMessage, true); return
      }
      if (!facts.delivered) {
        if (job.receivedAt !== undefined) {
          fail(card, job, 'A recorded delivery is missing from Session history. Restore or inspect that history before retrying.', true)
          return
        }
        job.status = 'pending'; delete job.error; delete job.mayHaveSent
        clearLease(job)
        note(card, 'Undelivered work returned to the queue')
      } else if (job.backgroundResolvedAt || !facts.end || interrupted(facts.end.data?.reason)) {
        recover(card, job, (job.backgroundResolvedAt ? 'The user verified the old background tasks stopped. Read their saved verification evidence. ' : 'DSH confirms the previous attempt was interrupted. ') + 'Read the saved step, Session history and existing files; do not repeat completed effects.')
      } else {
        fail(card, job, 'The previous turn ended without a completed board update. Review its task conversation before retrying.')
      }
    } catch (error) {
      fail(card, job, 'Could not reconcile task delivery: ' + String(error.message).slice(0, 350), true)
    }
  }

  async function settleControl(card) {
    const room = rt.roomOf(card.roomId)
    const ids = new Set([room?.id, ...Object.values(room?.sessions ?? {}), ...(card.deliveries ?? []).filter(job => LIVE_JOBS.has(job.status)).map(job => job.sessionId)].filter(Boolean))
    let stopped = true
    for (const id of ids) {
      try {
        const agent = await rt.resolveAgent(id)
        for (const message of waiting(agent)) {
          agent.inbox.remove(message.id)
          if (message.source?.exchangeId) rt.forgetDelivery?.(message.source.exchangeId)
        }
        await ctx.sessions.flush(agent.session)
        if (activeAgent(agent) || rt.live.get(id)?.turn !== undefined) {
          agent.cancel({ kind: 'hook', reason: 'ds-bot/board-stop' })
          stopped = false
        }
      } catch (error) {
        if (error.code !== 'session/not-found') { stopped = false; card.deliveryError = 'Waiting for task shutdown: ' + String(error.message).slice(0, 350) }
      }
    }
    if (card.roomId && rt.switchJobs?.().some(job => job.roomId === card.roomId)) stopped = false
    try {
      if (rt.boardBackground(card, { stop: true }).length) stopped = false
      if (rt.boardBackgroundUnknown(card)) card.deliveryError = backgroundUnknownMessage
    } catch (error) { stopped = false; card.deliveryError = 'Waiting for background task shutdown: ' + String(error.message).slice(0, 350) }
    if (!stopped) return
    const cancelled = card.status === 'cancelling'
    for (const job of card.deliveries ?? []) {
      if (LIVE_JOBS.has(job.status)) {
        job.status = jobSatisfied(card, job) ? 'finished' : cancelled ? 'cancelled' : 'paused'
        rt.forgetDelivery?.(job.id)
      }
      if (cancelled && ['held', 'pending', 'paused', 'failed'].includes(job.status)) job.status = 'cancelled'
      clearLease(job)
    }
    for (const step of card.steps) if (step.status !== 'done') step.status = cancelled ? 'cancelled' : step.status === 'running' ? 'paused' : step.status
    if (cancelled) for (const decision of card.decisions) if (decision.status === 'open') decision.status = 'cancelled'
    card.status = cancelled ? 'cancelled' : 'paused'
    card.summary = cancelled ? 'Cancelled; deliverables and history retained' : 'Paused; progress retained'
    delete card.deliveryError
    note(card, cancelled ? 'Requirement cancelled' : 'Requirement paused')
  }

  async function dispatch(card, job) {
    if (current().botLeases[job.botId] || busy(job.botId)) return
    if (ownsProject(card) && current().projectLeases[card.projectPath] !== card.id) return
    try {
      const project = ctx.workspaceRegistry.get(card.projectId)
      if (!project || project.path !== card.projectPath || !await rt.isFolder(card.projectPath)) throw new Error('The registered project directory is no longer available')
      const dir = await rt.cleanWorkDir(card.projectPath)
      if (membersOf(card).some(id => !rt.botOf(id))) throw new Error('An assigned Bot is no longer on the team')
      let room = card.roomId ? rt.roomOf(card.roomId) : Object.values(rt.state.rooms).find(room => room.boardCardId === card.id)
      if (card.roomId && !room) throw new Error('The task conversation was removed')
      if (!room) room = await rt.createRoom({ members: membersOf(card), name: `#${card.number} ${card.title}`.slice(0, 60), admin: card.leadId, mode: 'admin', boardCardId: card.id })
      card.roomId = room.id; room.workDir = dir ?? card.projectPath
      await rt.save()
      const session = await rt.groupSessionFor(room, rt.botOf(job.botId))
      if (!session) throw new Error('The assigned Bot left the task conversation')
      const agent = await rt.resolveAgent(session.id)
      if (activeAgent(agent) || waiting(agent).length) return
      job.sessionId = session.id; job.status = 'sending'; job.bootId = boot; job.epoch = card.runEpoch ?? 0
      current().botLeases[job.botId] = job.id
      const step = card.steps.find(step => step.id === job.stepId)
      if (step) step.status = 'running'
      // Persist the lease and stable message id before any Agent can take this work.
      await rt.save()
      await rt.deliver({ toId: job.botId, sessionId: session.id, roomId: room.id, role: 'board', exchangeId: job.id, text: prompt(card, job) })
      job.status = 'sent'; job.sentAt = Date.now()
      delete card.deliveryError
      await rt.save()
    } catch (error) {
      fail(card, job, String(error.message).slice(0, 400), job.status === 'sending')
      await rt.save()
    }
  }

  const run = async () => {
    await rt.load()
    if (!current() || rt.readOnly() !== undefined || disposed) return
    if (!initialized) {
      await rt.boardWrite(async () => {
        const board = current()
        normalizeQueue(board)
        for (const [bot, id] of Object.entries(board.botLeases)) if (!find(id)) delete board.botLeases[bot]
        initialized = true
        await rt.save()
      })
    }
    const unfinished = orderedJobs(current()).filter(({ card, job }) => LIVE_JOBS.has(job.status)
      || (job.status === 'failed' && job.mayHaveSent)
      || (job.status === 'interrupted' && !card.deliveries.some(child => child.parentId === job.id)))
    for (const entry of unfinished) {
      if (disposed) return
      await rt.boardWrite(async () => {
        const { card, job } = find(entry.job.id) ?? {}
        if (!job) return
        if (card.status === 'done' && LIVE_JOBS.has(job.status)) {
          const agent = await rt.resolveAgent(job.sessionId)
          if (!activeAgent(agent) && rt.live.get(job.sessionId)?.turn === undefined && !rt.boardBackground(card).length) { finish(card, job); await rt.save() }
          return
        }
        if (card.status !== 'active') return
        const needsRecovery = (LIVE_JOBS.has(job.status) || job.status === 'interrupted') && job.bootId !== boot && Date.now() >= (job.nextCheckAt ?? 0) && !card.deliveries.some(child => child.parentId === job.id)
        const uncertain = job.status === 'failed' && job.mayHaveSent && Date.now() >= (job.nextCheckAt ?? 0)
        if (needsRecovery || uncertain) { await reconcile(card, job); await rt.save(); return }
        if (job.status === 'settling') {
          if (rt.boardBackground(card).length) {
            if (rt.boardBackgroundUnknown(card)) fail(card, job, backgroundUnknownMessage, true)
            await rt.save(); return
          }
          const agent = await rt.resolveAgent(job.sessionId)
          if (activeAgent(agent) || rt.live.get(job.sessionId)?.turn !== undefined || rt.switchJobs?.().some(item => item.roomId === card.roomId && item.botId === job.botId)) return
          if (jobSatisfied(card, job)) finish(card, job)
          else if (interrupted(job.endReason)) recover(card, job, 'The turn was interrupted. Inspect existing results before continuing.')
          else fail(card, job, job.endReason?.kind === 'error' ? 'The Bot turn failed; inspect its task conversation and retry after resolving the cause.' : 'The Bot stopped without reporting a completed step. Inspect its progress before retrying.')
          await rt.save()
        }
      })
    }
    for (const original of Object.values(current().cards)) {
      if (disposed) return
      if (!['pausing', 'cancelling'].includes(original.status)) continue
      await rt.boardWrite(async () => { const card = current().cards[original.id]; await settleControl(card); await rt.save() })
    }
    await rt.boardWrite(async () => {
      const before = JSON.stringify(current().projectLeases)
      refreshProjectLeases(current())
      if (before !== JSON.stringify(current().projectLeases)) await rt.save()
    })
    for (const entry of orderedJobs(current()).filter(({ card, job }) => card.status === 'active' && job.status === 'pending')) {
      if (disposed) return
      await rt.boardWrite(async () => {
        const { card, job } = find(entry.job.id) ?? {}
        if (job?.status === 'pending' && card.status === 'active') await dispatch(card, job)
      })
    }
  }
  const pump = () => {
    if (pumping || disposed || !rt.state.board) return pumping ?? Promise.resolve()
    pumping = run().catch(error => { if (!disposed) rt.warn('ds-bot: board scheduler failed: %s', error) }).finally(() => { pumping = undefined })
    return pumping
  }
  rt.boardExecution = sessionId => {
    if (rt.readOnly() !== undefined) return undefined
    const owner = rt.groupOwners.get(sessionId)
    if (!owner) return undefined
    const found = find(current()?.botLeases?.[owner.botId])
    if (!found || found.card.roomId !== owner.roomId || found.job.sessionId !== sessionId || found.card.status !== 'active'
      || found.job.bootId !== boot || found.job.epoch !== (found.card.runEpoch ?? 0) || !['sent', 'running', 'settling'].includes(found.job.status)) return undefined
    return found
  }
  rt.boardReconcileWork = (sessionId, observations, references) => rt.boardWrite(async () => {
    const found = rt.boardExecution(sessionId)
    if (!found || !found.job.recovery) throw new Error('There is no assigned recovery attempt')
    if (found.job.reconciled) return found.card
    if (typeof observations !== 'string' || !observations.trim() || observations.length > 6000 || !Array.isArray(references) || !references.length || references.length > 10 || references.some(value => typeof value !== 'string' || !value.trim() || value.length > 2000)) throw new Error('Record observed progress and 1 to 10 references before resuming')
    found.job.reconciled = { at: Date.now(), observations: observations.trim(), references }
    note(found.card, 'Saved progress reconciled')
    await rt.save()
    return found.card
  })
  rt.boardPump = pump
  rt.drainBoard = () => { void pump() }
  ctx.on('session/event', (session, event) => {
    if (disposed || !current() || !['user/message', 'turn/start', 'turn/end'].includes(event.type)) return
    const received = event.type === 'user/message' && event.data?.source?.role === 'board' ? event.data.source.exchangeId : undefined
    const jobIds = received ? [received] : jobsOf(current()).filter(({ job }) => LIVE_JOBS.has(job.status) && job.sessionId === session?.id && (event.type === 'turn/start' || job.turn === undefined || event.data?.turn === undefined || job.turn === event.data.turn)).map(({ job }) => job.id)
    if (!jobIds.length) return
    void rt.boardWrite(async () => {
      for (const id of jobIds) {
        const { card, job } = find(id) ?? {}
        if (!job || !LIVE_JOBS.has(job.status)) continue
        if (received || event.type === 'turn/start') {
          job.sessionId = session.id; job.turn = event.data.turn ?? rt.live.get(session.id)?.turn ?? job.turn
          if (received) job.receivedAt = event.time ?? Date.now()
          if (card.status === 'active') job.status = 'running'
        } else {
          job.endReason = event.data?.reason ?? { kind: 'completed' }
          if (card.status === 'active') job.status = 'settling'
        }
      }
      await rt.save()
    }).then(() => rt.drainBoard()).catch(error => { if (!disposed) rt.warn('ds-bot: board event could not be saved: %s', error) })
  })
  ctx.effect(() => {
    const timer = setInterval(() => void pump(), 1000)
    timer.unref?.()
    return () => { disposed = true; clearInterval(timer); return pumping }
  }, 'ds-bot: requirement delivery')
}
