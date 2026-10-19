// DSH owns process control. Persist observations, never treat a missing registry
// entry after a host restart as evidence that its process stopped.
export const backgroundLive = job => ['running', 'stopping', 'unknown'].includes(job.status)
export const backgroundKey = job => [job.bootId, job.owner, job.id, job.startedAt].join(':')

export function installBackground(rt, boot) {
  const registry = rt.ctx.jobs
  const cards = () => Object.values(rt.state.board?.cards ?? {})
  const ownerCard = owner => cards().find(card => {
    const room = rt.roomOf(card.roomId)
    return owner && (room?.id === owner || Object.values(room?.sessions ?? {}).includes(owner)
      || card.deliveries?.some(job => job.sessionId === owner))
  })
  const observe = (card, view) => {
    const records = card.backgroundJobs ??= []
    let record = records.find(job => job.bootId === boot && job.id === view.id && job.owner === view.owner && job.startedAt === view.startedAt)
    if (!record) {
      const attempt = card.deliveries?.findLast(job => job.sessionId === view.owner)
      record = { id: view.id, owner: view.owner, kind: view.kind, startedAt: view.startedAt, bootId: boot, attemptId: attempt?.id }
      records.push(record)
    }
    // DSH may force-fail a record when producer teardown throws, without
    // establishing that the external work stopped. Preserve that uncertainty.
    record.status = view.status === 'failed' ? record.resolution ? 'confirmed-stopped' : 'unknown' : view.status
    if (view.finishedAt !== undefined) record.finishedAt = view.finishedAt
    // Commands, output and arbitrary producer details can contain credentials.
    // They remain in DSH's task conversation, never copied into the board.
  }
  const sync = (card, owners) => {
    if (registry) for (const owner of owners) for (const job of registry.list(owner)) if (job.owner === owner) observe(card, job)
    for (const record of card.backgroundJobs ?? []) {
      if (backgroundLive(record) && record.bootId !== boot) record.status = 'unknown'
    }
    return (card.backgroundJobs ?? []).filter(backgroundLive)
  }
  rt.boardBackground = (card, { stop = false } = {}) => {
    const room = rt.roomOf(card.roomId)
    const owners = new Set([room?.id, ...Object.values(room?.sessions ?? {}), ...card.deliveries?.map(job => job.sessionId) ?? [], ...card.backgroundJobs?.map(job => job.owner) ?? []].filter(Boolean))
    const live = sync(card, owners)
    if (stop) for (const job of live) if (job.bootId === boot && job.status === 'running') registry.kill(job.id, job.owner, 'ds-bot/board-stop')
    return stop ? sync(card, owners) : live
  }
  rt.boardBackgroundUnknown = card => (card.backgroundJobs ?? []).some(job => job.status === 'unknown')
  rt.boardResolveBackground = input => rt.boardWrite(async () => {
    const before = rt.state.board, board = structuredClone(before), card = board.cards[input.id]
    if (!card || !['active', 'pausing', 'cancelling'].includes(card.status)) throw new Error('This requirement is not waiting for background verification')
    const unknown = (card.backgroundJobs ?? []).filter(job => job.status === 'unknown')
    if (!unknown.length || !Array.isArray(input.jobKeys) || input.jobKeys.length !== unknown.length || unknown.some(job => !input.jobKeys.includes(backgroundKey(job)))) throw new Error('Background tasks changed. Refresh and inspect the current tasks.')
    if (typeof input.evidence !== 'string' || input.evidence.trim().length < 10 || input.evidence.length > 4000) throw new Error('Describe how you verified the old processes stopped and checked their saved effects')
    const at = Date.now(), evidence = input.evidence.trim()
    for (const job of unknown) { job.status = 'confirmed-stopped'; job.resolution = { actor: 'user', at, evidence } }
    for (const attempt of card.deliveries ?? []) if (unknown.some(job => job.attemptId === attempt.id) && attempt.status === 'failed' && attempt.mayHaveSent) {
      attempt.status = 'recovering'; attempt.backgroundResolvedAt = at; delete attempt.bootId; delete attempt.nextCheckAt
    }
    delete card.deliveryError
    card.version++; card.updatedAt = at
    card.activity = [...card.activity, { id: 'background-resolved-' + at, actor: 'user', at, text: 'Background task shutdown verified by user' }].slice(-200)
    rt.state.board = board
    try { await rt.save() } catch (error) { rt.state.board = before; throw error }
    rt.drainBoard?.()
    return card
  })
  if (registry) rt.ctx.effect(() => registry.events.subscribe({ owners: 'all' }, event => {
    if (event.type === 'output' || event.type === 'progress' || event.type === 'removed' || !event.job.owner || rt.readOnly() !== undefined) return
    if (!ownerCard(event.job.owner)) return
    void rt.boardWrite(async () => {
      const card = ownerCard(event.job.owner)
      if (!card) return
      observe(card, event.job)
      await rt.save()
    }).then(() => rt.drainBoard?.()).catch(error => rt.warn('ds-bot: background observation could not be saved: %s', error))
  }), 'ds-bot: requirement background jobs')
}

export const backgroundUnknownMessage = 'A background task from the previous host is no longer observable. Inspect its task conversation and process or external effects before continuing. Automatic replay is blocked.'
