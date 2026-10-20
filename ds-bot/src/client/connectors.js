import { createElement as h, useRef, useState } from 'react'
import { useMorph } from './motion.js'
import { MaskedInput } from './secret-card.js'
import { t } from './i18n.js'
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
// A connector that declares no consent of its own keeps the wording the OAuth services used
// before cards carried it: the authorization page offers a read-only set and a full grant.
const GENERIC_CONSENT = {
  title: 'Choose the access level on the authorization page',
  body: 'Requested scopes is read-only, and it is all this connector asks for. Full access lets Bots change your {service} account; every write still asks for your approval first.',
  acknowledge: "I'll choose the access level on the authorization page",
}
const TOKEN_CREATE = {
  github: () => t('Create a token on GitHub'),
  vercel: () => t('Create a token on Vercel'),
}
const tokenLabel = id => (TOKEN_LABELS[id] ?? (() => t('Token')))()
const tokenCreate = id => (TOKEN_CREATE[id] ?? (() => t('Create a token')))()

// The card data a connector declares in its view: an icon name, one line about it, where its
// documentation is, what a read-only grant means, and the consent to show before a browser
// leaves for its authorization page. Text arrives in English and goes through the interface
// dictionary, so a service that changes its wording does not need a client change.
const cardText = (connector, key) => {
  const value = connector.card?.[key]
  return typeof value === 'string' && value !== '' ? t(value) : null
}
const cardAbout = connector => cardText(connector, 'about') ?? ABOUT[connector.id]?.()
const cardConsent = (connector) => {
  const declared = connector.card?.consent
  const source = declared !== null && typeof declared === 'object' && typeof declared.title === 'string'
    ? declared
    : GENERIC_CONSENT
  return {
    title: t(source.title),
    body: typeof source.body === 'string' ? t(source.body, { service: connector.name }) : '',
    // Only a connector whose authorization page asks the reader to choose says so in the
    // card; without that line the consent is information, not a gate.
    acknowledge: typeof source.acknowledge === 'string' ? t(source.acknowledge) : null,
  }
}

// One settings section inside a connector's panel: a title, what the switch does, and the
// switch itself. Any connector with settings renders these; the card owns the panel.
export function ConnectorOption({ title, note, checked, disabled = false, describedby, onChange }) {
  return h('div', { className: 'bt-connector-action-row' },
    h('div', { className: 'bt-connector-action-text' },
      h('div', { className: 'bt-connector-action-title' }, title),
      h('div', { className: 'bt-connector-action-note' }, note)),
    h('button', {
      type: 'button', role: 'switch', className: 'bt-switch', 'aria-checked': checked, 'aria-label': title,
      disabled,
      ...(describedby ? { 'aria-describedby': describedby } : {}),
      onClick: (event) => { event.stopPropagation(); onChange(!checked) },
    }, h('span', { className: 'bt-switch-knob', 'aria-hidden': true })))
}

function statusText(connector) {
  if (connector.state === 'connecting') return connector.oauth === true ? t('Waiting for the browser…') : t('Connecting…')
  // The host writes an OAuth failure as a sentence; it is shown as it came.
  if (connector.state === 'error' && connector.oauth === true) return connector.error ?? t('Could not connect')
  if (connector.state === 'error') return t('Could not connect: {error}', { error: connector.error ?? '' })
  if (connector.state === 'ready') return connector.account ? t('Connected as {account}', { account: connector.account }) : t('Connected')
  return cardAbout(connector) ?? (connector.oauth === true ? t('Not connected') : '')
}

function ConnectorRow({ connector, actions }) {
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
  // A connector that declares a consent shows its own wording before the browser leaves;
  // one that does not keeps the generic wording and its acknowledgement.
  const consent = oauth && connector.state === 'off' ? cardConsent(connector) : null
  const consentGate = consent !== null && consent.acknowledge !== null
  const [consentAck, setConsentAck] = useState(false)
  const configured = typeof connector.clientId === 'string' && connector.clientId !== ''
  const [appForm, setAppForm] = useState(false)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [authorizeUrl, setAuthorizeUrl] = useState(null)
  const startAuthorization = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    // Opened before the request so a popup blocker sees the reader's own press.
    const tab = window.open('about:blank', '_blank')
    try {
      const result = await actions.connectorOauthStart(connector.id)
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
    const done = () => { setValues({}); setForm(false) }
    // A host that declares its fields takes them as `values`; an older one takes the token.
    void run(declared.length > 0 ? actions.connectorConnectValues(connector.id, filled) : actions.connectorConnect(connector.id, filled.token), done)
  }
  const on = connector.state !== 'off'
  // `actions` is absent for a connector without write actions; a boolean says whether the
  // Bot may run them, and every run asks the user first.
  const actionsOn = connector.actions === true
  // `toolbox` is absent for a connector that cannot offer its whole toolset. With it on,
  // the named action tools are not registered: every action goes through the server's own
  // call tool, which asks for approval by itself, so the actions switch has nothing to do.
  const toolboxOn = connector.toolbox === true
  const toolboxOffered = typeof connector.toolbox === 'boolean'
  // The call tool is per service (`vercel_call`, `cloudflare_call`); an older host without
  // the field keeps the Vercel one.
  const toolboxCall = typeof connector.toolboxCall === 'string' && connector.toolboxCall !== '' ? connector.toolboxCall : 'vercel_call'
  const actionsOffered = typeof connector.actions === 'boolean'
  // A connected connector that has settings opens them from its own row; without either
  // there is nothing to open and the row stays what it was.
  const hasOptions = on && (actionsOffered || toolboxOffered)
  // The line saying where actions go while the toolbox is on; the disabled switch points
  // at it, so the reason survives a reader who never focuses the switch.
  const actionsNoteId = toolboxOn && actionsOffered ? `bt-connector-${connector.id}-actions-note` : undefined
  const [details, setDetails] = useState(false)
  const panelId = hasOptions ? `bt-connector-${connector.id}-panel` : undefined
  // The card names its own glyph; a host that declares none keeps the mark its id had.
  const Mark = CARD_GLYPHS[connector.card?.glyph] ?? CARD_GLYPHS[connector.id]
  // What the connector says about itself: its docs, the words on its token field, and what a
  // read-only grant means.
  const readOnlyNote = cardText(connector, 'readOnlyNote')
  const docsUrl = typeof connector.card?.docsUrl === 'string' && connector.card.docsUrl !== '' ? connector.card.docsUrl : TOKEN_URLS[connector.id]
  const row = useRef(null)
  useMorph(row, `${form}:${error !== null}:${connector.state}`)
  const mark = h('span', { className: 'bt-connector-mark' }, Mark ? h(Mark) : null)
  const text = h('span', { className: 'bt-connector-text' },
    h('span', { className: 'bt-connector-name' }, connector.name),
    h('span', { className: 'bt-connector-status' }, statusText(connector)))
  return h('div', { ref: row, className: 'bt-connector', 'data-state': connector.state, 'data-open': details || undefined },
    h('div', { className: 'bt-connector-head' },
      hasOptions
        ? h('button', {
          type: 'button', className: 'bt-connector-main', 'aria-expanded': details,
          ...(details ? { 'aria-controls': panelId } : {}),
          onClick: () => setDetails(value => !value),
        }, mark, text, h('span', { className: 'bt-connector-chevron', 'aria-hidden': true }, h(ChevronRightIcon)))
        : h('div', { className: 'bt-connector-main' }, mark, text),
      h('span', { className: 'bt-connector-actions' },
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
                type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || (consentGate && !consentAck),
                onClick: (event) => { event.stopPropagation(); void startAuthorization() },
              }, connector.state === 'error' ? t('Connect again') : t('Connect')))
              : form ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: (event) => { event.stopPropagation(); setForm(true) } }, t('Connect')))),
    // What a read-only grant means, in the connector's own words: it says before connecting
    // what the Bots may do, and stays there once connected.
    readOnlyNote !== null ? h('div', { className: 'bt-connector-readonly' }, readOnlyNote) : null,
    oauth && docsUrl !== undefined ? h('div', { className: 'bt-connector-docs' },
      h('a', { className: 'bt-connector-link', href: docsUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Documentation'))) : null,
    consent !== null
      ? h('div', { className: 'bt-connector-scope' },
        h('div', { className: 'bt-connector-scope-title' }, consent.title),
        consent.body !== '' ? h('div', { className: 'bt-connector-scope-body' }, consent.body) : null,
        consent.acknowledge !== null
          ? h('label', { className: 'bt-connector-consent' },
            h('input', {
              type: 'checkbox', className: 'bt-connector-check', checked: consentAck,
              onChange: (event) => setConsentAck(event.target.checked),
            }),
            h('span', null, consent.acknowledge))
          : null)
      : null,
    hasOptions && details
      ? h('div', { className: 'bt-connector-panel', id: panelId, role: 'group', 'aria-label': t('Connector settings') },
        toolboxOffered
          ? h('div', { className: 'bt-connector-setting' },
            h(ConnectorOption, {
              title: t('Full capabilities'),
              note: toolboxOn
                ? t('Each run goes through {tool}', { tool: toolboxCall })
                : t('Let the Bots use every tool the server offers, not only the read ones'),
              checked: toolboxOn,
              disabled: busy,
              onChange: (next) => void run(actions.connectorSetToolbox(connector.id, next)),
            }),
            // A full-access grant can write; say so where its toolbox is switched on.
            connector.oauth === true && connector.id === 'cloudflare'
              ? h('div', { className: 'bt-connector-action-note' }, t('Full access can change your {service} account; every write asks for your approval first.', { service: connector.name }))
              : null)
          : null,
        actionsOffered
          ? h('div', { className: 'bt-connector-setting', 'data-locked': toolboxOn || undefined },
            h(ConnectorOption, {
              title: t('Allow actions'),
              note: actionsOn
                ? t('Each run asks for your approval')
                : t('Let the Bots deploy, cancel, promote and roll back; every run asks for your approval'),
              checked: actionsOn,
              disabled: busy || toolboxOn,
              describedby: actionsNoteId,
              onChange: (next) => void run(actions.connectorSetActions(connector.id, next)),
            }),
            actionsNoteId
              ? h('div', { className: 'bt-connector-action-note', id: actionsNoteId }, t('With Full capabilities on, actions go through {tool} and ask for approval one by one', { tool: toolboxCall }))
              : null)
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
      h('div', { className: 'bt-connector-form-row' },
        docsUrl ? h('a', { className: 'bt-connector-link', href: docsUrl, target: '_blank', rel: 'noopener noreferrer' }, tokenCreate(connector.id)) : null,
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
  return h('section', { className: 'bt-set-section' },
    h('div', { className: 'bt-set-card bt-connectors-card' }, list.length === 0
      ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No connectors')))
      : list.map(connector => h(ConnectorRow, { key: connector.id, connector, actions }))))
}
