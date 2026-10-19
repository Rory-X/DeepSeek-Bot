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

// Everything the connector cards need per service: the mark, what it is for, and where its
// token comes from. A service without an entry still draws its row, just without a mark.
const MARKS = { github: GitHubMark, vercel: VercelMark, cloudflare: CloudflareMark, notion: NotionMark, slack: SlackMark }
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
// A service whose authorization page offers a read-only set and a full-access grant: the
// card says what the two mean before the browser leaves for it, so the reader chooses.
const SCOPE_CHOICES = { cloudflare: true }
const TOKEN_CREATE = {
  github: () => t('Create a token on GitHub'),
  vercel: () => t('Create a token on Vercel'),
}
const tokenLabel = id => (TOKEN_LABELS[id] ?? (() => t('Token')))()
const tokenCreate = id => (TOKEN_CREATE[id] ?? (() => t('Create a token')))()

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
  return ABOUT[connector.id]?.() ?? (connector.oauth === true ? t('Not connected') : '')
}

function ConnectorRow({ connector, actions }) {
  const [form, setForm] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // OAuth connectors: the browser tab that finishes the sign-in, and the app fields a
  // service without dynamic registration asks for first.
  const oauth = connector.oauth === true
  const manual = oauth && connector.manualClient === true
  const scopeChoice = oauth && connector.state === 'off' && SCOPE_CHOICES[connector.id] === true
  const [scopeAck, setScopeAck] = useState(false)
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
  const connect = () => {
    if (busy || token.trim() === '') return
    void run(actions.connectorConnect(connector.id, token), () => { setToken(''); setForm(false) })
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
  const Mark = MARKS[connector.id]
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
                type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || (scopeChoice && !scopeAck),
                onClick: (event) => { event.stopPropagation(); void startAuthorization() },
              }, connector.state === 'error' ? t('Connect again') : t('Connect')))
              : form ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: (event) => { event.stopPropagation(); setForm(true) } }, t('Connect')))),
    scopeChoice
      ? h('div', { className: 'bt-connector-scope' },
        h('div', { className: 'bt-connector-scope-title' }, t('Choose the access level on the authorization page')),
        h('div', { className: 'bt-connector-scope-body' }, t('Requested scopes is read-only, and it is all this connector asks for. Full access lets Bots change your {service} account; every write still asks for your approval first.', { service: connector.name })),
        h('label', { className: 'bt-connector-consent' },
          h('input', {
            type: 'checkbox', className: 'bt-connector-check', checked: scopeAck,
            onChange: (event) => setScopeAck(event.target.checked),
          }),
          h('span', null, t("I'll choose the access level on the authorization page"))))
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
      h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value: token, onChange: setToken, onEnter: connect, label: tokenLabel(connector.id), autoFocus: true })),
      h('div', { className: 'bt-connector-form-row' },
        TOKEN_URLS[connector.id] ? h('a', { className: 'bt-connector-link', href: TOKEN_URLS[connector.id], target: '_blank', rel: 'noopener noreferrer' }, tokenCreate(connector.id)) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setForm(false); setToken(''); setError(null) } }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || token.trim() === '', onClick: connect }, busy ? t('Connecting…') : t('Connect')))) : null,
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
