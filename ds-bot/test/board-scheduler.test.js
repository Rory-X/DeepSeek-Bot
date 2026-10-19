import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installBoard, boardColumn, emptyBoard } from '../src/host/board.js'
import { installScheduler } from '../src/host/board-scheduler.js'
import { appendJob, queueView } from '../src/host/board-jobs.js'
import { fakeContext } from './fake-ctx.js'

function fixture(saved, shared) {
  const ctx = fakeContext()
  const history = shared?.history ?? new Map(), agents = shared?.agents ?? new Map(), sent = shared?.sent ?? []
  const state = saved ?? { revision: 1, board: emptyBoard(), bots: { dev: { id: 'dev' }, other: { id: 'other' }, lead: { id: 'lead' } }, rooms: {} }
  let stopDelay = false, historyFailure = false, saveFailure = false
  const rt = { ctx, state, live: new Map(), groupOwners: new Map(), load: async () => {}, refresh: async () => {}, readOnly: () => undefined,
    save: async () => { if (saveFailure) throw new Error('disk full'); state.revision++ },
    own: (obj, id) => Object.hasOwn(obj, id) ? obj[id] : undefined, botOf: id => state.bots[id], roomOf: id => state.rooms[id],
    selfOf: id => rt.groupOwners.get(id)?.botId, warn() {}, forgetDelivery() {}, switchJobs: () => [],
    isFolder: async () => true, cleanWorkDir: async path => path,
    createRoom: async args => {
      const room = { id: 'room-' + args.boardCardId, boardCardId: args.boardCardId, members: args.members, sessions: {} }
      state.rooms[room.id] = room; return room
    },
    groupSessionFor: async (room, bot) => {
      const id = room.sessions[bot.id] ??= room.id + '-' + bot.id
      rt.groupOwners.set(id, { botId: bot.id, roomId: room.id }); agent(id); return { id }
    },
    resolveAgent: async id => agent(id),
    async *eventsBackwards(id) { if (historyFailure) throw new Error('session history unavailable'); yield* [...(history.get(id) ?? [])].reverse() },
    deliver: async args => { sent.push(args); agent(args.sessionId).inbox.nextTurn.push({ id: args.exchangeId, source: { role: 'board', exchangeId: args.exchangeId } }) },
  }
  const projects = [{ id: 'p', path: '/p' }, { id: 'q', path: '/q' }]
  ctx.workspaceRegistry = { list: () => projects, get: id => projects.find(project => project.id === id) }
  ctx.sessions = { flush: async () => {} }
  const processes = new Map(), jobListeners = new Set(), killed = []
  let killError
  ctx.jobs = {
    list: owner => [...processes.values()].filter(job => !job.owner || job.owner === owner).map(job => ({ ...job })),
    kill(id, owner) { if (killError) throw new Error(killError); const job = processes.get(id); assert.equal(job.owner, owner); killed.push(id); job.status = 'stopping' },
    events: { subscribe(_filter, listener) { jobListeners.add(listener); return () => jobListeners.delete(listener) } },
  }
  const processEvent = async (job, type = 'registered') => {
    processes.set(job.id, { ...job })
    for (const listener of jobListeners) listener({ type, job: { ...job } })
    await rt.boardWrite(async () => {})
  }
  const emit = (id, event) => {
    history.set(id, [...(history.get(id) ?? []), event])
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, event)
  }
  const agent = id => {
    if (!agents.has(id)) agents.set(id, { status: 'idle', session: { id }, inbox: { nextStep: [], nextTurn: [], remove(messageId) { this.nextTurn = this.nextTurn.filter(message => message.id !== messageId); return true } }, cancel() {} })
    const result = agents.get(id)
    result.cancel = () => { if (!stopDelay) { result.status = 'idle'; rt.live.delete(id); emit(id, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook' } } } }) } }
    return result
  }
  for (const room of Object.values(state.rooms)) for (const [botId, id] of Object.entries(room.sessions)) rt.groupOwners.set(id, { botId, roomId: room.id })
  installBoard(rt); installScheduler(rt, (_card, job) => job.reason)
  const pump = async () => { await rt.boardPump(); await rt.boardWrite(async () => {}); await rt.boardPump() }
  const take = async job => {
    const current = agent(job.sessionId); current.inbox.nextTurn = []; current.status = 'running'
    rt.live.set(job.sessionId, { turn: 1, info: { exchangeId: job.id } })
    emit(job.sessionId, { type: 'turn/start', data: { turn: 1 } })
    emit(job.sessionId, { type: 'user/message', data: { turn: 1, source: { role: 'board', exchangeId: job.id } } })
    await rt.boardWrite(async () => {})
  }
  const end = async (job, reason = { kind: 'completed' }) => {
    agent(job.sessionId).status = 'idle'; rt.live.delete(job.sessionId)
    emit(job.sessionId, { type: 'turn/end', data: { turn: 1, reason } })
    await rt.boardWrite(async () => {}); await pump()
  }
  const add = (id, bot = 'dev', project = 'p') => {
    const card = { id, number: Object.keys(state.board.cards).length + 1, projectId: project, projectPath: '/' + project,
      title: id, description: id, acceptance: 'Check output', leadId: 'lead', collaboratorIds: [bot], status: 'active', stage: 'implementation', version: 1,
      planVersion: 1, approvedPlan: 1, approvedAt: Date.now(), createdAt: Date.now(), activity: [], decisions: [], artifacts: [], steps: [
        { id: 'build', title: 'Build', phase: 'implementation', assigneeId: bot, scope: id + '.txt', status: 'queued', dependsOn: [] },
        { id: 'verify', title: 'Verify', phase: 'validation', assigneeId: 'lead', scope: id + '.txt', status: 'queued', dependsOn: ['build'] },
      ] }
    state.board.cards[id] = card
    appendJob(state.board, card, bot, 'Build', 'build')
    return card
  }
  return { rt, ctx, state, add, pump, take, end, sent, history, agents, emit, agent, processes, processEvent, killed, breakKill: value => { killError = value },
    stop: () => ctx.dispose(), delayStop: value => { stopDelay = value }, breakHistory: value => { historyFailure = value }, breakSave: value => { saveFailure = value } }
}
const control = (f, card, command, requestId = command) => f.rt.boardMutate(command, { id: card.id, requestId })

test('a durable Bot lease prevents double dispatch even before the first message is consumed', async t => {
  const f = fixture(); t.after(f.stop)
  const a = f.add('A'), b = f.add('B', 'dev', 'q')
  await f.pump(); await f.pump()
  assert.equal(f.sent.length, 1)
  assert.equal(a.deliveries[0].status, 'sent')
  assert.equal(b.deliveries[0].status, 'pending')
  assert.equal(queueView(f.state.board).find(item => item.cardId === 'B').blockedBy, 'bot')
})

test('an end event does not revoke execution or release the Bot while the Agent is still running', async t => {
  const f = fixture(); t.after(f.stop); const card = f.add('A'); f.add('B', 'dev', 'q')
  await f.pump(); const job = card.deliveries[0]; await f.take(job)
  f.emit(job.sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await f.rt.boardWrite(async () => {}); await f.pump()
  assert.equal(f.rt.boardExecution(job.sessionId).job.id, job.id)
  assert.equal(f.sent.length, 1)
  await f.rt.boardMutate('board-step', { id: card.id, version: card.version, stepId: 'build', status: 'done', summary: 'Saved', evidence: '/p/A.txt' }, 'dev', { sessionId: job.sessionId, jobId: job.id })
  await f.end(job)
  assert.equal(f.state.board.cards.A.steps[0].status, 'done')
})

test('an unrelated active turn is not mistaken for a previously completed delivery', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]
  await first.take(job)
  first.history.get(job.sessionId).push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, { type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: { turn: 2, source: { kind: 'user' } } })
  await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop)
  await next.pump()
  assert.equal(next.state.board.cards.A.deliveries[0].status, 'failed')
  assert.equal(next.sent.length, 1)
})

test('project reservations serialize different Bots, while unrelated projects can run', async t => {
  const f = fixture(); t.after(f.stop)
  f.add('A'); f.add('B', 'other'); f.add('C', 'other', 'q')
  await f.pump()
  assert.deepEqual(f.sent.map(job => job.toId), ['dev', 'other'])
  assert.equal(queueView(f.state.board).find(item => item.cardId === 'B').blockedBy, 'project')
})

test('paused work is labelled as paused and does not count ahead of executable work', async t => {
  const f = fixture(); t.after(f.stop)
  const a = f.add('A'); f.add('B')
  a.status = 'paused'; a.deliveries[0].status = 'paused'; f.state.board.projectLeases = { '/p': 'B' }
  const queue = queueView(f.state.board)
  assert.equal(queue.find(item => item.cardId === 'A').blockedBy, undefined)
  assert.equal(queue.find(item => item.cardId === 'A').state, 'held')
  assert.equal(queue.find(item => item.cardId === 'B').position, 1)
  assert.equal(boardColumn({ status: 'pausing', deliveryError: 'Could not stop the Session' }), 'needs-you')
})

test('acceptance during the last active turn releases capacity only after that Agent becomes idle', async t => {
  const f = fixture(); t.after(f.stop)
  const a = f.add('A'); f.add('B', 'other')
  await f.pump(); const job = a.deliveries[0]; await f.take(job)
  a.status = 'done'; job.outcome = 'board-submit'
  await f.pump()
  assert.equal(f.state.board.projectLeases['/p'], a.id)
  assert.equal(f.sent.length, 1)
  await f.end(job)
  assert.equal(f.state.board.botLeases.dev, undefined)
  assert.equal(f.sent.length, 2)
})

test('pausing holds leases until cancellation is acknowledged, then resumes with a recovery checkpoint', async t => {
  const f = fixture(); t.after(f.stop)
  const a = f.add('A'); f.add('B', 'dev', 'q')
  await f.pump(); const job = a.deliveries[0]; await f.take(job)
  f.delayStop(true)
  await control(f, a, 'board-pause'); await f.pump()
  assert.equal(f.state.board.cards.A.status, 'pausing')
  assert.equal(f.sent.length, 1)
  assert.equal(f.state.board.botLeases.dev, job.id)
  f.delayStop(false); await f.pump(); await f.pump()
  assert.equal(f.state.board.cards.A.status, 'paused')
  assert.equal(f.sent.length, 2)
  await control(f, a, 'board-resume'); await f.pump()
  const resume = f.state.board.cards.A.deliveries.find(item => item.parentId === job.id)
  assert.equal(resume.status, 'pending'); assert.equal(resume.recovery, true)
  assert.equal(resume.epoch, 1)
  await control(f, a, 'board-pause')
  assert.equal(f.state.board.cards.A.status, 'active', 'replaying the old pause request must not pause a resumed task')
  await assert.rejects(f.rt.boardMutate('board-step', { id: a.id, version: f.state.board.cards.A.version, stepId: 'build', status: 'done', summary: 'old callback', evidence: 'x' }, 'dev', { sessionId: job.sessionId, jobId: job.id }), /no longer assigned/)
})

test('cancel is idempotent, retains artifacts, clears pending decisions, and never marks Done', async t => {
  const f = fixture(); t.after(f.stop)
  const a = f.add('A'); a.artifacts.push({ id: 'artifact', title: 'Saved work' }); a.decisions.push({ status: 'open' })
  await control(f, a, 'board-cancel', 'same-click'); await f.pump()
  const after = f.state.board.cards.A
  assert.equal(after.status, 'cancelled'); assert.equal(after.artifacts.length, 1); assert.equal(after.decisions[0].status, 'cancelled')
  assert.equal(boardColumn(after), 'backlog')
  await control(f, after, 'board-cancel', 'same-click'); await f.pump()
  assert.equal(f.sent.length, 0)
  await assert.rejects(control(f, after, 'board-resume'), /stopped before resuming/)
})

test('an unstarted draft can be cancelled without creating a conversation', async t => {
  const f = fixture(); t.after(f.stop)
  const card = await f.rt.boardMutate('board-create', { projectId: 'p', requestId: 'draft', title: 'Draft', description: '', acceptance: '', leadId: 'lead', collaboratorIds: [] })
  await control(f, card, 'board-cancel'); await f.pump()
  assert.equal(f.state.board.cards[card.id].status, 'cancelled')
  assert.equal(f.sent.length, 0); assert.equal(Object.keys(f.state.rooms).length, 0)
})

test('restart adopts a durable inbox message without resending it', async t => {
  const first = fixture(); first.add('A'); await first.pump(); await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop)
  await next.pump(); await next.pump()
  assert.equal(next.sent.length, 1)
  assert.equal(next.state.board.cards.A.deliveries[0].status, 'sent')
})

test('restart proves an unsent attempt absent and delivers the same stable id exactly once', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]
  first.agent(job.sessionId).inbox.nextTurn = []; first.sent.length = 0; job.status = 'sending'
  await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop)
  await next.pump(); await next.pump()
  assert.deepEqual(next.sent.map(item => item.exchangeId), [job.id])
})

test('interrupted received work creates one recovery attempt and records reconciliation before continuing', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]
  await first.take(job); first.agent(job.sessionId).status = 'idle'; first.rt.live.clear(); await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop)
  await next.pump(); await next.pump()
  const jobs = next.state.board.cards.A.deliveries
  assert.equal(jobs.length, 2); assert.equal(jobs[1].parentId, job.id); assert.equal(jobs[1].recovery, true)
  assert.equal(next.sent.filter(item => item.exchangeId === job.id).length, 1)
  await next.take(jobs[1])
  await assert.rejects(next.rt.boardReconcileWork(jobs[1].sessionId, 'Maybe', []), /references/)
  await next.rt.boardReconcileWork(jobs[1].sessionId, 'Output already exists; verify it without rewriting.', ['/p/A.txt'])
  assert.match(jobs[1].reconciled.observations, /already exists/)
})

test('a saved completion receipt survives a crash without running the completed step again', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]
  await first.take(job); job.outcome = 'board-step'; first.state.board.cards.A.steps[0].status = 'done'
  first.agent(job.sessionId).status = 'idle'; first.rt.live.clear(); await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop)
  await next.pump()
  assert.equal(next.sent.length, 1)
  assert.equal(next.state.board.cards.A.deliveries[0].status, 'finished')
})

test('a crash after a generation ended but before tool completion still requires reconciliation', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]
  await first.take(job)
  first.history.get(job.sessionId).push({ type: 'turn/end', data: { reason: { kind: 'completed' } } }, { type: 'tool/call', data: { name: 'write' } }, { type: 'tool/result', data: {} })
  first.agent(job.sessionId).status = 'idle'; first.rt.live.clear(); await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop)
  await next.pump()
  assert.equal(next.state.board.cards.A.deliveries[1].recovery, true)
  assert.equal(next.state.board.cards.A.deliveries[1].sequence, job.sequence)
})

test('unreadable history fails closed and retains the lease instead of replaying uncertain work', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]
  first.agent(job.sessionId).inbox.nextTurn = []; first.state.board.botLeases = {}; await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop); next.breakHistory(true)
  await next.pump()
  assert.equal(next.sent.length, 1)
  assert.equal(next.state.board.botLeases.dev, job.id)
  assert.equal(next.state.board.cards.A.deliveries[0].mayHaveSent, true)
  assert.equal(boardColumn(next.state.board.cards.A), 'needs-you')
})

test('the interrupted marker written by DSH on reopening a crashed Session resumes exactly once', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]
  await first.take(job)
  first.history.get(job.sessionId).push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } })
  first.agent(job.sessionId).status = 'idle'; first.rt.live.clear(); await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop)
  await next.pump(); await next.pump()
  assert.equal(next.state.board.cards.A.deliveries.filter(item => item.parentId === job.id).length, 1)
  assert.equal(next.sent.filter(item => item.exchangeId === job.id).length, 1)
})

test('a repeated restart loop stops for review instead of generating unlimited continuations', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]
  await first.take(job); job.recoveryCount = 3
  first.agent(job.sessionId).status = 'idle'; first.rt.live.clear(); await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop)
  await next.pump()
  assert.equal(next.state.board.cards.A.deliveries.length, 1)
  assert.match(next.state.board.cards.A.deliveryError, /interrupted repeatedly/)
})

test('missing history contradicting a saved receipt is not treated as proof that nothing ran', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]
  await first.take(job); first.history.set(job.sessionId, []); first.agent(job.sessionId).status = 'idle'; first.rt.live.clear(); await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop)
  await next.pump()
  assert.equal(next.sent.length, 1)
  assert.equal(next.state.board.botLeases.dev, job.id)
  assert.match(next.state.board.cards.A.deliveryError, /recorded delivery is missing/)
})

test('an ordinary turn ending without a board result becomes actionable, not completed or auto-retried', async t => {
  const f = fixture(); t.after(f.stop); f.add('A'); await f.pump(); const job = f.state.board.cards.A.deliveries[0]
  await f.take(job); await f.end(job)
  assert.equal(f.state.board.cards.A.status, 'active'); assert.equal(job.status, 'failed')
  assert.equal(boardColumn(f.state.board.cards.A), 'needs-you'); assert.equal(f.sent.length, 1)
})

test('a failed durable write starts no Agent', async t => {
  const f = fixture(); t.after(f.stop); f.add('A'); f.breakSave(true); await f.pump()
  assert.equal(f.sent.length, 0)
})

test('an idle Agent with a live shell keeps its lease and cannot report completion', async t => {
  const f = fixture(); t.after(f.stop); const a = f.add('A'); f.add('B', 'dev', 'q')
  await f.pump(); const job = a.deliveries[0]; await f.take(job)
  await f.processEvent({ id: 'bash-1', owner: job.sessionId, kind: 'bash', startedAt: 1, status: 'running' })
  await f.end(job)
  assert.equal(f.sent.length, 1)
  await assert.rejects(f.rt.boardMutate('board-step', { id: a.id, version: a.version, stepId: 'build', status: 'done', summary: 'early', evidence: 'not finished' }, 'dev', { sessionId: job.sessionId, jobId: job.id }), /background tasks/)
  await control(f, a, 'board-pause'); await f.pump()
  assert.deepEqual(f.killed, ['bash-1'])
  assert.equal(f.state.board.cards.A.status, 'pausing')
  await f.processEvent({ ...f.processes.get('bash-1'), status: 'killed', finishedAt: 2 }, 'settled'); await f.pump()
  assert.equal(f.state.board.cards.A.status, 'paused')
  assert.equal(f.sent.length, 2)
})

test('cancelling only stops jobs owned by the requirement, and waits through kill failures', async t => {
  const f = fixture(); t.after(f.stop); const a = f.add('A'); await f.pump(); const job = a.deliveries[0]
  await f.processEvent({ id: 'bash-1', owner: job.sessionId, kind: 'bash', startedAt: 1, status: 'running' })
  f.processes.set('bash-2', { id: 'bash-2', kind: 'bash', status: 'running' })
  f.processes.set('bash-3', { id: 'bash-3', owner: 'unrelated', kind: 'bash', status: 'running' })
  f.breakKill('permission denied'); await control(f, a, 'board-cancel'); await f.pump()
  assert.equal(f.state.board.cards.A.status, 'cancelling')
  assert.match(f.state.board.cards.A.deliveryError, /permission denied/)
  f.breakKill(); await f.pump(); assert.deepEqual(f.killed, ['bash-1'])
  await f.processEvent({ ...f.processes.get('bash-1'), status: 'killed', finishedAt: 2 }, 'settled'); await f.pump()
  assert.equal(f.state.board.cards.A.status, 'cancelled')
  assert.equal(f.processes.get('bash-2').status, 'running')
  assert.equal(f.processes.get('bash-3').status, 'running')
})

test('a fresh host never adopts a recycled job id or replays an unobservable shell', async t => {
  const first = fixture(); const a = first.add('A'); await first.pump(); const job = a.deliveries[0]; await first.take(job)
  await first.processEvent({ id: 'bash-1', owner: job.sessionId, kind: 'bash', startedAt: 1, status: 'running' })
  first.agent(job.sessionId).status = 'idle'; await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop)
  next.processes.set('bash-1', { id: 'bash-1', owner: 'unrelated', kind: 'bash', startedAt: 999, status: 'running' })
  await next.pump()
  assert.equal(next.state.board.cards.A.backgroundJobs[0].status, 'unknown')
  assert.equal(next.sent.length, 1)
  assert.equal(next.state.board.botLeases.dev, job.id)
  assert.match(next.state.board.cards.A.deliveryError, /Automatic replay is blocked/)
  await control(next, next.state.board.cards.A, 'board-cancel'); await next.pump()
  assert.equal(next.state.board.cards.A.status, 'cancelling')
  assert.deepEqual(next.killed, [])
})

test('a shell launch in Session history fences a crash before the job journal was saved', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]; await first.take(job)
  first.history.get(job.sessionId).push({ type: 'tool/call', data: { name: 'bash', arguments: { command: 'sleep 10', run_in_background: true } } })
  first.agent(job.sessionId).status = 'idle'; await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop); await next.pump()
  assert.equal(next.sent.length, 1)
  assert.equal(next.state.board.cards.A.backgroundJobs[0].status, 'unknown')
})

test('user verification is required for an unknown shell and resumes only after evidence is saved', async t => {
  const first = fixture(); first.add('A'); await first.pump(); const job = first.state.board.cards.A.deliveries[0]; await first.take(job)
  await first.processEvent({ id: 'bash-1', owner: job.sessionId, kind: 'bash', startedAt: 1, status: 'running' })
  first.agent(job.sessionId).status = 'idle'; await first.stop()
  const next = fixture(structuredClone(first.state), first); t.after(next.stop); await next.pump()
  const record = next.state.board.cards.A.backgroundJobs[0]
  const input = { id: 'A', jobKeys: [[record.bootId, record.owner, record.id, record.startedAt].join(':')], evidence: 'Checked the old process and saved outputs; it is stopped.' }
  await assert.rejects(next.rt.boardResolveBackground({ ...input, evidence: '' }), /Describe how/)
  await assert.rejects(next.rt.boardResolveBackground({ ...input, jobKeys: ['stale'] }), /changed/)
  next.breakSave(true)
  await assert.rejects(next.rt.boardResolveBackground(input), /disk full/)
  assert.equal(next.state.board.cards.A.backgroundJobs[0].status, 'unknown')
  next.breakSave(false)
  await next.rt.boardResolveBackground(input); await next.pump()
  const card = next.state.board.cards.A
  assert.equal(card.backgroundJobs[0].resolution.actor, 'user')
  assert.equal(card.backgroundJobs[0].status, 'confirmed-stopped')
  assert.equal(card.deliveries.filter(j => j.parentId === job.id).length, 1)
  assert.equal(next.sent.length, 2)
  assert.equal(card.deliveries.at(-1).recovery, true)
})

test('a failed registry record is not proof that its process stopped', async t => {
  const f = fixture(); t.after(f.stop); const a = f.add('A'); await f.pump(); const job = a.deliveries[0]
  await f.processEvent({ id: 'bash-1', owner: job.sessionId, kind: 'bash', startedAt: 1, status: 'running' })
  await control(f, a, 'board-pause'); await f.pump()
  await f.processEvent({ ...f.processes.get('bash-1'), status: 'failed', finishedAt: 2 }, 'settled'); await f.pump()
  const card = f.state.board.cards.A, record = card.backgroundJobs[0]
  assert.equal(card.status, 'pausing')
  assert.equal(record.status, 'unknown')
  await f.rt.boardResolveBackground({ id: card.id, evidence: 'The old worker is absent and its output is stable.', jobKeys: [[record.bootId, record.owner, record.id, record.startedAt].join(':')] }); await f.pump()
  assert.equal(f.state.board.cards.A.status, 'paused')
  assert.equal(f.state.board.cards.A.backgroundJobs[0].status, 'confirmed-stopped')
})
