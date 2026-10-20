// Background retries for a connector mount that timed out.
//
// The count has to survive the retry itself: the timer callback must NOT drop the entry,
// or a retry that fails again would restart at the first delay and retry forever. A
// successful mount (or stopping) clears the chain; three failures stop it.
export const MOUNT_RETRY_DELAYS = [15_000, 45_000, 120_000]

export function createMountRetryScheduler({
  run,
  delays = MOUNT_RETRY_DELAYS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  isStopped = () => false,
} = {}) {
  const entries = new Map()

  const clear = (id) => {
    const entry = entries.get(id)
    if (entry?.timer !== undefined) clearTimer(entry.timer)
    entries.delete(id)
  }

  // Schedules the next background mount attempt. Returns false when the chain is over
  // (already three failures, or the plugin is stopping).
  const schedule = (id) => {
    if (isStopped()) return false
    const entry = entries.get(id)
    // A timer is already waiting for this connector: scheduling again must not move the
    // chain forward.
    if (entry?.timer !== undefined) return true
    const index = entry?.count ?? 0
    if (index >= delays.length) {
      clear(id)
      return false
    }
    if (entry?.timer !== undefined) clearTimer(entry.timer)
    const timer = setTimer(() => {
      const current = entries.get(id)
      if (current === undefined) return
      // Keep the entry (and its count): a retry that times out again must move on to the
      // next, longer delay instead of starting the chain over.
      current.timer = undefined
      if (isStopped()) {
        clear(id)
        return
      }
      Promise.resolve()
        .then(() => run(id))
        .catch(() => {})
    }, delays[index])
    timer?.unref?.()
    entries.set(id, { count: index + 1, timer })
    return true
  }

  return {
    schedule,
    clear,
    attempts: id => entries.get(id)?.count ?? 0,
    pending: id => entries.get(id) !== undefined,
  }
}
