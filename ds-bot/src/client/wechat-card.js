// The WeChat connector card: one card for the module, one expandable row per channel. A
// channel is a WeChat endpoint bound to one Bot and one transport; Webhook posts notices to a
// receiver, ClawBot logs in through the module's own command. The host sends the fields and
// the live bits (inbound address, login step) as data; this card only draws them.
import { createElement as h, useState } from 'react'
import { language, t } from './i18n.js'
import { ChevronRightIcon } from './icons.js'
import { SettingField, declaredSettingsOf, instanceOf, levelChoiceVisible, levelsOfConnector, settingKindOf, settingOptionsOf } from './connector-shared.js'

// Two chat bubbles of our own drawing, one weight throughout: a larger one at the upper
// left and a smaller one at the lower right, each with two eyes and a short tail. No brand
// artwork is copied into the bundle.
export const WeChatMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('ellipse', { cx: 7.2, cy: 6.9, rx: 4.9, ry: 4 }),
  h('path', { d: 'M5.36 10.61 L3.31 11.99 L3.92 9.87' }),
  h('circle', { cx: 5.6, cy: 6.4, r: 0.55, fill: 'currentColor', stroke: 'none' }),
  h('circle', { cx: 8.3, cy: 6.4, r: 0.55, fill: 'currentColor', stroke: 'none' }),
  h('ellipse', { cx: 13, cy: 13, rx: 4.2, ry: 3.5 }),
  h('path', { d: 'M15.81 15.6 L16.23 17.3 L14.57 16.25' }),
  h('circle', { cx: 11.7, cy: 12.5, r: 0.5, fill: 'currentColor', stroke: 'none' }),
  h('circle', { cx: 14, cy: 12.5, r: 0.5, fill: 'currentColor', stroke: 'none' }))

const aboutOf = (row) => {
  const about = row?.card?.about
  if (typeof about !== 'string' || about === '') return null
  const chinese = row.card?.zh?.about
  return language().startsWith('zh') && typeof chinese === 'string' && chinese !== '' ? chinese : about
}
const docsUrlOf = (row) => (typeof row?.card?.docsUrl === 'string' && row.card.docsUrl !== '' ? row.card.docsUrl : null)

const TRANSPORTS = { webhook: () => t('Webhook'), clawbot: () => t('ClawBot') }
const transportOf = connector => (connector?.transport === 'clawbot' ? 'clawbot' : 'webhook')
const transportLabel = id => (TRANSPORTS[id] ?? TRANSPORTS.webhook)()
// The field list carries no transport scope yet: the webhook fields only mean something for
// the Webhook transport, so ClawBot hides them while keeping their saved values in the view.
const WEBHOOK_FIELDS = new Set(['webhookUrl', 'webhookFormat', 'webhookSecret'])

const levelEntry = (entry) => {
  if (typeof entry === 'string') return { id: entry, title: entry, description: null, write: entry === 'write' }
  const id = typeof entry?.id === 'string' ? entry.id : String(entry?.id ?? '')
  return {
    id,
    title: typeof entry?.title === 'string' && entry.title !== '' ? entry.title : id,
    description: typeof entry?.description === 'string' && entry.description !== '' ? entry.description : null,
    write: entry?.write === true || entry?.danger === true || id === 'write',
  }
}

const channelStatus = (row) => {
  if (row.state === 'connecting') return t('Connecting…')
  if (row.state === 'error') return row.error ?? t('Could not connect')
  if (row.state === 'ready') return row.account ? t('Connected as {account}', { account: row.account }) : t('Connected')
  return t('Not connected')
}

const loginText = (login) => {
  if (login.state === 'qr') return t('Scan the QR code with WeChat to link this channel.')
  if (login.state === 'logged-in') return login.account ? t('Logged in as {account}', { account: login.account }) : t('Credentials saved')
  if (login.state === 'expired') return t('This QR code expired. Refresh it to try again.')
  return t('Not logged in yet.')
}

// One channel: its own settings, level and connection. The module card above it holds the
// add button and the summary; the row holds every action for this channel.
export function WeChatChannel({ row, actions, readOnly = null, bots = [], expanded = false, onToggle, lastOne = false }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [settingDraft, setSettingDraft] = useState(null)
  const [secretDraft, setSecretDraft] = useState({})
  const [secretClears, setSecretClears] = useState([])
  const [removeAsk, setRemoveAsk] = useState(false)
  const [confirmTransport, setConfirmTransport] = useState(false)
  const [copied, setCopied] = useState(null)
  const fields = declaredSettingsOf(row)
  const savedTransport = transportOf(row)
  const settingValue = (field) => {
    if (settingDraft !== null && Object.hasOwn(settingDraft, field.name)) return settingDraft[field.name]
    return typeof field.value === 'string' ? field.value : ''
  }
  const transportField = fields.find(field => field.name === 'transport')
  const shownTransport = transportField !== undefined ? (settingValue(transportField) === 'clawbot' ? 'clawbot' : 'webhook') : savedTransport
  const transportChanged = shownTransport !== savedTransport
  const visibleFields = shownTransport === 'clawbot' ? fields.filter(field => !WEBHOOK_FIELDS.has(field.name)) : fields
  const settingsChanged = secretClears.length > 0 || fields.some((field) => {
    if (settingKindOf(field) === 'secret') return Object.hasOwn(secretDraft, field.name) && String(secretDraft[field.name] ?? '').trim() !== ''
    return settingValue(field) !== (typeof field.value === 'string' ? field.value : '')
  })
  const levels = levelsOfConnector(row).map(levelEntry)
  const currentLevel = typeof row.level === 'string' ? row.level : (levels[0]?.id ?? null)
  const writesLocked = typeof readOnly === 'string' && readOnly !== ''
  const levelNotes = row.levelNotes !== null && typeof row.levelNotes === 'object' ? row.levelNotes : {}
  const storedValue = field => (typeof field.value === 'string' ? field.value : '').trim()
  const missingRequired = fields.some(field => field.required === true && settingKindOf(field) !== 'secret' && storedValue(field) === '')
  const fallbackNote = missingRequired ? t('Fill in the settings before switching to this level.') : null
  const levelBlocked = (id) => {
    const note = typeof levelNotes[id] === 'string' && levelNotes[id] !== '' ? levelNotes[id] : null
    return note ?? fallbackNote
  }
  const connectNote = levelBlocked(currentLevel)
  const run = (task, after) => {
    setBusy(true)
    setError(null)
    return Promise.resolve().then(task).then(() => { after?.() }, failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  const saveValues = () => {
    const values = {}
    const clears = []
    for (const field of fields) {
      if (settingKindOf(field) === 'secret') {
        if (secretClears.includes(field.name)) clears.push(field.name)
        else if (Object.hasOwn(secretDraft, field.name) && String(secretDraft[field.name] ?? '').trim() !== '') values[field.name] = secretDraft[field.name].trim()
        continue
      }
      values[field.name] = settingValue(field).trim()
    }
    return { values, clears }
  }
  const resetDrafts = () => {
    setSettingDraft(null)
    setSecretDraft({})
    setSecretClears([])
  }
  const persist = async () => {
    const { values, clears } = saveValues()
    await actions.connectorSetSettings(row.id, values, { clearSecrets: clears })
    resetDrafts()
  }
  const save = () => {
    if (busy || !settingsChanged) return
    if (transportChanged && (row.state === 'ready' || row.state === 'error')) {
      setConfirmTransport(true)
      return
    }
    void run(persist)
  }
  // The host refuses a transport change on a live channel; confirm, stop it, then save, and
  // let the reader connect again.
  const switchTransport = () => {
    setConfirmTransport(false)
    void run(async () => {
      if (row.state === 'ready' || row.state === 'error' || row.state === 'connecting') await actions.connectorDisconnect(row.id)
      await persist()
    })
  }
  const connect = () => { if (busy || connectNote !== null) return; void run(() => actions.connectorConnect(row.id)) }
  const disconnect = () => { if (busy) return; void run(() => actions.connectorDisconnect(row.id)) }
  const test = () => { if (busy) return; void run(() => actions.connectorTest(row.id)) }
  const remove = () => { if (busy || lastOne) return; void run(() => actions.connectorDeleteInstance(row.id), () => setRemoveAsk(false)) }
  const command = action => { if (busy) return; void run(() => actions.connectorCommand(row.id, action)) }
  const copy = async (key, text) => {
    if (typeof text !== 'string' || text === '') return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied(current => (current === key ? null : current)), 1500)
    } catch {
      setError(t('Copy failed — select the text instead.'))
    }
  }
  const secretOf = (field) => {
    const kind = settingKindOf(field)
    if (kind !== 'secret') return null
    return {
      editing: Object.hasOwn(secretDraft, field.name),
      cleared: secretClears.includes(field.name),
      value: secretDraft[field.name] ?? '',
      onReplace: () => {
        setSecretClears(previous => previous.filter(name => name !== field.name))
        setSecretDraft(previous => ({ ...previous, [field.name]: '' }))
      },
      onCancel: () => setSecretDraft((previous) => { const next = { ...previous }; delete next[field.name]; return next }),
      onChange: next => setSecretDraft(previous => ({ ...previous, [field.name]: next })),
      onClear: () => {
        setSecretDraft((previous) => { const next = { ...previous }; delete next[field.name]; return next })
        setSecretClears(previous => (previous.includes(field.name) ? previous : [...previous, field.name]))
      },
      onUndo: () => setSecretClears(previous => previous.filter(name => name !== field.name)),
    }
  }
  // A segmented field the host has not saved yet still shows its first option as current;
  // the transport uses the row's live transport so the visible switch never starts blank.
  const valueFor = (field) => {
    const kind = settingKindOf(field)
    if (kind !== 'segmented') return settingValue(field)
    const current = settingValue(field)
    if (current !== '') return current
    if (field.name === 'transport') return shownTransport
    return settingOptionsOf(field)[0]?.value ?? ''
  }
  const fieldNode = (field) => {
    const kind = settingKindOf(field)
    return h(SettingField, {
      key: field.name,
      field,
      value: kind === 'secret' ? '' : valueFor(field),
      bots,
      disabled: busy,
      onChange: (next) => {
        if (kind === 'secret') setSecretDraft(previous => ({ ...previous, [field.name]: next }))
        else setSettingDraft(previous => ({ ...previous, [field.name]: next }))
      },
      onEnter: save,
      secret: secretOf(field),
    })
  }
  const levelBlock = levelChoiceVisible(row)
    ? h('div', { className: 'bt-connector-setting' },
      h('div', { className: 'bt-connector-action-title' }, t('Access level')),
      h('div', { className: 'bt-connector-levels', role: 'radiogroup', 'aria-label': t('Access level') },
        levels.map((item) => {
          const current = item.id === currentLevel
          const blocked = current ? null : levelBlocked(item.id)
          // The current level's reason is drawn once, above the level rows; an identical note
          // under another level would read like a second error.
          const blockedShown = blocked !== null && blocked !== connectNote ? blocked : null
          return h('div', { key: item.id, className: 'bt-connector-level-wrap' },
            h('button', {
              type: 'button', role: 'radio', 'aria-checked': current,
              className: 'bt-connector-level', 'data-current': current || undefined,
              disabled: busy || (writesLocked && item.write === true) || blocked !== null,
              onClick: () => {
                if (current || blocked !== null) return
                void run(() => actions.connectorSetLevel(row.id, item.id))
              },
            },
            h('span', { className: 'bt-connector-level-title' }, item.title),
            item.description !== null ? h('span', { className: 'bt-connector-level-note' }, item.description) : null),
            blockedShown !== null ? h('span', { className: 'bt-connector-level-blocked' }, blockedShown) : null)
        })),
      h('div', { className: 'bt-connector-hint' }, t('Changing the access level changes what this channel can do.')))
    : null
  const inbound = transportOf(row) === 'webhook' && row.inbound !== null && typeof row.inbound === 'object' ? row.inbound : null
  const inboundBlock = inbound !== null
    ? h('div', { className: 'bt-connector-setting bt-wechat-inbound', 'data-inbound': '' },
      h('div', { className: 'bt-connector-action-title' }, t('Inbound callback')),
      h('div', { className: 'bt-wechat-copy-row' },
        h('span', { className: 'bt-wechat-copy-key' }, 'URL'),
        h('code', null, typeof inbound.url === 'string' ? inbound.url : ''),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void copy('url', inbound.url) }, copied === 'url' ? t('Copied') : t('Copy'))),
      h('div', { className: 'bt-wechat-copy-row' },
        h('span', { className: 'bt-wechat-copy-key' }, 'Token'),
        h('code', null, typeof inbound.token === 'string' ? inbound.token : ''),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void copy('token', inbound.token) }, copied === 'token' ? t('Copied') : t('Copy'))),
      h('div', { className: 'bt-connector-hint' }, t('Copy these into the WeChat push settings.')))
    : null
  const login = transportOf(row) === 'clawbot' && row.login !== null && typeof row.login === 'object' && typeof row.login.state === 'string' ? row.login : null
  const qr = login !== null && login.state === 'qr' && typeof login.qr === 'string' && login.qr.startsWith('data:image/png;base64,') ? login.qr : null
  const loginActions = login === null
    ? null
    : login.state === 'qr'
      ? [h('button', { key: 'refresh', type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => command('login-refresh') }, t('Refresh QR')),
        h('button', { key: 'cancel', type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => command('login-cancel') }, t('Cancel'))]
      : login.state === 'logged-in' || login.state === 'expired'
        ? [h('button', { key: 'refresh', type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => command('login-refresh') }, t('Re-scan'))]
        : [h('button', { key: 'start', type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => command('login-start') }, t('Log in'))]
  const loginBlock = login !== null
    ? h('div', { className: 'bt-connector-setting bt-wechat-login', 'data-login-state': login.state },
      qr !== null ? h('img', { className: 'bt-wechat-qr', src: qr, alt: t('QR code') }) : null,
      h('div', { className: 'bt-connector-hint' }, loginText(login)),
      loginActions !== null ? h('div', { className: 'bt-connector-form-row' }, loginActions) : null)
    : null
  const headActions = []
  if (transportOf(row) === 'webhook' && row.canTest === true && row.state === 'ready') {
    headActions.push(h('button', { key: 'test', type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: (event) => { event.stopPropagation(); test() } }, busy ? t('Testing…') : t('Test message')))
  }
  if (row.state === 'error') {
    headActions.push(h('button', { key: 'connect', type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: (event) => { event.stopPropagation(); connect() } }, t('Connect again')))
  } else if (row.state === 'connecting') {
    headActions.push(h('button', { key: 'waiting', type: 'button', className: 'bt-soft bt-soft-sm', disabled: true }, t('Waiting for the browser…')))
  } else if (row.state === 'ready') {
    headActions.push(h('button', { key: 'disconnect', type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: (event) => { event.stopPropagation(); disconnect() } }, t('Disconnect')))
  } else {
    headActions.push(h('button', {
      key: 'connect', type: 'button', className: 'bt-soft bt-soft-sm',
      disabled: busy || connectNote !== null, title: connectNote ?? undefined,
      onClick: (event) => { event.stopPropagation(); connect() },
    }, t('Connect')))
  }
  const removeBlock = h('div', { className: 'bt-connector-setting bt-connector-remove' },
    removeAsk
      ? h('div', { className: 'bt-connector-remove-ask' },
        h('div', { className: 'bt-connector-action-title' }, t('Remove this channel')),
        h('div', { className: 'bt-connector-hint' }, t('Removing this channel disconnects it and deletes its credentials (webhook secret / iLink login). The WeChat side is not changed.')),
        h('div', { className: 'bt-connector-form-row' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setRemoveAsk(false) }, t('Cancel')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-danger', disabled: busy, onClick: remove }, busy ? t('Removing…') : t('Remove'))))
      : h('button', {
        type: 'button', className: 'bt-connector-link bt-connector-link-btn bt-danger',
        disabled: busy || lastOne,
        onClick: () => setRemoveAsk(true),
      }, t('Remove this channel')),
    lastOne ? h('div', { className: 'bt-connector-hint' }, t('Keep at least one channel.')) : null)
  return h('div', {
    className: 'bt-connector-project', 'data-wechat-channel': row.id, 'data-state': row.state,
    'data-transport': transportOf(row), 'data-open': expanded || undefined,
  },
    h('div', { className: 'bt-connector-project-head' },
      h('button', { type: 'button', className: 'bt-connector-project-main', 'aria-expanded': expanded, onClick: onToggle },
        h('span', { className: 'bt-connector-project-text' },
          h('span', { className: 'bt-connector-project-name', title: row.name },
            row.name,
            h('span', { className: 'bt-wechat-transport' }, transportLabel(transportOf(row)))),
          h('span', { className: 'bt-connector-project-status' }, channelStatus(row))),
        h('span', { className: 'bt-connector-chevron', 'aria-hidden': true }, h(ChevronRightIcon))),
      h('span', { className: 'bt-connector-actions' }, headActions)),
    // A failed Test keeps the channel ready but leaves the host's sentence on the row.
    row.state !== 'error' && typeof row.error === 'string' && row.error !== ''
      ? h('div', { className: 'bt-wechat-error', role: 'alert' }, row.error)
      : null,
    expanded
      ? h('div', { className: 'bt-connector-project-body', 'data-wechat-channel-body': '' },
        h('div', { className: 'bt-connector-instance-grid' },
          visibleFields.map(fieldNode),
          levelBlock,
          h('div', { className: 'bt-connector-instance-save' },
            h('div', { className: 'bt-connector-form-row' },
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !settingsChanged, onClick: save }, t('Save settings'))),
            h('div', { className: 'bt-connector-hint' }, t('The name changes only this channel; the binding and its credentials stay the same.')))),
        connectNote !== null && row.state !== 'ready' ? h('div', { className: 'bt-connector-hint' }, connectNote) : null,
        loginBlock,
        inboundBlock,
        confirmTransport
          ? h('div', { className: 'bt-connector-remove-ask', 'data-transport-confirm': '' },
            h('div', { className: 'bt-connector-action-title' }, t('Switch transport')),
            h('div', { className: 'bt-connector-hint' }, t('Switching the transport disconnects this channel. Continue?')),
            h('div', { className: 'bt-connector-form-row' },
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setConfirmTransport(false) }, t('Cancel')),
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: switchTransport }, t('Continue'))))
          : null,
        removeBlock,
        error !== null ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null)
      : null)
}

// The module card: one WeChat card for every channel, the summary in its head, and the add
// button at the bottom of the list. A channel is added off and unconfigured; it connects
// only when its own row asks to.
export function WeChatCard({ rows, actions, readOnly = null, bots = [] }) {
  const first = rows[0] ?? null
  const about = first === null ? null : aboutOf(first)
  const docsUrl = first === null ? null : docsUrlOf(first)
  const instance = first === null ? null : instanceOf(first)
  const max = instance === null ? null : instance.max
  const ready = rows.filter(row => row.state === 'ready').length
  const [expanded, setExpanded] = useState(false)
  const [openChannel, setOpenChannel] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const atCap = typeof max === 'number' && rows.length >= max
  const status = rows.length === 0
    ? t('Not connected')
    : rows.length === 1
      ? t('1 channel · {ready} ready', { ready })
      : t('{count} channels · {ready} ready', { count: rows.length, ready })
  const add = async () => {
    if (busy || atCap) return
    setBusy(true)
    setError(null)
    const before = new Set(rows.map(row => row.id))
    try {
      const view = await actions.connectorCreateInstance('wechat')
      const created = Array.isArray(view) ? view.find(row => instanceOf(row)?.base === 'wechat' && !before.has(row.id)) : undefined
      if (created !== undefined) {
        setExpanded(true)
        setOpenChannel(created.id)
      }
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }
  return h('div', {
    className: 'bt-connector', 'data-wechat-card': '', 'data-group': 'wechat',
    'data-open': expanded || undefined,
  },
    h('div', { className: 'bt-connector-head' },
      h('button', { type: 'button', className: 'bt-connector-main', 'aria-expanded': expanded, onClick: () => setExpanded(value => !value) },
        h('span', { className: 'bt-connector-mark' }, h(WeChatMark)),
        h('span', { className: 'bt-connector-text' },
          h('span', { className: 'bt-connector-name' }, t('WeChat')),
          h('span', { className: 'bt-connector-status' }, status),
          about !== null ? h('span', { className: 'bt-connector-about' }, about) : null),
        h('span', { className: 'bt-connector-chevron', 'aria-hidden': true }, h(ChevronRightIcon)))),
    expanded
      ? h('div', { className: 'bt-connector-panel', role: 'group', 'aria-label': t('Connector settings') },
        h('div', { className: 'bt-connector-panel-inner' },
          docsUrl !== null
            ? h('div', { className: 'bt-wechat-docs' },
              h('a', { className: 'bt-connector-link', href: docsUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Documentation')))
            : null,
          rows.length === 0
            ? h('div', { className: 'bt-connector-hint' }, t('No WeChat channels yet. Add one to send notices.'))
            : h('div', { className: 'bt-connector-project-list' }, rows.map(row => h(WeChatChannel, {
              key: row.id,
              row,
              actions,
              readOnly,
              bots,
              lastOne: rows.length <= 1,
              expanded: openChannel === row.id,
              onToggle: () => setOpenChannel(current => (current === row.id ? null : row.id)),
            }))),
          h('button', {
            type: 'button', className: 'bt-connector-add-btn', disabled: busy || atCap,
            onClick: () => void add(),
          },
          h('span', { className: 'bt-connector-add-plus', 'aria-hidden': true },
            h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
              h('path', { d: 'M10 4.5v11M4.5 10h11' }))),
          h('span', null, busy ? t('Adding…') : t('Add a WeChat channel'))),
          atCap ? h('div', { className: 'bt-connector-hint' }, t('You can add up to {max} channels.', { max })) : null,
          error !== null ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null))
      : null)
}
