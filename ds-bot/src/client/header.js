import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { currentPart, latestMemoryChange } from './text.js'
import { ArrowUpIcon, ChevronLeftIcon, CloseIcon, ArrowDownIcon, MemoryIcon, SidePanelIcon } from './icons.js'
import { botState, BotAvatar, RoomAvatar } from './mark.js'
import { ActivityIndicator } from './activity-row.js'
import { clockLabel, openingTurn, unseenSince } from './cells.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// Conversation header

// The pill's tail: a → that springs in on hover, flipping to ← while details are open.
const GoArrow = () => h('svg', { width: 14, height: 14, viewBox: '-12 -12 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M-7 0H7M2 -5L7 0L2 5' }))

// How long the pill says "Memory updated" after the change reaches this window.
const MEMORY_NOTICE_MS = 3_200
const noNews = select => select({})

// How far the conversation moves before the phone's header gives way, and how near the top
// it has to come back. A header that flickers at every nudge is worse than one that stays.
export const HEAD_COLLAPSE_AT = 24
// A movement this large is a jump rather than a scroll: a restore, a script, a scrollbar.
export const HEAD_JUMP = 200

/**
 * Whether the header belongs out of the way: past the threshold and moving down it goes,
 * moving up or back near the top it returns, and a scroll that does not move keeps it as
 * it was. A jump is judged by where it lands, since there is no direction to read.
 * @param top - the transcript's current scroll offset.
 * @param last - the offset the previous read saw.
 * @param collapsed - the state the header is in now.
 * @param kind - 'gesture' for a scroll the reader made, 'jump' for one the page made.
 * @returns the state it should be in.
 */
export function headCollapse(top, last, collapsed, kind = 'gesture') {
  if (top <= HEAD_COLLAPSE_AT) return false
  if (kind === 'jump') return true
  if (top > last) return true
  if (top < last) return false
  return collapsed
}

// The phone's header follows the conversation. The transcript also moves on its own:
// opening a conversation lands at its end, and a reply arriving while the reader is at the
// bottom scrolls it further. A scroll the reader makes is judged by its direction; a jump
// the page makes is judged by where it lands; the page's own small moves are not scrolling
// at all and leave the header as the reader left it.
const HEAD_GESTURE_MS = 700
const HEAD_ARM_MS = 500

function useHeadCollapse(sessionId) {
  const [collapsed, setCollapsed] = useState(false)
  const state = useRef(collapsed)
  state.current = collapsed
  useEffect(() => {
    let last = null
    let armed = false
    let gestureUntil = 0
    const arm = setTimeout(() => { armed = true }, HEAD_ARM_MS)
    // Only a gesture that can scroll the transcript counts: a wheel, or a finger moving
    // over it. A tap is not one — a tap on the composer sends a message, and the transcript
    // then jumps to its end on its own.
    const gesture = (event) => {
      if (event.target instanceof Element && event.target.closest('[data-conversation-scroll]') !== null) gestureUntil = Date.now() + HEAD_GESTURE_MS
    }
    const read = () => {
      const scroller = document.querySelector('[data-conversation-scroll]')
      if (scroller === null) return
      const top = scroller.scrollTop
      if (!armed || last === null) {
        last = top
        return
      }
      const moving = Date.now() < gestureUntil
      if (moving) gestureUntil = Date.now() + HEAD_GESTURE_MS
      if (!moving && Math.abs(top - last) < HEAD_JUMP) {
        last = top
        return
      }
      const next = headCollapse(top, last, state.current, moving ? 'gesture' : 'jump')
      last = top
      if (next !== state.current) setCollapsed(next)
    }
    document.addEventListener('scroll', read, true)
    document.addEventListener('touchmove', gesture, true)
    document.addEventListener('wheel', gesture, true)
    read()
    return () => {
      clearTimeout(arm)
      document.removeEventListener('scroll', read, true)
      document.removeEventListener('touchmove', gesture, true)
      document.removeEventListener('wheel', gesture, true)
    }
  }, [sessionId])
  return [collapsed, setCollapsed]
}

// True while the latest memory change of the Bots in this conversation is news.
function useMemoryNotice(ids, useMemoryNews) {
  const seen = useMemoryNews(map => Math.max(0, ...ids.map(id => map?.[id]?.seen ?? 0)))
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const left = seen + MEMORY_NOTICE_MS - Date.now()
    setShown(seen > 0 && left > 0)
    if (seen === 0 || left <= 0) return undefined
    const timer = setTimeout(() => setShown(false), left)
    return () => clearTimeout(timer)
  }, [seen])
  return shown
}

// The notice the pill stretches to show. Its width is measured, so the pill's spring
// runs between two real widths.
function MemoryNotice({ shown }) {
  const inner = useRef(null)
  const [width, setWidth] = useState(0)
  const label = t('Memory updated')
  useLayoutEffect(() => { if (shown) setWidth(inner.current?.scrollWidth ?? 0) }, [label, shown])
  return h('span', { className: 'bt-pill-mem', 'aria-hidden': true, style: { '--bt-mem-w': `${width}px` } },
    h('span', { className: 'bt-pill-mem-in', ref: inner }, h('span', { className: 'bt-pill-mem-ico' }, h(MemoryIcon)), label))
}

export function HeaderPill({ sessionId, useRoster, useSessions, useSessionStatus, useSession, useActivity, useMemoryNews, useTurnClock, useUi, useLive, useWork, useMobileNav, useNavLevel, actions }) {
  const roster = useRoster(value => value)
  const title = useSessions(list => list.byId[sessionId]?.displayTitle ?? list.byId[sessionId]?.title ?? '')
  const firstTurns = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.slice(0, 8).map(entry => entry.turn).join(',') : ''
  })
  const hiddenTurns = roster.exchangeTurns?.[sessionId]
  const visit = useUi(state => state.visits?.[sessionId])
  // The opening separator has no turn before it, so the transcript column draws it,
  // unless the opening is unread: then the first trigger draws it under the divider.
  const opening = useTurnClock((state) => {
    const first = openingTurn(state[sessionId], firstTurns, hiddenTurns)
    return first && !unseenSince(visit, first.start) ? clockLabel(first.start) : ''
  })
  useEffect(() => {
    if (opening) document.body.style.setProperty('--bt-first-sep', JSON.stringify(opening))
    else document.body.style.removeProperty('--bt-first-sep')
    return () => document.body.style.removeProperty('--bt-first-sep')
  }, [opening])
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const owner = roster.byId[sessionId]?.id ?? sessionId
  const doing = useActivity(map => map[owner])
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const detailsOpen = useUi(state => state.details === sessionId)
  const name = bot?.name ?? room?.name ?? ''
  const useNews = useMemoryNews ?? noNews
  const memoryIds = bot ? [bot.id] : room?.members ?? []
  const notice = useMemoryNotice(memoryIds, useNews)
  // While the notice shows, the pill opens the memory of the Bot that changed.
  const changed = useNews(map => latestMemoryChange(map, memoryIds))
  // The composer placeholder is not localizable per Session, so CSS reads it from here.
  useEffect(() => {
    document.body.style.setProperty('--bt-placeholder', JSON.stringify(name ? t('Message {name}', { name }) : t('Message')))
  }, [name, t('Message')])
  useEffect(() => {
    actions.beginVisit(sessionId)
    return () => actions.endVisit(sessionId)
  }, [sessionId])
  // Group chats have no voice mode, so the composer CSS needs to know the Session kind.
  useEffect(() => {
    if (room) document.body.dataset.btRoom = ''
    else delete document.body.dataset.btRoom
    return () => { delete document.body.dataset.btRoom }
  }, [Boolean(room)])
  const memoryNotice = notice && changed !== null && roster.memory !== false
  // On a phone the conversation is the second level: the back control leaves it for the
  // list page. Its hook is what the test bench reads.
  const onNavChat = useMobileNav(value => value) && useNavLevel(value => value === 'chat')
  const onPhone = useMobileNav(value => value)
  // The phone's header gives way while the conversation is scrolled down, and a thin bar
  // takes its place. The state is published on <body> for the styles and the test bench,
  // and the covered header is taken out of reach with it.
  const navLevel = useNavLevel(value => value)
  const [collapsed, setCollapsed] = useHeadCollapse(sessionId)
  useEffect(() => {
    if (!onPhone) return undefined
    document.body.dataset.btHead = collapsed ? 'collapsed' : 'expanded'
    const shellHeader = document.querySelector('header[class*="_header"]')
    if (collapsed) shellHeader?.setAttribute('inert', '')
    else shellHeader?.removeAttribute('inert')
    return () => {
      delete document.body.dataset.btHead
      document.querySelector('header[class*="_header"]')?.removeAttribute('inert')
    }
  }, [onPhone, collapsed])
  const backControl = onNavChat
    ? h('button', { type: 'button', className: 'bt-icon-btn bt-back', 'data-bt-nav-back': '', 'aria-label': t('Back to Bot list'), title: t('Back to Bot list'), onClick: () => actions.showBotList() }, h(ChevronLeftIcon))
    : null
  const pill = h('button', {
    type: 'button', className: 'bt-pill', 'aria-expanded': detailsOpen, 'data-memory': memoryNotice ? 'updated' : undefined,
    'aria-label': memoryNotice ? t('Memory updated. Open {name}\'s memory', { name: roster.byId[changed]?.name ?? name }) : t('View conversation details'),
    onClick: () => (memoryNotice ? actions.openMemory(changed) : actions.toggleDetails(sessionId)),
  },
  bot ? h(BotAvatar, { bot, size: 24, state: botState(running, doing, roster.questions?.[currentPart(bot)] !== undefined), badge: false })
    : room ? h(RoomAvatar, { room, roster, size: 24 }) : null,
  h('span', { className: 'bt-pill-name' }, bot?.name ?? room?.name ?? (title || t('New chat'))),
  h(MemoryNotice, { shown: memoryNotice }),
  h('span', { className: 'bt-pill-go', 'aria-hidden': true }, h(GoArrow)))
  const activity = h(ActivityIndicator, { key: `activity:${sessionId}`, sessionId, useRoster, useSessionStatus, useSession, useLive, useWork, actions })
  // DSH's way into its right sidebar sits in the session header this pill replaces.
  const sideControl = actions.hasRightSidebar?.()
    ? h('button', { type: 'button', className: 'bt-icon-btn bt-head-side', 'data-bt-right-sidebar': '', 'aria-label': t('Show or hide the right sidebar'), title: t('Right sidebar'), onClick: () => actions.toggleRightSidebar() }, h(SidePanelIcon))
    : null
  // The transcript keeps its own scroll, so the new-message pills are portalled and stay
  // mounted whichever way the header is drawn.
  const newMessages = h(NewMessagePills, { key: sessionId, sessionId, useSessions, useUi, useTurnClock })
  // Collapsed, the header is an empty marker that keeps the shell's own header styled and
  // out of the way; its controls move into the thin bar, so none of them leaves the screen.
  // The bar belongs to the conversation level: on the list page the conversation is covered
  // by a page of its own, and its header controls must not be reachable behind it.
  if (onPhone && collapsed && navLevel !== 'list') {
    return h(Fragment, null,
      h('div', { className: 'bt-head' }),
      newMessages,
      createPortal(h('div', { className: 'bt-head-bar', 'data-bt-head-bar': '' },
        backControl,
        pill,
        activity,
        sideControl,
        h('button', {
          type: 'button', className: 'bt-icon-btn bt-head-bar-go', 'data-bt-head-expand': '',
          'aria-label': t('Show the conversation header'), title: t('Show the conversation header'),
          onClick: () => setCollapsed(false),
        }, h(ArrowDownIcon))), document.body))
  }
  return h('div', { className: 'bt-head' },
    backControl,
    pill,
    h('span', { className: 'bt-sr', role: 'status' }, memoryNotice ? t('Memory updated') : ''),
    newMessages,
    activity,
    sideControl)
}

// New-message pills. "N new messages ↓" takes Back to bottom's place when
// replies land while the user is scrolled up; "N new messages ↑" points at an unread
// divider above the viewport until it has been seen. The shell shows Back to bottom
// only while unpinned, so its presence is the pinned signal.
function useTranscriptView() {
  const [view, setView] = useState(null)
  useEffect(() => {
    let frame = 0
    let watched = null
    const observer = new MutationObserver(() => schedule())
    const measure = () => {
      frame = 0
      const scroller = document.querySelector('[data-conversation-scroll]')
      if (scroller !== watched) {
        observer.disconnect()
        watched = scroller
        if (scroller) observer.observe(scroller, { childList: true, subtree: true })
      }
      if (!scroller) { setView(null); return }
      const box = scroller.getBoundingClientRect()
      const headerBottom = document.querySelector('header[class*="_header"]')?.getBoundingClientRect().bottom ?? box.top + 50
      const sep = scroller.querySelector('.bt-new-sep')
      let divider = null
      if (sep) {
        const at = sep.getBoundingClientRect()
        divider = at.bottom <= headerBottom ? 'above' : at.top >= box.bottom ? 'below' : 'in-view'
      }
      const composer = parseFloat(getComputedStyle(scroller).getPropertyValue('--dsh-composer-height')) || 152
      const next = {
        unpinned: scroller.querySelector('[class*="_toBottomSlot"]>button') !== null,
        divider,
        center: Math.round(box.left + box.width / 2),
        top: Math.round(headerBottom + 8),
        bottom: Math.round(window.innerHeight - box.bottom + composer + 8),
      }
      setView(prev => (prev && Object.keys(next).every(key => prev[key] === next[key]) ? prev : next))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [])
  return view
}

function NewMessagePills({ sessionId, useSessions, useUi, useTurnClock }) {
  const replies = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.reduce((count, entry) => count + (entry.response ? 1 : 0), 0) : 0
  })
  const visit = useUi(state => state.visits?.[sessionId])
  const unread = useTurnClock((state) => {
    if (typeof visit?.seen !== 'number') return 0
    let count = 0
    for (const entry of Object.values(state[sessionId] ?? {})) {
      if (entry.first !== undefined && entry.first > visit.seen && entry.first <= visit.entered) count += 1
    }
    return count
  })
  const view = useTranscriptView()
  const unpinned = view?.unpinned === true
  const [release, setRelease] = useState({ base: null, dismissed: false })
  const [above, setAbove] = useState({ seen: false, dismissed: false })
  useEffect(() => { setRelease({ base: unpinned ? replies : null, dismissed: false }) }, [unpinned])
  useEffect(() => { if (view?.divider === 'in-view') setAbove(state => (state.seen ? state : { ...state, seen: true })) }, [view?.divider])
  const fresh = release.base === null ? 0 : replies - release.base
  const showDown = unpinned && fresh > 0 && !release.dismissed
  const showUp = view?.divider === 'above' && !above.seen && !above.dismissed
  useEffect(() => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (!scroller) return undefined
    scroller.toggleAttribute('data-bt-news', showDown)
    return () => scroller.removeAttribute('data-bt-news')
  }, [showDown])
  if (!view || (!showDown && !showUp)) return null
  const label = count => (count === 1 ? t('1 new message') : count > 0 ? t('{count} new messages', { count }) : t('New messages'))
  const pill = (direction, count, style, onJump, onDismiss) => h('div', { className: 'bt-news', 'data-direction': direction, style },
    h('button', { type: 'button', className: 'bt-news-jump', onClick: onJump },
      h('span', { className: 'bt-news-ico' }, h(direction === 'up' ? ArrowUpIcon : ArrowDownIcon)), label(count)),
    h('button', {
      type: 'button', className: 'bt-news-x', 'aria-label': t('Dismiss new messages'),
      onClick: (event) => { event.stopPropagation(); onDismiss() },
    }, h(CloseIcon)))
  const toLatest = () => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    const back = scroller?.querySelector('[class*="_toBottomSlot"]>button')
    if (back) back.click()
    else scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }
  const toDivider = () => document.querySelector('[data-conversation-scroll] .bt-new-sep')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return createPortal(h(Fragment, null,
    showUp ? pill('up', unread, { left: view.center, top: view.top }, toDivider, () => setAbove(state => ({ ...state, dismissed: true }))) : null,
    showDown ? pill('down', fresh, { left: view.center, bottom: view.bottom }, toLatest, () => setRelease(state => ({ ...state, dismissed: true }))) : null),
  document.body)
}
