import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NotificationWatcher } from './notifications.js'
import { createPortal } from 'react-dom'
import { CommandPalette } from './palette.js'
import { GroupSearch } from './group-search.js'
import { NewChat } from './new-chat.js'
import { ExchangeDialog } from './exchange.js'
import { VoiceMode } from './voice.js'
import { SettingsDialog } from './settings.js'
import { ContextMenu } from './context-menu.js'
import { BotFoldersDialog } from './bot-folders.js'
import { PANEL_LINGER_MS, BotPanel } from './browser-pane.js'
import { frameLayout, FALLBACK_SIDEBAR_WIDTH } from './frame-layout.js'
import { MemoryDialog } from './memory-panel.js'
import { reducedMotion, useLinger, SPRING_SHAPE } from './motion.js'
import { OpeningCover, openingModel } from './opening.js'
import { OverlayBoundary } from './overlay-boundary.js'

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

const useDefaultFrame = () => ({ viewport: typeof window === 'undefined' ? 0 : window.innerWidth, sidebarWidth: FALLBACK_SIDEBAR_WIDTH, collapsedWidth: 0 })
const useDefaultSidebarPref = () => 'open'
const useDefaultFalse = () => false

export function Overlays({ useRoster, useUi, useSessions, useSessionStatus, useActivity, useWork, useComputer, useRegistry, useBrowserPages, useBrowserTabs, useBrowserHolds, useUpdate, useFrame, useSidebarPref, useSettingsShellHeld, actions }) {
  const roster = useRoster(value => value)
  const ui = useUi(value => value)
  useRegistry(value => value)
  const useReadFrame = useFrame ?? useDefaultFrame
  const useReadSidebarPref = useSidebarPref ?? useDefaultSidebarPref
  const useReadSettingsShellHeld = useSettingsShellHeld ?? useDefaultFalse
  const frameSnap = useReadFrame(value => value)
  const pref = useReadSidebarPref(value => value)
  const current = useSessions(list => Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  // An open panel follows the conversation in the main view. Only a change of the
  // main view moves it, so opening details for another id (Rename) is not undone.
  const previous = useRef(current)
  useEffect(() => {
    if (previous.current === current) return
    previous.current = current
    if (current) actions.followPanel?.(current)
  }, [current])
  const open = ui.details ? { id: ui.details, view: ui.view ?? 'details', renaming: ui.renaming, tab: ui.tab, side: ui.side, task: ui.task } : null
  // A panel that no longer fits folds away: its state stays open, it just is not
  // mounted — the usual exit plays and the webview goes with it — until the room
  // returns and it shows again on its own.
  const layout = frameLayout({
    viewport: frameSnap.viewport, sidebarWidth: frameSnap.sidebarWidth,
    pref, drawer: ui.leftDrawer === true,
    panel: open ? { view: open.view, yielded: ui.panelYield === true } : null,
  })
  const shown = open !== null && layout.panel !== 'folded' ? open : null
  const [kept, setKept] = useState(shown)
  useEffect(() => {
    if (shown) { setKept(shown); return undefined }
    const timer = setTimeout(() => setKept(null), reducedMotion() ? 0 : PANEL_LINGER_MS)
    return () => clearTimeout(timer)
  }, [ui.details, ui.view, ui.renaming, ui.tab, ui.task, shown === null])
  const pane = shown ?? kept
  // The settings shell draws the dialog while DS Bot holds the seat.
  const shellHeld = useReadSettingsShellHeld(value => value)
  const [settings, settingsLeaving] = useLinger(shellHeld ? null : ui.settings, DIALOG_EXIT_MS)
  // The memory dialog shows a Bot's memory or a group chat's.
  const memoryOwner = (id) => {
    const bot = roster.byId[id]
    if (bot) return { id: bot.id, name: bot.name }
    const room = roster.roomsById[id]
    return room ? { id: room.id, name: room.name, group: true } : null
  }
  const [memory, memoryLeaving] = useLinger(ui.memory && memoryOwner(ui.memory) ? ui.memory : null, DIALOG_EXIT_MS)
  const owner = memory ? memoryOwner(memory) : null
  const [menu, menuLeaving] = useLinger(ui.menu, MENU_EXIT_MS)
  // A Session the Host made a moment ago is not in the shell's list yet: the asked-for
  // Bot fills the conversation area instead of the chat that was there before.
  const opening = openingModel({ pending: ui.pendingOpen ?? null, current, roster })
  const paletteToken = ui.palette?.token
  const groupSearchToken = ui.groupSearch?.token
  return h(Fragment, null,
    ui.botFolders ? h(OverlayBoundary, {
      name: 'bot-folders', reset: `${ui.botFolders.folderId ?? ''}:${ui.botFolders.botId ?? ''}`,
      onDismiss: () => actions.closeBotFolders?.(), actions,
    }, createPortal(h(BotFoldersDialog, { key: `${ui.botFolders.folderId ?? ''}:${ui.botFolders.botId ?? ''}`, start: ui.botFolders, roster, actions }), document.body)) : null,
    h(OverlayBoundary, { key: 'ds-bot:notifications', name: 'notifications', notify: false },
      h(NotificationWatcher, { useSessions, useSessionStatus, useRoster, useWork, actions })),
    opening ? h(OverlayBoundary, { name: 'opening', reset: opening.id, notify: false },
      createPortal(h(OpeningCover, { model: opening, column: layout.column }), document.body)) : null,
    pane ? h(OverlayBoundary, {
      name: 'panel', active: shown !== null, notify: shown !== null,
      reset: `${pane.id}:${pane.view}:${pane.tab ?? ''}:${pane.side ?? ''}:${pane.task?.botId ?? ''}:${pane.task?.taskId ?? ''}`,
      onDismiss: () => actions.closePanel?.(), actions,
    }, createPortal(h(BotPanel, { pane, leaving: shown === null, room: layout.room, overlay: layout.panel === 'overlay', roster, actions, useSessions, useSessionStatus, useActivity, useWork, useComputer, useBrowserTabs, useBrowserPages, useBrowserHolds }), document.body)) : null,
    ui.newChat ? h(OverlayBoundary, {
      name: 'new-chat', reset: `${ui.newChat}:${ui.newChatSection ?? ''}`,
      onDismiss: () => (actions.closeNewChat ?? actions.closeOverlay)?.(), actions,
    }, createPortal(h(NewChat, { key: `${ui.newChat}:${ui.newChatSection ?? ''}`, mode: ui.newChat, sectionId: ui.newChatSection ?? null, paneLeft: layout.column, roster, actions }), document.body)) : null,
    ui.palette ? h(OverlayBoundary, {
      name: 'palette', reset: paletteToken,
      onDismiss: () => actions.closePalette?.(paletteToken), actions,
    }, createPortal(h(CommandPalette, { key: ui.palette.token, start: ui.palette.query, token: ui.palette.token, roster, actions, useSessions }), document.body)) : null,
    ui.groupSearch && roster.roomsById[ui.groupSearch.roomId]
      ? h(OverlayBoundary, {
          name: 'group-search', reset: groupSearchToken,
          onDismiss: () => actions.closeGroupSearch?.(groupSearchToken), actions,
        }, createPortal(h(GroupSearch, { key: ui.groupSearch.token, room: roster.roomsById[ui.groupSearch.roomId], roster, token: ui.groupSearch.token, actions }), document.body))
      : null,
    ui.exchange ? h(OverlayBoundary, {
      name: 'exchange', reset: Array.isArray(ui.exchange) ? ui.exchange.join(':') : String(ui.exchange),
      onDismiss: () => (actions.closeExchange ?? actions.closeOverlay)?.(), actions,
    }, createPortal(h(ExchangeDialog, { pair: ui.exchange, paneLeft: layout.column, at: ui.exchangeAt ?? undefined, roster, actions }), document.body)) : null,
    ui.voice ? h(OverlayBoundary, {
      name: 'voice', reset: ui.voice,
      onDismiss: () => actions.closeVoice?.(), actions,
    }, createPortal(h(VoiceMode, { key: ui.voice, sessionId: ui.voice, paneLeft: layout.column, roster, actions, useSessions, useSessionStatus }), document.body)) : null,
    menu ? h(OverlayBoundary, {
      name: 'menu', active: !menuLeaving, notify: !menuLeaving,
      reset: `${menu.kind ?? ''}:${menu.id}:${menu.x}:${menu.y}`,
      onDismiss: () => actions.closeMenu?.(), actions,
    }, createPortal(h(ContextMenu, { key: `${menu.kind ?? ''}:${menu.id}:${menu.x}:${menu.y}`, menu, roster, actions, useWork, leaving: menuLeaving }), document.body)) : null,
    settings ? h(OverlayBoundary, {
      name: 'settings', active: !settingsLeaving, notify: !settingsLeaving,
      reset: `${settings.page}:${settings.id ?? ''}`,
      onDismiss: () => actions.closeSettings?.(), actions,
    }, createPortal(h(SettingsDialog, { page: settings.page, id: settings.id, roster, actions, useUpdate, leaving: settingsLeaving }), document.body)) : null,
    owner ? h(OverlayBoundary, {
      name: 'memory', active: !memoryLeaving, notify: !memoryLeaving,
      reset: owner.id,
      onDismiss: () => actions.closeMemory?.(), actions,
    }, createPortal(h(MemoryDialog, { key: owner.id, owner, actions, leaving: memoryLeaving }), document.body)) : null,
    ui.hint ? h(OverlayBoundary, { name: 'hint', reset: ui.hint.token, notify: false },
      createPortal(h(SettingHint, { key: ui.hint.token, hint: ui.hint, actions }), document.body)) : null)
}
