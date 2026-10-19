import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CommandPalette } from './palette.js'
import { NewChat } from './new-chat.js'
import { ExchangeDialog } from './exchange.js'
import { VoiceMode } from './voice.js'
import { SettingsDialog } from './settings.js'
import { ContextMenu } from './context-menu.js'
import { PANEL_LINGER_MS, BotPanel } from './browser-pane.js'
import { MemoryDialog } from './memory-panel.js'
import { useLinger, SPRING_SHAPE } from './motion.js'

// How long a closing dialog or menu stays for its exit (see their [data-leaving] CSS).
const DIALOG_EXIT_MS = 160
const MENU_EXIT_MS = 120
// How long the hint beside a desktop-only entry stays, and how long its exit takes.
const HINT_MS = 2600
const HINT_EXIT_MS = 200

// The phone's answer to an entry that leads to a desktop-only surface: a small hint beside
// the entry that was pressed, centred on it and kept inside the viewport, gone on its own.
// It is portalled to the body with a z-index of its own, because the shell's overlay layer
// is a stacking context that the phone's list page sits above.
function SettingHint({ hint, actions }) {
  const box = useRef(null)
  const [leaving, setLeaving] = useState(false)
  const { rect, token } = hint
  const above = rect.top > 64
  useLayoutEffect(() => {
    const el = box.current
    if (el === null) return
    const half = el.getBoundingClientRect().width / 2
    const x = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8)
    el.style.left = `${x}px`
  }, [token])
  useEffect(() => {
    const dismiss = () => actions.dismissHint(token)
    const fade = setTimeout(() => setLeaving(true), HINT_MS)
    const gone = setTimeout(dismiss, HINT_MS + HINT_EXIT_MS)
    const onDown = (event) => { if (!(event.target instanceof Element) || event.target.closest('.bt-hint') === null) dismiss() }
    const onKey = (event) => { if (event.key === 'Escape') dismiss() }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(fade)
      clearTimeout(gone)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [token])
  return h('div', {
    ref: box, className: 'bt-hint', role: 'status', 'data-leaving': leaving || undefined,
    style: above ? { bottom: `${Math.round(window.innerHeight - rect.top + 8)}px` } : { top: `${Math.round(rect.bottom + 8)}px` },
  }, hint.text)
}

export const HINT_CSS = `
.bt-hint{position:fixed;z-index:80;transform:translateX(-50%);max-width:min(300px,calc(100vw - 24px));padding:8px 12px;border-radius:10px;background:var(--bt-card);color:var(--bt-ink);border:.5px solid var(--bt-line-2);box-shadow:0 10px 24px -8px rgba(0,0,0,.28);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:13px;line-height:18px;text-align:center;box-sizing:border-box;animation:bt-hint-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .16s ease-out}
.bt-hint[data-leaving]{opacity:0;transform:translate(-50%,4px);transition:opacity .18s ease-in,transform .18s ease-in}
@keyframes bt-hint-in{from{opacity:0;transform:translate(-50%,4px)}}
@media (prefers-reduced-motion:reduce){.bt-hint{animation:none}.bt-hint[data-leaving]{transition:none}}
`

export function Overlays({ useRoster, useUi, useSessions, useSessionStatus, useActivity, useWork, useRegistry, useBrowserPages, useBrowserTabs, useUpdate, actions }) {
  const roster = useRoster(value => value)
  const ui = useUi(value => value)
  useRegistry(value => value)
  const current = useSessions(list => Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  // An open panel follows the conversation in the main view. Only a change of the
  // main view moves it, so opening details for another id (Rename) is not undone.
  const previous = useRef(current)
  useEffect(() => {
    if (previous.current === current) return
    previous.current = current
    if (current) actions.followPanel?.(current)
  }, [current])
  const open = ui.details ? { id: ui.details, view: ui.view ?? 'details', renaming: ui.renaming, tab: ui.tab } : null
  const [kept, setKept] = useState(open)
  useEffect(() => {
    if (open) { setKept(open); return undefined }
    const timer = setTimeout(() => setKept(null), PANEL_LINGER_MS)
    return () => clearTimeout(timer)
  }, [ui.details, ui.view, ui.renaming, ui.tab])
  const pane = open ?? kept
  const [settings, settingsLeaving] = useLinger(ui.settings, DIALOG_EXIT_MS)
  const [memory, memoryLeaving] = useLinger(ui.memory && roster.byId[ui.memory] ? ui.memory : null, DIALOG_EXIT_MS)
  const [menu, menuLeaving] = useLinger(ui.menu, MENU_EXIT_MS)
  return h(Fragment, null,
    pane ? createPortal(h(BotPanel, { pane, leaving: open === null, roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages }), document.body) : null,
    ui.newChat ? createPortal(h(NewChat, { key: ui.newChat, mode: ui.newChat, roster, actions }), document.body) : null,
    ui.palette ? createPortal(h(CommandPalette, { key: ui.palette.token, start: ui.palette.query, token: ui.palette.token, roster, actions, useSessions }), document.body) : null,
    ui.exchange ? createPortal(h(ExchangeDialog, { pair: ui.exchange, at: ui.exchangeAt ?? undefined, roster, actions }), document.body) : null,
    ui.voice ? createPortal(h(VoiceMode, { key: ui.voice, sessionId: ui.voice, roster, actions, useSessions, useSessionStatus }), document.body) : null,
    menu ? createPortal(h(ContextMenu, { key: `${menu.kind ?? ''}:${menu.id}:${menu.x}:${menu.y}`, menu, roster, actions, leaving: menuLeaving }), document.body) : null,
    settings ? createPortal(h(SettingsDialog, { page: settings.page, id: settings.id, roster, actions, useUpdate, leaving: settingsLeaving }), document.body) : null,
    memory && roster.byId[memory] ? createPortal(h(MemoryDialog, { key: memory, bot: roster.byId[memory], actions, leaving: memoryLeaving }), document.body) : null,
    ui.hint ? createPortal(h(SettingHint, { key: ui.hint.token, hint: ui.hint, actions }), document.body) : null)
}
