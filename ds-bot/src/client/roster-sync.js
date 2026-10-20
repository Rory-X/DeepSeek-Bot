// Each caller waits for a read started after its request. Notifications that arrive
// during a read share one following read, without keeping earlier callers waiting.
export function queueRosterPull(read) {
  let running = false
  let pending
  const batch = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  const start = (request) => {
    running = true
    void Promise.resolve().then(read).then(request.resolve, request.reject).finally(() => {
      running = false
      const next = pending
      pending = undefined
      if (next) start(next)
    })
    return request.promise
  }
  return () => {
    if (!running) return start(batch())
    pending ??= batch()
    return pending.promise
  }
}

const RETRY_MS = [500, 1000, 2000, 5000]

// Fetch streams also work in the desktop window's custom scheme. This subscription
// receives roster revisions only; chat text and model output stay on the full feed.
export function watchRosterChanges(onChange, { fetcher = globalThis.fetch, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let stopped = false
  let controller, reader, timer, finishWait
  const run = async () => {
    let failures = 0
    while (!stopped) {
      controller = new AbortController()
      try {
        const response = await fetcher('api/bot/feed?scope=roster', { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' })
        if (stopped) { await response.body?.cancel(); return }
        if (!response.ok || !response.body) throw new Error('Roster feed unavailable')
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!stopped) {
          const { value, done } = await reader.read()
          if (done) break
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const lines = buffer.slice(0, end).split('\n')
            buffer = buffer.slice(end + 2)
            const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
            if (event !== 'hello' && event !== 'revision') continue
            let data
            try { data = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')) } catch { continue }
            if (!Number.isSafeInteger(data?.revision)) continue
            failures = 0
            if (!stopped) onChange(data.revision)
          }
          if (buffer.length > 65536) throw new Error('Roster feed frame is too large')
        }
      } catch {
        // Polling remains active while the stream is disconnected or unsupported.
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
          reader = undefined
        }
      }
      if (stopped) return
      await new Promise(resolve => {
        finishWait = resolve
        timer = schedule(resolve, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)])
      })
      timer = undefined
      finishWait = undefined
    }
  }
  void run()
  return () => {
    stopped = true
    controller?.abort()
    void reader?.cancel().catch(() => {})
    cancel(timer)
    finishWait?.()
  }
}
