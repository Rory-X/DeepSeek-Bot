import { createElement as h, useRef, useState } from 'react'
import { useMorph } from './motion.js'
import { MaskedInput } from './secret-card.js'
import { language, t } from './i18n.js'
import { ChevronRightIcon } from './icons.js'

export const GitHubMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' }))

// The Vercel mark is its plain triangle; the edge is a path of our own so no artwork is
// copied into the bundle.
export const VercelMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M10 2.8 18.6 17.6H1.4z' }))

// The OAuth services carry a plain glyph of our own drawing — a cloud, a bracketed N, a hash —
// rather than any brand artwork.
export const CloudflareMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true },
  h('path', { d: 'M6.2 15h7.4a3.2 3.2 0 0 0 .4-6.4 4.6 4.6 0 0 0-8.8-1.1A3.7 3.7 0 0 0 6.2 15z' }))

export const NotionMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('rect', { x: 3.2, y: 3.2, width: 13.6, height: 13.6, rx: 2.6 }), h('path', { d: 'M7.2 13.2V6.8l5.6 6.4V6.8' }))

export const SlackMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': true },
  h('path', { d: 'M7.6 4.4v11.2M12.4 4.4v11.2M4.4 7.6h11.2M4.4 12.4h11.2' }))

// A notification connector's mark: a paper plane of our own drawing, like the others.
export const TelegramMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M17.2 3.4 2.7 9.6l4.9 1.6 1.6 4.7 2.9-3.2 3.6 2.7z' }), h('path', { d: 'M7.6 11.2 17.2 3.4' }))

// Neon's mark is a database stack of our own drawing, not its logo.
export const NeonMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('ellipse', { cx: 10, cy: 5.4, rx: 6, ry: 2.4 }),
  h('path', { d: 'M4 5.4v4.2c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V5.4' }),
  h('path', { d: 'M4 9.6v4.2c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V9.6' }))

// A page with written lines, for a notes service; an open book for a reading one.
export const ImaMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('rect', { x: 4.2, y: 3.4, width: 11.6, height: 13.2, rx: 2.2 }),
  h('path', { d: 'M7.4 7.6h5.2M7.4 10.3h5.2M7.4 13h3.2' }))

export const WeReadMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M10 5.6c-1.5-1.2-3.3-1.7-5.8-1.7v10.6c2.5 0 4.3.5 5.8 1.7 1.5-1.2 3.3-1.7 5.8-1.7V3.9c-2.5 0-4.3.5-5.8 1.7z' }),
  h('path', { d: 'M10 5.6v10.6' }))

// Two envelopes of our own drawing, told apart by their folds: a letter, and a tray.
export const GmailMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('rect', { x: 2.8, y: 4.8, width: 14.4, height: 10.4, rx: 2 }),
  h('path', { d: 'M3.6 6.4 10 11l6.4-4.6' }))

export const QQMailMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('rect', { x: 2.8, y: 4.8, width: 14.4, height: 10.4, rx: 2 }),
  h('path', { d: 'M3.4 15.2 8.4 10.6M16.6 15.2 11.6 10.6' }))

// A mark for a connector that names a glyph this client does not draw: a plug, of our own
// drawing, says "a service" without pretending to be any service's logo.
export const GenericMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M7.6 3.4v3.2M12.4 3.4v3.2' }),
  h('path', { d: 'M5.8 6.6h8.4v2.1a4.2 4.2 0 0 1-8.4 0z' }),
  h('path', { d: 'M10 12.9v3.7' }))

// Every mark the cards can name, by the `glyph` a connector declares. A host that does not
// declare one yet falls back to the service id, so the older connectors keep their marks.
const CARD_GLYPHS = {
  github: GitHubMark,
  vercel: VercelMark,
  cloudflare: CloudflareMark,
  notion: NotionMark,
  slack: SlackMark,
  telegram: TelegramMark,
  neon: NeonMark,
  ima: ImaMark,
  weread: WeReadMark,
  gmail: GmailMark,
  qqmail: QQMailMark,
}
const ABOUT = {
  github: () => t('Repositories, issues, and pull requests'),
  vercel: () => t('Projects, deployments, and logs'),
}
const TOKEN_URLS = {
  github: 'https://github.com/settings/personal-access-tokens/new',
  vercel: 'https://vercel.com/account/tokens',
}
const TOKEN_LABELS = {
  github: () => t('GitHub token'),
  vercel: () => t('Vercel token'),
}
const TOKEN_CREATE = {
  github: () => t('Create a token on GitHub'),
  vercel: () => t('Create a token on Vercel'),
}
const tokenLabel = id => (TOKEN_LABELS[id] ?? (() => t('Token')))()
const tokenCreate = id => (TOKEN_CREATE[id] ?? (() => t('Create a token')))()

// The card data a connector declares in its view: an icon name, one line about it, where its
// documentation is, and the words on its fields. A module that also has Chinese puts the same
// keys under `card.zh`, and the reader's language picks one; no service is named here.
const wantsChinese = () => language().startsWith('zh')
const cardText = (connector, key) => {
  const value = connector.card?.[key]
  if (typeof value !== 'string' || value === '') return null
  const chinese = connector.card?.zh?.[key]
  return wantsChinese() && typeof chinese === 'string' && chinese !== '' ? chinese : value
}
const cardAbout = connector => cardText(connector, 'about') ?? ABOUT[connector.id]?.()
// A level or a capability is drawn as the module declares it: its own order and words.
// Only the shape we need is filled in; nothing is inferred beyond the declared `write`.
const LEVEL_TITLES = { read: () => t('Read-only'), write: () => t('Can write') }
const levelTitle = (id, declared) => (typeof declared === 'string' && declared !== ''
  ? declared
  : LEVEL_TITLES[id] !== undefined ? LEVEL_TITLES[id]() : id)
const levelItem = entry => (typeof entry === 'string'
  ? { id: entry, title: levelTitle(entry), description: null, write: entry === 'write' }
  : {
      id: typeof entry?.id === 'string' ? entry.id : String(entry?.id ?? ''),
      title: levelTitle(typeof entry?.id === 'string' ? entry.id : String(entry?.id ?? ''), entry?.title ?? entry?.name),
      description: typeof entry?.description === 'string' && entry.description !== '' ? entry.description : null,
      write: entry?.write === true || entry?.danger === true || entry?.id === 'write',
    })
const capabilityItem = (entry, index) => {
  const risk = entry?.risk === 'destructive' || entry?.danger === true
    ? 'destructive'
    : entry?.risk === 'write' || entry?.write === true ? 'write' : 'read'
  return {
    key: typeof entry?.key === 'string' ? entry.key : `capability-${index}`,
    title: typeof entry?.title === 'string' ? entry.title : typeof entry?.name === 'string' ? entry.name : String(entry?.key ?? ''),
    description: typeof entry?.description === 'string' && entry.description !== '' ? entry.description : null,
    // What the write would change, when the module says: drawn under the description.
    change: typeof entry?.preview?.change === 'string' && entry.preview.change !== '' ? entry.preview.change : null,
    risk,
    available: entry?.available !== false,
  }
}

function statusText(connector) {
  if (connector.state === 'connecting') return connector.oauth === true ? t('Waiting for the browser…') : t('Connecting…')
  // The host writes an OAuth failure as a sentence; it is shown as it came.
  if (connector.state === 'error' && connector.oauth === true) return connector.error ?? t('Could not connect')
  if (connector.state === 'error') return t('Could not connect: {error}', { error: connector.error ?? '' })
  if (connector.state === 'ready') {
    // A notification connector names the bot that writes, and its chat once one is known.
    const account = connector.mode === 'notify' && connector.account ? `@${connector.account}` : connector.account
    const who = account ? t('Connected as {account}', { account }) : t('Connected')
    return connector.mode === 'notify' && typeof connector.chatId === 'string' && connector.chatId !== ''
      ? `${who} · ${t('Chat found')}`
      : who
  }
  return cardAbout(connector) ?? (connector.oauth === true ? t('Not connected') : '')
}

function ConnectorRow({ connector, actions, readOnly = null }) {
  const [form, setForm] = useState(false)
  // The credential values, by the secret name the host declared; a form with one field is
  // the token field the cards always had.
  const [values, setValues] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // OAuth connectors: the browser tab that finishes the sign-in, and the app fields a
  // service without dynamic registration asks for first.
  const oauth = connector.oauth === true
  const manual = oauth && connector.manualClient === true
  // The settings a connector declares are plain text, shown with the stored value: they
  // decide which address or project the mounted level runs against, not who the user is.
  const settings = Array.isArray(connector.settings)
    ? connector.settings.filter(field => field !== null && typeof field?.name === 'string' && field.name !== '')
    : []
  const [settingDraft, setSettingDraft] = useState(null)
  const settingValue = (field) => {
    if (settingDraft !== null && Object.hasOwn(settingDraft, field.name)) return settingDraft[field.name]
    return typeof field.value === 'string' ? field.value : ''
  }
  const settingsChanged = settings.some(field => settingValue(field) !== (typeof field.value === 'string' ? field.value : ''))
  const saveSettings = () => {
    if (busy || !settingsChanged) return
    const values = Object.fromEntries(settings.map(field => [field.name, settingValue(field).trim()]))
    void run(actions.connectorSetSettings(connector.id, values), () => setSettingDraft(null))
  }
  // The fields a connector declares (`credentials` on the host): the card draws one masked
  // input per field and sends them together as `values`. A host that declares none keeps the
  // single token field, labelled for its service.
  const tokenFieldLabel = cardText(connector, 'tokenLabel') ?? tokenLabel(connector.id)
  const tokenFieldPlaceholder = cardText(connector, 'tokenPlaceholder') ?? undefined
  const declared = Array.isArray(connector.inputs) ? connector.inputs.filter(input => input !== null && typeof input?.name === 'string' && input.name !== '') : []
  const fields = declared.length > 0
    ? declared.map(input => ({
        name: input.name,
        label: input.label ?? (declared.length === 1 ? tokenFieldLabel : input.name),
        placeholder: typeof input.placeholder === 'string' && input.placeholder !== '' ? input.placeholder : undefined,
        required: input.required !== false,
      }))
    : [{ name: 'token', label: tokenFieldLabel, required: true }]
  const given = field => (values[field.name] ?? '').trim()
  // A notification connector keeps one secret and points it at a chat: the card draws the
  // secret's own fields plus the chat id, and tests the message path from the same row.
  const notify = connector.mode === 'notify'
  const [chatDraft, setChatDraft] = useState(null)
  // `null` follows the view, so a chat id the host finds after a Test shows up in the field.
  const chatValue = chatDraft ?? (typeof connector.chatId === 'string' ? connector.chatId : '')
  const configured = typeof connector.clientId === 'string' && connector.clientId !== ''
  const [appForm, setAppForm] = useState(false)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [authorizeUrl, setAuthorizeUrl] = useState(null)
  const oauthLevel = () => (typeof shownLevel === 'string' && shownLevel !== '' ? shownLevel : undefined)
  const startAuthorization = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    // Opened before the request so a popup blocker sees the reader's own press.
    const tab = window.open('about:blank', '_blank')
    try {
      const result = await actions.connectorOauthStart(connector.id, oauthLevel())
      const url = typeof result?.authorizeUrl === 'string' ? result.authorizeUrl : ''
      if (url === '') throw new Error(t('The authorization page could not be opened'))
      setAuthorizeUrl(url)
      if (tab !== null) {
        try { tab.location.href = url } catch { /* the link below stays the way in */ }
        tab.focus?.()
      }
    } catch (failure) {
      try { tab?.close?.() } catch { /* a blocked or closed tab needs nothing */ }
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }
  const saveApp = async () => {
    if (busy || appId.trim() === '' || appSecret.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await actions.connectorOauthApp(connector.id, appId.trim(), appSecret)
      setAppSecret('')
      setAppForm(false)
      await startAuthorization()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }
  const run = (task, after) => {
    setBusy(true)
    setError(null)
    return task.then(() => { after?.() }, failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  const complete = () => fields.every(field => !field.required || given(field) !== '')
  const connect = () => {
    if (busy || !complete()) return
    const filled = {}
    for (const field of fields) {
      const value = given(field)
      if (value !== '') filled[field.name] = value
    }
    const done = () => { setValues({}); setChatDraft(null); setForm(false) }
    const submit = () => declared.length > 0 ? actions.connectorConnectValues(connector.id, filled) : actions.connectorConnect(connector.id, filled.token)
    if (notify) {
      const chatId = chatValue.trim()
      // The chat id typed beside the secret is saved once the token is known to be good.
      void run(submit().then(() => (chatId === '' ? undefined : actions.connectorSetChat(connector.id, chatId))), done)
      return
    }
    // A host that declares its fields takes them as `values`; an older one takes the token.
    void run(submit(), done)
  }
  const saveChat = () => {
    if (busy) return
    void run(actions.connectorSetChat(connector.id, chatValue.trim()), () => setChatDraft(null))
  }
  const on = connector.state !== 'off'
  // Write access is what the connector declares: its level, its capabilities in its own
  // order, and a line about its permissions. Nothing here switches them on or off; the
  // level is the setting, and a change asks the host for a new grant.
  const levels = Array.isArray(connector.levels) ? connector.levels.filter(entry => entry !== null) : []
  const currentLevel = typeof connector.level === 'string' ? connector.level : null
  const capabilities = Array.isArray(connector.capabilities) ? connector.capabilities.filter(entry => entry !== null && typeof entry === 'object') : []
  const capWrites = capabilities.some((entry) => {
    const item = capabilityItem(entry, 0)
    return item.risk !== 'read'
  })
  const permissions = typeof connector.permissions?.summary === 'string' && connector.permissions.summary !== '' ? connector.permissions.summary : null
  // The host says why a connector is not ready at its level, and when a level change needs
  // the reader to authorize again.
  const levelNote = typeof connector.levelNote === 'string' && connector.levelNote !== '' ? connector.levelNote : null
  const needsReauth = connector.needsReauth === true
  // A host whose profile forbids changes says why; every declared write then shows as
  // unavailable instead of disappearing.
  const writesLocked = typeof readOnly === 'string' && readOnly !== ''
  // The host may name per-level reasons (a level that needs another setting); without them,
  // a level that needs the unfilled settings is blocked here with the same words.
  const levelNotes = connector.levelNotes !== null && typeof connector.levelNotes === 'object' ? connector.levelNotes : {}
  // The level the reader picked. An OAuth connector sends it with the authorization request
  // (`connector-oauth-start { level }`), so a stored level that cannot connect is not in the
  // way; other connectors switch at once.
  const [levelDraft, setLevelDraft] = useState(null)
  const shownLevel = oauth ? (levelDraft ?? currentLevel) : currentLevel
  const chooseLevel = (id) => {
    if (oauth && !on) { setLevelDraft(id); return }
    // A connected OAuth connector asks the host for the new level: it disconnects and the
    // next Connect authorizes for that level.
    setLevelDraft(null)
    void run(actions.connectorSetLevel(connector.id, id))
  }
  const storedSetting = field => (typeof field.value === 'string' ? field.value : '').trim()
  const settingsEmpty = settings.some(field => storedSetting(field) === '')
  const levelBlocked = (id) => {
    const note = typeof levelNotes[id] === 'string' && levelNotes[id] !== '' ? levelNotes[id] : null
    if (note !== null) return note
    if (settingsEmpty && /write|full/i.test(id)) return t('Fill in the settings before switching to this level.')
    return null
  }
  // A connector with settings opens its panel even before it is connected: the settings are
  // what a level needs in order to connect at all.
  const hasOptions = settings.length > 0 || levels.length > 0
    || (on && (capabilities.length > 0 || permissions !== null))
  const [details, setDetails] = useState(false)
  const panelId = hasOptions ? `bt-connector-${connector.id}-panel` : undefined
  // The card names its own glyph; a host that declares none keeps the mark its id had.
  const Mark = CARD_GLYPHS[connector.card?.glyph] ?? CARD_GLYPHS[connector.id] ?? GenericMark
  // What the connector says about itself: its docs and the words on its token field.
  const docsUrl = typeof connector.card?.docsUrl === 'string' && connector.card.docsUrl !== '' ? connector.card.docsUrl : TOKEN_URLS[connector.id]
  const row = useRef(null)
  useMorph(row, `${form}:${error !== null}:${connector.state}`)
  const mark = h('span', { className: 'bt-connector-mark' }, Mark ? h(Mark) : null)
  const text = h('span', { className: 'bt-connector-text' },
    h('span', { className: 'bt-connector-name' }, connector.name),
    h('span', { className: 'bt-connector-status' }, statusText(connector)))
  return h('div', { ref: row, className: 'bt-connector', 'data-state': connector.state, 'data-open': details || undefined, 'data-notify': notify || undefined },
    h('div', { className: 'bt-connector-head' },
      hasOptions
        ? h('button', {
          type: 'button', className: 'bt-connector-main', 'aria-expanded': details,
          ...(details ? { 'aria-controls': panelId } : {}),
          onClick: () => setDetails(value => !value),
        }, mark, text, h('span', { className: 'bt-connector-chevron', 'aria-hidden': true }, h(ChevronRightIcon)))
        : h('div', { className: 'bt-connector-main' }, mark, text),
      h('span', { className: 'bt-connector-actions' },
        notify && connector.state === 'ready' && connector.canTest === true ? h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
          onClick: (event) => { event.stopPropagation(); void run(actions.connectorTest(connector.id)) },
        }, busy ? t('Testing…') : t('Test message')) : null,
        connector.state === 'error' && !oauth ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: (event) => { event.stopPropagation(); void run(actions.connectorRetry(connector.id)) } }, t('Try again')) : null,
        connector.state === 'error' && oauth ? h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
          onClick: (event) => { event.stopPropagation(); void startAuthorization() },
        }, t('Connect again'))
          : on && connector.state !== 'connecting'
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: (event) => { event.stopPropagation(); void run(actions.connectorDisconnect(connector.id)) } }, t('Disconnect'))
          : connector.state === 'connecting'
            ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: true }, t('Waiting for the browser…'))
            : oauth
              ? (manual && !configured && !appForm ? null : h('button', {
                type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
                onClick: (event) => { event.stopPropagation(); void startAuthorization() },
              }, connector.state === 'error' ? t('Connect again') : t('Connect')))
              : form ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: (event) => { event.stopPropagation(); setForm(true) } }, t('Connect')))),
    // A failed Test message keeps the connector ready and shows the host's sentence on the
    // card, the place a mount failure would use; a found chat id lands in the field below.
    notify && connector.state !== 'error' && connector.error !== undefined
      ? h('div', { className: 'bt-connector-error', role: 'alert' }, connector.error)
      : null,
    // The chat the Bot writes to stays editable: empty clears it, and Test looks again.
    notify && connector.state === 'ready' ? h('div', { className: 'bt-connector-chat' },
      h('div', { className: 'bt-connector-form-row' },
        h('label', { className: 'bt-q-field' }, h('input', {
          className: 'bt-connector-input', value: chatValue, placeholder: t('Chat id'), 'aria-label': t('Chat id'),
          autoComplete: 'off', spellCheck: false, inputMode: 'numeric',
          onChange: (event) => setChatDraft(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') saveChat() },
        })),
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm',
          disabled: busy || chatValue.trim() === (typeof connector.chatId === 'string' ? connector.chatId : ''),
          onClick: () => saveChat(),
        }, t('Save'))),
      typeof connector.chatId === 'string' && connector.chatId !== ''
        ? null
        : h('div', { className: 'bt-connector-hint' }, t('Send the bot a message first, then press Test.')))
      : null,
    levelNote !== null ? h('div', { className: 'bt-connector-hint' }, levelNote) : null,
    needsReauth ? h('div', { className: 'bt-connector-hint' }, t('Click Connect to authorize with this access level again.')) : null,
    oauth && docsUrl !== undefined ? h('div', { className: 'bt-connector-docs' },
      h('a', { className: 'bt-connector-link', href: docsUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Documentation'))) : null,
    hasOptions && details
      ? h('div', { className: 'bt-connector-panel', id: panelId, role: 'group', 'aria-label': t('Connector settings') },
        settings.length > 0
          ? h('div', { className: 'bt-connector-setting' },
            h('div', { className: 'bt-connector-action-title' }, t('Settings')),
            settings.map(field => h('label', { key: field.name, className: 'bt-connector-field' },
              h('span', { className: 'bt-connector-field-name' }, typeof field.label === 'string' && field.label !== '' ? field.label : field.name),
              h('div', { className: 'bt-q-field' }, h('input', {
                className: 'bt-connector-input', value: settingValue(field), placeholder: field.name, 'aria-label': field.label ?? field.name,
                autoComplete: 'off', spellCheck: false, disabled: busy,
                onChange: (event) => setSettingDraft(previous => ({ ...previous, [field.name]: event.target.value })),
                onKeyDown: (event) => { if (event.key === 'Enter') saveSettings() },
              })))),
            h('div', { className: 'bt-connector-form-row' },
              h('button', {
                type: 'button', className: 'bt-soft bt-soft-sm',
                disabled: busy || !settingsChanged,
                onClick: () => saveSettings(),
              }, t('Save settings'))))
          : null,
        levels.length > 0
          ? h('div', { className: 'bt-connector-setting' },
            h('div', { className: 'bt-connector-action-title' }, t('Access level')),
            h('div', { className: 'bt-connector-levels', role: 'radiogroup', 'aria-label': t('Access level') },
              levels.map((entry) => {
                const item = levelItem(entry)
                const current = item.id === shownLevel
                const blocked = current ? null : levelBlocked(item.id)
                return h('div', { key: item.id, className: 'bt-connector-level-wrap' },
                  h('button', {
                    type: 'button', role: 'radio', 'aria-checked': current,
                    className: 'bt-connector-level', 'data-current': current || undefined,
                    disabled: busy || (writesLocked && item.write === true) || blocked !== null,
                    onClick: () => { if (!current && blocked === null) chooseLevel(item.id) },
                  },
                  h('span', { className: 'bt-connector-level-title' }, item.title),
                  item.description !== null ? h('span', { className: 'bt-connector-level-note' }, item.description) : null),
                  blocked !== null ? h('span', { className: 'bt-connector-level-blocked' }, blocked) : null)
              })),
            h('div', { className: 'bt-connector-hint' }, t('Switching the access level needs a new authorization.')))
          : null,
        permissions !== null ? h('div', { className: 'bt-connector-hint' }, permissions) : null,
        capabilities.length > 0
          ? h('div', { className: 'bt-connector-setting' },
            h('div', { className: 'bt-connector-action-title' }, t('Capabilities')),
            capWrites && currentLevel === 'read' && !writesLocked
              ? h('div', { className: 'bt-connector-hint' }, t('Capabilities that write open after switching to Can write.'))
              : null,
            h('ul', { className: 'bt-connector-caps' }, capabilities.map((entry, index) => {
              const item = capabilityItem(entry, index)
              const locked = item.available === false || (writesLocked && item.risk !== 'read')
              const badge = item.risk === 'destructive' ? t('Destructive') : item.risk === 'write' ? t('Write') : null
              return h('li', { key: item.key, className: 'bt-connector-cap', 'data-risk': item.risk, 'data-locked': locked || undefined },
                h('span', { className: 'bt-connector-cap-title' }, item.title, badge !== null ? h('span', { className: 'bt-connector-cap-badge' }, badge) : null),
                item.description !== null ? h('span', { className: 'bt-connector-cap-note' }, item.description) : null,
                item.change !== null ? h('span', { className: 'bt-connector-cap-change' }, item.change) : null,
                locked ? h('span', { className: 'bt-connector-cap-lock' }, t('Unavailable on this host.')) : null)
            })))
          : null)
      : null,
    !oauth && !on && form ? h('div', { className: 'bt-connector-form' },
      fields.map((field, index) => {
        const input = h(MaskedInput, {
          value: values[field.name] ?? '',
          onChange: (next) => setValues(previous => ({ ...previous, [field.name]: next })),
          onEnter: connect,
          label: field.label,
          placeholder: field.placeholder ?? (declared.length === 0 ? tokenFieldPlaceholder : undefined),
          autoFocus: index === 0,
        })
        // Several fields have to be told apart at a glance; one field is the token box it was.
        return declared.length === 0
          ? h('label', { key: field.name, className: 'bt-q-field bt-secret-field' }, input)
          : h('label', { key: field.name, className: 'bt-connector-field' },
            h('span', { className: 'bt-connector-field-name' }, field.label),
            h('div', { className: 'bt-q-field bt-secret-field' }, input))
      }),
      notify ? h('label', { key: 'chat', className: 'bt-connector-field' },
        h('span', { className: 'bt-connector-field-name' }, t('Chat id (optional)')),
        h('div', { className: 'bt-q-field' }, h('input', {
          className: 'bt-connector-input', value: chatValue, placeholder: t('Optional'), 'aria-label': t('Chat id'),
          autoComplete: 'off', spellCheck: false, inputMode: 'numeric',
          onChange: (event) => setChatDraft(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') connect() },
        }))) : null,
      h('div', { className: 'bt-connector-form-row' },
        docsUrl ? h('a', { className: 'bt-connector-link', href: docsUrl, target: '_blank', rel: 'noopener noreferrer' }, connector.card?.docsUrl ? t('Documentation') : tokenCreate(connector.id)) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setForm(false); setValues({}); setError(null) } }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !complete(), onClick: connect }, busy ? t('Connecting…') : t('Connect')))) : null,
    // Slack has no dynamic registration: its app id and secret are typed here first, with the
    // redirect URL the app has to carry.
    manual && !on && (!configured || appForm) ? h('div', { className: 'bt-connector-form' },
      h('label', { className: 'bt-q-field' }, h('input', {
        className: 'bt-connector-input', value: appId, placeholder: t('Client ID'), 'aria-label': t('Client ID'),
        autoComplete: 'off', spellCheck: false,
        onChange: (event) => setAppId(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') void saveApp() },
      })),
      h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value: appSecret, onChange: setAppSecret, onEnter: () => void saveApp(), label: t('Client secret') })),
      h('div', { className: 'bt-connector-hint' }, t('In the app settings, set the redirect URL to {url}', { url: `${location.origin}/oauth/ds-bot/slack` })),
      h('div', { className: 'bt-connector-form-row' },
        configured ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setAppForm(false); setAppSecret('') } }, t('Cancel')) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || appId.trim() === '' || appSecret.trim() === '', onClick: () => void saveApp() }, busy ? t('Connecting…') : t('Save and connect'))))
      : null,
    // A tab the browser refused to open still has a way in.
    oauth && !on && authorizeUrl !== null && connector.state !== 'connecting' ? h('div', { className: 'bt-connector-form-row' },
      h('a', { className: 'bt-connector-link', href: authorizeUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Open the authorization page'))) : null,
    manual && configured && !on && !appForm ? h('div', { className: 'bt-connector-form-row' },
      h('button', { type: 'button', className: 'bt-connector-link bt-connector-link-btn', onClick: () => { setAppForm(true); setAppId(connector.clientId ?? '') } }, t('Use a different app'))) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null)
}

// Settings → Connectors: one row per connector.
export function ConnectorsPage({ roster, actions }) {
  const list = roster?.connectors ?? []
  const readOnly = typeof roster?.readOnly === 'string' && roster.readOnly !== '' ? roster.readOnly : null
  return h('section', { className: 'bt-set-section' },
    h('div', { className: 'bt-set-card bt-connectors-card' }, list.length === 0
      ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No connectors')))
      : list.map(connector => h(ConnectorRow, { key: connector.id, connector, actions, readOnly }))))
}
