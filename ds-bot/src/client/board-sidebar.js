import { useEffect, useState } from 'react'

// The existing shell owns its sidebar DOM and drag handle. The board only makes room.
export function useBoardSidebar(actions) {
  const [view, setView] = useState({ width: 0, open: false, fullscreen: false })
  useEffect(() => {
    document.body.dataset.btBoardOpen = ''
    let frame, column, queued = 0
    const measure = () => {
      queued = 0
      const nextColumn = document.querySelector('[data-rightbar-col]')
      const nextFrame = nextColumn?.closest('[class*="_frame"]')
      if (nextColumn !== column) { if (column) resize.unobserve(column); column = nextColumn; if (column) resize.observe(column) }
      if (nextFrame !== frame) { if (frame) resize.unobserve(frame); frame = nextFrame; if (frame) resize.observe(frame) }
      const nativeFullscreen = Boolean(frame?.hasAttribute('data-rightbar-fullscreen'))
      const open = nativeFullscreen || actions.boardSidebar()?.isExpanded() === true
      if (open) document.body.dataset.btBoardSidebar = 'open'
      else delete document.body.dataset.btBoardSidebar
      const fullscreen = open && (window.innerWidth < 768 || nativeFullscreen)
      const box = column?.getBoundingClientRect()
      const width = open && !fullscreen && box ? Math.max(0, Math.round(window.innerWidth - box.left)) : 0
      setView(previous => previous.width === width && previous.open === open && previous.fullscreen === fullscreen ? previous : { width, open, fullscreen })
    }
    const schedule = () => { if (!queued) queued = requestAnimationFrame(measure) }
    const resize = new ResizeObserver(schedule)
    const mutation = new MutationObserver(schedule)
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-rightbar-collapsed', 'data-rightbar-fullscreen'] })
    const off = actions.boardSidebar()?.mounted?.subscribe(schedule)
    window.addEventListener('resize', schedule)
    measure()
    return () => { delete document.body.dataset.btBoardOpen; delete document.body.dataset.btBoardSidebar; resize.disconnect(); mutation.disconnect(); off?.(); window.removeEventListener('resize', schedule); cancelAnimationFrame(queued) }
  }, [actions])
  return view
}

export const BOARD_SIDEBAR_CSS = `
body[data-bt-board-open] [data-rightbar-col]{position:relative;z-index:61}
body[data-bt-board-open] [class*="_frame"][data-rightbar-fullscreen] [data-rightbar-col]{z-index:61!important}
.bt-board[data-preview-open=true] .bt-board-header{flex-wrap:wrap;gap:10px}
.bt-board[data-preview-open=true] .bt-board-toolbar{flex-wrap:wrap}
.bt-board[data-preview-open=true] .bt-board-search{width:100%}
.bt-board[data-preview-open=true] .bt-board-project-bar{flex-basis:100%}
.bt-board-preview-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
.bt-board-preview-actions .bt-board-button{font-size:12px;height:32px;max-width:100%;white-space:normal;text-align:left}
.bt-board-preview-error{font-size:12px;color:var(--bt-danger);margin:10px 0 0;overflow-wrap:anywhere}
.bt-board-preview-targets{list-style:none;padding:0;margin:8px 0}
.bt-board-preview-targets li{padding:6px 0;min-width:0}
.bt-board-preview-targets button{overflow-wrap:anywhere;max-width:100%;white-space:normal;height:auto;min-height:32px}
`

export async function openBoardPreview({ ctx, target, preview, signal }) {
  if (signal?.aborted) return
  if (target.unavailable) throw new Error(target.unavailable)
  const sidebar = ctx.get('sidebarRight')
  if (!sidebar) throw new Error('The DSH preview sidebar is unavailable.')
  if (target.kind === 'url' && !ctx.get('sidebarRightTabs')?.get('browser')) throw new Error('Browser preview is not enabled in this DSH profile. Open the link in a new tab.')
  if (!sidebar.mounted.getSnapshot()) {
    const sessionId = preview.roomId || preview.sessionId
    if (!sessionId) throw new Error('The task conversation for this deliverable is unavailable.')
    await ctx.sessions.refresh?.()
    if (signal?.aborted) return
    ctx.uiWorkspace.openSession(sessionId)
    for (let i = 0; i < 60 && !sidebar.mounted.getSnapshot(); i++) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      if (signal?.aborted) return
    }
    if (!sidebar.mounted.getSnapshot()) throw new Error('The DSH preview sidebar is unavailable.')
    await new Promise(resolve => requestAnimationFrame(resolve))
  }
  if (signal?.aborted) return
  if (target.kind === 'file') sidebar.openResource(target.address, target.line ? { params: { line: target.line } } : undefined)
  else sidebar.openTab('browser', { params: { url: target.value } })
}
