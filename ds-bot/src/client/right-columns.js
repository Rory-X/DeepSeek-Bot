// -------------------------------------------------------------------------
// One right column at a time. The shell's right sidebar and the Bot drawer both take their
// width from the conversation column — the shell gives the column a track, the drawer writes
// the column's right margin — and with both open the chat is squeezed to a sliver. Whichever
// one the reader reaches for wins: the drawer yields to the shell's sidebar, and the shell's
// sidebar yields to the drawer, so the two are never open together.

// The shell's frame carries this attribute while its right column is collapsed, and the
// column itself moves with it; either one says when to look again.
const FRAME = '[class*="_frame"]'
const COLUMN = '[data-rightbar-col]'

/**
 * Keep the shell's right sidebar and the Bot drawer from being open together.
 * @param options - `ui` holds the drawer, `isDesktop` gates the rule, `rightbar` is the
 *   shell's own face (`ctx.sidebarRight`), `onError` reports a refused call.
 * @returns a disposer that removes every observer and subscription.
 */
export function installRightColumns({ ui, isDesktop, rightbar, onError }) {
  if (rightbar === undefined) return () => {}
  let frame = null
  let column = null
  let frameWatch = null
  let columnWatch = null
  let findWatch = null
  let open = false

  const isOpen = () => {
    try { return rightbar.isExpanded() === true } catch (error) { onError?.(error); return false }
  }
  const collapse = () => {
    try { if (rightbar.isExpanded()) rightbar.toggleExpanded() } catch (error) { onError?.(error) }
  }
  const closeDrawer = () => ui.set(state => (state.details ? { ...state, details: null, view: 'details' } : state))
  // Only the sidebar's own arrival closes the drawer: an expansion the drawer asked for is
  // the drawer winning, and must not close what it just opened.
  const read = () => {
    const now = isDesktop() && isOpen()
    if (now && !open) closeDrawer()
    open = now
  }
  const attach = () => {
    const nextFrame = document.querySelector(FRAME)
    const nextColumn = document.querySelector(COLUMN)
    if (nextFrame === frame && nextColumn === column) return
    frameWatch?.disconnect()
    columnWatch?.disconnect()
    frame = nextFrame
    column = nextColumn
    if (frame !== null) {
      frameWatch = new MutationObserver(read)
      frameWatch.observe(frame, { attributes: true, attributeFilter: ['data-rightbar-collapsed', 'data-rightbar-fullscreen'] })
      findWatch?.disconnect()
      findWatch = null
    }
    if (column !== null && typeof ResizeObserver === 'function') {
      columnWatch = new ResizeObserver(read)
      columnWatch.observe(column)
    }
    open = isDesktop() && isOpen()
  }
  attach()
  // The plugin may boot before the shell's frame is up, so the frame is looked for until it
  // arrives; once it has, nothing watches the document.
  if (frame === null) {
    findWatch = new MutationObserver(attach)
    findWatch.observe(document.documentElement, { childList: true, subtree: true })
  }
  // The frame is rebuilt when the Session on screen changes, which the shell publishes.
  const offMounted = rightbar.mounted?.subscribe ? rightbar.mounted.subscribe(attach) : null
  // A drawer opened while the sidebar is expanded is the drawer winning: the sidebar yields
  // first, so the press is never a no-op.
  const offUi = ui.subscribe(() => {
    if (ui.getSnapshot().details === null) return
    if (isDesktop() && isOpen()) collapse()
  })
  return () => {
    frameWatch?.disconnect()
    columnWatch?.disconnect()
    findWatch?.disconnect()
    offMounted?.()
    offUi()
  }
}
