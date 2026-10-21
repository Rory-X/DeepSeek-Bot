import { countCards, heldCardKey } from './sources.js'
import { noteClientError } from './diagnostics.js'

// The actions every window that draws the Bot views shares: dialogs and panels (the `ui`
// source), requests to the host, and the notes the transcript keeps. The shell around the
// views adds navigation and its own panels. `after` reads the team again once a request
// is done; `partFor` maps a Bot id, or any part of its chat, to its current part.
export function teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock }) {
  // A memory is a Bot's or a group chat's; both are opened by id.
  const memoryOf = id => (roster.getSnapshot().roomsById[id] ? { roomId: id } : { botId: id })
  return {
    openBotFolders: (start = {}) => { ui.set(state => ({ ...state, botFolders: start, menu: null, newChat: null, palette: null })) },
    closeBotFolders: () => { ui.set(state => ({ ...state, botFolders: null })) },
    saveBotFolder: payload => after(call('bot-folder-save', payload)),
    deleteBotFolder: payload => after(call('bot-folder-delete', payload)),
    pinBotFolder: payload => after(call('bot-folder-pin', payload)),
    dissolveBotFolder: payload => after(call('bot-folder-dissolve', payload)),
    ungroupBot: id => after(call('bot-folder-assign', { name: '', botIds: [id] })),
    openNewChat: (mode) => { ui.set(state => ({ ...state, newChat: mode, menu: null, palette: null })) },
    openPalette: (query = '') => { ui.set(state => ({ ...state, palette: { query, token: Date.now() }, newChat: null, menu: null })) },
    // The token keeps a late exit timer from closing a palette opened again since.
    closePalette: (token) => { ui.set(state => (state.palette && (token === undefined || state.palette.token === token) ? { ...state, palette: null } : state)) },
    // `at` names the exchange line that was tapped, so the dialog can open on it.
    openExchange: (a, b, at) => { if (a && b) ui.set(state => ({ ...state, exchange: [a, b], exchangeAt: at ?? null })) },
    openVoice: (id) => { if (id) ui.set(state => ({ ...state, voice: id, menu: null })) },
    closeVoice: () => { ui.set(state => (state.voice ? { ...state, voice: null } : state)) },
    toggleDetails: (id, force) => {
      ui.set((state) => {
        const details = force || state.details !== id || state.view !== 'details' ? id : null
        return { ...state, renaming: false, tab: null, details, view: 'details' }
      })
    },
    // The open panel follows the main view; a subject with no browser (a group
    // chat, an outside Session) settles on the details view.
    followPanel: (id) => {
      ui.set((state) => {
        if (!state.details || state.details === id) return state
        const view = state.view === 'browser' && roster.getSnapshot().byId[id] === undefined ? 'details' : state.view
        return { ...state, details: id, view, renaming: false, tab: null }
      })
    },
    showDetails: (id, tab = null) => { ui.set(state => ({ ...state, details: id, view: 'details', renaming: false, tab })) },
    // Opening the conversation would move focus to its composer and blur the name field.
    renameBot: (id) => { ui.set(state => ({ ...state, details: id, view: 'details', renaming: true, tab: null })) },
    // `id` opens one Bot (page 'bots') or one group chat (page 'groups').
    openSettings: (page = 'general', id = null) => { ui.set(state => ({ ...state, settings: { page, id }, menu: null, palette: null, newChat: null })) },
    closeSettings: () => { ui.set(state => (state.settings ? { ...state, settings: null } : state)) },
    openMemory: (id) => { ui.set(state => ({ ...state, memory: id, menu: null, palette: null })) },
    closeMemory: () => { ui.set(state => (state.memory ? { ...state, memory: null } : state)) },
    openConnectors: () => { ui.set(state => ({ ...state, settings: { page: 'connectors', id: null }, menu: null, palette: null, newChat: null })) },
    setPanelView: (view) => {
      if (view !== 'details' && view !== 'browser') return
      ui.set(state => (state.details && state.view !== view ? { ...state, view } : state))
    },
    closePanel: () => { ui.set(state => (state.details ? { ...state, details: null, view: 'details', renaming: false, tab: null } : state)) },
    setFlags: (id, flags) => after(call('set-flags', { id, ...flags })),
    deleteRoom: id => after(call('delete-room', { id })),
    openMenu: (menu) => { ui.set(state => ({ ...state, menu })) },
    closeMenu: () => { ui.set(state => (state.menu ? { ...state, menu: null } : state)) },
    closeOverlay: () => { ui.set(state => ({ ...state, newChat: null, exchange: null, details: state.newChat || state.exchange ? state.details : null })) },
    createBot: payload => after(call('create-bot', payload)),
    createRoom: (members, options = {}) => after(call('create-room', { members, ...options })),
    updateBot: (id, patch) => after(call('update-bot', { id, ...patch })),
    refreshModels: () => after(call('models')).catch(() => {}),
    efforts: ref => call('efforts', { ref }),
    folders: () => call('folders'),
    folderPick: () => call('folder-pick'),
    folderList: path => call('folder-list', { path: path ?? '' }),
    setTeamWorkspace: path => after(call('team-workspace', { path })),
    deleteBot: id => after(call('delete-bot', { id })),
    duplicateBot: id => after(call('duplicate-bot', { id })),
    setPrefs: prefs => after(call('set-prefs', prefs)),
    setMain: (id, main = true, options = {}) => after(call('set-main', { id, main, ...options })),
    updateRoom: (id, patch) => after(call('update-room', { id, ...patch })),
    send: (sessionId, text) => after(call('send', { sessionId: partFor(sessionId), text })),
    answerQuestion: (sessionId, questionId, answer) => after(call('answer-question', { sessionId: partFor(sessionId), questionId, answer })),
    dismissQuestion: sessionId => after(call('dismiss-question', { sessionId })),
    answerView: (sessionId, viewId, action, values) => after(call('view-reply', { sessionId: partFor(sessionId), viewId, action, values })),
    dismissView: sessionId => after(call('dismiss-view', { sessionId: partFor(sessionId) })),
    answerApproval: (id, choice) => after(call('approval-answer', { id, choice })),
    stopMemberWork: (roomId, botId) => after(call('stop-member-work', { roomId, botId })),
    // Values go out in these requests and never come back in a response.
    secretSet: payload => after(call('secret-set', payload)),
    secretAllow: requestId => after(call('secret-allow', { requestId })),
    secretCancel: requestId => after(call('secret-cancel', { requestId })),
    secretUpdate: (name, scope) => after(call('secret-update', { name, scope })),
    secretDelete: name => after(call('secret-delete', { name })),
    connectorConnect: (id, token) => after(call('connector-connect', { id, token })),
    // A notification connector sends one message to prove the path, and remembers the chat
    // a Test message found or the reader typed.
    connectorTest: id => after(call('connector-test', { id })),
    connectorSetChat: (id, chatId) => after(call('connector-set-chat', { id, chatId })),
    // One notification connector sends without an approval card until the user turns this off.
    connectorSetAutoPush: (id, enabled) => after(call('connector-set-auto-push', { id, enabled })),
    // A connector whose card declares several credential fields sends them together, by the
    // secret name the host named each field with.
    connectorConnectValues: (id, values) => after(call('connector-connect', { id, values })),
    connectorDisconnect: id => after(call('connector-disconnect', { id })),
    connectorRetry: id => after(call('connector-retry', { id })),
    // A level change asks the host for a new grant: an OAuth connector goes back to off and
    // asks to authorize again, a token connector remounts with the new level.
    connectorSetLevel: (id, level) => after(call('connector-set-level', { id, level })),
    // Settings are plain values (a project id, a role name), saved in one request; the view
    // comes back with what the host normalized. A module that keeps several connections
    // takes the card's own name here too, which is why the input sits beside them.
    // An empty secret value means "keep the stored one"; a secret the reader removed travels
    // in `clearSecrets`, which the host applies to the stored credential.
    connectorSetSettings: (id, values, options = {}) => after(call('connector-set-settings', {
      id,
      values,
      ...(Array.isArray(options?.clearSecrets) && options.clearSecrets.length > 0 ? { clearSecrets: options.clearSecrets } : {}),
    })),
    // One more card of a multi-instance module, and one fewer; both answer with the new view.
    connectorCreateInstance: base => after(call('connector-create-instance', { base })),
    connectorDeleteInstance: id => after(call('connector-delete-instance', { id })),
    // The chosen level travels with the authorization request, so the grant is asked for the
    // level the reader sees.
    connectorOauthStart: (id, level) => after(call('connector-oauth-start', { id, ...(typeof level === 'string' && level !== '' ? { level } : {}) })),
    connectorOauthApp: (id, clientId, clientSecret) => after(call('connector-oauth-app', { id, clientId, clientSecret })),
    // One small module operation the generic endpoints do not cover (WeChat's ClawBot login).
    // The action name travels as the module declares it; the host refuses unknown ones.
    connectorCommand: (id, action, args) => after(call('connector-command', { id, action, ...(args === undefined ? {} : { args }) })),
    saveCapability: capability => after(call('capability-save', capability)),
    deleteCapability: name => after(call('capability-delete', { name })),
    approveCapability: name => after(call('capability-approve', { name })),
    setBotCapability: (botId, name, attached) => after(call('bot-capability', { botId, name, attached })),
    schedules: () => call('schedules'),
    scheduleCreate: task => call('schedule-create', task),
    scheduleDelete: (sessionId, id) => call('schedule-delete', { sessionId, id }),
    exchange: (a, b) => call('exchange', { a, b }).catch(() => []),
    exchangeText: id => call('exchange-text', { id }).catch(() => undefined),
    fileText: file => call('file-text', { file }).catch(() => undefined),
    roomProgress: roomId => call('room-progress', { roomId }).catch(() => []),
    earlier: (sessionId, cursor) => call('earlier', { sessionId, cursor: cursor ?? null }),
    // Hours come back in this browser's time zone, so days start at local midnight.
    usage: () => call('usage', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    // `summarize` starts a summary when the entries changed; `regenerate` always does.
    memoryView: (id, flags = {}) => call('memory-view', { ...memoryOf(id), ...flags }),
    memoryAsk: (id, text) => call('memory-ask', { ...memoryOf(id), text }),
    memoryForget: (id, entry) => call('memory-forget', { ...memoryOf(id), scope: entry.scope, topic: entry.topic, text: entry.text }),
    diagnostics: payload => call('diagnostics', payload),
    diagnosticsLog: () => call('diagnostics-log'),
    diagnosticsClear: () => call('diagnostics-clear'),
    repoStars: () => call('repo-stars'),
    // A failed action away from any form (a menu, the palette) shows as a toast.
    reportError: (error, where = 'action') => {
      noteClientError(where, error)
      ui.set(state => ({ ...state, toast: { text: error?.message ?? String(error), token: Date.now() } }))
    },
    dismissToast: token => ui.set(state => (state.toast && (token === undefined || state.toast.token === token) ? { ...state, toast: null } : state)),
    noteTurnTime: (sessionId, turn, key, time) => {
      if (sessionId === undefined || !Number.isFinite(turn) || !Number.isFinite(time)) return
      turnClock.set((state) => {
        const turns = state[sessionId] ?? {}
        const entry = turns[turn] ?? {}
        const next = key === 'first' && entry.first !== undefined ? Math.min(entry.first, time) : time
        if (entry[key] === next) return state
        return { ...state, [sessionId]: { ...turns, [turn]: { ...entry, [key]: next } } }
      })
    },
    noteTurnPeer: (sessionId, turn, peerId) => {
      if (sessionId === undefined || !Number.isFinite(turn)) return
      turnClock.set((state) => {
        const turns = state[sessionId] ?? {}
        const entry = turns[turn] ?? {}
        if (entry.peer === peerId) return state
        return { ...state, [sessionId]: { ...turns, [turn]: { ...entry, peer: peerId } } }
      })
    },
    noteLive: (sessionId, id, entry) => {
      if (sessionId === undefined) return
      live.set((state) => {
        const own = state[sessionId] ?? {}
        const prev = own[id]
        if (entry === null ? prev === undefined : prev !== undefined && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...entry, at: 0 })) return state
        const next = { ...own }
        if (entry === null) delete next[id]
        else next[id] = { ...entry, at: prev?.at ?? Date.now() }
        return { ...state, [sessionId]: next }
      })
    },
    noteCards: (sessionId, callIds, delta) => {
      if (sessionId !== undefined) cards.set(state => countCards(state, sessionId, callIds, delta))
    },
    noteHeldCard: (sessionId, kind, requestId, delta) => {
      if (sessionId !== undefined) heldCards.set(state => countCards(state, sessionId, [heldCardKey(kind, requestId)], delta))
    },
    clearLive: sessionId => live.set((state) => {
      if (!state[sessionId]) return state
      const next = { ...state }
      delete next[sessionId]
      return next
    }),
  }
}
