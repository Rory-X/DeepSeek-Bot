import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from './files.js'

const VERSION = 1
const PREVIEW_CHARS = 240
const textOf = text => String(text ?? '').replace(/^\[(?:Message from|Reply from|Group chat|Group post from|Bot team setup|Handoff · part|Secret card)[^\r\n]*\]\r?\n/, '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS)

export function projectionSummary(snapshot, hiddenTurns = []) {
  const outline = snapshot?.values?.turnOutline
  if (!Array.isArray(outline)) return undefined
  for (let i = outline.length - 1; i >= 0; i--) {
    const entry = outline[i]
    if (hiddenTurns.includes(entry.turn)) continue
    const preview = textOf(entry.response || entry.prompt)
    if (preview) return { preview, updatedAt: entry.start ?? 0, seq: Number(snapshot.asOfSeq) || 0, turn: entry.turn }
  }
  return undefined
}

// This is a disposable display cache. Seeding reads only a header and an existing
// projection checkpoint; it never resolves an Agent or replays a cold Session.
export function install(rt) {
  const { ctx, home, state } = rt
  const path = join(home, 'chat-summaries.json')
  const entries = new Map()
  const pending = new Set()
  const seeded = new Set()
  const hidden = new Map()
  let stopped = false, active = 0, timer, loading, writing = Promise.resolve()
  const ids = () => new Set([
    ...Object.values(state.bots).map(bot => rt.chatOf(bot.id)),
    ...Object.values(state.rooms).map(room => rt.sessionOfRoom(room)),
  ])
  const save = () => {
    clearTimeout(timer)
    timer = undefined
    writing = writing.then(async () => {
      if (rt.readOnly?.() !== undefined) return
      await load()
      const allowed = ids()
      const value = { version: VERSION, entries: Object.fromEntries([...entries].filter(([id]) => allowed.has(id))) }
      await mkdir(home, { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
      await replaceFile(temp, path)
    }).catch(error => rt.warn('ds-bot: saving chat summaries failed: %s', error))
    return writing
  }
  const changed = () => {
    if (stopped || timer !== undefined) return
    timer = setTimeout(save, 1000)
    timer.unref?.()
  }
  const put = (id, value, fromDisk = false) => {
    if ((stopped && !fromDisk) || !value || !ids().has(id)) return
    const previous = entries.get(id)
    if (previous && (previous.seq > value.seq || previous.updatedAt > value.updatedAt)) return
    if (previous?.preview === value.preview && previous?.seq === value.seq) return
    entries.set(id, value)
    if (!fromDisk) changed()
  }
  const load = () => loading ??= (async () => {
    await rt.load()
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'))
      if (saved.version === VERSION) {
        for (const [id, value] of Object.entries(saved.entries ?? {})) {
          if (typeof value?.preview === 'string' && Number.isSafeInteger(value.seq) && Number.isFinite(value.updatedAt)) put(id, { preview: textOf(value.preview), seq: value.seq, updatedAt: value.updatedAt, ...(Number.isSafeInteger(value.turn) ? { turn: value.turn } : {}) }, true)
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn('ds-bot: chat summaries will be rebuilt: %s', error)
    }
  })()
  async function seed(id) {
    const projections = ctx.get?.('sessionProjections')
    const live = ctx.sessions?.get?.(id)
    let snapshot
    if (live && projections) snapshot = projections.snapshot(live)
    else {
      const cache = ctx.get?.('sessionProjectionCache')
      const persistence = ctx.get?.('sessionPersistence')
      if (!cache || !persistence) return
      const stored = await persistence.stat(id, { signal: AbortSignal.timeout(5000) })
      if (stored) snapshot = cache.cachedSnapshot(stored.header)
    }
    put(id, projectionSummary(snapshot, state.exchangeTurns[id]))
  }
  const drain = () => {
    while (!stopped && active < 2 && pending.size) {
      const id = pending.values().next().value
      pending.delete(id)
      active++
      void seed(id).catch(error => rt.warn('ds-bot: reading a chat summary failed: %s', error)).finally(() => { active--; drain() })
    }
  }
  const refresh = () => {
    const allowed = ids()
    for (const id of entries.keys()) if (!allowed.has(id)) { entries.delete(id); changed() }
    for (const id of seeded) if (!allowed.has(id)) { seeded.delete(id); hidden.delete(id); pending.delete(id) }
    for (const id of allowed) {
      const turns = JSON.stringify(state.exchangeTurns[id] ?? [])
      if (hidden.get(id) !== turns) {
        hidden.set(id, turns)
        seeded.delete(id)
        if ((state.exchangeTurns[id] ?? []).includes(entries.get(id)?.turn)) entries.delete(id)
      }
      if (seeded.has(id)) continue
      seeded.add(id)
      pending.add(id)
    }
    drain()
  }
  rt.chatSummariesReady = load
  rt.chatSummariesView = () => {
    void load().then(refresh).catch(error => rt.warn('ds-bot: loading chat summaries failed: %s', error))
    const allowed = ids()
    return Object.fromEntries([...entries].filter(([id, entry]) => allowed.has(id) && !(state.exchangeTurns[id] ?? []).includes(entry.turn)))
  }
  ctx.on('session/event', (session, event) => {
    if (!ids().has(session.id) || !['user/message', 'assistant/message'].includes(event.type)) return
    const items = rt.displayItems(session.id, [event], session)
    const item = items.findLast(row => ['user', 'bot', 'post'].includes(row.kind) && textOf(row.text || row.texts?.join(' ')))
    if (item) put(session.id, { preview: textOf(item.text || item.texts?.join(' ')), updatedAt: event.time ?? Date.now(), seq: event.seq, ...(Number.isSafeInteger(item.turn) ? { turn: item.turn } : {}) })
  })
  const off = rt.onSaved(() => { void load().then(refresh).catch(error => rt.warn('ds-bot: refreshing chat summaries failed: %s', error)) })
  ctx.effect(() => () => {
    stopped = true
    off()
    clearTimeout(timer)
    pending.clear()
    return save()
  }, 'ds-bot: lightweight chat summaries')
}
