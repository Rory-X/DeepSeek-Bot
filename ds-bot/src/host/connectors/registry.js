// Connector auto-registration: every module under this directory, except this file, is one
// connector, loaded when the plugin loads. A connector line adds its own file and nothing
// else, so six lines never edit one registry and never conflict. The shape is checked once
// here: a module that cannot load, a missing or bad id, a duplicate id, or a connector
// without a display name or a known mode fails loudly at plugin load, naming the file.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { credentialFields } from '../connector-setup.js'
import { SECRET_NAME } from '../secrets.js'

export const CONNECTOR_DIR = import.meta.dirname
export const CONNECTOR_ID = /^[a-z][a-z0-9-]{0,39}$/
export const CONNECTOR_MODES = ['mcp-client', 'read-tools', 'oauth-mcp', 'notify', 'rest-tools', 'imap', 'imap-read', 'custom']
// A connector module may be mounted more than once, one instance per id
// (`<id>`, `<id>-2`, ...). The first instance keeps the module id, so a team that used the
// connector before instances existed keeps its state and grant untouched. Only OAuth
// connectors can be instances: the grant is addressed by instance id, so each one holds
// its own authorization and nothing is shared between them.
export const INSTANCE_LIMIT = 64
// An access level is what a connector may do once it is connected: read only, or read and
// write. Every write tool is gated by it, so a connector that does not declare a level is
// read only.
export const CONNECTOR_LEVELS = ['read', 'write']
// This file and test-only helpers stay out of the registry.
const NOT_A_CONNECTOR = /^(registry\.js|_.*|.*\.test\.js)$/
const LEVEL_HOOKS = ['authorize', 'toolsOf', 'readiness', 'normalizeSettings', 'actionApproval', 'view', 'status', 'test', 'command']
const CAPABILITY_RISKS = ['read', 'write', 'destructive']
const SETTING_KINDS = ['text', 'secret', 'bot', 'segmented']
const COMMAND_ID = /^[a-z][a-z0-9-]{0,31}$/

// Display-only additions: what the connector can do, and one line about the grant it asks
// for. Missing pieces hide that block on the card; nothing here enables a tool.
const checkDisplay = (file, id, connector) => {
  if (connector.capabilities !== undefined) {
    if (!Array.isArray(connector.capabilities)) throw new Error(`Connector module ${file} ("${id}") capabilities must be a list`)
    for (const entry of connector.capabilities) {
      if (entry === null || typeof entry !== 'object' || typeof entry.key !== 'string' || entry.key === ''
        || typeof entry.title !== 'string' || entry.title === '' || !CAPABILITY_RISKS.includes(entry.risk)) {
        throw new Error(`Connector module ${file} ("${id}") capabilities need a key, a title and a risk of ${CAPABILITY_RISKS.join(', ')}`)
      }
      if (entry.preview !== undefined && (entry.preview === null || typeof entry.preview !== 'object')) {
        throw new Error(`Connector module ${file} ("${id}") capability "${entry.key}" preview must be an object`)
      }
    }
  }
  if (connector.permissions !== undefined) {
    if (connector.permissions === null || typeof connector.permissions !== 'object'
      || typeof connector.permissions.summary !== 'string' || connector.permissions.summary === '') {
      throw new Error(`Connector module ${file} ("${id}") permissions need a summary`)
    }
    if (connector.permissions.scopes !== undefined
      && (!Array.isArray(connector.permissions.scopes) || connector.permissions.scopes.some(scope => typeof scope !== 'string'))) {
      throw new Error(`Connector module ${file} ("${id}") permissions scopes must be strings`)
    }
  }
}

// The level-aware part of the shape: the levels, the compatibility default, and the hooks
// that take a level. A wrong default or a non-function hook is a configuration error.
const checkLevels = (file, id, connector) => {
  const levels = connector.levels === undefined ? ['read'] : connector.levels
  if (!Array.isArray(levels) || levels.length === 0 || new Set(levels).size !== levels.length
    || levels.some(level => !CONNECTOR_LEVELS.includes(level))) {
    throw new Error(`Connector module ${file} ("${id}") levels must be a non-empty list of ${CONNECTOR_LEVELS.join(', ')}`)
  }
  if (connector.defaultLevel !== undefined && !levels.includes(connector.defaultLevel)) {
    throw new Error(`Connector module ${file} ("${id}") needs a defaultLevel that is one of its levels`)
  }
  for (const hook of LEVEL_HOOKS) {
    if (connector[hook] !== undefined && typeof connector[hook] !== 'function') {
      throw new Error(`Connector module ${file} ("${id}") needs ${hook} to be a function`)
    }
  }
  if (connector.settings !== undefined) {
    if (!Array.isArray(connector.settings) || connector.settings.some(field => field === null || typeof field !== 'object' || typeof field.name !== 'string' || field.name === '')) {
      throw new Error(`Connector module ${file} ("${id}") settings must list fields with a name`)
    }
    for (const field of connector.settings) {
      const kind = field.kind === undefined ? 'text' : field.kind
      if (!SETTING_KINDS.includes(kind)) {
        throw new Error(`Connector module ${file} ("${id}") settings field "${field.name}" has an unknown kind; use ${SETTING_KINDS.join(', ')}`)
      }
      if (field.required !== undefined && typeof field.required !== 'boolean') {
        throw new Error(`Connector module ${file} ("${id}") settings field "${field.name}" needs required to be true or false`)
      }
      if (field.options !== undefined
        && (!Array.isArray(field.options)
          || field.options.some(option => option === null || typeof option !== 'object' || typeof option.value !== 'string' || option.value === ''))) {
        throw new Error(`Connector module ${file} ("${id}") settings field "${field.name}" options must list values`)
      }
      if (kind === 'secret') {
        const credential = field.secret === undefined ? field.name : field.secret
        if (typeof credential !== 'string' || !SECRET_NAME.test(credential)) {
          throw new Error(`Connector module ${file} ("${id}") settings field "${field.name}" needs a credential name for its secret`)
        }
      }
    }
  }
  if (connector.commands !== undefined && typeof connector.command !== 'function') {
    throw new Error(`Connector module ${file} ("${id}") needs a command function for its commands`)
  }
  if (connector.commands !== undefined) {
    if (connector.commands === null || typeof connector.commands !== 'object' || Array.isArray(connector.commands)) {
      throw new Error(`Connector module ${file} ("${id}") commands must map an action to its transport and arguments`)
    }
    for (const [action, spec] of Object.entries(connector.commands)) {
      if (!COMMAND_ID.test(action)) {
        throw new Error(`Connector module ${file} ("${id}") command "${action}" needs lowercase letters, digits and hyphens`)
      }
      if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new Error(`Connector module ${file} ("${id}") command "${action}" must describe itself`)
      }
      if (spec.transport !== undefined && typeof spec.transport !== 'string') {
        throw new Error(`Connector module ${file} ("${id}") command "${action}" transport must be a string`)
      }
      if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string' || arg === ''))) {
        throw new Error(`Connector module ${file} ("${id}") command "${action}" args must list argument names`)
      }
    }
  }
  if (connector.blockedTools !== undefined
    && (!Array.isArray(connector.blockedTools)
      || connector.blockedTools.some(item => !(typeof item === 'string' && item !== '') && !(item instanceof RegExp)))) {
    throw new Error(`Connector module ${file} ("${id}") blockedTools must list tool names`)
  }
}


// The multi-instance declaration, normalized. The prefix is the module id itself: the first
// instance must keep that id, or an existing team's state and grant would move. An id has
// to leave room for a `-2` suffix (the shortest the framework ever adds).
const checkInstances = (file, id, connector) => {
  const instances = connector.instances
  if (instances === undefined) return undefined
  if (instances === null || typeof instances !== 'object' || Array.isArray(instances)) {
    throw new Error(`Connector module ${file} ("${id}") instances must be an object`)
  }
  const prefix = instances.prefix ?? id
  if (typeof prefix !== 'string' || !CONNECTOR_ID.test(prefix)) {
    throw new Error(`Connector module ${file} ("${id}") instances needs a prefix matching ${CONNECTOR_ID}`)
  }
  if (prefix !== id) {
    throw new Error(`Connector module ${file} ("${id}") instances prefix must be the module id "${id}"`)
  }
  if (id.length + 2 > 40) {
    throw new Error(`Connector module ${file} ("${id}") instances needs an id short enough for a "-2" instance`)
  }
  // Every instance needs credentials of its own: an OAuth grant is addressed by instance
  // id, and a custom module declares the credentials it stores per instance (the framework
  // keeps them under a per-instance secret name). A mode without that would make two
  // instances share one authorization or one secret, so it is refused here.
  const perInstanceCredentials = connector.mode === 'oauth-mcp'
    || (connector.mode === 'custom' && credentialFields(connector).length > 0)
  if (!perInstanceCredentials) {
    throw new Error(`Connector module ${file} ("${id}") instances needs per-instance credentials: an OAuth grant, or declared credentials in custom mode`)
  }
  const min = instances.min ?? 1
  const max = instances.max ?? 8
  if (!Number.isInteger(min) || min < 1) {
    throw new Error(`Connector module ${file} ("${id}") instances needs a min of at least 1`)
  }
  if (!Number.isInteger(max) || max < min || max > INSTANCE_LIMIT) {
    throw new Error(`Connector module ${file} ("${id}") instances needs a max from ${min} to ${INSTANCE_LIMIT}`)
  }
  return { prefix, min, max }
}

// A module id that another module reserves for one of its instances would make that
// instance unreachable: creating it would find the id taken, and the file's own row would
// pretend to be an instance. Refuse the pair at load, naming both files' ids.
const checkInstanceIds = (loaded) => {
  const bases = Object.keys(loaded).filter(id => loaded[id].instances !== undefined)
  for (const base of bases) {
    const reserved = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[1-9][0-9]*$`)
    for (const other of Object.keys(loaded)) {
      if (other !== base && reserved.test(other)) {
        throw new Error(`Connector module id "${other}" is reserved for instances of "${base}"`)
      }
    }
  }
}

const moduleFiles = dir => readdirSync(dir, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.js') && !NOT_A_CONNECTOR.test(entry.name))
  .map(entry => entry.name)
  .sort()

// Loads one directory of connector modules. `id` is the key the team file, the tools and the
// view use; the rest of the object is the definition `connectors.js` already understands
// (displayName, mode, readTools/restTools/oauth/toolbox, tokenSecret, and so on).
export async function loadConnectorModules(dir = CONNECTOR_DIR) {
  const loaded = {}
  for (const file of moduleFiles(dir)) {
    let module
    try {
      module = await import(pathToFileURL(join(dir, file)).href)
    } catch (error) {
      throw new Error(`Connector module ${file} did not load: ${String(error?.message ?? error).slice(0, 300)}`)
    }
    const connector = module.default ?? module.connector
    if (connector === null || typeof connector !== 'object' || Array.isArray(connector)) {
      throw new Error(`Connector module ${file} must export a connector object as its default export`)
    }
    const id = connector.id
    if (typeof id !== 'string' || !CONNECTOR_ID.test(id)) {
      throw new Error(`Connector module ${file} needs an id matching ${CONNECTOR_ID}`)
    }
    if (Object.hasOwn(loaded, id)) throw new Error(`Connector module ${file} repeats the id "${id}"`)
    if (typeof connector.displayName !== 'string' || connector.displayName.trim() === '') {
      throw new Error(`Connector module ${file} ("${id}") needs a displayName`)
    }
    if (!CONNECTOR_MODES.includes(connector.mode)) {
      throw new Error(`Connector module ${file} ("${id}") needs a mode: ${CONNECTOR_MODES.join(', ')}`)
    }
    checkLevels(file, id, connector)
    checkDisplay(file, id, connector)
    const instances = checkInstances(file, id, connector)
    const { id: key, ...definition } = connector
    if (instances !== undefined) definition.instances = instances
    loaded[key] = definition
  }
  checkInstanceIds(loaded)
  return loaded
}

// Loaded once for the plugin, in file-name order (the view appends them after the built-ins).
export const externalConnectors = await loadConnectorModules()
