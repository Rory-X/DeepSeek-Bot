// -------------------------------------------------------------------------
// The two-level navigation's motion. The page that leaves slides, the page that arrives
// follows it, and a drag from the left edge drives the same movement by hand — so a swipe
// and the back control are one gesture seen from two sides.

// The same spring the plugin's page transitions use, at the length a page change wants.
export const NAV_MOTION_MS = 200
// A drag has to start this close to the left edge, and has to be more sideways than down.
export const NAV_EDGE = 28
export const NAV_EDGE_SLOPE = 1.2
// Released past this much of the screen, or this fast (px per ms), the drag completes.
export const NAV_COMMIT_RATIO = 0.4
export const NAV_COMMIT_VELOCITY = 0.35
const NAV_DECIDE_AT = 8
const NAV_LONG_PRESS_MS = 600

/**
 * Whether a released edge drag goes back, given where it ended.
 * @param x - how far the page was dragged, in px.
 * @param width - the screen width in px.
 * @param velocity - the drag's speed in px per ms.
 * @returns true to complete the return, false to spring back.
 */
export function swipeBack(x, width, velocity) {
  if (width <= 0) return false
  return x >= width * NAV_COMMIT_RATIO || velocity >= NAV_COMMIT_VELOCITY
}

// A drag that starts in one of these is not a back gesture: the right panel, an overlay,
// or a horizontal scroller of its own (a code block, a wide table, a tab strip).
const OWN_GESTURE = '[data-rightbar-col], .bt-panel, .bt-settings-layer, .bt-mem-layer, .bt-palette-layer, [role="dialog"]'

function scrollsSideways(el) {
  for (let node = el; node !== null && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (!/auto|scroll/.test(style.overflowX)) continue
    if (node.scrollWidth > node.clientWidth + 1) return true
  }
  return false
}

/**
 * Install the left-edge swipe. Every callback is optional and called with plain numbers, so
 * the caller owns what a drag means.
 * @param options - `canStart` gates the gesture, `onStart`/`onMove`/`onCommit`/`onCancel` report it.
 * @returns a disposer that removes every listener.
 */
export function installSwipeBack({ canStart, onStart, onMove, onCommit, onCancel }) {
  let drag = null
  const onTouchStart = (event) => {
    if (event.touches.length !== 1 || drag !== null) return
    const touch = event.touches[0]
    if (touch.clientX > NAV_EDGE) return
    if (!canStart?.()) return
    if (event.target instanceof Element && (event.target.closest(OWN_GESTURE) !== null || scrollsSideways(event.target))) return
    drag = { x0: touch.clientX, y0: touch.clientY, at: performance.now(), x: 0, lastX: touch.clientX, lastAt: performance.now(), velocity: 0, decided: false, active: false }
  }
  const onTouchMove = (event) => {
    if (drag === null || event.touches.length !== 1) return
    const touch = event.touches[0]
    const dx = touch.clientX - drag.x0
    const dy = touch.clientY - drag.y0
    if (!drag.decided) {
      if (Math.abs(dx) < NAV_DECIDE_AT && Math.abs(dy) < NAV_DECIDE_AT) return
      drag.decided = true
      // Down the page, or a press held long enough to be a selection: not a back gesture.
      if (dx <= 0 || Math.abs(dx) < Math.abs(dy) * NAV_EDGE_SLOPE || performance.now() - drag.at > NAV_LONG_PRESS_MS) {
        drag = null
        return
      }
      drag.active = true
      onStart?.()
    }
    if (!drag.active) return
    // The page must not scroll under the finger that is moving it.
    if (event.cancelable) event.preventDefault()
    const width = window.innerWidth
    const x = Math.max(0, Math.min(dx, width))
    const now = performance.now()
    drag.velocity = (touch.clientX - drag.lastX) / Math.max(1, now - drag.lastAt)
    drag.lastX = touch.clientX
    drag.lastAt = now
    drag.x = x
    onMove?.(x, width)
  }
  const onTouchEnd = () => {
    if (drag === null) return
    const ended = drag
    drag = null
    if (!ended.active) return
    if (swipeBack(ended.x, window.innerWidth, ended.velocity)) onCommit?.()
    else onCancel?.()
  }
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true })
  document.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true })
  return () => {
    drag = null
    document.removeEventListener('touchstart', onTouchStart, { capture: true })
    document.removeEventListener('touchmove', onTouchMove, { capture: true })
    document.removeEventListener('touchend', onTouchEnd, { capture: true })
    document.removeEventListener('touchcancel', onTouchEnd, { capture: true })
  }
}
