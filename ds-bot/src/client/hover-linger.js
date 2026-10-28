// A hover that has to outlive the pointer: a message's tool strip floats a gap away
// from its bubble, so a plain :hover ends before the pointer crosses that gap and the
// tools vanish under it. The strip stays for a short grace period after the pointer
// leaves, and reaching the strip itself cancels the hide.
export const HOVER_LINGER_MS = 180

export function createHoverLinger(onShown, { ms = HOVER_LINGER_MS, setTimer, clearTimer } = {}) {
  const schedule = setTimer ?? ((run, delay) => setTimeout(run, delay))
  const cancelTimer = clearTimer ?? (id => clearTimeout(id))
  let timer = 0
  let shown = false
  const publish = (value) => {
    if (value === shown) return
    shown = value
    onShown(value)
  }
  const stop = () => {
    if (timer === 0) return
    cancelTimer(timer)
    timer = 0
  }
  return {
    hold() { stop(); publish(true) },
    release() {
      stop()
      timer = schedule(() => { timer = 0; publish(false) }, ms)
    },
    dispose() { stop(); shown = false },
    get shown() { return shown },
  }
}
