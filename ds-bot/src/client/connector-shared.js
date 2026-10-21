// The pieces every connector card shares: what an instance row names, how a declared setting
// is edited, and the level entries a module sends. Kept apart from the connectors page so a
// module with its own card (WeChat) draws the same controls without copying them.
import { createElement as h } from 'react'
import { MaskedInput } from './secret-card.js'
import { t } from './i18n.js'

// A module may keep several connections — Neon keeps one per project, WeChat one per channel
// — and then its view sends one row per instance, each naming the module it belongs to. A row
// without `instance` stays the single card every connector drew before.
export const instanceOf = (connector) => {
  const value = connector?.instance
  if (value === null || typeof value !== 'object') return null
  if (typeof value.base !== 'string' || value.base === '') return null
  if (typeof value.id !== 'string' || value.id === '') return null
  return {
    base: value.base,
    id: value.id,
    label: typeof value.label === 'string' ? value.label : '',
    max: Number.isInteger(value.max) && value.max > 0 ? value.max : null,
  }
}

// A row declares its settings as `settings` (the cards before the WeChat connector) or as
// `fields` (the object-shaped contract with kinds); both name the same fields.
export const declaredSettingsOf = (connector) => {
  const list = Array.isArray(connector.fields) ? connector.fields : connector.settings
  return Array.isArray(list) ? list.filter(field => field !== null && typeof field?.name === 'string' && field.name !== '') : []
}

export const levelsOfConnector = (connector) => (Array.isArray(connector.levels) ? connector.levels.filter(entry => entry !== null) : [])

// A one-way channel (Telegram, WeChat push) has a single meaningful level, so its module
// declares `card.levelChoice: false` and the card leaves the whole level block out.
export const levelChoiceVisible = (connector) => levelsOfConnector(connector).length > 0 && connector?.card?.levelChoice !== false

// How a declared setting is edited. A host that names no kind keeps the plain text field
// every card had; `secret`, `bot` and `segmented` are the shapes a channel needs, and the
// client never guesses a kind from a field name.
export const settingKindOf = (field) => (field?.kind === 'secret' || field?.kind === 'bot' || field?.kind === 'segmented' ? field.kind : 'text')
export const settingOptionsOf = (field) => (Array.isArray(field?.options)
  ? field.options.filter(option => option !== null && typeof option === 'object' && typeof option.value === 'string' && option.value !== '')
  : [])
export const settingLabelOf = (field) => (typeof field.label === 'string' && field.label !== '' ? field.label : field.name)

// One field of a settings form. `secret` never carries a value: it says whether the host has
// one saved and only draws a masked input while the reader is replacing it.
export function SettingField({ field, value, bots = [], disabled = false, onChange, onEnter, secret = null }) {
  const kind = settingKindOf(field)
  const label = settingLabelOf(field)
  if (kind === 'secret') {
    const editing = secret !== null && secret.editing === true
    const cleared = secret !== null && secret.cleared === true
    const state = cleared ? t('Will be removed') : field.saved === true ? t('Saved') : t('Not set')
    let control
    if (editing) {
      control = h('div', { className: 'bt-connector-field-control' },
        h('div', { className: 'bt-q-field bt-secret-field' },
          h(MaskedInput, { value: secret.value ?? '', onChange: secret.onChange, onEnter, label })),
        h('button', { type: 'button', className: 'bt-connector-link bt-connector-link-btn', disabled, onClick: secret.onCancel }, t('Cancel')))
    } else if (cleared) {
      control = h('div', { className: 'bt-connector-field-control' },
        h('span', { className: 'bt-connector-field-state' }, state),
        h('button', { type: 'button', className: 'bt-connector-link bt-connector-link-btn', disabled, onClick: secret.onUndo }, t('Undo')))
    } else {
      control = h('div', { className: 'bt-connector-field-control' },
        h('span', { className: 'bt-connector-field-state' }, state),
        h('button', {
          type: 'button', className: 'bt-connector-link bt-connector-link-btn', disabled,
          onClick: secret === null ? undefined : secret.onReplace,
        }, field.saved === true ? t('Replace') : t('Set secret')),
        field.saved === true
          ? h('button', { type: 'button', className: 'bt-connector-link bt-connector-link-btn', disabled, onClick: secret.onClear }, t('Remove'))
          : null)
    }
    return h('div', { className: 'bt-connector-field', 'data-field': field.name, 'data-kind': 'secret', 'data-secret-state': cleared ? 'cleared' : field.saved === true ? 'saved' : 'unset' },
      h('span', { className: 'bt-connector-field-name' }, label),
      control)
  }
  if (kind === 'bot') {
    return h('label', { className: 'bt-connector-field', 'data-field': field.name, 'data-kind': 'bot' },
      h('span', { className: 'bt-connector-field-name' }, label),
      h('select', {
        className: 'bt-select', value: typeof value === 'string' ? value : '', disabled, 'aria-label': label,
        onChange: (event) => onChange(event.target.value),
      },
      h('option', { value: '' }, t('Choose a Bot')),
      bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))))
  }
  if (kind === 'segmented') {
    const options = settingOptionsOf(field)
    // One option is not a choice: a lone button reads like a broken control. Show the value
    // as a plain line; the switch appears once there is something to switch to.
    if (options.length < 2) {
      const only = options[0]
      const shown = only === undefined
        ? (typeof value === 'string' ? value : '')
        : (typeof only.label === 'string' && only.label !== '' ? only.label : only.value)
      return h('div', { className: 'bt-connector-field', 'data-field': field.name, 'data-kind': 'segmented' },
        h('span', { className: 'bt-connector-field-name' }, label),
        h('span', { className: 'bt-connector-field-value' }, shown))
    }
    return h('div', { className: 'bt-connector-field', 'data-field': field.name, 'data-kind': 'segmented' },
      h('span', { className: 'bt-connector-field-name' }, label),
      h('div', { className: 'bt-connector-levels', role: 'radiogroup', 'aria-label': label },
        options.map(option => h('button', {
          key: option.value, type: 'button', role: 'radio', 'aria-checked': value === option.value,
          className: 'bt-connector-level', 'data-current': value === option.value || undefined, disabled,
          onClick: () => { if (!disabled && value !== option.value) onChange(option.value) },
        }, h('span', { className: 'bt-connector-level-title' }, typeof option.label === 'string' && option.label !== '' ? option.label : option.value)))))
  }
  return h('label', { className: 'bt-connector-field', 'data-field': field.name, 'data-kind': 'text' },
    h('span', { className: 'bt-connector-field-name' }, label),
    h('div', { className: 'bt-q-field' }, h('input', {
      className: 'bt-connector-input', value: typeof value === 'string' ? value : '', placeholder: field.placeholder ?? label, 'aria-label': label,
      autoComplete: 'off', spellCheck: false, disabled,
      onChange: (event) => onChange(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter') onEnter?.() },
    })))
}
