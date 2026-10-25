// Where a message's tool strip goes. The strip is positioned absolutely, so showing
// it never moves the message; the caller measures both boxes and places it here so it
// sits outside the words, preferring the side of the bubble and falling back to a line
// above or below it when the viewport has no room beside it.
export const TOOLBAR_GAP = 6
export const VIEW_INSET = 8

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high))

export const rectOf = (node) => {
  const rect = node?.getBoundingClientRect?.()
  if (rect === undefined || rect === null) return null
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
}

export function placeToolbar({ bubble, toolbar, viewport, preferred = 'right', gap = TOOLBAR_GAP, inset = VIEW_INSET }) {
  const vw = viewport.width
  const vh = viewport.height
  const innerRight = vw - inset
  const innerBottom = vh - inset
  const top = clamp(bubble.top + (bubble.height - toolbar.height) / 2, inset, innerBottom - toolbar.height)
  // A bubble near the edge flips to its other side rather than leaving the screen.
  for (const side of preferred === 'left' ? ['left', 'right'] : ['right', 'left']) {
    const left = side === 'right' ? bubble.right + gap : bubble.left - gap - toolbar.width
    const fits = side === 'right' ? left + toolbar.width <= innerRight : left >= inset
    if (fits) return { side, left, top }
  }
  const left = clamp(bubble.left, inset, innerRight - toolbar.width)
  // No room beside it: a line above or below still leaves the words uncovered.
  if (bubble.bottom + gap + toolbar.height <= innerBottom) return { side: 'below', left, top: bubble.bottom + gap }
  if (bubble.top - gap - toolbar.height >= inset) return { side: 'above', left, top: bubble.top - gap - toolbar.height }
  // A message longer than the viewport has no outside line to use: pin the strip to
  // the edge it prefers, still inside the screen.
  return { side: preferred, left: preferred === 'left' ? inset : innerRight - toolbar.width, top }
}

// One toolbar at a time: opening a strip closes the one that was open in another row.
const openToolbars = new Map()

export function registerOpenToolbar(id, close) {
  openToolbars.set(id, close)
  return () => {
    if (openToolbars.get(id) === close) openToolbars.delete(id)
  }
}

export function closeOtherToolbars(id) {
  for (const [key, close] of [...openToolbars]) if (key !== id) close()
}
