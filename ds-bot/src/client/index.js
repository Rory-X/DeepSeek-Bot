import { call } from './api.js'
import { queueRosterPull, watchRosterChanges } from './roster-sync.js'
import { isHex, inkText, paintCss } from './inks.js'
import { DEFAULT_MASK, SHAPES, markupCache, maskOf } from './characters.js'
import { createSource, EMPTY_ROSTER, indexRoster, isAgentSession } from './sources.js'
import { watchMobileNav } from './media.js'
import { installViewport, watchStandalone } from './platform.js'
import { NAV_MOTION_MS, installSwipeBack } from './nav-motion.js'
import { installRightColumns } from './right-columns.js'
import { installNavHistory } from './nav-history.js'
import { teamActions } from './team-actions.js'
import { themeCss, shellTokens, registry, registerShape, registerTheme, allThemes, layoutOf, widthOf, flatWidthOf } from './themes.js'
import { MENTION_ORIGIN, currentPart } from './text.js'
import { SHELL_CSS, CONVERSATION_CSS, installStyles, installCompiledStyles } from './styles.js'
import { lookOf } from './mark.js'
import { TeamSidebar, YouAvatar, AccountLauncher, FooterAccount, BrandMark, BrandName, BotReturn, SIDEBAR_CSS, RETURN_CSS, holdShellShortcuts, openHarnessOnboarding, openHarnessSettings } from './sidebar.js'
import { ProjectBoard, BOARD_CSS } from './project-board.js'
import { openBoardPreview } from './board-sidebar.js'
import { HeaderPill, PlainBack } from './header.js'
import { ComposerPlus, ComposerVoice, menuIcons } from './composer.js'
import { ComposerQuote, QUOTE_SOURCE, quoteRef, quoteSource } from './quote.js'
import { CHATS_SOURCE, atSources } from './at-menu.js'
import { BtwDock, BtwTurnTail } from './btw.js'
import { SIDE_CSS, sideSource } from './side-chat.js'
import { VOICE_BUNDLE } from './speech.js'
import { sameVersion } from './dsh-offer.js'
import { QuestionCard, QuestionDock } from './questions.js'
import { AnsweredReply, WidgetDock, WIDGET_CSS } from './widget-cell.js'
import { HandoffDock, HANDOFF_CSS } from './handoff-card.js'
import { installHeaderNavigation } from './header-navigation.js'
import { AssistantCell, TriggerCell, TurnProcessCell, Nothing, TurnTailCell, ToolCell } from './cells.js'
import { Overlays, HINT_CSS } from './overlays.js'
import { createBotBrowsers, serveBrowserReads } from './bot-browsers.js'
import { BROWSER_CSS } from './browser-pane.js'
import { SECRET_CSS, SecretDock } from './secret-card.js'
import { MODEL_CSS, ModelChoiceDock, DeepSeekSignIn } from './model-menu.js'
import { BOT_SETTINGS_CSS } from './bot-settings.js'
import { AVATAR_LIBRARY_CSS } from './avatar-library.js'
import { GROUP_SETTINGS_CSS } from './group-settings.js'
import { FOLDER_CSS } from './folder-menu.js'
import { USAGE_CSS } from './usage-page.js'
import { SCHEDULE_CSS } from './schedules.js'
import { STORAGE, migrateStorage } from './storage.js'
import { noteLeft, setUnread, sharedMap, toggleReaction } from './shared-map.js'
import { freePriority, groupsFor, readMode, surfaceGroups, writeMode } from './surface.js'
import { installLocale, language, t } from './i18n.js'
import { noteClientError, quietly } from './diagnostics.js'
import { RIGHTBAR_ATTRIBUTES, columnOpened, createSwitchWindow, drawerOpened, rightColumnOpen } from './right-panel.js'
import { ErrorToast, FEEDBACK_CSS } from './feedback.js'
import { ABOUT_CSS } from './about.js'
import { MEMBER_CSS, MemberDock } from './member-status.js'
import { USER_MESSAGE_CSS, UserMessageCell, canDrawUserMessages } from './user-message.js'
import { noticeApprovals } from './approval-notices.js'
import { listedOpener } from './open-listed.js'

export const inject = ['sessions', 'uiWorkspace', 'uiConversation', 'slots', 'theme', 'layout']

export function apply(ctx) {
  ctx.effect(() => installLocale(ctx.get('locale')), 'ds-bot: interface copy')
  const roster = createSource(EMPTY_ROSTER)
  migrateStorage()
  const unreadStore = sharedMap(STORAGE.unread)
  const reactionStore = sharedMap(STORAGE.reactions)
  // When each conversation was last left; a visit compares new turns against it.
  const seenStore = sharedMap(STORAGE.seen)
  let seenAt = seenStore.read()
  // `details` is the panel's subject (a Session id); `view` picks details or the
  // subject Bot's browser inside it.
  const ui = createSource({ details: null, view: 'details', renaming: false, tab: null, side: null, newChat: null, exchange: null, menu: null, voice: null, palette: null, quotes: {}, quote: null, settings: null, memory: null, toast: null, hint: null, signIn: null, renameAgent: null, unread: unreadStore.read(), reactions: reactionStore.read(), visits: {} })
  // Bot mode paints the whole team surface; Agent mode withdraws every slot and
  // style so the shell's own interface returns. `plain` stays false until a Bot-mode
  // view hosts a plain session, which drops only the conversation replacements.
  const surface = createSource({ mode: readMode(), plain: false })
  // A phone gets a two-level navigation: `mobileNav` is the device test (media.js), and
  // `navLevel` says which of the two levels the Bot surface shows.
  const mobileNav = createSource(false)
  const navLevel = createSource('list')
  // Which level a conversation was entered from, and the page motion in flight. The return
  // path reads the origin, so a second entry point (a search, a notification) returns to
  // where it came from instead of to the list page by name.
  const navOrigin = createSource(null)
  const navMotion = createSource('idle')
  // An installed app: no browser chrome, so the styles and the motion default treat it as
  // the most app-like case there is.
  const standalone = createSource(false)
  // DSH Agent Session ids from the last pull, so a reload already knows the main
  // view is a plain Session before the team answers.
  let agentSessionCache = new Set()
  try { agentSessionCache = new Set(JSON.parse(localStorage.getItem(STORAGE.agentSessions) ?? '[]')) } catch { agentSessionCache = new Set() }
  // Sessions adopted on this window (workspace pick, fork) but not yet in the roster.
  const pendingAdopt = new Map()
  const isAgentSessionId = id => isAgentSession(roster.getSnapshot(), agentSessionCache, id) || pendingAdopt.has(id)
  const agentOfSession = id => roster.getSnapshot().agentOf[id] ?? pendingAdopt.get(id)
  // The workspace a Session lives in, for follow-up creates and switch detection.
  const workspaces = ctx.get('workspaces')
  const workspaceOf = (sessionId) => {
    const items = workspaces?.list?.getSnapshot()?.items ?? []
    return items.find(item => item.sessionIds?.includes(sessionId))?.workspaceId
  }
  // A navigation this plugin started: the surface effect trusts the id it lands on.
  let expected = null
  const setPlain = (plain) => surface.set(state => (state.plain === plain ? state : { ...state, plain }))
  // A DSH Agent Session shows the plain conversation: the Bot details and browser
  // panels would follow it and report it is not on the team, so they close.
  const dropPanels = () => ui.set(state => (state.details || state.renaming ? { ...state, details: null, view: 'details', renaming: false, tab: null } : state))
  // A Bot's chat spans several parts, so when it was last left is kept per Bot.
  const seenKey = id => roster.getSnapshot().byId?.[id]?.id ?? id
  const leaveVisits = (ids) => {
    seenAt = seenStore.update(seen => noteLeft(seen, ids.map(seenKey), Date.now()), seenAt)
  }
  ctx.effect(() => {
    const onPageHide = () => leaveVisits(Object.keys(ui.getSnapshot().visits ?? {}))
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, 'ds-bot: remember visits on page hide')
  // Unread marks, reactions and visits are shared by every window; one saved elsewhere
  // shows here at once. A `null` key is a cleared storage.
  ctx.effect(() => {
    const onStorage = (event) => {
      if (event.storageArea !== localStorage) return
      if (event.key === null || event.key === unreadStore.key) ui.set(state => ({ ...state, unread: unreadStore.read(state.unread) }))
      if (event.key === null || event.key === reactionStore.key) ui.set(state => ({ ...state, reactions: reactionStore.read(state.reactions) }))
      if (event.key === null || event.key === seenStore.key) seenAt = seenStore.read(seenAt)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, 'ds-bot: follow other windows')
  const activity = createSource({})
  // Per Bot, the turn it runs and its tool; and the approvals waiting for the user.
  const work = createSource({ bots: {}, approvals: [] })
  let workKey = ''
  // Per Session, what its transcript has in flight (running tools, a streaming reply).
  const live = createSource({})
  // Per Session, the ask_user and request_secret calls its transcript draws; the
  // docks carry the cards of the other calls.
  const cards = createSource({})
  // Edited dock cards keep their component when history arrives. This source
  // holds only request identities and counts, never drafts or secret values.
  const heldCards = createSource({})
  // Per Session, the first visible time and the end time of each turn the transcript
  // has rendered; time separators compare one turn's end with the next turn's start.
  const turnClock = createSource({})
  let activityKey = '{}'
  // Per Bot, its latest memory change, and `seen`: when this window first saw it, or 0
  // for a change made before the window opened, which is no news.
  const memoryNews = createSource({})
  let memoryNewsKey
  const noteMemoryNews = (next) => {
    const key = JSON.stringify(next)
    if (key === memoryNewsKey) return
    const opening = memoryNewsKey === undefined
    memoryNewsKey = key
    memoryNews.set(state => Object.fromEntries(Object.entries(next).map(([id, entry]) => [id,
      state[id]?.at === entry.at ? state[id] : { ...entry, seen: opening ? 0 : Date.now() }])))
  }
  const PREFS_KEY = STORAGE.prefs
  let savedPrefs = {}
  try { savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {} } catch { savedPrefs = {} }
  const writeUnread = (id, value) => {
    const unread = unreadStore.update(marks => setUnread(marks, id, value), ui.getSnapshot().unread)
    ui.set(state => (JSON.stringify(state.unread) === JSON.stringify(unread) ? state : { ...state, unread }))
  }
  const refreshed = new Set()
  const pull = queueRosterPull(async () => {
    const known = roster.getSnapshot()
    const value = await call('state', { since: known.revision, models: known.modelsKey ?? '', locale: language() })
    const nextActivity = JSON.stringify(value.activity ?? {})
    if (nextActivity !== activityKey) { activityKey = nextActivity; activity.set(value.activity ?? {}) }
    const nextWork = JSON.stringify(value.work ?? null)
    if (nextWork !== workKey) { workKey = nextWork; work.set(value.work ?? { bots: {}, approvals: [] }) }
    noteMemoryNews(value.memoryNews ?? {})
    const current = roster.getSnapshot()
    // Connector and capability states change without a new revision.
    const live = {}
    if (value.connectors !== undefined && JSON.stringify(value.connectors) !== JSON.stringify(current.connectors ?? [])) live.connectors = value.connectors
    // A host can stop allowing changes without a new revision; the connector cards read it.
    if (value.readOnly !== undefined && value.readOnly !== (current.readOnly ?? null)) live.readOnly = value.readOnly
    if (value.capabilityStatuses !== undefined && JSON.stringify(value.capabilityStatuses) !== JSON.stringify(current.capabilityStatuses ?? {})) live.capabilityStatuses = value.capabilityStatuses
    if (value.btwCards !== undefined && JSON.stringify(value.btwCards) !== JSON.stringify(current.btwCards ?? {})) live.btwCards = value.btwCards
    if (value.sideChats !== undefined && JSON.stringify(value.sideChats) !== JSON.stringify(current.sideChats ?? {})) live.sideChats = value.sideChats
    if (Object.keys(live).length > 0 && current.ready) roster.set({ ...current, ...live })
    if (value.unchanged || (value.revision === current.revision && value.modelsKey === current.modelsKey)) return
    // On a browser with no visit record yet, everything already there counts as seen.
    if (Object.keys(seenAt).length === 0) leaveVisits([...value.bots, ...value.rooms].map(entry => entry.id))
    roster.set(indexRoster(value))
    try {
      const ids = (value.agents ?? []).flatMap(agent => agent.sessions ?? [])
      localStorage.setItem(STORAGE.agentSessions, JSON.stringify(ids))
      agentSessionCache = new Set(ids)
    } catch { /* storage unavailable */ }
    // Adopted ids are known by the roster now; ones gone from the list were archived.
    const listed = ctx.sessions.list.getSnapshot().byId ?? {}
    for (const id of pendingAdopt.keys()) {
      if (roster.getSnapshot().agentOf[id] !== undefined || listed[id] === undefined) pendingAdopt.delete(id)
    }
    for (const id of [...value.bots.map(currentPart), ...value.rooms.map(room => room.id)]) {
      if (refreshed.has(id)) continue
      refreshed.add(id)
      void Promise.resolve(ctx.sessions.refreshProjections?.(id)).catch(quietly('refresh projections'))
    }
  })

  ctx.effect(() => {
    let stopped = false
    let running = false
    let timer
    const loop = async () => {
      clearTimeout(timer)
      if (running || stopped) return
      running = true
      try { await pull() } catch (error) { if (!stopped) console.warn('[ds-bot] state', error) } finally { running = false }
      if (!stopped) timer = setTimeout(loop, document.hidden ? 10000 : 1500)
    }
    const wake = () => { if (!document.hidden) void loop() }
    const stopFeed = watchRosterChanges(revision => {
      if (!stopped && revision !== roster.getSnapshot().revision) void pull().catch(quietly('roster update'))
    })
    document.addEventListener('visibilitychange', wake)
    void loop()
    return () => { stopped = true; stopFeed(); clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, 'ds-bot: roster poll')

  // Plugin updates: every window that opens asks the host once (the host keeps its
  // answer for a while), again each hour, and every two seconds while installing.
  const update = createSource({ available: false, phase: 'idle' })
  let wakeUpdate = () => {}
  ctx.effect(() => {
    let stopped = false
    let timer
    const loop = async () => {
      clearTimeout(timer)
      if (stopped) return
      const value = await call('update-check', { fresh: false }).catch(() => null)
      if (stopped) return
      if (value) update.set(previous => ({ ...value, app: previous.app, ownApp: previous.ownApp }))
      timer = setTimeout(loop, value?.phase === 'installing' || value?.dsh?.phase === 'installing' ? 2000 : 60 * 60_000)
    }
    wakeUpdate = loop
    void loop()
    return () => { stopped = true; clearTimeout(timer); wakeUpdate = () => {} }
  }, 'ds-bot: update check')

  // A packaged DSH updates through its own updater; what that updater found is
  // kept beside the host's answer so the card can match it to the verified DSH.
  const appUpdates = window.dshDesktop?.protocolVersion === 1 ? window.dshDesktop.updates ?? null : null
  if (appUpdates?.status && appUpdates.subscribe) {
    ctx.effect(() => {
      let stopped = false
      const take = (app) => { if (!stopped && app) update.set(previous => ({ ...previous, app })) }
      void appUpdates.status().then(take, () => {})
      const unsubscribe = appUpdates.subscribe(take)
      return () => { stopped = true; unsubscribe?.() }
    }, 'ds-bot: app update status')
  }

  // The DeepSeek Bot app's own updater; its state goes beside the host's answer as ownApp,
  // which the About row turns into the app's update state and buttons.
  const ownAppUpdates = globalThis.dsBotApp?.updates ?? null
  if (ownAppUpdates?.state && ownAppUpdates.subscribe) {
    ctx.effect(() => {
      let stopped = false
      const take = (ownApp) => { if (!stopped && ownApp) update.set(previous => ({ ...previous, ownApp })) }
      void ownAppUpdates.state().then(take, () => {})
      const unsubscribe = ownAppUpdates.subscribe(take)
      return () => { stopped = true; unsubscribe?.() }
    }, 'ds-bot: own app update state')
  }

  // Bot browsers need a webview bridge: DSH Desktop's, or the desktop app's of the
  // same shape. The host serves read_browser only in those two (`browser` in the state).
  const bridge = (window.dshDesktop?.protocolVersion === 1 ? window.dshDesktop.browser : globalThis.dsBotApp?.browser) ?? null
  const browsers = bridge ? createBotBrowsers({ bridge, createSource }) : null
  if (browsers) {
    ctx.effect(() => {
      let stopReads = null
      const sync = () => {
        const snapshot = roster.getSnapshot()
        if (!snapshot.ready) return
        const on = snapshot.browser === true
        if (on && !stopReads) stopReads = serveBrowserReads({ browsers, post: call })
        if (!on && stopReads) { stopReads(); stopReads = null }
        // A Bot deleted here or in another window takes its guests and saved tabs along.
        void browsers.retain(snapshot.bots.map(bot => bot.id))
        // A panel open on the browser view without a browsable subject falls back
        // to the details view.
        ui.set(state => (state.details && state.view === 'browser' && (!on || !snapshot.byId[state.details]) ? { ...state, view: 'details' } : state))
      }
      sync()
      const offRoster = roster.subscribe(sync)
      return () => { offRoster(); stopReads?.(); browsers.dispose() }
    }, 'ds-bot: Bot browsers')
  }

  ctx.effect(() => () => { markupCache.clear() }, 'ds-bot: character markup')

  // Mentions wear each Bot's color and character silhouette (or its photo). A message
  // DSH still draws itself, while it waits to be sent or to join a running turn, shows
  // "@Name" as a file reference; one whose label is a whole Bot name wears the Bot's
  // mark there too (a name with a space is cut by DSH, so it stays as DSH draws it).
  const installMentions = () => {
    const style = installStyles('', 'mentions')
    let last = ''
    const render = () => {
      const next = roster.getSnapshot().bots.map((bot) => {
        const anchor = `.bt-bubble a[href="${MENTION_ORIGIN}${bot.id}"]`
        const chip = /\s/.test(bot.name) ? '' : `[class*="_userRow"] [data-ref-chip="file"][title="@${bot.name.replace(/["\\]/g, '\\$&')}" i]`
        const look = lookOf(bot)
        const marks = chip ? `${anchor}::before,${chip}::before` : `${anchor}::before`
        const mark = look.image
          ? `${marks}{background:center/cover url("${look.image}");-webkit-mask:none;mask:none;border-radius:50%}`
          : `${marks}{background:${paintCss(look.color)};-webkit-mask-image:${maskOf(look.shape)};mask-image:${maskOf(look.shape)}}`
        const chipBase = chip ? `${chip}{color:inherit;font-weight:600}${chip}>svg{display:none}${chip}::before{content:"";display:inline-block;flex:none;width:16px;height:16px;margin-right:3px;vertical-align:-3px;-webkit-mask:${DEFAULT_MASK} center/contain no-repeat;mask:${DEFAULT_MASK} center/contain no-repeat}` : ''
        return `${anchor}{color:${inkText(look.color)}}${chipBase}${mark}`
      }).join('\n')
      if (next !== last) style.textContent = last = next
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    return () => { offRoster(); offRegistry(); style.remove() }
  }

  // The shell's viewport and theme-colour metas: the plugin adds what a phone needs (the
  // safe areas behind viewport-fit=cover, the browser's own colour) and keeps the rest.
  const viewport = installViewport()
  ctx.effect(() => () => viewport.dispose(), 'ds-bot: viewport meta')
  ctx.effect(() => {
    const watch = watchStandalone(value => standalone.set(value))
    standalone.set(watch.read())
    const sync = () => {
      if (standalone.getSnapshot()) document.body.dataset.btStandalone = ''
      else delete document.body.dataset.btStandalone
    }
    const off = standalone.subscribe(sync)
    sync()
    return () => {
      watch.dispose()
      off()
      delete document.body.dataset.btStandalone
    }
  }, 'ds-bot: installed app')

  // The chosen theme lives in the team state so every device shares it; the local
  // copy only avoids a flash of the default theme before the first state pull.
  const installTheme = () => {
    const style = installStyles('', 'theme')
    let key = ''
    let releaseTokens = null
    const render = () => {
      const snapshot = roster.getSnapshot()
      const prefs = snapshot.ready ? snapshot.prefs ?? {} : savedPrefs
      const themes = allThemes()
      const id = themes[prefs.theme] ? prefs.theme : 'deepseek'
      const accent = isHex(prefs.accent) ? prefs.accent : undefined
      // An installed app has no browser chrome and a shorter attention span for motion:
      // an explicit choice still wins, otherwise it runs quiet.
      const motion = prefs.motion === 'quiet' || prefs.motion === 'lively' ? prefs.motion : standalone.getSnapshot() ? 'quiet' : 'normal'
      const layout = layoutOf(prefs)
      const width = widthOf(prefs)
      const flatWidth = flatWidthOf(prefs)
      document.body.dataset.btMotion = motion
      document.body.dataset.btLayout = layout
      document.body.style.setProperty('--bt-msg-w', String(width / 100))
      document.body.style.setProperty('--bt-flat-w', String(flatWidth / 100))
      const next = `${id}|${accent ?? ''}|${motion}|${layout}|${width}|${flatWidth}|${registry.getSnapshot()}`
      if (next === key) return
      key = next
      style.textContent = themeCss(themes[id], accent)
      viewport.theme({ light: themes[id].light.bg, dark: themes[id].dark.bg })
      const release = releaseTokens
      releaseTokens = ctx.theme.overrideTokens('ds-bot', shellTokens(themes[id]))
      if (typeof release === 'function') release()
      if (snapshot.ready) {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: prefs.theme, accent: prefs.accent, motion: prefs.motion, layout: prefs.layout, width: prefs.width, flatWidth: prefs.flatWidth, thinking: prefs.thinking })) } catch { /* storage unavailable */ }
      }
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    const offStandalone = standalone.subscribe(render)
    return () => {
      offRoster()
      offRegistry()
      offStandalone()
      try {
        if (typeof releaseTokens === 'function') releaseTokens()
      } finally {
        delete document.body.dataset.btMotion
        delete document.body.dataset.btLayout
        document.body.style.removeProperty('--bt-msg-w')
        document.body.style.removeProperty('--bt-flat-w')
        style.remove()
      }
    }
  }

  ctx.effect(() => {
    const hub = { registerShape, registerTheme, themes: () => Object.keys(allThemes()), shapes: () => Object.keys(SHAPES) }
    const queued = Array.isArray(window.dshBotQueue) ? window.dshBotQueue : []
    window.dshBot = hub
    window.dshBotQueue = { push: (task) => { try { task(hub) } catch (error) { console.warn('[ds-bot] registration', error); noteClientError('registration', error) } } }
    for (const task of queued) window.dshBotQueue.push(task)
    return () => {
      if (window.dshBot === hub) delete window.dshBot
      delete window.dshBotQueue
    }
  }, 'ds-bot: registry')

  ctx.inject(['shortcuts'], scope => { scope.effect(() => holdShellShortcuts(scope.shortcuts), 'ds-bot: settings shortcut') })

  const after = promise => promise.then(async (value) => { await pull().catch(() => {}); return value })
  // A Bot id, or any part of its chat, opens the Bot's current part.
  const partFor = (id) => {
    const bot = roster.getSnapshot().byId[id]
    return bot ? currentPart(bot) : id
  }
  // The shell refuses a Session it does not know — an archived part, a deleted Bot, or a list
  // that has not caught up — and a refusal from a timer leaves the view half-open on a
  // conversation that will never fill. The open is guarded, so a refusal is reported instead
  // of thrown away, and a target can be checked against the shell's own list first.
  const knownSession = id => typeof id === 'string' && id !== '' && ctx.sessions.list.getSnapshot().byId?.[id] !== undefined
  const openTarget = (target) => {
    try { ctx.uiWorkspace.openSession(target); return true } catch (error) { actions.reportError(error, 'open-session'); return false }
  }
  // Sessions owned by an Agent, including ones adopted before the roster caught up.
  const agentSessions = (agentId) => {
    const ids = [...(roster.getSnapshot().agentsById[agentId]?.sessions ?? [])]
    for (const [id, owner] of pendingAdopt) if (owner === agentId && !ids.includes(id)) ids.push(id)
    return ids
  }
  const mainView = () => Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
  const show = listedOpener({ list: ctx.sessions.list, refresh: () => Promise.resolve(ctx.sessions.refresh?.()).catch(quietly('refresh sessions')), open: (target) => { expected = target; openTarget(target) }, current: mainView })
  // The shell focuses the resident composer whenever a Session opens and again when a turn
  // ends. On a phone that raises the keyboard over the conversation the reader is looking at,
  // and the shell has no way to ask for no focus, so the focus is handed straight back —
  // unless the reader's own finger is on the box, which is the only focus a phone wants.
  const COMPOSER_TAP_MS = 900
  let composerTappedAt = 0
  const composerField = (node) => {
    if (!(node instanceof HTMLElement)) return null
    const field = node.closest('[role=textbox],input,textarea,[contenteditable=true]')
    return field !== null && field.closest('[class*="_centerCol"]') !== null ? field : null
  }
  // The phone's levels live on the browser's history so the system's back gesture returns to
  // the list; every way back still runs the one return, `goBack`.
  // A return in flight: the pop the browser sends back arrives while the level has not moved
  // yet, so the guard keeps one press from starting a second return.
  let returning = false
  const navHistory = installNavHistory({
    mobileNav,
    navLevel,
    onLeave: () => actions.leaveChat(),
    onEnter: () => navLevel.set('chat'),
  })
  ctx.effect(() => () => navHistory.dispose(), 'ds-bot: the phone levels in history')
  // Bot mode's view must hold a team conversation; an outside Session wears the
  // Bot skin without one. Runs whenever the surface is (or stays) Bot mode —
  // including a cold start, where no setSurface call ever fires.
  const homeToMainBot = () => {
    const snapshot = roster.getSnapshot()
    if (!snapshot.ready || !snapshot.mainBotId) return
    const main = mainView()
    if (main !== undefined && snapshot.byId[main] === undefined && snapshot.roomsById[main] === undefined) {
      actions.openSession(snapshot.mainBotId)
    }
  }
  const ensureBotHome = () => {
    if (roster.getSnapshot().ready) homeToMainBot()
    else {
      const off = roster.subscribe(() => {
        if (!roster.getSnapshot().ready) return
        off()
        homeToMainBot()
      })
    }
  }
  const actions = {
    ...teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock }),
    openBoard: () => ui.set(state => ({ ...state, board: true, settings: null, details: null, newChat: null, palette: null, menu: null })),
    closeBoard: () => ui.set(state => ({ ...state, board: false })),
    // The full-pane overlays sit above the conversation, so opening one must dismiss them
    // or the click appears to do nothing.
    isAgentSession: id => isAgentSessionId(id),
    openSession: (id) => {
      actions.closeBoard()
      // A DSH Agent Session id lands on the plain surface, not the Bot skin.
      if (isAgentSessionId(id)) return actions.openAgentSession(id)
      // Opening a conversation from the list page is the push: the list yields and the
      // conversation arrives from the right. The origin is what the way back reads.
      const fromList = mobileNav.getSnapshot() && navLevel.getSnapshot() === 'list'
      if (fromList) {
        navOrigin.set('list')
        runMotion('push', { from: '100%', to: '0px', listFrom: '0px', listTo: '-18px' })
        // The arrival gets a history entry of its own, so the system's back gesture has
        // somewhere to return to instead of leaving the app.
        navHistory.entered()
      }
      // Opening a conversation is what leaves the phone's list page.
      navLevel.set('chat')
      ui.set(state => (state.newChat || state.exchange || state.menu || state.palette ? { ...state, newChat: null, exchange: null, menu: null, palette: null } : state))
      setPlain(false)
      const target = partFor(id)
      show(target)
    },
    // The conversation replacements withdraw for a plain Session; set the surface
    // before the navigation so the Bot skin never flashes.
    openAgentSession: (sessionId) => {
      actions.closeBoard()
      const fromList = mobileNav.getSnapshot() && navLevel.getSnapshot() === 'list'
      if (fromList) {
        navOrigin.set('list')
        runMotion('push', { from: '100%', to: '0px', listFrom: '0px', listTo: '-18px' })
        navHistory.entered()
      }
      navLevel.set('chat')
      ui.set(state => ({ ...state, newChat: null, exchange: null, menu: null, palette: null, details: null, view: 'details', renaming: false, tab: null }))
      setPlain(true)
      show(sessionId)
    },
    addAgent: async () => {
      const agent = await after(call('add-agent'))
      if (agent?.sessions?.[0] !== undefined) actions.openAgentSession(agent.sessions[0])
      return agent
    },
    openAgent: (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      if (agent === undefined) return
      const list = ctx.sessions.list.getSnapshot()
      const recent = agentSessions(agentId).sort((a, b) => (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0))
      if (recent.length === 0) return actions.newAgentSession(agentId)
      actions.openAgentSession(recent[0])
    },
    newAgentSession: async (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      if (agent === undefined) return
      const list = ctx.sessions.list.getSnapshot()
      const recent = agentSessions(agentId).sort((a, b) => (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0))
      // An untouched Session is already the new conversation the user wants.
      if (recent.length > 0 && list.byId[recent[0]]?.blank === true) {
        actions.openAgentSession(recent[0])
        return recent[0]
      }
      const { sessionId } = await after(call('agent-session', { agentId, workspaceId: workspaceOf(recent[0]) }))
      actions.openAgentSession(sessionId)
      return sessionId
    },
    archiveAgentSession: async (agentId, sessionId) => {
      await after(call('agent-archive', { agentId, sessionId }))
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== sessionId) return
      const rest = roster.getSnapshot().agentsById[agentId]?.sessions ?? []
      if (rest.length > 0) actions.openAgent(agentId)
      else if (roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
    },
    renameAgentSession: (agentId, sessionId, title) => after(call('agent-rename', { agentId, sessionId, title })),
    beginAgentRename: sessionId => ui.set(state => ({ ...state, renameAgent: sessionId })),
    endAgentRename: () => ui.set(state => (state.renameAgent ? { ...state, renameAgent: null } : state)),
    // Removing the Agent archives every Session it owns; one of them may fill the
    // main view, and it must not stay there wearing the Bot surface afterwards.
    removeAgent: async (agentId) => {
      const owned = agentSessions(agentId)
      const result = await after(call('remove-agent', { agentId }))
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== undefined && owned.includes(main) && roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
      return result
    },
    // `last` is the Bot conversation the view held before it cleared: when that part was
    // archived for a fresh one, the view goes on in the fresh one. What it lands on has to be
    // a Session the shell still knows — a part the roster remembers but the shell has dropped
    // would be refused, and the view would stay on an empty page — so the Bot's current part
    // and the Main Bot's are tried in turn, and with none of them the reader stays on the
    // list rather than landing nowhere.
    landOn: async (id, last) => {
      try {
        if (last) await pull().catch(() => {})
        const snapshot = roster.getSnapshot()
        const bot = last ? snapshot.byId[last.botId] : undefined
        setPlain(false)
        const target = [
          bot && currentPart(bot) !== last.sessionId ? currentPart(bot) : partFor(id),
          bot ? currentPart(bot) : undefined,
          snapshot.mainBotId ? partFor(snapshot.mainBotId) : undefined,
        ].find(knownSession)
        if (target === undefined) {
          // Nothing to land on: the list is a level of its own, and that is where the reader
          // stays. On a desktop the list is the sidebar, and the view keeps whatever it holds.
          if (mobileNav.getSnapshot()) navLevel.set('list')
          return
        }
        expected = target
        show(target)
      } catch (error) {
        actions.reportError(error, 'land-on')
      }
    },
    selectPanel: (id) => { ctx.layout.selectPanel(id) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    // The one return path: the back control, the edge swipe and anything else that leaves a
    // conversation come here. The origin says where it lands, and the conversation leaves
    // the way it arrived — it goes out to the right while the page it came from comes back.
    goBack: () => {
      if (navLevel.getSnapshot() !== 'chat') return
      ui.set(state => (state.details ? { ...state, details: null, view: 'details' } : state))
      if (!mobileNav.getSnapshot()) {
        navLevel.set('list')
        return
      }
      // The entry this arrival pushed is popped, and the return starts with the press rather
      // than with the pop that follows: the pop then finds the level already back.
      navHistory.returned()
      actions.leaveChat()
    },
    // The conversation leaves the way it arrived: it goes out to the right while the page it
    // came from comes back. The origin says where it lands. This is what a pop from the
    // system's back gesture runs too, so every way back is this one return.
    leaveChat: () => {
      if (navLevel.getSnapshot() !== 'chat' || returning) return
      returning = true
      const origin = navOrigin.getSnapshot() ?? 'list'
      const from = document.body.style.getPropertyValue('--bt-nav-x') || '0px'
      const listFrom = document.body.style.getPropertyValue('--bt-nav-list-x') || '-18px'
      runMotion('pop', { from, to: '100%', listFrom, listTo: '0px', done: () => { returning = false; navOrigin.set(null); navLevel.set(origin) } })
    },
    showBotList: () => actions.goBack(),
    // Agent mode hands the surface back to the shell; everything open on the Bot
    // surface closes first so nothing stale reopens on the way back.
    setSurface: (mode) => {
      if (mode !== 'bot' && mode !== 'agent') return
      // Already there: still worth the landing check — a cold start never calls
      // setSurface, so this is also how a stuck Bot surface recovers itself.
      if (surface.getSnapshot().mode === mode) {
        if (mode === 'bot') ensureBotHome()
        return
      }
      if (mode === 'agent') {
        ui.set(state => ({ ...state, details: null, view: 'details', settings: null, palette: null, newChat: null, menu: null, voice: null, exchange: null, memory: null, toast: null }))
      }
      writeMode(mode)
      surface.set(state => ({ ...state, mode }))
      if (mode !== 'bot') return
      ensureBotHome()
    },
    markUnread: id => writeUnread(id, true),
    beginVisit: (id) => {
      // A conversation a Bot started, never opened here, is unread from its start.
      const made = roster.getSnapshot().byId[id] ?? roster.getSnapshot().roomsById[id]
      const seen = seenAt[seenKey(id)] ?? (made?.createdBy && Number.isFinite(made.createdAt) ? made.createdAt : null)
      ui.set(state => ({ ...state, visits: { ...state.visits, [id]: { seen, entered: Date.now() } } }))
    },
    endVisit: (id) => {
      leaveVisits([id])
      ui.set((state) => {
        if (!(id in (state.visits ?? {}))) return state
        const visits = { ...state.visits }
        delete visits[id]
        return { ...state, visits }
      })
    },
    toggleReaction: (key, index, emoji) => {
      const reactions = reactionStore.update(saved => toggleReaction(saved, key, index, emoji), ui.getSnapshot().reactions)
      ui.set(state => ({ ...state, reactions }))
    },
    clearUnread: id => writeUnread(id, false),
    // DSH's right sidebar (files, terminals), which a plugin may load after this one.
    hasRightSidebar: () => ctx.get('sidebarRight') !== undefined,
    boardSidebar: () => ctx.get('sidebarRight'),
    previewBoardArtifact: (preview, target, signal) => openBoardPreview({ ctx, preview, target, signal }),
    toggleRightSidebar: () => {
      try {
        ctx.get('sidebarRight')?.toggleExpanded()
      } catch (error) {
        actions.reportError(error, 'right-sidebar')
      }
    },
  }
  // Without the Desktop bridge these stay undefined, and no browser control renders.
  if (browsers) {
    Object.assign(actions, {
      // The globe button: the Bot's active tab in the browser view, or a new tab.
      openBrowser: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.ensureTabs(bot.id)
        if (browsers.tabs.getSnapshot()[bot.id]?.active == null) browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null }))
      },
      // '+' on the strip or the drawer's new-tab card: a blank tab in the browser view.
      browserNewTab: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return null
        browsers.ensureTabs(bot.id)
        const tabId = browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null }))
        return tabId
      },
      // A drawer card: its tab active, the panel on the browser view.
      browserPick: (id, tabId) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.activate(bot.id, tabId)
        ui.set(state => ({ ...state, details: id, view: 'browser' }))
      },
      browserEnsure: botId => browsers.ensureTabs(botId),
      browserCloseTab: (botId, tabId) => browsers.closeTab(botId, tabId),
      browserActivate: (botId, tabId) => browsers.activate(botId, tabId),
      browserShow: (tabId, box) => browsers.show(tabId, box),
      browserNavigate: (tabId, input) => browsers.navigate(tabId, input),
      browserCommand: (tabId, name) => browsers.command(tabId, name),
      browserFocus: (tabId) => browsers.focus(tabId),
      browserTakeover: bridge.views ? async botId => {
        const result = await call('browser-takeover', { botId })
        await bridge.views.hold(botId, true)
        return result
      } : undefined,
      browserStop: bridge.views ? async botId => {
        const result = await call('browser-stop', { botId })
        await bridge.views.hold(botId, true)
        return result
      } : undefined,
      // `answer` is a handoff card's { callId, outcome }; the panel's Give back sends none.
      browserGiveBack: bridge.views ? async (botId, answer = {}) => {
        const result = await call('browser-give-back', { botId, ...answer })
        await bridge.views.hold(botId, false)
        return result
      } : undefined,
      // Cookie imports, only where the bridge offers them (the desktop app): a file or an
      // installed browser's profile is previewed, then applied into the Bot's storage key.
      browserImport: typeof bridge.importSources === 'function' ? {
        sources: () => bridge.importSources(),
        pick: () => bridge.importPick(),
        live: (source, close) => bridge.importLive(source, close),
        apply: (botId, pending) => bridge.importApply(`bot:${botId}`, pending),
        cancel: (pending) => bridge.importCancel(pending),
      } : null,
    })
  }
  // Whether AccountLauncher holds the shell's settings seat; FooterAccount steps aside if so.
  actions.signInEntry = () => ctx.slots.entries?.('settings.models.sign-in')?.[0] ?? null
  actions.canSignIn = () => Boolean(actions.signInEntry())
  actions.signIn = () => ui.set(state => ({ ...state, signIn: (state.signIn ?? 0) + 1 }))
  actions.closeSignIn = () => ui.set(state => ({ ...state, signIn: null }))
  actions.accountT = () => ctx.get('locale').bind('settings.account')
  // The Voice Input plugin's speech Remote; absent while that plugin is off.
  actions.speech = () => ctx.get('remote.speech') ?? undefined
  // DSH's own settings: models, providers, keys and its plugins.
  // The shell's own settings are a desktop surface. On a phone the entries that lead there
  // say so beside themselves instead of opening something the reader cannot use; the
  // desktop keeps its path. True means the phone answered the press itself, so a settings
  // dialog the entry sits in stays where it is.
  const showHint = (text, anchor) => {
    const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : null
    ui.set(state => ({ ...state, hint: {
      text,
      token: Date.now(),
      // The rect is captured now: the hint stays where the entry was, even when the menu it
      // came from closes on this press.
      rect: rect === null
        ? { left: window.innerWidth / 2, top: 0, bottom: 0, width: 0 }
        : { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width },
    } }))
  }
  actions.dismissHint = token => ui.set(state => (state.hint && (token === undefined || state.hint.token === token) ? { ...state, hint: null } : state))
  actions.openHarnessSettings = (anchor) => {
    if (mobileNav.getSnapshot()) {
      showHint(t('Open this setting on a desktop.'), anchor)
      return true
    }
    openHarnessSettings()
    return false
  }
  actions.openHarnessOnboarding = openHarnessOnboarding
  actions.voiceSetup = () => {
    const navigation = ctx.get('pluginNavigation')
    return navigation ? () => navigation.openBundle(VOICE_BUNDLE) : null
  }
  actions.seatAccount = on => ui.set(state => (state.accountSeated === on ? state : { ...state, accountSeated: on }))
  // The install runs on the host; the check loop follows it every two seconds.
  actions.installUpdate = async () => {
    const value = await call('update-install')
    update.set(previous => ({ ...previous, ...value }))
    wakeUpdate()
  }
  // The DSH the newest released DS Bot verified installs the same way.
  actions.installDshUpdate = async () => {
    const dsh = await call('dsh-update-install')
    update.set(previous => ({ ...previous, dsh }))
    wakeUpdate()
  }
  // The app's panel installs whatever its updater found by now, so it opens only
  // while that is still the verified version.
  actions.openAppUpdates = async (verified) => {
    const app = await appUpdates?.status?.()
    if (app) update.set(previous => ({ ...previous, app }))
    if (sameVersion(app?.version, verified)) await appUpdates.open()
  }
  actions.checkUpdate = async () => {
    const value = await call('update-check', { fresh: true })
    update.set(previous => ({ ...value, app: previous.app, ownApp: previous.ownApp }))
    wakeUpdate()
  }
  // The app's own updater answers through its bridge; the state it pushes back re-renders
  // the About row.
  actions.checkOwnApp = async () => { await ownAppUpdates?.check?.() }
  actions.installOwnApp = async () => { await ownAppUpdates?.install?.() }
  actions.openOwnApp = async () => { await ownAppUpdates?.open?.() }
  const browserPages = browsers?.pages ?? createSource({})
  const browserTabs = browsers?.tabs ?? createSource({})
  const browserHolds = browsers?.holds ?? createSource({})
  const face = () => ({ actions, hooks: { roster, ui, activity, work, memoryNews, registry, turnClock, live, cards, heldCards, browserPages, browserTabs, browserHolds, surface, update, mobileNav, navLevel, navMotion } })
  // The level is published on <body> so the styles, the test bench and a screen reader all
  // read the same fact; it is absent whenever the navigation is not in effect (a desktop,
  // or the plain surface an Agent Session gets).
  // The list page is a layer of its own over the conversation, so while it is up the
  // covered column is marked inert: its header and messages are neither announced nor
  // reachable by a tab or a stray click. The list page itself is portalled to the body,
  // and the shell's overlay layer (the toast, a sign-in) stays outside the column.
  const coverConversation = (covered) => {
    for (const column of document.querySelectorAll('[class*="_centerCol"]')) {
      if (covered) column.setAttribute('inert', '')
      else column.removeAttribute('inert')
    }
  }
  // The page motion is written straight to the DOM: a page change is a transition, not a
  // state the reader sees, and the timers are what end it. `hold` seats the start position
  // without a transition, so the movement runs from there.
  let motionTimer = 0
  const setMotion = (phase, x, listX) => {
    if (navMotion.getSnapshot() !== phase) navMotion.set(phase)
    if (phase === 'idle') delete document.body.dataset.btNavMotion
    else document.body.dataset.btNavMotion = phase
    if (x === undefined) document.body.style.removeProperty('--bt-nav-x')
    else document.body.style.setProperty('--bt-nav-x', x)
    // The page that is being left yields a little, so the two move as one gesture.
    if (listX === undefined) document.body.style.removeProperty('--bt-nav-list-x')
    else document.body.style.setProperty('--bt-nav-list-x', listX)
  }
  const runMotion = (phase, { from, to, listFrom, listTo, done, ms = NAV_MOTION_MS }) => {
    clearTimeout(motionTimer)
    const start = () => {
      setMotion(phase, to, listTo)
      motionTimer = setTimeout(() => {
        setMotion('idle')
        done?.()
      }, ms + 40)
    }
    // Seating the start is only needed when the page is somewhere else: a drag that ends
    // where it already is, or a return from rest, starts its transition in this frame — the
    // two ways back have to begin alike.
    const now = document.body.style.getPropertyValue('--bt-nav-x') || '0px'
    if (now === from) start()
    else {
      setMotion('hold', from, listFrom)
      requestAnimationFrame(start)
    }
  }
  const syncNav = () => {
    // A plain (DSH Agent) Session keeps the phone's two levels too: the shell's own
    // conversation is the page, and the list is the way back to it.
    const nav = mobileNav.getSnapshot()
    if (nav) document.body.dataset.btNav = navLevel.getSnapshot()
    else delete document.body.dataset.btNav
    coverConversation(nav && navLevel.getSnapshot() === 'list')
  }
  ctx.effect(() => {
    const watch = watchMobileNav((value) => { mobileNav.set(value); navLevel.set('list') })
    mobileNav.set(watch.read())
    // The shell's frame is not up yet when the plugin boots, so the level is re-synced on
    // the state that arrives after it is: the roster and the session list.
    const offs = [mobileNav.subscribe(syncNav), navLevel.subscribe(syncNav), surface.subscribe(syncNav), roster.subscribe(syncNav), ctx.sessions.list.subscribe(syncNav)]
    syncNav()
    return () => {
      watch.dispose()
      for (const off of offs) off()
      delete document.body.dataset.btNav
      coverConversation(false)
    }
  }, 'ds-bot: mobile navigation')
  ctx.effect(() => installSwipeBack({
    // Only a conversation the reader is looking at: not a dialog, not the details pane.
    canStart: () => mobileNav.getSnapshot() && navLevel.getSnapshot() === 'chat'
      && ui.getSnapshot().details === null && ui.getSnapshot().settings === null && ui.getSnapshot().newChat === null,
    onStart: () => setMotion('drag', '0px'),
    onMove: (x, width) => {
      document.body.style.setProperty('--bt-nav-x', `${x}px`)
      document.body.style.setProperty('--bt-nav-list-x', `${(-18 * (1 - x / width)).toFixed(1)}px`)
    },
    onCommit: () => actions.goBack(),
    onCancel: () => runMotion('cancel', {
      from: document.body.style.getPropertyValue('--bt-nav-x') || '0px',
      to: '0px',
      listFrom: document.body.style.getPropertyValue('--bt-nav-list-x') || '-18px',
      listTo: '-18px',
    }),
  }), 'ds-bot: edge swipe back')
  // The shell's right sidebar loads after this plugin, so the rule is installed when it
  // arrives; it is the shell's own face, never a patched shell.
  ctx.inject(['sidebarRight'], (scope) => {
    scope.effect(() => installRightColumns({
      ui,
      isDesktop: () => !mobileNav.getSnapshot(),
      rightbar: scope.sidebarRight,
      onError: error => actions.reportError(error, 'right-sidebar'),
    }), 'ds-bot: one right column at a time')
  })
  ctx.effect(() => {
    const onFocusIn = (event) => {
      if (!mobileNav.getSnapshot()) return
      const field = composerField(event.target)
      if (field === null) return
      if (Date.now() - composerTappedAt < COMPOSER_TAP_MS) return
      field.blur()
    }
    const onPointerDown = (event) => {
      if (!mobileNav.getSnapshot()) return
      if (composerField(event.target) !== null) composerTappedAt = Date.now()
    }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, 'ds-bot: the phone keeps its keyboard down')
  ctx.effect(() => noticeApprovals({
    work,
    roster,
    shownSession: () => Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id,
    openSession: id => actions.openSession(id),
  }), 'ds-bot: approval notifications')
  const assistantFace = (sessionId) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ds-bot: unknown session "${sessionId}"`)
    const chat = ctx.uiConversation.binding(binding).target('chat')
    return { ...face(), keyedHooks: {
      turnSteps: (turn) => {
        const snapshot = chat.getSnapshot()
        if (snapshot === undefined) throw new Error('ds-bot: Chat target is unavailable')
        return snapshot.nodes.turnDataSource(Number(turn), 'assistant-step')
      },
      turnContext: (turn) => {
        const snapshot = chat.getSnapshot()
        if (snapshot === undefined) throw new Error('ds-bot: Chat target is unavailable')
        return snapshot.nodes.turnDataSource(Number(turn), 'context')
      },
    } }
  }

  // The dock lives outside the chat snapshot, so it subscribes for the turn that
  // owns a card. Until that turn closes, the card stays by the composer.
  actions.turnFacts = (sessionId) => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return { turns: undefined, openTurn: undefined }
      const conversation = ctx.uiConversation.binding(binding)
      const chat = conversation.target('chat').getSnapshot()
      return { turns: chat?.timeline?.turns, openTurn: conversation.openTurn.getSnapshot() }
    } catch {
      return { turns: undefined, openTurn: undefined }
    }
  }
  actions.watchTurns = (sessionId, listener) => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return () => {}
      const conversation = ctx.uiConversation.binding(binding)
      const offChat = conversation.target('chat').subscribe(listener)
      const offOpen = conversation.openTurn.subscribe(listener)
      return () => { offChat(); offOpen() }
    } catch {
      return () => {}
    }
  }
  // A terminal tab in DSH's right column, only where the terminal plugin
  // registered its type and the column face is there.
  actions.canOpenTerminal = () => ctx.get('sidebarRight') !== undefined && ctx.get('sidebarRightTabs')?.get('terminal') !== undefined
  actions.newTerminal = () => {
    // The column takes the drawer's space: hand it over first.
    actions.closePanel()
    try {
      ctx.get('sidebarRight')?.openTab('terminal')
    } catch (error) {
      actions.reportError(error, 'right-sidebar')
    }
  }
  // The same hand-off for DSH's files tab, where that plugin registered it.
  actions.canOpenFiles = () => ctx.get('sidebarRight') !== undefined && ctx.get('sidebarRightTabs')?.get('files') !== undefined
  actions.openFiles = () => {
    actions.closePanel()
    try {
      ctx.get('sidebarRight')?.openTab('files')
    } catch (error) {
      actions.reportError(error, 'right-sidebar')
    }
  }

  // The drawer and DSH's right column never share the window: whichever the
  // user asked for last wins. The column's state is read off the frame's
  // attributes through a MutationObserver. `mounted` moves before the DOM of a
  // Session switch does, so a switch opens a timed window (createSwitchWindow):
  // an attribute batch inside it is the switch revealing that Session's own
  // column — the drawer wins and folds it back — while one outside it is the
  // user's own opening and takes the space.
  ctx.effect(() => {
    const sidebar = ctx.get('sidebarRight')
    if (!sidebar) return undefined
    let open = rightColumnOpen(document)
    // Long enough for a fullscreen panel's slide, which reports only once it ends.
    const switchWindow = createSwitchWindow(done => setTimeout(done, 400))
    const collapseColumn = () => {
      try {
        if (sidebar.isExpanded()) sidebar.toggleExpanded()
      } catch (error) {
        actions.reportError(error, 'right-sidebar')
      }
    }
    const observer = new MutationObserver(() => {
      const next = rightColumnOpen(document)
      const opening = next && !open
      open = next
      const verdict = opening ? columnOpened(ui.getSnapshot().details !== null, switchWindow.pending) : null
      if (verdict === 'close-drawer') actions.closePanel()
      else if (verdict === 'collapse-column') collapseColumn()
    })
    observer.observe(document.documentElement, {
      subtree: true, attributes: true, attributeFilter: RIGHTBAR_ATTRIBUTES,
    })
    const offMounted = sidebar.mounted.subscribe(() => switchWindow.moved())
    let drawer = ui.getSnapshot().details !== null
    const offUi = ui.subscribe(() => {
      const next = ui.getSnapshot().details !== null
      if (next && !drawer && drawerOpened(rightColumnOpen(document)) === 'collapse-column') collapseColumn()
      drawer = next
    })
    return () => { observer.disconnect(); offMounted(); offUi() }
  }, 'ds-bot: one right panel')

  // A Bot surface owns the cells it shadows. It starts far below the -10 that plugins
  // commonly use and goes below whatever already holds the cell, so a plugin that
  // shadows the same cell neither breaks the install nor shows through.
  const BOT_PRIORITY = -100
  const shadow = (name, options, component) => ctx.slots.inject(name, () => ctx.slots.register({
    name, ...options, ...(options.priority === undefined ? {} : { priority: freePriority(ctx.slots.entries(name), options) }),
  }, component))
  const installHeader = () => ctx.slots.inject('conversation.session.header', () => installHeaderNavigation(ctx.slots, face, HeaderPill, BOT_PRIORITY))

  // The "@" menu's Bot group and the chats "+" references. The composer's controller
  // for a Session is the shell's own, so the chats open at its caret.
  let atMenu = null
  const installAtMenu = () => {
    const fiber = ctx.inject(['inputTriggers'], (scope) => {
      scope.effect(() => {
        const triggers = scope.inputTriggers
        const controllerOf = (sessionId) => {
          const binding = ctx.sessions.binding(sessionId)
          return binding === undefined ? undefined : triggers.sessionOf(binding.ctx)
        }
        const launched = sessionId => controllerOf(sessionId)?.launcher.getSnapshot() === CHATS_SOURCE
        const offs = [
          ...atSources({ roster, sessions: ctx.sessions, launched, iconFor: menuIcons(roster) }).map(source => triggers.registerSource(source)),
          triggers.registerSource(quoteSource()),
          triggers.registerSource(sideSource({ roster, actions })),
        ]
        atMenu = { controllerOf }
        return () => {
          atMenu = null
          for (const off of offs) off()
        }
      }, 'ds-bot: @ menu')
    })
    return () => fiber.dispose()
  }
  // A reply quotes the message as a structured reference: the composer shows one compact chip
  // and the model reads the same `> Name: …` line the quote card parses. A refused insertion
  // is reported, never replaced with raw text.
  const quoteFacade = (sessionId) => {
    const binding = sessionId === undefined ? undefined : ctx.sessions.binding(sessionId)
    const conversation = ctx.get('conversation')
    if (binding === undefined || conversation === undefined) return undefined
    try { return conversation.input.for(binding.ctx) } catch { return undefined }
  }
  // One pending reply per Session, kept until the reader cancels it or the draft it quotes in
  // is gone. A Session switch neither clears the state nor the text the shell restores.
  const quoteOf = token => Object.values(ui.getSnapshot().quotes ?? {}).find(entry => entry.token === token)
  const setQuote = (token, patch) => ui.set((state) => {
    const entry = Object.values(state.quotes ?? {}).find(row => row.token === token)
    if (entry === undefined) return state
    const next = patch(entry)
    if (next === null) {
      const quotes = { ...state.quotes }
      delete quotes[entry.sessionId]
      return { ...state, quotes }
    }
    return { ...state, quotes: { ...state.quotes, [entry.sessionId]: next } }
  })
  actions.quote = (sessionId, text, bot, target) => {
    const facade = quoteFacade(sessionId)
    if (facade === undefined) {
      actions.reportError(new Error('no composer to quote into'), 'quote')
      return
    }
    const { ref, clipboardText, label, excerpt } = quoteRef(bot, text)
    const quote = { sessionId, botId: bot?.id ?? null, botName: bot?.name ?? null, excerpt, ref, clipboardText, label, target: target instanceof Element ? target : null, token: Date.now(), inserted: false }
    ui.set(state => ({ ...state, quotes: { ...state.quotes, [sessionId]: quote } }))
  }
  actions.quoteInsert = (token, span, quiet = false) => {
    const quote = quoteOf(token)
    if (quote === undefined || span === undefined) return false
    const facade = quoteFacade(quote.sessionId)
    if (facade === undefined) return false
    let inserted = false
    try {
      inserted = facade.insertReference({ source: QUOTE_SOURCE, ref: quote.ref, label: quote.label, appearance: 'session', clipboardText: quote.clipboardText }, span) === true
    } catch (error) {
      actions.reportError(error, 'quote-reference')
    }
    if (!inserted) {
      if (!quiet) {
        facade.notify?.('error', t('Could not quote this message'))
        setQuote(token, () => null)
      }
      return false
    }
    setQuote(token, entry => ({ ...entry, inserted: true }))
    return true
  }
  // Cancel takes the quoted line out of the draft, keeping whatever the reader typed around it.
  actions.quoteCancel = (token) => {
    const quote = quoteOf(token)
    if (quote === undefined) return
    const facade = quoteFacade(quote.sessionId)
    if (facade !== undefined) {
      const draft = facade.state.getSnapshot().draft
      if (draft.includes(quote.clipboardText)) {
        const left = draft.replace(quote.clipboardText, '')
        facade.setDraft(left.trim() === '' ? '' : left)
      }
    }
    setQuote(token, () => null)
  }
  // The bar asks for this when the draft it quoted in no longer holds the quote.
  actions.clearQuote = token => setQuote(token, () => null)
  // A restored draft is plain text: these let the composer rebuild the chip and put the
  // reader's own words back after it, or fall back to the text when the chip is refused.
  actions.quoteDraft = (sessionId) => {
    const facade = quoteFacade(sessionId)
    if (facade === undefined) return null
    const state = facade.state.getSnapshot()
    return { draft: state.draft, occurrences: state.occurrences ?? [] }
  }
  actions.quoteTakeText = (sessionId, clipboardText) => {
    const facade = quoteFacade(sessionId)
    if (facade === undefined) return null
    const draft = facade.state.getSnapshot().draft
    const at = draft.indexOf(clipboardText)
    if (at < 0) return null
    const rest = `${draft.slice(0, at)}${draft.slice(at + clipboardText.length)}`.replace(/^\s+/, '')
    facade.setDraft('')
    return rest
  }
  actions.quotePutText = (sessionId, text) => {
    const facade = quoteFacade(sessionId)
    if (facade !== undefined) facade.setDraft(text)
  };
  actions.canReferenceChat = () => atMenu !== null
  actions.referenceChat = (sessionId, span) => {
    const controller = atMenu?.controllerOf(sessionId)
    if (controller === undefined || span === undefined) return
    controller.toggleSource(CHATS_SOURCE, { trigger: '@', query: '', quoted: false, position: 'inline', span })
  }

  // The shell group paints the team surface around the session; the conversation
  // group re-skins the session itself. Each step returns a disposer from slots.inject,
  // so a surface change withdraws the whole group and the outlets re-render.
  const installShell = () => [
    () => installCompiledStyles(SHELL_CSS, 'shell'),
    () => installCompiledStyles(SIDEBAR_CSS, 'sidebar'),
    () => installCompiledStyles(BOARD_CSS, 'project-board'),
    () => installCompiledStyles(SECRET_CSS, 'secrets'),
    () => installCompiledStyles(MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + GROUP_SETTINGS_CSS + AVATAR_LIBRARY_CSS, 'models'),
    () => installCompiledStyles(USAGE_CSS, 'usage'),
    () => installCompiledStyles(SCHEDULE_CSS, 'schedules'),
    () => installCompiledStyles(FEEDBACK_CSS, 'feedback'),
    () => installCompiledStyles(HINT_CSS, 'hint'),
    () => installCompiledStyles(ABOUT_CSS, 'about'),
    () => installCompiledStyles(MEMBER_CSS, 'members'),
    () => installCompiledStyles(USER_MESSAGE_CSS, 'user-messages'),
    () => installCompiledStyles(WIDGET_CSS, 'widgets'),
    () => installCompiledStyles(HANDOFF_CSS, 'handoff'),
    () => installCompiledStyles(SIDE_CSS, 'side'),
    // Strip and panel styles also serve the side-chat tabs, which need no bridge.
    () => installCompiledStyles(BROWSER_CSS, 'browser'),
    () => installTheme(),
    () => shadow('sidebar.workspaces', { priority: BOT_PRIORITY, inject: face }, TeamSidebar),
    () => shadow('sidebar.brand.mark', { priority: BOT_PRIORITY }, BrandMark),
    () => shadow('sidebar.brand.name', { priority: BOT_PRIORITY }, BrandName),
    () => shadow('sidebar.footer.action', { id: 'bot-account', order: -200, inject: face }, FooterAccount),
    () => shadow('settings.trigger', { priority: BOT_PRIORITY }, YouAvatar),
    // The whale wins the seat over a shell account plugin's own launcher (the
    // Desktop's "··· More"), which comes back in Agent mode.
    () => shadow('settings.launcher', { priority: BOT_PRIORITY, inject: face }, AccountLauncher),
    () => shadow('shell.overlay', { id: 'bot', order: 50, inject: face }, Overlays),
    () => shadow('shell.overlay', { id: 'bot-project-board', order: 52, inject: face }, ProjectBoard),
    () => shadow('shell.overlay', { id: 'bot-signin', order: 55, inject: face }, DeepSeekSignIn),
    () => shadow('shell.overlay', { id: 'bot-toast', order: 60, inject: face }, ErrorToast),
    // A plain Session withdraws the conversation group, so the way back to the list lives in
    // the shell's own header instead: its leading seat, which the Bot surface leaves empty.
    () => shadow('conversation.header.leading', { priority: BOT_PRIORITY, inject: face }, PlainBack),
  ]
  const installConversation = () => [
    () => installCompiledStyles(CONVERSATION_CSS, 'conversation'),
    () => installMentions(),
    () => installAtMenu(),
    installHeader,
    () => shadow('conversation.chat.node', { key: 'assistant-step', priority: BOT_PRIORITY, locale: 'chat', inject: assistantFace }, AssistantCell),
    () => shadow('conversation.chat.node', { key: 'turn-trigger', priority: BOT_PRIORITY, locale: 'chat', inject: face }, TriggerCell),
    () => shadow('conversation.chat.node', { key: 'tool-call', priority: BOT_PRIORITY, locale: 'chat', inject: face }, ToolCell),
    () => shadow('conversation.chat.node', { key: 'turn-process', priority: BOT_PRIORITY, locale: 'chat', inject: face }, TurnProcessCell),
    // DSH's own turn tail stays, so what other plugins add there shows, such as the
    // cards of the files a turn delivered; its copy and branch row is hidden.
    () => shadow('conversation.chat.turnTail', { id: 'bot-turn-separators', order: 1000, inject: face }, TurnTailCell),
    // A side question is not a transcript row. After its snapshot turn closes it
    // sits on that turn's tail, ahead of the time separator.
    () => shadow('conversation.chat.turnTail', { id: 'bot-btw', order: 800, priority: BOT_PRIORITY, inject: face }, BtwTurnTail),
    // A Bot condenses its conversation without telling anyone; the chat keeps showing
    // every message.
    () => shadow('conversation.chat.node', { key: 'question-reply', priority: BOT_PRIORITY, locale: 'chat' }, AnsweredReply),
    () => shadow('conversation.chat.node', { key: 'compaction', priority: BOT_PRIORITY, locale: 'chat' }, Nothing),
    // A Bot chat leaves DSH's context lines (tool updates, injected context) out; a Bot
    // message spliced in mid-turn gets an event line from the step that reads it instead.
    () => shadow('conversation.chat.node', { key: 'context', priority: BOT_PRIORITY, locale: 'chat' }, Nothing),
    ...(canDrawUserMessages() ? ['user', 'steering'].map(key => () => shadow('conversation.chat.node', { key, priority: BOT_PRIORITY, locale: 'chat', inject: face }, UserMessageCell)) : []),
    () => shadow('conversation.input.permission', { priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.input.plan', { priority: BOT_PRIORITY }, Nothing),
    // The composer carries no model picker or run statistics; a Bot's model lives
    // in its details panel.
    () => shadow('conversation.input.model', { priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.composer.dock', { id: 'activity', order: 0, priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.composer.dock', { id: 'usage', order: 1, priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.composer.dock', { id: 'btw', order: 2, priority: BOT_PRIORITY, inject: face }, BtwDock),
    () => shadow('conversation.input.left', { id: 'bot-plus', order: -100, inject: face }, ComposerPlus),
    () => shadow('conversation.input.right', { id: 'bot-voice', order: 100, inject: face }, ComposerVoice),
    () => shadow('conversation.composer', {
      priority: BOT_PRIORITY,
      select: owner => (owner.pendingInteraction?.kind === 'question' ? owner.pendingInteraction : null),
    }, QuestionCard),
    // The quote bar sits under every other dock, so it always hugs the composer the reader is
    // about to type in.
    () => shadow('conversation.input.dock', { id: 'bot-quote', order: 1000, inject: face }, ComposerQuote),
    () => shadow('conversation.input.dock', { id: 'bot-members', order: -120, inject: face }, MemberDock),
    () => shadow('conversation.input.dock', { id: 'bot-model', order: -110, inject: face }, ModelChoiceDock),
    () => shadow('conversation.input.dock', { id: 'bot-question', order: -100, inject: face }, QuestionDock),
    () => shadow('conversation.input.dock', { id: 'bot-view', order: -95, inject: face }, WidgetDock),
    () => shadow('conversation.input.dock', { id: 'bot-secret', order: -90, inject: face }, SecretDock),
    () => shadow('conversation.input.dock', { id: 'bot-handoff', order: -85, inject: face }, HandoffDock),
  ]
  // The return button belongs to neither group: it renders only in Agent mode.
  ctx.effect(() => installCompiledStyles(RETURN_CSS, 'return'), 'ds-bot: return styles')
  shadow('sidebar.footer.action', { id: 'bot-return', order: -300, inject: face }, BotReturn)

  // The main view decides `plain`: a DSH Agent Session keeps the Bot shell but
  // withdraws the conversation replacements, so the native dsh page shows. A jump
  // this plugin did not start — the hero's workspace picker or a fork — opens an
  // unowned Session; coming from a DSH Agent Session it is adopted into that Agent.
  ctx.effect(() => {
    let previous
    const sync = () => {
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      const plain = isAgentSessionId(main)
      setPlain(plain)
      if (plain) dropPanels()
      if (main === previous) return
      const before = previous
      previous = main
      const ours = expected !== null && main === expected
      expected = null
      if (ours || main === undefined) return
      // Adoption is a Bot-mode affair: in Agent mode the native sidebar owns
      // navigation, and opening an existing Session there must not pull it in.
      if (surface.getSnapshot().mode !== 'bot') return
      const agentId = before !== undefined ? agentOfSession(before) : undefined
      if (agentId === undefined) return
      const snapshot = roster.getSnapshot()
      if (snapshot.byId[main] !== undefined || snapshot.roomsById[main] !== undefined || agentOfSession(main) !== undefined) return
      // Only a Session this jump created joins the Agent: a blank one from the
      // workspace picker, or a fork of a Session the same Agent owns. An existing
      // Session the user opened from the sidebar keeps its team tools and stays out.
      const row = list.byId[main]
      // A subagent child reports the Agent Session as its parent, but adopting it
      // would steal it from subagent routing — the Host refuses anyway, so skip.
      if (row?.origin === 'subagent') return
      // The client list maps the fork's parent to `parentId`; the raw field is
      // the fallback for shapes that skip the mapping.
      const parent = row?.parentId ?? row?.parentSessionId
      const forkedFromAgent = parent !== undefined && agentOfSession(parent) === agentId
      if (row?.blank !== true && !forkedFromAgent) return
      pendingAdopt.set(main, agentId)
      setPlain(true)
      void call('agent-adopt', { agentId, sessionId: main }).then(() => pull()).catch((error) => {
        pendingAdopt.delete(main)
        console.warn('[ds-bot] agent-adopt', error)
        // The Session never joined the Agent: the sync puts the team surface
        // back (a Map delete fires no subscription), and the user hears why.
        sync()
        actions.reportError(error, 'agent-adopt')
      })
      // The hero's workspace picker leaves the blank Session it switched away from
      // behind; in another workspace it stays empty forever, so it is archived.
      const next = workspaceOf(main)
      if (list.byId[before]?.blank === true && next !== undefined && workspaceOf(before) !== next) {
        void call('agent-archive', { agentId, sessionId: before }).then(() => pull()).catch(() => {})
      }
    }
    const offList = ctx.sessions.list.subscribe(sync)
    const offRoster = roster.subscribe(sync)
    sync()
    return () => { offList(); offRoster() }
  }, 'ds-bot: agent surface')

  ctx.effect(() => {
    const groups = surfaceGroups({ shell: installShell, conversation: installConversation }, {
      onError: (_group, error) => actions.reportError(new Error(t('Bot mode could not be set up here: {error}', { error: error?.message ?? String(error) })), 'surface'),
    })
    // A shadow step can mount "successfully" with nothing registered: when a
    // slot's inject callback throws inside the host, the host cancels the
    // declaration's subscription but the step's disposer still counts the group
    // as mounted. After the shell goes on, check that its sidebar entry really
    // landed; remount a few times when it did not (cold start race).
    let verifyTimer = 0
    let verifyAttempts = 0
    const verifySidebar = () => {
      if (!groupsFor(surface.getSnapshot()).shell) return
      let landed = false
      let declared = true
      try {
        landed = ctx.slots.entries('sidebar.workspaces').some(entry => entry.component === TeamSidebar)
        declared = ctx.slots.spec?.('sidebar.workspaces') !== undefined
      } catch {
        declared = false
      }
      if (landed) return
      if (!declared) {
        // The slot itself is not declared yet; keep watching for a while.
        if (verifyAttempts < 20) {
          verifyAttempts += 1
          verifyTimer = setTimeout(verifySidebar, 250)
        }
        return
      }
      if (verifyAttempts >= 3) return
      verifyAttempts += 1
      console.warn('[ds-bot] sidebar entry missing after shell mount; remounting')
      groups.remount('shell')
      verifyTimer = setTimeout(verifySidebar, 250)
    }
    const reconcile = () => {
      groups.reconcile(groupsFor(surface.getSnapshot()))
      clearTimeout(verifyTimer)
      verifyAttempts = 0
      verifyTimer = setTimeout(verifySidebar, 250)
    }
    reconcile()
    if (surface.getSnapshot().mode === 'bot') ensureBotHome()
    const unsub = surface.subscribe(reconcile)
    return () => {
      unsub()
      clearTimeout(verifyTimer)
      groups.dispose()
    }
  }, 'ds-bot: surface')
}
