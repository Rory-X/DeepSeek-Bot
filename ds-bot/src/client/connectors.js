import { createElement as h, useRef, useState } from 'react'
import { useMorph } from './motion.js'
import { MaskedInput } from './secret-card.js'
import { t } from './i18n.js'

export const GitHubMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' }))

// The Vercel mark is its plain triangle; the edge is a path of our own so no artwork is
// copied into the bundle.
export const VercelMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M10 2.8 18.6 17.6H1.4z' }))

// Everything the connector cards need per service: the mark, what it is for, and where its
// token comes from. A service without an entry still draws its row, just without a mark.
const MARKS = { github: GitHubMark, vercel: VercelMark }
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

function statusText(connector) {
  if (connector.state === 'connecting') return t('Connecting…')
  if (connector.state === 'error') return t('Could not connect: {error}', { error: connector.error ?? '' })
  if (connector.state === 'ready') return connector.account ? t('Connected as {account}', { account: connector.account }) : t('Connected')
  return ABOUT[connector.id]?.() ?? ''
}

function ConnectorRow({ connector, actions }) {
  const [form, setForm] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
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
  const Mark = MARKS[connector.id]
  const row = useRef(null)
  useMorph(row, `${form}:${error !== null}:${connector.state}`)
  return h('div', { ref: row, className: 'bt-connector', 'data-state': connector.state },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, Mark ? h(Mark) : null),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, connector.name),
        h('span', { className: 'bt-connector-status' }, statusText(connector))),
      h('span', { className: 'bt-connector-actions' },
        connector.state === 'error' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorRetry(connector.id)) }, t('Try again')) : null,
        on
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorDisconnect(connector.id)) }, t('Disconnect'))
          : form ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setForm(true) }, t('Connect')))),
    typeof connector.actions === 'boolean'
      ? h('div', { className: 'bt-connector-action-row', 'data-on': actionsOn || undefined },
        h('div', { className: 'bt-connector-action-text' },
          h('div', { className: 'bt-connector-action-title' }, t('Allow actions')),
          h('div', { className: 'bt-connector-action-note' }, actionsOn
            ? t('Each run asks for your approval')
            : t('Let the Bots deploy, cancel, promote and roll back; every run asks for your approval'))),
        h('button', {
          type: 'button', role: 'switch', className: 'bt-switch', 'aria-checked': actionsOn, 'aria-label': t('Allow actions'),
          disabled: busy, onClick: () => void run(actions.connectorSetActions(connector.id, !actionsOn)),
        }, h('span', { className: 'bt-switch-knob', 'aria-hidden': true })))
      : null,
    !on && form ? h('div', { className: 'bt-connector-form' },
      h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value: token, onChange: setToken, onEnter: connect, label: tokenLabel(connector.id), autoFocus: true })),
      h('div', { className: 'bt-connector-form-row' },
        TOKEN_URLS[connector.id] ? h('a', { className: 'bt-connector-link', href: TOKEN_URLS[connector.id], target: '_blank', rel: 'noopener noreferrer' }, tokenCreate(connector.id)) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setForm(false); setToken(''); setError(null) } }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || token.trim() === '', onClick: connect }, busy ? t('Connecting…') : t('Connect')))) : null,
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
