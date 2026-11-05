import { createElement as h, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { FishLogo } from './dsh-primitives.js'
import { isMainOf } from './sources.js'
import { currentPart, previewOf, relativeShort } from './text.js'
import { PlusIcon, SearchIcon, SidebarIcon, GaugeIcon, ClockIcon, GearIcon, PinMarkIcon, ConnectorIcon, SwitchIcon, CloudDownloadIcon, SignInIcon, SignOutIcon, SlidersIcon } from './icons.js'
import { lookOf, MAIN_LOOK } from './characters.js'
import { botState, BotMark, BotAvatar, RoomAvatar } from './mark.js'
import { reducedMotion } from './activity-row.js'
import { workStateLine } from './member-status.js'
import { Shimmer, workPhrase } from './cells.js'
import { springEasing, SPRING_POP, SPRING_SHAPE, useLinger, useViewport, viewBottom } from './motion.js'
import { hostText, t } from './i18n.js'
import { showsDshRow } from './dsh-offer.js'
import { quietly } from './diagnostics.js'
import { frameLayout, dragColumn, RAIL_WIDTH, FALLBACK_SIDEBAR_WIDTH, userSidebarToggle } from './frame-layout.js'
import { chatRoom, dshCollapsed } from './frame-watch.js'
import { useRowMenu } from './hold.js'
import { BoardEntry } from './project-board.js'
import { BotFolderSection, BOT_FOLDERS_CSS } from './bot-folders.js'
import { splitBotFolders } from './bot-folder-order.js'

// -------------------------------------------------------------------------
// Sidebar

// Manual "Mark as Unread" lasts until the conversation is opened again.
function useMarkedUnread(id, active, marked, actions) {
  useEffect(() => {
    if (active && marked) actions.clearUnread(id)
  }, [active, marked])
}

const PinMark = () => h('span', { className: 'bt-pin', 'aria-hidden': true }, h(PinMarkIcon))

// The rail shows a row's name only on hover; the wide list does so when the name is
// cut, which only the laid-out row can tell, so it is measured as the pointer enters.
const nameIfCut = (event) => {
  const row = event.currentTarget
  const name = row.querySelector('.bt-row-title')
  if (name && name.scrollWidth > name.clientWidth) row.title = name.textContent
  else row.removeAttribute('title')
}

// Whether an approval waits for the user: for a Bot, in any of its Sessions; for a group,
// from any of its members there.
const useApproval = (useWork, match) => (useWork ? useWork(work => (work.approvals ?? []).some(match)) : false)

// Work running in group Sessions, as "botId|tool" keys so a row redraws only when it
// changes: the groups one Bot works in, or the members at work in one group.
// Picked as text, so a row redraws only when what it shows changes.
const useGroupWork = (useWork, pick) => (useWork ? useWork(work => JSON.stringify(pick(work.rooms ?? {}))) : '[]')
const workKeys = text => JSON.parse(text)
const doingOf = ({ tool, said, note, target, switching, since }) => ({ tool, said, note, target, switching, since })
const workLine = (lead, doing, more) => h(Shimmer, null, `${lead} · ${workPhrase(doing)}…${more > 0 ? ` +${more}` : ''}`)
// The row already names the Bot; its own-chat preview is just what it is doing.
const doingLine = doing => h(Shimmer, null, `${workPhrase(doing)}…`)
// The Bots and groups a Bot waits for (handoffs.js), by the names they have now.
const waitingFor = (roster, waits) => {
  const names = [...(waits?.bots ?? []).map(id => roster.byId[id]?.name), ...(waits?.rooms ?? []).map(id => roster.roomsById[id]?.name)].filter(Boolean)
  return names.length === 0 ? '' : t('Waiting for {names}', { names: names.join(t(' and ')) })
}

function BotRow({ bot, roster, actions, useSessions, useSessionStatus, useSessionRetainInfo, useActivity, useWork, wide, marked, time }) {
  const id = bot.id
  const part = currentPart(bot)
  const preview = useSessions(list => previewOf(list, part, roster.exchangeTurns[part]))
  const running = useSessionStatus(map => map.get(part)?.running === true)
  const active = useSessionRetainInfo(part, info => (info?.retainedBy?.mainView ?? 0) > 0)
  const unread = useSessionStatus(map => map.get(part)?.completionUnread === true || map.get(part)?.pendingInteraction !== undefined) || (marked && !active)
  useMarkedUnread(id, active, marked, actions)
  const main = isMainOf(roster, id)
  const tile = isMainOf(roster, id)
  const approval = useApproval(useWork, entry => entry.botId === id)
  const alert = roster.questions?.[part] !== undefined || approval
  const doing = useActivity(map => map[id])
  // Work in a group runs in a Session of its own, so the Bot's chat stays idle meanwhile.
  const groups = workKeys(useGroupWork(useWork, rooms => Object.entries(rooms).flatMap(([roomId, entries]) => entries.filter(entry => entry.botId === id).map(entry => ({ id: roomId, ...doingOf(entry) })))))
  const away = !running && groups.length > 0
  const state = botState(running || away, doing, alert)
  // A Bot running in its own chat previews what it is doing, like a group's row.
  const runningLine = running && doing ? doingLine(doing) : null
  const awayLine = away ? workLine(roster.roomsById[groups[0].id]?.name ?? t('a group chat'), groups[0], groups.length - 1) : null
  const waits = workKeys(useWork ? useWork(work => JSON.stringify(work.waiting?.[id] ?? null)) : 'null')
  const waitsFor = state === 'waiting' ? waitingFor(roster, waits) : ''
  if (bot.hidden && !active && !main) return null
  // A right click and a phone hold open the same menu, at the mouse or the finger.
  const menu = useRowMenu(point => actions.openMenu({ kind: 'bot', id, x: point.x, y: point.y }))
  const pinned = bot.pinned === true && !tile
  const label = [bot.name, bot.role ?? '', main ? t('Main Bot') : '', pinned ? t('Pinned') : '', running || away ? t('Working') : '', waitsFor, approval ? t('Waiting for your approval') : alert ? t('Waiting for your answer') : '', unread ? t('Unread activity') : ''].filter(Boolean).join(', ')
  if (tile && wide) {
    return h('div', { className: 'bt-tile-wrap' }, h('button', {
      type: 'button', className: 'bt-tile', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
      'data-bot-id': id, title: preview || bot.name, onClick: () => actions.openSession(id), ...menu,
    },
    h(BotAvatar, { bot, size: 60, state, main: true }),
    h('span', { className: 'bt-tile-name' }, bot.name),
    bot.role ? h('span', { className: 'bt-chip' }, bot.role) : null,
    unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true }) : null))
  }
  return h('button', {
    type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
    'data-bot-id': id, title: wide ? undefined : bot.name, onMouseEnter: wide ? nameIfCut : undefined, onClick: () => actions.openSession(id), ...menu,
  },
  h(BotAvatar, { bot, size: wide ? 36 : 44, state, main }),
  pinned && !wide ? h(PinMark) : null,
  wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, bot.name), bot.role ? h('span', { className: 'bt-row-role' }, bot.role) : null, pinned ? h(PinMark) : null, time ? h('span', { className: 'bt-row-time' }, time) : null),
    runningLine ? h('span', { className: 'bt-row-preview' }, runningLine)
      : awayLine ? h('span', { className: 'bt-row-preview' }, awayLine)
        : waitsFor ? h('span', { className: 'bt-row-preview' }, waitsFor)
          : preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
  wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true })
    : !wide && !active && (alert || unread) ? h('span', { className: `bt-dot${alert ? ' bt-dot-wait' : ''}`, 'aria-hidden': true }) : null)
}

function RoomRow({ room, roster, actions, useSessions, useSessionStatus, useSessionRetainInfo, useWork, wide, marked, time }) {
  const id = room.id
  const menu = useRowMenu(point => actions.openMenu({ kind: 'room', id, x: point.x, y: point.y }))
  // The group's own Session is a chain of parts; the row shows the current one.
  const sessionId = room.sessionId ?? id
  const fallback = useSessions(list => previewOf(list, sessionId))
  const preview = room.preview?.replace(/\s+/g, ' ').trim() || fallback
  const active = useSessionRetainInfo(sessionId, info => (info?.retainedBy?.mainView ?? 0) > 0)
  const unread = useSessionStatus(map => map.get(sessionId)?.completionUnread === true) || (marked && !active)
  useMarkedUnread(id, active, marked, actions)
  const approval = useApproval(useWork, entry => entry.roomId === id)
  const members = workKeys(useGroupWork(useWork, rooms => (rooms[id] ?? []).filter(entry => entry.botId !== undefined).map(entry => ({ id: entry.botId, ...doingOf(entry) }))))
  const first = roster.byId[members[0]?.id]
  // The reader is in this group, so the line names no place: the member, the work and its clock.
  const workingLine = first ? workStateLine({ doing: members[0], lead: first.name, more: members.length - 1, className: 'bt-member-state bt-row-state' }) : null
  if (room.hidden && !active) return null
  const pinned = room.pinned === true
  const label = [room.name, pinned ? t('Pinned') : '', members.length > 0 ? t('Working') : '', approval ? t('Waiting for your approval') : ''].filter(Boolean).join(', ')
  return h('button', {
    type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
    'data-room-id': id, title: wide ? undefined : room.name, onMouseEnter: wide ? nameIfCut : undefined, onClick: () => actions.openSession(id),
    onContextMenu: (event) => { event.preventDefault(); actions.openMenu({ kind: 'room', id, x: event.clientX, y: event.clientY }) }, ...menu,
  },
  h(RoomAvatar, { room, roster, size: wide ? 36 : 44 }),
  pinned && !wide ? h(PinMark) : null,
  wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, room.name), pinned ? h(PinMark) : null, time ? h('span', { className: 'bt-row-time' }, time) : null),
    workingLine ? h('span', { className: 'bt-row-preview' }, workingLine) : preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
  wide && approval && !active ? h('span', { className: 'bt-unread bt-unread-wait', 'aria-hidden': true })
    : wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true })
      : !wide && !active && (approval || unread) ? h('span', { className: `bt-dot${approval ? ' bt-dot-wait' : ''}`, 'aria-hidden': true }) : null)
}

// One expanded DSH Agent Session row: title, relative stamp, rename field, and a
// context menu for rename/archive.
function AgentSessionRow({ session, agent, actions, renaming, index }) {
  const input = useRef(null)
  const menu = useRowMenu(point => actions.openMenu({ kind: 'agent-session', id: session.id, agentId: agent.id, x: point.x, y: point.y }))
  useLayoutEffect(() => {
    if (!renaming) return
    input.current?.focus()
    input.current?.select()
  }, [renaming])
  if (renaming) {
    const commit = (keep) => {
      const value = input.current?.value ?? ''
      if (!keep || value.trim() === '' || value.trim() === session.title) { actions.endAgentRename(); return }
      // The editor closes only after the rename landed; a failure keeps it open.
      void (async () => {
        try {
          await actions.renameAgentSession(agent.id, session.id, value)
          actions.endAgentRename()
        } catch (error) {
          actions.reportError(error, 'agent-rename')
        }
      })()
    }
    return h('div', { className: 'bt-agent-sub-row bt-agent-edit', style: { '--i': index } },
      h('input', {
        ref: input, defaultValue: session.title, 'aria-label': t('Rename'),
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') commit(true)
          else if (event.key === 'Escape') commit(false)
        },
        onBlur: () => commit(true),
      }))
  }
  return h('button', {
    type: 'button', className: 'bt-agent-sub-row', 'aria-current': session.active ? 'page' : undefined, style: { '--i': index },
    onClick: () => actions.openAgentSession(session.id), ...menu,
  },
  h('span', { className: 'bt-agent-sub-title' }, session.title),
  h('span', { className: 'bt-agent-sub-time' }, session.at > 0 ? relativeShort(session.at) : ''))
}

// The DSH Agent row: a plain dsh Session list lives in the Bot workspace, so it
// sits among the Bots with the harness's own whale mark.
function AgentRow({ agent, actions, useSessions, useSessionStatus, useUi, wide, marked }) {
  const menu = useRowMenu(point => actions.openMenu({ kind: 'agent', id: agent.id, x: point.x, y: point.y }))
  const info = useSessions(list => JSON.stringify(agent.sessions.map((id) => {
    const row = list.byId[id]
    return {
      id,
      // A blank Session's title is the workspace folder name; show the label instead.
      title: row?.blank === true ? '' : (row?.displayTitle ?? row?.title ?? ''),
      at: row?.updatedAt ?? 0,
      running: row?.running === true,
      active: (row?.retainedBy?.mainView ?? 0) > 0,
    }
  }).sort((a, b) => b.at - a.at)))
  const statusInfo = useSessionStatus(map => JSON.stringify(agent.sessions.map(id => ({
    id, running: map.get(id)?.running === true, unread: map.get(id)?.completionUnread === true,
  }))))
  const statuses = Object.fromEntries(JSON.parse(statusInfo).map(entry => [entry.id, entry]))
  const sessions = JSON.parse(info).map(session => ({
    ...session,
    running: statuses[session.id]?.running ?? session.running,
    unread: statuses[session.id]?.unread ?? false,
    title: session.title === '' ? t('New session') : session.title,
  }))
  const renaming = useUi(value => value.renameAgent)
  const active = sessions.some(session => session.active)
  const running = sessions.some(session => session.running)
  const unread = sessions.some(session => session.unread) || (marked && !active)
  useMarkedUnread(agent.id, active, marked, actions)
  const preview = sessions[0]?.title ?? t('New session')
  const label = ['DSH Agent', running ? t('Working') : '', unread ? t('Unread activity') : ''].filter(Boolean).join(', ')
  const open = active && wide
  return h('div', { className: 'bt-agent' },
    h('button', {
      type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
      'data-agent-id': agent.id, title: wide ? undefined : 'DSH Agent', onClick: () => actions.openAgent(agent.id),
      ...menu,
    },
    h('span', { className: `bt-agent-ava${running ? ' bt-run' : ''}` }, h(FishLogo, { size: wide ? 22 : 24 })),
    wide ? h('span', { className: 'bt-row-body' },
      h('span', { className: 'bt-row-name' }, 'DSH Agent'),
      preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
    wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true })
      : !wide && unread && !active ? h('span', { className: 'bt-dot', 'aria-hidden': true }) : null),
    h('div', { className: 'bt-agent-sub', 'data-open': open || undefined },
      h('div', { className: 'bt-agent-sub-in' },
        h('button', { type: 'button', className: 'bt-agent-sub-row bt-agent-new', style: { '--i': 0 }, onClick: () => { void actions.newAgentSession(agent.id).catch(error => actions.reportError(error, 'agent-session')) } },
          h(PlusIcon), h('span', { className: 'bt-agent-sub-title' }, t('New session'))),
        sessions.map((session, index) => h(AgentSessionRow, {
          key: session.id, session, agent, actions, index: index + 1,
          renaming: renaming === session.id,
        })))))
}

// List rows glide to new places on a spring.
const GLIDE = springEasing(1000, 63)

function useListGlide(listRef, layout, key) {
  const tops = useRef({ layout, map: new Map() })
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const next = new Map()
    const still = reducedMotion() || tops.current.layout !== layout
    for (const row of list.querySelectorAll('[data-bot-id],[data-room-id],[data-agent-id]')) {
      const id = row.dataset.botId ?? row.dataset.roomId ?? row.dataset.agentId
      // offsetTop ignores transforms, so a glide in flight does not skew the next one.
      const top = row.offsetTop
      next.set(id, top)
      const before = tops.current.map.get(id)
      if (!still && before !== undefined && Math.abs(before - top) > 0.5) {
        row.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], GLIDE)
      }
    }
    tops.current = { layout, map: next }
  }, [layout, key])
}

// In the Bot view the left column is ours, drawn on <body> over the shell's
// collapsed sidebar: the open column or the avatar rail push the conversation
// over, the drawer floats above it. Its right edge drags the open width, and
// down to the rail.
function LeftColumn({ mode, width, onGrip, leaving, children }) {
  return createPortal(h('div', { className: 'bt-leftcol', 'data-left': mode, 'data-leaving': leaving || undefined, 'aria-hidden': leaving || undefined, style: { width: `${width}px` } },
    children,
    h('div', { className: 'bt-leftcol-grip', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('Resize sidebar'), title: t('Resize sidebar'), onPointerDown: onGrip })), document.body)
}

// The top-left switch hides the whole column and brings it back. Under a
// Windows title bar it takes the shell's own place in the title band; elsewhere
// it shows only while the column is hidden, since the column's own top row
// carries it otherwise.
function TitleToggle({ hidden, onToggle }) {
  if (typeof document === 'undefined') return null
  const titlebar = document.documentElement.hasAttribute('data-windows-titlebar')
  if (!titlebar && !hidden) return null
  const label = t(hidden ? 'Expand sidebar' : 'Collapse sidebar')
  return createPortal(h('button', {
    type: 'button', className: titlebar ? 'bt-title-toggle' : 'bt-round bt-title-toggle', 'aria-label': label, title: label, onClick: onToggle,
  }, h(SidebarIcon)), document.body)
}

// The Bot-API-down hint cannot send the user to Settings → Feedback: its
// diagnostics request needs the same API. What still works in this state is
// the last error this window recorded, and the engine's own startup output —
// its console, or the app's startup error box (#516).
export function TeamSidebar(props) {
  const { wide, useRoster, useUi, useSessions, actions } = props
  const listRef = useRef(null)
  const roster = useRoster(value => value)
  const markedUnread = useUi(value => value.unread)
  const uiNow = useUi(value => value)
  props.useRegistry(value => value)
  const frameSnap = props.useFrame ? props.useFrame(value => value) : { viewport: typeof window === 'undefined' ? 0 : window.innerWidth, sidebarWidth: FALLBACK_SIDEBAR_WIDTH, collapsedWidth: 0 }
  const pref = props.useSidebarPref ? props.useSidebarPref(value => value) : 'open'
  const layout = frameLayout({
    viewport: frameSnap.viewport, sidebarWidth: frameSnap.sidebarWidth,
    pref, drawer: uiNow.leftDrawer === true,
    panel: uiNow.details ? { view: uiNow.view, yielded: uiNow.panelYield === true } : null,
  })
  // A drag of the column's edge shows where it would land, live.
  const [drag, setDrag] = useState(null)
  const mode = drag?.left ?? layout.left
  // A hidden column stays mounted for its slide out; `shown` is the mode it last had.
  const [held, leaving] = useLinger(mode === 'hidden' ? null : mode, SPRING_SHAPE.duration)
  const shown = held ?? mode
  const wideContent = shown !== 'rail'
  const updated = useSessions(list => {
    const stamps = {}
    for (const id of list.ids) stamps[id] = list.byId[id]?.updatedAt ?? 0
    return JSON.stringify(stamps)
  })
  const order = useMemo(() => {
    const stamps = JSON.parse(updated)
    // A Session's list time only moves for messages the user typed, so a Bot answering another
    // Bot never moved its row. The team view carries the newest message in or out of each Bot
    // and group; that is what the list moves on, with the Session time and the creation time as
    // the floor so a missing field never sends a row to the end.
    const activity = (item, id) => {
      const seen = typeof item.lastActivity === 'number' ? item.lastActivity : 0
      return Math.max(seen, stamps[id] ?? 0, item.createdAt ?? 0)
    }
    const entries = [
      ...roster.bots.filter(bot => !isMainOf(roster, bot.id)).map(bot => ({ kind: 'bot', item: bot, at: activity(bot, currentPart(bot)) })),
      ...roster.rooms.map(room => ({ kind: 'room', item: room, at: activity(room, room.id) })),
      // The Agent sorts by its most recent Session, falling back to when it was added.
      ...(roster.agents ?? []).map(agent => ({ kind: 'agent', item: agent, at: Math.max(0, ...agent.sessions.map(id => stamps[id] ?? 0)) || agent.createdAt })),
    ]
    return entries.sort((a, b) => Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned)) || b.at - a.at)
  }, [roster, updated])
  const mains = useMemo(() => (roster.mainBotIds ?? []).map(id => roster.byId[id]).filter(Boolean), [roster])
  // On a phone the list is a page of its own: the sidebar hands over to it instead of
  // showing the rail, so only one copy of the list is ever mounted.
  const onPhone = props.useMobileNav?.(value => value) ?? false
  const atList = props.useNavLevel?.(value => value === 'list') ?? false
  useListGlide(listRef, wideContent, order.map(entry => entry.item.id).join(','))
  useLandOnMainBot(roster, useSessions, actions)
  useReportReady(roster.ready, roster)

  // Our column pushes the conversation over by what it takes beyond the shell's
  // collapsed track; a drawer floats over the rail's place, so it pushes as much
  // as the rail and the chat stays put when it opens or closes.
  const openWidth = drag?.width ?? frameSnap.sidebarWidth
  const ourWidth = shown === 'rail' ? RAIL_WIDTH : openWidth
  const pushed = mode === 'open' ? openWidth : mode === 'hidden' ? 0 : RAIL_WIDTH
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    chatRoom.setLeft(Math.max(0, pushed - (frameSnap.collapsedWidth ?? 0)))
  }, [pushed, frameSnap.collapsedWidth])
  useEffect(() => () => { if (typeof document !== 'undefined') chatRoom.setLeft(null) }, [])

  // The edge drag: live while the pointer moves, the column's new state on release.
  // Per frame the drag writes the column's own inline style and each conversation
  // column's inline margin — the same path the panel's resize takes — so nothing
  // re-renders or restyles the chat while the pointer moves. A render only happens
  // when the drag crosses the rail's snap line, and the spring (`data-folding`)
  // rides that switch alone: it comes off when the switch settles, so a drag that
  // keeps going afterwards follows the cursor frame by frame again.
  const settleTimer = useRef(0)
  const springTimer = useRef(0)
  const startDrag = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    clearTimeout(settleTimer.current)
    clearTimeout(springTimer.current)
    const grip = event.currentTarget
    const column = grip.parentElement
    // A re-grab can land while a previous spring still stands: the new drag owns
    // the column from here, so its fold state starts clean.
    delete column.dataset.folding
    grip.setPointerCapture?.(event.pointerId)
    chatRoom.hold(true)
    const columns = chatRoom.columns()
    for (const col of columns) col.style.setProperty('transition', 'none', 'important')
    const offLeft = frameSnap.collapsedWidth ?? 0
    let last = null
    let liveLeft = mode
    let done = false
    const write = (at) => {
      const width = at.left === 'rail' ? RAIL_WIDTH : at.width
      column.style.width = `${width}px`
      column.style.setProperty('--bt-lc-w', `${width}px`)
      const push = Math.max(0, (at.left === 'open' ? width : RAIL_WIDTH) - offLeft)
      for (const col of columns) col.style.setProperty('margin-left', `${push}px`, 'important')
    }
    // A snap crossing arms the spring for the switch's glide; the timer takes it
    // back off once the switch has had its duration.
    let springUntil = 0
    const springOff = () => {
      springUntil = 0
      delete column.dataset.folding
      for (const col of columns) col.style.setProperty('transition', 'none', 'important')
    }
    const springOn = () => {
      column.dataset.folding = ''
      for (const col of columns) col.style.setProperty('transition', `margin-left ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}`, 'important')
      springUntil = performance.now() + SPRING_SHAPE.duration
      clearTimeout(springTimer.current)
      springTimer.current = setTimeout(springOff, SPRING_SHAPE.duration)
    }
    const track = (x) => {
      last = dragColumn(x, window.innerWidth)
      if (last.left !== liveLeft) {
        liveLeft = last.left
        if (!reducedMotion()) springOn()
        setDrag(last)
      }
      write(last)
    }
    const onMove = (move) => track(move.clientX)
    // The rules and props take the landed geometry back over; while the fold's
    // spring still runs this waits it out so the landing does not snap. The
    // inline `width` stays: it is the landed geometry, and React writes its width
    // prop only when the value changes, so removing it would leave the edge at
    // its CSS fallback (57px on the rail).
    const finish = () => {
      clearTimeout(springTimer.current)
      if (column.isConnected && last !== null) chatRoom.setLeft(Math.max(0, (last.left === 'open' ? last.width : RAIL_WIDTH) - offLeft))
      for (const col of columns) { col.style.removeProperty('margin-left'); col.style.removeProperty('transition') }
      column.style.removeProperty('--bt-lc-w')
      delete column.dataset.folding
      chatRoom.hold(false)
    }
    const ends = ['pointerup', 'pointercancel', 'lostpointercapture']
    const onEnd = (end) => {
      if (done) return
      done = true
      if (end.type === 'pointerup') track(end.clientX)
      grip.removeEventListener('pointermove', onMove)
      for (const name of ends) grip.removeEventListener(name, onEnd)
      setDrag(null)
      if (last === null) { finish(); return }
      // The drag is the latest explicit gesture: it takes back a yielded panel's room.
      actions.setPanelYield?.(false)
      if (last.left === 'rail') { actions.setLeftDrawer?.(false); actions.setSidebarPref?.('rail') }
      else {
        actions.setSidebarWidth?.(last.width)
        actions.setSidebarPref?.('open')
        actions.setLeftDrawer?.(last.left === 'drawer')
      }
      if (springUntil === 0) finish()
      else settleTimer.current = setTimeout(finish, Math.max(0, springUntil - performance.now()) + 60)
    }
    grip.addEventListener('pointermove', onMove)
    for (const name of ends) grip.addEventListener(name, onEnd)
  }

  // In the Bot view the shell's own sidebar stays collapsed under our column. A
  // flip we did not ask for is the user's own switch gesture (the shell's button
  // or shortcut where it still reaches), unless the width just crossed the
  // shell's auto-collapse line, which re-applies the shell's own rule.
  const dsh = useRef(null)
  const requested = useRef(false)
  // The request mark always lapses on its own: a re-render before the shell's
  // flip must not leave it set, or the user's next switch would read as ours.
  // A lapse checks the shell again, since our flip and another one landing in
  // the same frame cancel out and no flip arrives to settle it.
  const requestLapse = useRef(0)
  const [lapsed, setLapsed] = useState(0)
  useEffect(() => () => clearTimeout(requestLapse.current), [])
  // The window's own resize event lands before the shell's next-frame measure,
  // so it dates a width change even while our frame source still holds the old one.
  const resizedAt = useRef(0)
  useEffect(() => {
    const onResize = () => { resizedAt.current = performance.now() }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const quiet = (on) => {
    // Our own collapse of the shell's sidebar lands at once: its slide would drag
    // the conversation across under our column.
    if (on) document.documentElement.setAttribute('data-bt-collapsing', '')
    else document.documentElement.removeAttribute('data-bt-collapsing')
  }
  useEffect(() => () => quiet(false), [])
  useLayoutEffect(() => {
    if (typeof document === 'undefined' || typeof actions.toggleSidebar !== 'function') return undefined
    const collapsed = dshCollapsed() ?? !wide
    const prev = dsh.current
    const viewport = window.innerWidth
    dsh.current = { collapsed, viewport }
    if (prev !== null && collapsed !== prev.collapsed) {
      if (requested.current) requested.current = false
      else if (!collapsed && userSidebarToggle({ before: prev, after: { collapsed, viewport }, sinceResize: performance.now() - resizedAt.current })) {
        toggleRef.current()
      }
    }
    if (collapsed) { requested.current = false; quiet(false); return undefined }
    if (requested.current) return undefined
    requested.current = true
    quiet(true)
    actions.toggleSidebar()
    clearTimeout(requestLapse.current)
    requestLapse.current = setTimeout(() => { requested.current = false; quiet(false); setLapsed(value => value + 1) }, 300)
    return undefined
  }, [wide, frameSnap.viewport, lapsed])

  // The drawer closes on a row pick, on Escape and on a press outside it.
  useEffect(() => {
    if (mode !== 'drawer') return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && event.target.closest('.bt-leftcol')) return
      actions.setLeftDrawer?.(false)
    }
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      actions.setLeftDrawer?.(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [mode])

  const navigate = (open, id) => {
    const result = open(id)
    if (uiNow.leftDrawer === true) actions.setLeftDrawer?.(false)
    return result
  }
  const rowActions = {
    ...actions,
    openSession: id => navigate(actions.openSession, id),
    openAgent: id => navigate(actions.openAgent, id),
    openAgentSession: id => navigate(actions.openAgentSession, id),
    newAgentSession: id => navigate(actions.newAgentSession, id),
  }
  const rowProps = { roster, actions: rowActions, useSessions, useUi, useSessionStatus: props.useSessionStatus, useSessionRetainInfo: props.useSessionRetainInfo, useActivity: props.useActivity, useWork: props.useWork, wide: wideContent }
  // Typing while the sidebar has focus starts a search.
  const typeToSearch = (event) => {
    if (event.defaultPrevented || event.key.length !== 1 || event.key === ' ' || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]')) return
    event.preventDefault()
    actions.openPalette(event.key)
  }
  // The list page is mounted while it is the level, and also while a page motion is in
  // flight: it is the page the conversation slides over on the way in, and the one that
  // comes back underneath on the way out. At rest on the conversation it is not mounted.
  const moving = props.useNavMotion?.(value => value !== 'idle') ?? false
  if (onPhone && (atList || moving)) {
    return createPortal(h(MobileNavList, {
      roster, actions, listRef, mains, order, markedUnread, typeToSearch,
      // The page is the full-width list: its rows carry names, previews and the unread dot.
      rowProps: { ...rowProps, wide: true }, useUpdate: props.useUpdate,
    }), document.body)
  }
  if (onPhone) return null
  // The switch (top-left button, the shortcut) hides the whole column or brings
  // back the one it hid.
  const onToggle = () => actions.toggleLeftHidden?.()
  // The shell's sidebar shortcut is caught on its way down, before the shell's
  // own listener on window sees it: left to the shell, it would expand the shell's
  // sidebar first and our sync would pull it back, a visible flash.
  const toggleRef = useRef(onToggle)
  toggleRef.current = onToggle
  useEffect(() => {
    const onKey = (event) => {
      if (event.defaultPrevented || event.isComposing || !pressesShellShortcut(event, 'sidebar.left.toggle')) return
      if (event.target instanceof Element && event.target.closest('.xterm')) return
      if (document.querySelector('[aria-modal="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      toggleRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])
  const top = wideContent
    ? h('div', { className: 'bt-side-top' },
        h('span', { className: 'bt-brand' }, h(BrandMark, { size: 22 }), h(BrandName)),
        h(BoardEntry, { actions, pending: roster.boardPending ?? 0 }),
        h(UpdateButton, { useUpdate: props.useUpdate, actions }),
        h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Search'), title: t('Search'), onClick: () => actions.openPalette() }, h(SearchIcon)),
        h('button', { type: 'button', className: 'bt-round', 'aria-label': t('New…'), title: t('New…'), onClick: () => actions.openNewChat('new') }, h(PlusIcon)),
        h('button', { type: 'button', className: 'bt-round bt-side-collapse', 'aria-label': t('Collapse sidebar'), title: t('Collapse sidebar'), onClick: onToggle }, h(SidebarIcon)))
    : h('div', { className: 'bt-rail-top' },
        h(BoardEntry, { actions, pending: roster.boardPending ?? 0 }),
        h(UpdateButton, { useUpdate: props.useUpdate, actions }),
        h('button', { type: 'button', className: 'bt-round bt-side-collapse', 'aria-label': t('Collapse sidebar'), title: t('Collapse sidebar'), onClick: onToggle }, h(SidebarIcon)))
  // The foot stands in for the shell's hidden footer: the account avatar, and on
  // the rail the new-chat button above it.
  const foot = wideContent
    ? h('div', { className: 'bt-leftcol-foot' }, h(AccountLauncher, { seat: false, actions }))
    : h('div', { className: 'bt-leftcol-foot bt-leftcol-foot-rail' },
        h('button', { type: 'button', className: 'bt-round', 'aria-label': t('New…'), title: t('New…'), onClick: () => actions.openNewChat('new') }, h(PlusIcon)),
        h(AccountLauncher, { seat: false, actions }))
  const content = h('div', { className: wideContent ? 'bt-side' : 'bt-side bt-rail', onKeyDown: typeToSearch },
    top,
    wideContent && roster.readOnly ? h('div', { className: 'bt-hint bt-read-only', role: 'status' }, hostText(roster.readOnly)) : null,
    h(BotList, { listRef, mains, order, roster, markedUnread, rowProps }),
    foot)
  return h(Fragment, null,
    h(TitleToggle, { hidden: mode === 'hidden', onToggle }),
    shown === 'hidden' ? null : h(LeftColumn, { mode: shown, width: ourWidth, onGrip: startDrag, leaving }, content))
}

// The Bot and group list. The sidebar and the phone's list page both render it, so the
// two views cannot disagree about order, marks or rows.
function BotList({ listRef, mains, order, roster, markedUnread, rowProps, showTime }) {
  const stamp = entry => (showTime ? relativeShort(entry.at) : undefined)
  const sections = splitBotFolders(order, roster.botFolders)
  const row = entry => (entry.kind === 'bot'
    ? h(BotRow, { key: entry.item.id, ...rowProps, bot: entry.item, marked: markedUnread[entry.item.id] === true, time: stamp(entry) })
    : entry.kind === 'room'
      ? h(RoomRow, { key: entry.item.id, ...rowProps, room: entry.item, marked: markedUnread[entry.item.id] === true, time: stamp(entry) })
      : h(AgentRow, { key: entry.item.id, ...rowProps, agent: entry.item, marked: markedUnread[entry.item.id] === true }))
  const tops = (mains ?? []).map(bot => h(BotRow, { key: bot.id, ...rowProps, bot, marked: markedUnread[bot.id] === true, time: undefined }))
  return h('div', { ref: listRef, className: 'bt-list', role: 'region', 'aria-label': t('Bot list') },
    mains === undefined || mains.length === 0
      ? roster.ready ? null : h('div', { className: 'bt-hint' }, t('Setting up your Main Bot…'))
      : rowProps.wide
        ? mains.length === 1 ? tops[0] : h(MainStrip, { count: mains.length }, tops)
        : tops,
    rowProps.wide ? sections.pinned.map(row) : null,
    rowProps.wide ? sections.folders.map(folder => h(BotFolderSection, { key: folder.id, folder, roster, actions: rowProps.actions, useUi: rowProps.useUi, renderRow: row })) : null,
    rowProps.wide ? sections.loose.map(row) : order.map(row),
    rowProps.wide ? h('button', { type: 'button', className: 'bt-bot-folder-empty', onClick: () => rowProps.actions.openBotFolders() }, t('New Bot folder')) : null)
}

// A row of Main Bots that runs past the sidebar: the wheel pans it, a mouse drags it,
// touch swipes it natively, and the edge that still holds more fades.
function useHorizontalScroll(ref, setEdges) {
  useEffect(() => {
    const row = ref.current
    if (row === null) return undefined
    const read = () => {
      const max = row.scrollWidth - row.clientWidth
      const left = row.scrollLeft > 1
      const right = max - row.scrollLeft > 1
      setEdges(current => (current.left === left && current.right === right ? current : { left, right }))
    }
    let drag = null
    let swallowClick = false
    const refuseClick = (event) => {
      if (!swallowClick) return
      swallowClick = false
      event.stopPropagation()
      event.preventDefault()
    }
    const onDown = (event) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return
      // No capture yet: capturing on press retargets the click to this row, and the Bot
      // tile under the pointer never gets its own click. Capture once the press is a drag.
      drag = { x: event.clientX, left: row.scrollLeft, moved: false, pointerId: event.pointerId, captured: false }
      row.dataset.dragging = ''
    }
    const onMove = (event) => {
      if (drag === null) return
      const dx = event.clientX - drag.x
      if (!drag.moved && Math.abs(dx) > 4) {
        drag.moved = true
        try {
          row.setPointerCapture(event.pointerId)
          drag.captured = true
        } catch { /* the pointer already went away */ }
      }
      if (drag.moved) row.scrollLeft = drag.left - dx
    }
    const onUp = () => {
      if (drag === null) return
      const { moved, captured, pointerId } = drag
      drag = null
      delete row.dataset.dragging
      if (captured) {
        try { row.releasePointerCapture(pointerId) } catch { /* already released */ }
      }
      // The press that ended a drag must not open the Bot it ended on.
      if (moved) {
        swallowClick = true
        setTimeout(() => { swallowClick = false }, 300)
      }
    }
    const onWheel = (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      const max = row.scrollWidth - row.clientWidth
      if (max <= 0) return
      // One notch often runs past a short row; clamp to the edge, and hand the wheel back
      // to the page once the row is already there.
      const atStart = row.scrollLeft <= 0
      const atEnd = row.scrollLeft >= max - 1
      if ((event.deltaY < 0 && atStart) || (event.deltaY > 0 && atEnd)) return
      event.preventDefault()
      row.scrollLeft = Math.max(0, Math.min(max, row.scrollLeft + event.deltaY))
    }
    row.addEventListener('pointerdown', onDown)
    row.addEventListener('pointermove', onMove)
    row.addEventListener('pointerup', onUp)
    row.addEventListener('pointercancel', onUp)
    row.addEventListener('click', refuseClick, true)
    row.addEventListener('wheel', onWheel, { passive: false })
    row.addEventListener('scroll', read, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null
    observer?.observe(row)
    read()
    return () => {
      row.removeEventListener('pointerdown', onDown)
      row.removeEventListener('pointermove', onMove)
      row.removeEventListener('pointerup', onUp)
      row.removeEventListener('pointercancel', onUp)
      row.removeEventListener('click', refuseClick, true)
      row.removeEventListener('wheel', onWheel)
      row.removeEventListener('scroll', read)
      observer?.disconnect()
    }
  }, [ref, setEdges])
}

function MainStrip({ count, children }) {
  const row = useRef(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  useHorizontalScroll(row, setEdges)
  return h('div', { className: 'bt-mains-wrap' },
    h('div', { ref: row, className: 'bt-mains', 'data-count': count, role: 'group', 'aria-label': t('Main Bots') }, children),
    edges.left ? h('span', { className: 'bt-mains-fade bt-mains-fade-left', 'aria-hidden': true }) : null,
    edges.right ? h('span', { className: 'bt-mains-fade bt-mains-fade-right', 'aria-hidden': true }) : null)
}

// The Main Bot's card is the list's first item, and on a phone it stands in for the whole
// Bot while it is out of view: a thin bar with its mark, its name and the way back to the
// full card. The bar overlays the list rather than taking a row of its own — the list's
// scroll geometry must not change when the bar comes and goes, or the content under the
// reader's finger would move and the card could slide back into view by itself.
const CHIEF_COLLAPSE_AT = 24

// The Main Bot's card is the list's first item, and on a phone a small pill stands in for
// it once the list has moved and all but a sliver of the card is past the top edge. The
// pill opens the Main Bot's conversation, the same move the card makes.
function useChiefBar(listRef) {
  const [out, setOut] = useState(false)
  useEffect(() => {
    const list = listRef.current
    if (list === null) return undefined
    const read = () => {
      const card = list.querySelector('.bt-tile-wrap')
      const box = list.getBoundingClientRect()
      // A short list cannot scroll the whole card away, so the top edge is the measure: the
      // pill comes when the card has all but left, and goes when the card is back in sight.
      const next = card !== null && list.scrollTop > CHIEF_COLLAPSE_AT && card.getBoundingClientRect().bottom <= box.top + 24
      setOut(current => (current === next ? current : next))
    }
    list.addEventListener('scroll', read, { passive: true })
    read()
    return () => list.removeEventListener('scroll', read)
  }, [listRef])
  return out
}

// The card's stand-in: the mark with its Main Bot star, the name and the role, on a small
// rounded card under the top row. It is a button, and it goes where the card goes.
function ChiefBar({ mains, actions }) {
  const list = (mains ?? []).filter(Boolean)
  if (list.length === 0) return null
  // One Main Bot keeps the card the phone always had; several share one pill, one segment
  // each, so the stand-in still reaches every Main Bot.
  return list.length === 1
    ? h(ChiefPill, { main: list[0], actions })
    : h(ChiefGroup, { mains: list, actions })
}

function ChiefPill({ main, actions }) {
  const name = main.name
  return h('button', {
    type: 'button', className: 'bt-chief-bar', 'data-bt-chief-bar': '',
    'aria-label': t("Open {name}'s chat", { name }), title: name,
    onClick: () => actions.openSession(main.id),
  },
    h(BotAvatar, { bot: main, size: 30, state: 'idle', main: true, badge: true, live: false }),
    h('span', { className: 'bt-chief-text' },
      h('span', { className: 'bt-chief-name' }, name),
      main.role ? h('span', { className: 'bt-chief-role' }, main.role) : null))
}

function ChiefGroup({ mains, actions }) {
  const row = useRef(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  useHorizontalScroll(row, setEdges)
  return h('div', { className: 'bt-chief-bar bt-chief-group', 'data-bt-chief-bar': '' },
    h('div', { ref: row, className: 'bt-chief-track', role: 'group', 'aria-label': t('Main Bots') },
      mains.map(main => h('button', {
        key: main.id, type: 'button', className: 'bt-chief-seg',
        'aria-label': t("Open {name}'s chat", { name: main.name }), title: main.name,
        onClick: () => actions.openSession(main.id),
      },
      h(BotAvatar, { bot: main, size: 28, state: 'idle', main: true, badge: true, live: false }),
      h('span', { className: 'bt-chief-seg-name' }, main.name)))),
    edges.left ? h('span', { className: 'bt-chief-fade bt-chief-fade-left', 'aria-hidden': true }) : null,
    edges.right ? h('span', { className: 'bt-chief-fade bt-chief-fade-right', 'aria-hidden': true }) : null)
}

// The phone's list page: the same list as the sidebar, on a page of its own. Its root
// carries the hook the styles and the test bench read, and its brand opens the same
// account menu the footer avatar does — the shell's settings seat is not on this page.
// The page is unmounted whenever a conversation holds the screen, and how far the reader
// had scrolled is part of the way back: the return hands them the list they left rather
// than its top, so the position is kept here, outside the page that comes and goes.
let listScrollTop = 0

function MobileNavList({ roster, actions, listRef, mains, order, markedUnread, rowProps, typeToSearch, useUpdate }) {
  const menu = useAccountMenu(actions, 'down')
  const chiefOut = useChiefBar(listRef)
  // Restored before the first paint, so the list is never shown at its top first.
  useLayoutEffect(() => {
    const list = listRef.current
    if (list === null) return undefined
    list.scrollTop = listScrollTop
    const save = () => { listScrollTop = list.scrollTop }
    list.addEventListener('scroll', save, { passive: true })
    return () => { save(); list.removeEventListener('scroll', save) }
  }, [listRef])
  // The state is published for the styles and the test bench: `collapsed` while the pill
  // stands in, `expanded` while the card is in place. It exists only while this page does,
  // which is only where the judgment holds.
  useEffect(() => {
    document.body.dataset.btChief = chiefOut ? 'collapsed' : 'expanded'
    return () => { delete document.body.dataset.btChief }
  }, [chiefOut])
  return h('div', { className: 'bt-nav-page', 'data-bt-nav': 'list', onKeyDown: typeToSearch },
    h('div', { className: 'bt-nav-top' },
      h('button', {
        ref: menu.anchor, type: 'button', className: 'bt-brand bt-nav-account', 'aria-label': t('Account'),
        'aria-haspopup': 'menu', 'aria-expanded': menu.open, 'data-bt-settings-entry': '', onClick: menu.toggle,
      }, h(BrandMark, { size: 22 }), h(BrandName)),
      h(BoardEntry, { actions, pending: roster.boardPending ?? 0 }),
      h(UpdateButton, { useUpdate, actions }),
      h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Search'), title: t('Search'), onClick: () => actions.openPalette() }, h(SearchIcon)),
      h('button', { type: 'button', className: 'bt-round', 'aria-label': t('New…'), title: t('New…'), onClick: () => actions.openNewChat('new') }, h(PlusIcon))),
    roster.readOnly ? h('div', { className: 'bt-hint bt-read-only', role: 'status' }, hostText(roster.readOnly)) : null,
    h('div', { className: 'bt-nav-body' },
      // The stand-in comes first in the DOM: while it is drawn, it is what the card is.
      chiefOut ? h(ChiefBar, { mains, actions }) : null,
      h(BotList, { listRef, mains, order, roster, markedUnread, rowProps, showTime: true })),
    menu.menu)
}

// The update button at the sidebar's top right: a cloud while a newer DS Bot —
// or a newer verified DSH — is available, then the install's progress and
// result. Its card has one row each for the bot and DSH, with their versions,
// the release notes link, and each row's own button.
function UpdateButton({ useUpdate, actions }) {
  const update = useUpdate(value => value)
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState(null)
  const [error, setError] = useState('')
  const [dshError, setDshError] = useState('')
  const button = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && (event.target.closest('.bt-update-pop') || button.current?.contains(event.target))) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  const phase = update?.phase ?? 'idle'
  const dsh = update?.dsh
  const dshPhase = dsh?.phase ?? 'idle'
  const dshRow = showsDshRow(dsh, update?.app)
  // Hooks first: an update that turns visible after the sidebar mounted would
  // otherwise add hooks on a later render and crash the slot.
  const tick = useViewport()
  useLayoutEffect(() => {
    if (!open) return
    const rect = button.current?.getBoundingClientRect()
    if (rect) setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: rect.bottom + 6 })
  }, [open, tick])
  if (!update?.available && !dshRow && phase === 'idle' && dshPhase === 'idle') return null
  const cloudPhase = phase === 'installing' || dshPhase === 'installing' ? 'installing' : phase !== 'idle' ? phase : dshPhase
  const toggle = () => setOpen(value => !value)
  const start = () => {
    setError('')
    void actions.installUpdate().catch(failure => setError(hostText(failure?.message ?? String(failure))))
  }
  const startDsh = () => {
    setDshError('')
    void actions.installDshUpdate().catch(failure => setDshError(hostText(failure?.message ?? String(failure))))
  }
  const label = phase === 'installing' ? t('Updating DS Bot…')
    : dshPhase === 'installing' ? t('Updating DSH…')
      : phase === 'installed' ? t('DS Bot {version} is installed. Restart DSH to use it.', { version: update.installed ?? update.latest })
        : phase === 'updated' ? t('DS Bot {version} is installed.', { version: update.installed ?? update.latest })
        : dshPhase === 'installed' ? t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
          : update?.available ? t('DS Bot {version} is available', { version: update.latest })
            : t('DSH {version} is available', { version: dsh?.verified })
  const message = error || (phase === 'failed' ? update.error : '')
  const dshMessage = dshError || (dshPhase === 'failed' ? dsh?.error : '')
  const dshText = dshPhase === 'installed'
    ? t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
    : dsh?.available === false && dsh?.blockedBy
      ? t('Update DS Bot {version} first.', { version: dsh.blockedBy })
      : t('You have {version}.', { version: dsh?.current })
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-round bt-update', 'data-phase': cloudPhase, 'aria-label': label, title: label,
      'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: toggle,
    }, h(CloudDownloadIcon, { done: phase === 'installed' || phase === 'updated' }), phase === 'failed' || dshPhase === 'failed' ? h('span', { className: 'bt-update-dot', 'aria-hidden': true }) : null),
    open && box ? createPortal(h('div', { className: 'bt-update-pop', role: 'dialog', 'aria-label': update?.available || phase !== 'idle' ? t('DS Bot update') : t('DSH update'), style: box },
      update?.available || phase !== 'idle' ? h(Fragment, null,
        h('div', { className: 'bt-update-title' }, phase === 'installed' || phase === 'updated' ? t('Update installed') : t('DS Bot {version}', { version: update.latest })),
        h('div', { className: 'bt-update-text' }, phase === 'installed'
          ? t('Restart DSH to start using DS Bot {version}.', { version: update.installed ?? update.latest })
          : phase === 'updated' ? t('DS Bot {version} is installed.', { version: update.installed ?? update.latest })
            : t('You have {version}.', { version: update.current })),
        message ? h('div', { className: 'bt-update-error', role: 'alert' }, t('The update did not finish: {reason}', { reason: message })) : null,
        h('div', { className: 'bt-update-actions' },
          update.notesUrl ? h('a', { className: 'bt-update-notes', href: update.notesUrl, target: '_blank', rel: 'noopener noreferrer' }, t("What's new")) : null,
          phase === 'installed' || phase === 'updated' ? null : h('button', {
            type: 'button', className: 'bt-update-go', disabled: phase === 'installing', onClick: start,
          }, phase === 'installing' ? t('Updating…') : phase === 'failed' ? t('Try again') : t('Update')))) : null,
      dshRow ? h('div', { className: 'bt-update-dsh' },
        h('div', { className: 'bt-update-title' }, t('DSH {version}', { version: dsh.verified })),
        h('div', { className: 'bt-update-text' }, dshText),
        dshMessage ? h('div', { className: 'bt-update-error', role: 'alert' }, t('The update did not finish: {reason}', { reason: dshMessage })) : null,
        h('div', { className: 'bt-update-actions' },
          dsh.kind === 'app' ? (dsh.available
            ? h('button', { type: 'button', className: 'bt-update-go', onClick: () => void actions.openAppUpdates(dsh.verified).catch(() => {}) }, t('Open updates'))
            : null)
            : !dsh.available && dshPhase === 'idle' ? null
              : dshPhase === 'installed' ? null
                : h('button', {
                  type: 'button', className: 'bt-update-go', disabled: dshPhase === 'installing', onClick: startDsh,
                }, dshPhase === 'installing' ? t('Updating…') : dshPhase === 'failed' ? t('Try again') : t('Update')))) : null), document.body) : null)
}

// Account seat of the Settings trigger: the visible label stays for assistive tech only.
export function YouAvatar() {
  return h('span', { className: 'bt-you-wrap' },
    h('span', { className: 'bt-you', 'aria-hidden': true }, h(GearIcon)),
    h('span', { style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' } }, t('Settings')))
}

let openShellSettings = null
let openShellOnboarding = null
let shellShortcuts = null

export function holdShellShortcuts(shortcuts) {
  shellShortcuts = shortcuts
  return () => { if (shellShortcuts === shortcuts) shellShortcuts = null }
}

// DeepSeek Harness hands its settings opener only to the settings.launcher seat. When
// the Desktop's account menu holds that seat, its first item (Settings) is the way in;
// the Desktop on Windows and macOS takes shortcuts natively, so a synthetic key press
// reaches the shell only where the page delivers them (the Web, Linux).
export function openHarnessSettings() {
  // A frame first, so a Bot dialog that closes on this click leaves the modal stack.
  requestAnimationFrame(() => {
    if (openShellSettings) { openShellSettings(); return }
    const desktop = document.querySelector('button[aria-haspopup="menu"][data-signed-out]')
    if (desktop) openThroughMenu(desktop)
    else pressSettingsShortcut()
  })
}

// Opens one of the shell's own onboarding editors, such as the DeepSeek API key form.
export function openHarnessOnboarding(id) {
  requestAnimationFrame(() => {
    if (openShellOnboarding) openShellOnboarding(id)
    else openHarnessSettings()
  })
}

// The launcher seat can only open DSH's settings on their first section. This onboarding
// step of DS Bot's own, opened by id, hands the shell's openSection the Models page; the
// first-run pass meets it last and it steps aside at once.
export const MODELS_STEP = 'ds-bot-models'
export const MODELS_STEP_ORDER = 1000

export function OpenModelsStep({ explicit, complete, openSection }) {
  useEffect(() => {
    if (explicit) {
      if (typeof openSection === 'function') openSection('models')
      else openHarnessSettings()
    }
    complete()
  }, [explicit])
  return null
}

function openThroughMenu(trigger) {
  const before = new Set(document.querySelectorAll('[role="menu"]'))
  trigger.click()
  let frames = 0
  const look = () => {
    const menu = [...document.querySelectorAll('[role="menu"]')].find(node => !before.has(node))
    const item = menu?.querySelector('button[role="menuitem"]')
    if (item) item.click()
    else if (++frames < 30) requestAnimationFrame(look)
    else pressSettingsShortcut()
  }
  requestAnimationFrame(look)
}

function pressSettingsShortcut() {
  const binding = shellShortcuts?.catalog.getSnapshot().find(row => row.id === 'settings.open')?.binding
  if (!binding) return
  const held = new Set(binding.modifiers)
  window.dispatchEvent(new KeyboardEvent('keydown', {
    code: binding.code, key: binding.code === 'Comma' ? ',' : '', bubbles: true, cancelable: true,
    ctrlKey: held.has('control'), altKey: held.has('alt'), shiftKey: held.has('shift'), metaKey: held.has('meta'),
  }))
}

// The account menu's entries. The footer avatar and the phone's list page open the same
// menu, so it is built in one place. `phone` is the list page's menu: the shell's sidebar
// panels are not there — the list page covers the screen and the shell's sidebar is away —
// so its automation tasks open the settings page a phone can see.
function accountGroups(actions, phone) {
  return [
    [
      [t('Usage'), GaugeIcon, () => actions.openSettings('usage')],
      [t('Connectors'), ConnectorIcon, () => actions.openConnectors()],
      [t('Automation tasks'), ClockIcon, () => (phone ? actions.openSettings('schedules') : actions.selectPanel('schedules'))],
      [t('Bot settings'), GearIcon, () => actions.openSettings('general')],
    ],
    [
      [t('Switch to classic Agent mode'), SwitchIcon, () => actions.setSurface('agent')],
    ],
  ]
}

// One account menu: `up` opens above its trigger (the footer avatar), `down` below it (the
// phone's list page, whose trigger is at the top of the screen). Outside a press or Escape
// closes it, and the trigger keeps the focus.
function useAccountMenu(actions, place = 'up') {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState(null)
  const anchor = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && (event.target.closest('.bt-account-menu') || anchor.current?.contains(event.target))) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); anchor.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  const toggle = () => {
    const rect = anchor.current?.getBoundingClientRect()
    if (rect) setBox(place === 'down' ? { left: rect.left, top: rect.bottom + 6 } : { left: rect.left, bottom: window.innerHeight - rect.top + 5 })
    setOpen(value => !value)
  }
  const menu = open && box ? createPortal(h('div', {
    className: `bt-menu bt-account-menu${place === 'up' ? ' bt-menu-up' : ''}`, role: 'menu', 'aria-label': t('Account'), style: box,
  }, accountGroups(actions, place === 'down').map((group, index) => h(Fragment, { key: index },
    index > 0 ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
    group.map(([label, Icon, run]) => h('button', {
      key: label, type: 'button', role: 'menuitem',
      onClick: () => { setOpen(false); void Promise.resolve(run()).catch(error => actions.reportError(error, 'menu')) },
    }, h(Icon), h('span', { className: 'bt-menu-label' }, label)))))), document.body) : null
  return { open, anchor, toggle, menu, close: () => setOpen(false) }
}

// Whether a key press is the shell's current binding for one of its shortcuts.
function pressesShellShortcut(event, id) {
  const binding = shellShortcuts?.catalog.getSnapshot().find(row => row.id === id)?.binding
  if (!binding) return false
  const held = new Set(binding.modifiers)
  return event.code === binding.code && event.ctrlKey === held.has('control') && event.altKey === held.has('alt')
    && event.shiftKey === held.has('shift') && event.metaKey === held.has('meta')
}

const NO_SUBSCRIBE = () => () => {}
const NO_SNAPSHOT = () => null

// The footer avatar opens an account menu above itself, with Bot settings as one
// entry. Shell panels hidden from the Bot sidebar (plugins, automation) live here too.
// `seat` is the shell's settings.launcher seat: at priority -10 the whale wins it
// over a shell account plugin's own launcher (the Desktop's "··· More"), which comes
// back in Agent mode; FooterAccount stands in while no seat exists at all.
export function AccountLauncher({ seat = true, settingsOpen, openSettings, openOnboarding, actions }) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState(null)
  const button = useRef(null)
  useLayoutEffect(() => {
    if (!seat) return undefined
    actions.seatAccount(true)
    return () => actions.seatAccount(false)
  }, [seat])
  useEffect(() => { if (settingsOpen) setOpen(false) }, [settingsOpen])
  // The settings dialog links back to the shell's own settings (models, providers).
  useEffect(() => {
    if (!openSettings) return undefined
    openShellSettings = openSettings
    return () => { if (openShellSettings === openSettings) openShellSettings = null }
  }, [openSettings])
  useEffect(() => {
    if (!openOnboarding) return undefined
    openShellOnboarding = openOnboarding
    return () => { if (openShellOnboarding === openOnboarding) openShellOnboarding = null }
  }, [openOnboarding])
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && (event.target.closest('.bt-account-menu') || button.current?.contains(event.target))) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  // The shell's account plugin lends its sign-out operation; the item shows only
  // when the plugin's entry is there and its account snapshot says signed in. The
  // entry can arrive after this mounts, so its operations follow the entry.
  const signIn = actions.signInEntry?.() ?? null
  const ops = useMemo(() => signIn?.inject?.() ?? {}, [signIn])
  const accountSource = ops.hooks?.account
  const account = useSyncExternalStore(accountSource?.subscribe ?? NO_SUBSCRIBE, accountSource ? () => accountSource.getSnapshot() : NO_SNAPSHOT)
  const signedIn = signIn !== null && typeof ops.signOut === 'function' && account?.view?.status === 'credential-stored'
  const signedOut = signIn !== null && typeof actions.signIn === 'function' && account?.view?.status === 'signed-out'
  const accountT = actions.accountT?.() ?? (key => key)
  const [confirm, setConfirm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const askSignOut = async () => {
    setSignOutError('')
    let state = 'none'
    try {
      if (await ops.hasRunningAccountTasks?.()) state = 'running'
    } catch { state = 'unknown' }
    setConfirm(state)
  }
  const cancelSignOut = () => { setConfirm(null); setSignOutError('') }
  const runSignOut = async () => {
    setBusy(true)
    setSignOutError('')
    try {
      await ops.signOut()
      setConfirm(null)
      setOpen(false)
    } catch (error) {
      setSignOutError(String(error?.message ?? error))
    } finally {
      setBusy(false)
    }
  }
  const tick = useViewport()
  const anchor = () => {
    const rect = button.current?.getBoundingClientRect()
    if (rect) setBox({ left: rect.left, bottom: viewBottom() - rect.top + 5 })
  }
  useLayoutEffect(() => { if (open) anchor() }, [open, tick])
  const toggle = () => { if (!open) anchor(); setOpen(value => !value) }
  // Closing the menu drops a half-finished sign-out confirm with it.
  useEffect(() => {
    if (open) return
    setConfirm(null)
    setSignOutError('')
    setBusy(false)
  }, [open])
  // DS Bot's Models page where the host serves the providers, else DSH's own.
  const openModels = actions.providers ? actions.openModels : actions.openHarnessModels
  const groups = [
    [
      [t('Usage'), GaugeIcon, () => actions.openSettings('usage')],
      openModels ? [t('Models and API keys'), SlidersIcon, () => openModels()] : null,
      [t('Connectors'), ConnectorIcon, () => actions.openConnectors()],
      [t('Automation tasks'), ClockIcon, () => actions.selectPanel('schedules')],
      [t('Bot settings'), GearIcon, () => actions.openSettings('general')],
    ].filter(Boolean),
    [
      [t('Switch to classic Agent mode'), SwitchIcon, () => actions.setSurface('agent')],
    ],
  ]
  if (signedIn) groups.push([[accountT('signOut'), SignOutIcon, askSignOut, undefined, true]])
  else if (signedOut) groups.push([[t('Sign in to DeepSeek'), SignInIcon, () => actions.signIn()]])
  return h(Fragment, null,
    h('button', { ref: button, type: 'button', className: 'bt-account', 'aria-label': t('Account'), 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: toggle },
      h('span', { className: 'bt-you', 'aria-hidden': true }, h(GearIcon))),
    open && box ? createPortal(h('div', { className: 'bt-menu bt-menu-up bt-account-menu', role: 'menu', 'aria-label': t('Account'), style: box },
      confirm !== null ? h('div', { className: 'bt-confirm', role: 'alertdialog', 'aria-label': accountT('signOut') },
        h('p', { className: 'bt-confirm-text' }, accountT(confirm === 'running' ? 'signOutRunningDescription' : confirm === 'unknown' ? 'signOutUnknownDescription' : 'signOutDescription')),
        signOutError !== '' ? h('p', { className: 'bt-confirm-error', role: 'alert' }, signOutError) : null,
        h('div', { className: 'bt-confirm-row' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: cancelSignOut }, t('Cancel')),
          h('button', { type: 'button', className: 'bt-confirm-go', disabled: busy, onClick: () => { void runSignOut() } }, accountT('signOut'))))
        : groups.map((group, index) => h(Fragment, { key: index },
          index > 0 ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
          group.map(([label, Icon, run, hint, stay]) => h('button', {
            key: label, type: 'button', role: 'menuitem',
            onClick: () => { if (stay !== true) setOpen(false); void Promise.resolve(run()).catch(error => actions.reportError(error, 'menu')) },
          }, h(Icon), h('span', { className: 'bt-menu-label' }, label), hint ? h('span', { className: 'bt-menu-hint' }, hint) : null))))), document.body) : null)
}

// The desktop app keeps its main window hidden until the team interface has drawn
// the first state, and shows its failure page when that never comes. The report
// says where the Main Bot's avatar is when it wears the start window's whale: the
// start window hands that whale over at the top of its jump, and it glides onto
// the avatar here.
let readyReported = false
function useReportReady(drawn, roster) {
  useEffect(() => {
    if (!drawn || readyReported) return
    readyReported = true
    void Promise.resolve().then(() => {
      const app = globalThis.dsBotApp
      if (typeof app?.ready !== 'function') return undefined
      // The place is a nicety: whatever goes wrong measuring it, the report still goes.
      let place
      try { place = mainAvatarPlace(roster) } catch { place = undefined }
      if (place === undefined) return app.ready()
      const mainId = roster.mainBotId
      app.onHandoff?.((from) => { try { glideOnto(mainMarkOf(mainId), from) } catch (error) { quietly('handoff')(error) } })
      return app.ready(place)
    }).catch(quietly('app ready'))
  }, [drawn])
}

function mainMarkOf(id) {
  if (typeof document === 'undefined') return null
  const key = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id
  return document.querySelector(`.bt-side [data-bot-id="${key}"] .bt-mark`)
}

// The Main Bot's avatar in the team column, in CSS px of the page, with the page's size.
// Only the default look: a photo or another character would not match the start window's whale.
function mainAvatarPlace(roster) {
  const main = roster?.byId?.[roster.mainBotId]
  if (main === undefined || main.avatar?.image || typeof document === 'undefined') return undefined
  const look = lookOf(main)
  if (look.shape !== MAIN_LOOK.shape || look.color !== MAIN_LOOK.color) return undefined
  const mark = mainMarkOf(main.id)
  // Not the opacity: the column fades in as it first draws, which is when this is measured.
  if (!mark || mark.checkVisibility?.({ visibilityProperty: true }) === false) return undefined
  const box = mark.getBoundingClientRect()
  const view = document.documentElement
  return { x: box.left, y: box.top, width: box.width, height: box.height, viewportWidth: globalThis.innerWidth ?? view.clientWidth, viewportHeight: globalThis.innerHeight ?? view.clientHeight }
}

// The whale the start window hands over (app/src/start-window.mjs): `from` is where it is on
// this page at the top of its jump. A copy of the avatar waits there for `hold` ms, while the two
// windows cross-fade, then glides onto the avatar in one compositor animation, so the jump does
// not stutter the way a window that resizes under it would. x and y ease differently, so the path
// bows upward; the avatar itself is hidden until the copy is on it, then gives a small bounce.
// Hidden by opacity, not visibility: the copy draws through the avatar's own masks (same ids),
// which a hidden avatar would stop drawing.
const GLIDE_MS = 460
function glideOnto(mark, from) {
  if (!mark || reducedMotion()) return
  const box = mark.getBoundingClientRect()
  if (!box.width) return
  const outer = document.createElement('div')
  const inner = document.createElement('div')
  const copy = mark.cloneNode(true)
  copy.removeAttribute('data-live')
  Object.assign(outer.style, { position: 'fixed', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, zIndex: '2147483647', pointerEvents: 'none' })
  Object.assign(inner.style, { width: '100%', height: '100%', transformOrigin: '0 0' })
  Object.assign(copy.style, { width: '100%', height: '100%' })
  copy.style.setProperty('--bt-ink-deepseek', getComputedStyle(mark).getPropertyValue('--bt-ink-deepseek'))
  inner.append(copy)
  outer.append(inner)
  outer.setAttribute('aria-hidden', 'true')
  document.body.append(outer)
  mark.style.opacity = '0'
  const timing = { delay: Math.max(0, Number(from.hold) || 0), duration: GLIDE_MS, fill: 'both' }
  outer.animate([{ transform: `translateX(${from.x - box.left}px)` }, { transform: 'none' }], { ...timing, easing: 'cubic-bezier(.45,0,.25,1)' })
  const glide = inner.animate([{ transform: `translateY(${from.y - box.top}px) scale(${from.size / box.width})` }, { transform: 'none' }], { ...timing, easing: 'cubic-bezier(.2,.65,.3,1)' })
  let landed = false
  const land = () => {
    if (landed) return
    landed = true
    outer.remove()
    mark.style.opacity = ''
    mark.animate([{ transform: 'scale(1.08, .92)' }, { transform: 'none' }], { duration: SPRING_POP.duration, easing: SPRING_POP.easing })
  }
  glide.finished.then(land, land)
  // A hidden page stops ticking animations: the avatar comes back regardless.
  setTimeout(land, timing.delay + GLIDE_MS + 500)
}

// Opens the Main Bot whenever the main view holds no Bot conversation, the way
// The view always lands on a Bot rather than an empty New Session page.
// When a Bot's chat moves on to a fresh part, the shell clears the view of the part
// it archived; the chat then goes on in the Bot's current part instead.
function useLandOnMainBot(roster, useSessions, actions) {
  const mainView = useSessions((list) => {
    const row = Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)
    return row ? `${row.id}|${row.blank ? 1 : 0}` : ''
  })
  const lastBot = useRef(null)
  useEffect(() => {
    if (!roster.ready || !roster.mainBotId) return undefined
    const [id, blank] = mainView.split('|')
    const bot = id === '' ? undefined : roster.byId[id]
    if (bot !== undefined) {
      lastBot.current = { botId: bot.id, sessionId: id }
      if (currentPart(bot) !== id) actions.landOn(bot.id)
      return undefined
    }
    // The group's own Session moves on like a Bot's chat does: the part it archived
    // is cleared, and the view goes on in the fresh one.
    const room = id === '' ? undefined : roster.roomsById[id]
    if (room !== undefined) {
      lastBot.current = null
      if ((room.sessionId ?? room.id) !== id) actions.openSession(room.id)
      return undefined
    }
    // A DSH Agent Session, blank or not, is a real destination: it stays.
    if (id !== '' && ((actions.isAgentSession?.(id) ?? roster.agentOf[id] !== undefined) || blank !== '1')) {
      lastBot.current = null
      return undefined
    }
    const last = lastBot.current
    const timer = setTimeout(() => actions.landOn(roster.mainBotId, last), last ? 0 : 400)
    return () => clearTimeout(timer)
  }, [mainView, roster])
}

export function FooterAccount(props) {
  const seated = props.useUi(value => value.accountSeated === true)
  if (seated) return null
  return h('span', { className: 'bt-foot-account' }, h(AccountLauncher, { ...props, seat: false }))
}

// The only entry registered in every mode: in Agent mode the whole Bot surface is
// withdrawn, and this button in the shell's own footer is the way back.
export function BotReturn({ wide, useSurface, useRoster, actions }) {
  const mode = useSurface(value => value.mode)
  const ready = useRoster(value => value.ready)
  // Agent mode draws no team sidebar; there this button is the team interface.
  useReportReady(mode === 'agent' && ready)
  if (mode !== 'agent') return null
  return h('button', { type: 'button', className: 'bt-return', 'aria-label': t('DS Bot'), title: t('DS Bot'), onClick: () => actions.setSurface('bot') },
    h(BotMark, { look: MAIN_LOOK, size: 20 }),
    wide ? h('span', { className: 'bt-return-name' }, t('DS Bot')) : null)
}

// Agent mode has none of the shell-group styles, so the return button carries its own.
export const RETURN_CSS = `
.bt-return{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:0 14px;border:0;border-radius:999px;background:none;color:inherit;font:inherit;font-size:14px;line-height:20px;cursor:pointer;transition:background-color .12s ease}
.bt-return:hover{background:rgba(127,127,127,.14)}
.bt-return:active{transform:scale(.96)}
.bt-return .bt-mark{display:inline-flex;flex:none;line-height:0}
.bt-return .bt-mark svg{width:100%;height:100%;overflow:visible}
/* Shell styles carry --bt-ink-deepseek and Agent mode withdraws them; pin it here. */
.bt-return .bt-mark{--bt-ink-deepseek:#4D6BFE}
.bt-return-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

export function BrandMark({ size = 24 }) {
  return h('span', { className: 'bt-brand-whale' }, h(BotMark, { look: MAIN_LOOK, size }))
}
export function BrandName() {
  return h('span', { style: { fontWeight: 600, fontSize: 14 } }, 'DS Bot')
}

// With the whale holding the settings seat, the Bot row is just the account menu;
// FooterAccount only shows when the seat went to no one. The shell's footer classes
// are CSS-module names, so they match on their stems.
export const SIDEBAR_CSS = `
${BOT_FOLDERS_CSS}
.bt-confirm{width:260px;max-width:72vw;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px}
.bt-confirm-text{margin:0;font-size:13px;line-height:19px;color:var(--bt-ink-2)}
.bt-confirm-error{margin:0;font-size:12px;line-height:17px;color:var(--bt-danger);overflow-wrap:anywhere}
.bt-confirm-row{display:flex;justify-content:flex-end;gap:8px}
.bt-menu .bt-confirm button{width:auto;min-height:0}
.bt-confirm-go{height:28px;padding:0 14px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .12s ease}
.bt-confirm-go:hover:not(:disabled){opacity:.9}
.bt-confirm-go:disabled{opacity:.6;cursor:default}
.bt-side-top .bt-brand{cursor:default;padding-left:6px}
.bt-side-top .bt-brand:hover{background:none}
.bt-brand .bt-mark{flex:none}
.bt-pin{flex:none;display:inline-flex;color:var(--bt-ink-3)}
.bt-rail .bt-row{position:relative}
.bt-rail .bt-pin{position:absolute;top:1px;left:calc(50% + 14px)}
.bt-side .bt-read-only{margin:4px 8px 6px;padding:8px 10px;border-radius:10px;background:var(--bt-hover);font-size:12px;line-height:1.45;text-align:left}
[class*="_footArea"]:has(.bt-foot-account){grid-template-columns:auto minmax(0,1fr) auto;column-gap:6px}
[class*="_footArea"]>[class*="_footerActions"]>div>.bt-foot-account{grid-column:1;order:1;display:inline-flex}
[class*="_footArea"]:has(.bt-foot-account)>[class*="_settingsArea"]{grid-column:3}
[class*="_footArea"]:has(.bt-foot-account)>[class*="_settingsArea"] button[class*="_trigger"] [class*="_label"]{display:none!important}

/* The update cloud springs in when a newer DS Bot shows up; its arrow drops in a
   loop while the install runs. */
.bt-round.bt-update{position:relative;color:var(--bt-accent,#4D6BFE);animation:bt-update-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-round.bt-update svg{width:17px;height:17px}
.bt-round.bt-update[data-phase=installed]{color:var(--bt-ink-2)}
@keyframes bt-update-in{from{opacity:0;transform:scale(.6);filter:blur(4px)}}
.bt-update[data-phase=installing] .bt-cloud-arrow{animation:bt-cloud-drop 1.1s cubic-bezier(.45,0,.55,1) infinite}
@keyframes bt-cloud-drop{0%{transform:translateY(-3px);opacity:0}35%{opacity:1}70%{transform:translateY(1px);opacity:1}100%{transform:translateY(2px);opacity:0}}
.bt-update-dot{position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:#E5484D;box-shadow:0 0 0 1.5px var(--bt-sidebar)}
.bt-update-pop{position:fixed;z-index:60;width:280px;padding:14px 14px 12px;border-radius:14px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 10px 20px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1);color:var(--bt-ink);box-sizing:border-box;transform-origin:top left;font-family:var(--bt-font);animation:bt-update-pop ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
@keyframes bt-update-pop{from{opacity:0;transform:scale(.96);filter:blur(4px)}}
.bt-update-title{font-size:14px;line-height:20px;font-weight:600}
.bt-update-text{margin-top:2px;font-size:12.5px;line-height:18px;color:var(--bt-ink-2)}
.bt-update-error{margin-top:8px;font-size:12px;line-height:17px;color:var(--bt-danger);overflow-wrap:anywhere;max-height:90px;overflow:auto}
.bt-update-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:12px}
.bt-update-notes{margin-right:auto;font-size:12.5px;color:var(--bt-ink-2);text-decoration:none}
.bt-update-notes:hover{color:var(--bt-ink);text-decoration:underline}
.bt-update-go{height:30px;padding:0 14px;border:0;border-radius:999px;background:var(--bt-accent,#4D6BFE);color:var(--bt-accent-ink,#fff);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .12s ease,transform .12s ease}
.bt-update-go:hover:not(:disabled){opacity:.9}
.bt-update-go:active:not(:disabled){transform:scale(.96)}
.bt-update-go:disabled{opacity:.6;cursor:default}
.bt-update-dsh:not(:first-child){margin-top:12px;padding-top:12px;border-top:.5px solid var(--bt-line-2)}
@media (prefers-reduced-motion:reduce){.bt-round.bt-update,.bt-update-pop,.bt-update .bt-cloud-arrow{animation:none}}

/* The DSH Agent row and its expanding Session list. The black whale is the
   harness's own mark, so the row reads as "plain dsh" next to the Bot marks. */
.bt-agent-ava{flex:none;width:36px;height:36px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-hover);color:var(--bt-ink)}
.bt-agent-ava.bt-run{animation:bt-agent-pulse 1.4s ease-in-out infinite}
@keyframes bt-agent-pulse{0%,100%{opacity:1}50%{opacity:.55}}
.bt-agent-sub{display:grid;grid-template-rows:0fr;transition:grid-template-rows ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-agent-sub[data-open]{grid-template-rows:1fr}
.bt-agent-sub-in{overflow:hidden;min-height:0;margin-left:44px}
.bt-agent-sub-row{display:flex;align-items:center;gap:8px;width:100%;padding:5px 10px 5px 8px;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.bt-agent-sub-row:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-agent-sub-row[aria-current=page]{background:var(--bt-hover);color:var(--bt-ink);font-weight:500}
/* .bt-agent-sub-in clips for the expand animation and the rows touch its edges, so the ring goes inside. */
.bt-agent-sub-row:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-agent-sub-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-agent-sub-time{flex:none;font-size:11px;color:var(--bt-ink-3)}
.bt-agent-new{color:var(--bt-ink-3)}
.bt-agent-new svg{width:14px;height:14px;flex:none}
.bt-agent-edit{padding:3px 10px 3px 4px}
.bt-agent-edit input{width:100%;border:0;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;line-height:20px;padding:2px 8px;outline:none;box-shadow:inset 0 0 0 .5px var(--bt-line-2)}
.bt-agent-sub[data-open] .bt-agent-sub-row{animation:bt-agent-row-in .24s ease both;animation-delay:calc(var(--i, 0)*30ms)}
@keyframes bt-agent-row-in{from{opacity:0;filter:blur(4px)}to{opacity:1;filter:blur(0)}}
@media (prefers-reduced-motion:reduce){.bt-agent-sub{transition:none}.bt-agent-sub .bt-agent-sub-row{animation:none}}

/* The phone's list page. It is the only copy of the list while it is up: the sidebar
   renders nothing, and the shell's own sidebar column is closed by the shell styles. */
.bt-nav-page{position:fixed;inset:0;z-index:35;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);box-sizing:border-box}
.bt-nav-top{display:flex;align-items:center;gap:8px;flex:none;padding:10px 12px 6px}
.bt-nav-page .bt-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 8px 12px}
.bt-nav-page .bt-row{min-height:60px}
.bt-nav-page .bt-tile-wrap{padding:8px 0 12px}
.bt-row-time{flex:none;margin-left:auto;padding-left:8px;font-size:12px;line-height:18px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
`
