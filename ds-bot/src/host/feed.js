// The live feed: a Server-Sent Events stream of what changes, for a window that draws
// the team itself (the desktop app) instead of polling.
//   revision  the team was saved: ask for `state` again
//   live      work changed without a new revision: ask for `state` again
//   message   a new entry of a Bot's own chat, as the `chat` endpoint returns it
//   stream    the reply a Bot is writing: a start, its text as it comes, an end
import { ROUTE } from './constants.js'

export const FEED_ROUTE = `${ROUTE}/feed`
// A comment line now and then keeps an idle connection open.
const KEEPALIVE_MS = 20_000
// Status changes come in bursts (a turn starts several Sessions); one notice covers them.
const LIVE_DELAY_MS = 150
// A window that stops reading is dropped once this many events wait for it; it
// reconnects and catches up from `hello`.
const MAX_QUEUED = 512

export function install(rt) {
  const { ctx, state } = rt
  const encoder = new TextEncoder()
  // Open streams, with the request signal that closes them: the listener on that signal is
  // the only thing that ends a stream when its window goes, and a signal nothing else points
  // at may be collected together with the listener before the abort arrives. One entry per
  // open stream, removed at `leave`, which is the only place a stream is taken away.
  /** @type {Map<ReadableStreamDefaultController<Uint8Array>, AbortSignal>} */
  const clients = new Map()
  const rosterClients = new Set()
  const send = (controller, chunk) => {
    if ((controller.desiredSize ?? 0) < -MAX_QUEUED) {
      leave(controller)
      return
    }
    try {
      controller.enqueue(chunk)
    } catch {
      // A window that cannot take the chunk is gone; taking it away here is the same exit.
      leave(controller)
    }
  }
  const publish = (event, data) => {
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    for (const controller of clients.keys()) {
      if (!rosterClients.has(controller) || event === 'revision') send(controller, chunk)
    }
  }

  rt.stateSaved = () => {
    if (clients.size > 0) publish('revision', { revision: state.revision })
  }

  let liveTimer
  const live = () => {
    if (clients.size === rosterClients.size || liveTimer !== undefined) return
    liveTimer = setTimeout(() => {
      liveTimer = undefined
      publish('live', {})
    }, LIVE_DELAY_MS)
  }
  ctx.on('agent/status', ({ agent }) => {
    if (rt.selfOf(agent.id) !== undefined) live()
  })

  ctx.on('session/event', (session, event) => {
    if (clients.size === rosterClients.size) return
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) return
    for (const item of rt.displayItems(session.id, [event])) publish('message', { botId, sessionId: session.id, item })
    if (event.type === 'tool/call') live()
  })

  // Attempts being streamed, by id. A turn with nothing of its own to show (a stop
  // acknowledgement, a part's opening line) is hidden from the chat, so its text is
  // not streamed.
  const writing = new Map()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      const botId = rt.chatOwners.get(agent.id)
      if (clients.size === rosterClients.size || botId === undefined || (state.exchangeTurns[agent.id] ?? []).includes(frame.turn)) return
      writing.set(frame.attemptId, { botId, sessionId: agent.id })
      publish('stream', { botId, sessionId: agent.id, attemptId: frame.attemptId, phase: 'start' })
      return
    }
    const target = writing.get(frame.attemptId)
    if (target === undefined) return
    if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') publish('stream', { ...target, attemptId: frame.attemptId, text: frame.chunk.text })
    else if (frame.type === 'end') {
      writing.delete(frame.attemptId)
      publish('stream', { ...target, attemptId: frame.attemptId, phase: 'end' })
    }
  })

  const leave = (controller) => {
    clients.delete(controller)
    rosterClients.delete(controller)
    if (clients.size === rosterClients.size) writing.clear()
    try { controller.close() } catch { /* already closed or errored */ }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: FEED_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let controller
      const rosterOnly = new URL(request.url).searchParams.get('scope') === 'roster'
      const body = new ReadableStream({
        start(own) {
          controller = own
          clients.set(own, request.signal)
          if (rosterOnly) rosterClients.add(own)
          // A window that is already gone cannot be told about an abort that already happened.
          if (request.signal.aborted) {
            leave(own)
            return
          }
          request.signal.addEventListener('abort', () => leave(own), { once: true })
          send(own, encoder.encode(`event: hello\ndata: ${JSON.stringify({ revision: state.revision })}\n\n`))
        },
        cancel() { leave(controller) },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } })
    },
  }), 'ds-bot: live feed route')

  ctx.effect(() => {
    const keepalive = setInterval(() => {
      if (clients.size > 0) for (const controller of clients.keys()) send(controller, encoder.encode(': keepalive\n\n'))
    }, KEEPALIVE_MS)
    keepalive.unref?.()
    return () => {
      clearInterval(keepalive)
      clearTimeout(liveTimer)
      // Each entry is a `[controller, signal]` pair, so take the keys: `leave` needs the controller.
      for (const controller of clients.keys()) leave(controller)
    }
  }, 'ds-bot: live feed')

  // Read-only bookkeeping for the tests: how many streams are open, and how many of them only
  // want roster news.
  Object.assign(rt, { feedStats: () => ({ clients: clients.size, roster: rosterClients.size }) })
}
