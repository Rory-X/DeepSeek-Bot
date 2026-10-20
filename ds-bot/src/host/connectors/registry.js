// Connector auto-registration: every module under this directory, except this file, is one
// connector, loaded when the plugin loads. A connector line adds its own file and nothing
// else, so six lines never edit one registry and never conflict. The shape is checked once
// here: a module that cannot load, a missing or bad id, a duplicate id, or a connector
// without a display name or a known mode fails loudly at plugin load, naming the file.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CONNECTOR_DIR = import.meta.dirname
export const CONNECTOR_ID = /^[a-z][a-z0-9-]{0,39}$/
export const CONNECTOR_MODES = ['mcp-client', 'read-tools', 'oauth-mcp', 'notify', 'rest-tools', 'imap', 'imap-read', 'custom']
// An access level is what a connector may do once it is connected: read only, or read and
// write. Every write tool is gated by it, so a connector that does not declare a level is
// read only.
export const CONNECTOR_LEVELS = ['read', 'write']
// This file and test-only helpers stay out of the registry.
const NOT_A_CONNECTOR = /^(registry\.js|_.*|.*\.test\.js)$/
const LEVEL_HOOKS = ['authorize', 'toolsOf', 'readiness', 'normalizeSettings', 'actionApproval']
const CAPABILITY_RISKS = ['read', 'write', 'destructive']

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
  if (connector.settings !== undefined
    && (!Array.isArray(connector.settings) || connector.settings.some(field => field === null || typeof field !== 'object' || typeof field.name !== 'string' || field.name === ''))) {
    throw new Error(`Connector module ${file} ("${id}") settings must list fields with a name`)
  }
  if (connector.blockedTools !== undefined
    && (!Array.isArray(connector.blockedTools)
      || connector.blockedTools.some(item => !(typeof item === 'string' && item !== '') && !(item instanceof RegExp)))) {
    throw new Error(`Connector module ${file} ("${id}") blockedTools must list tool names`)
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
    const { id: key, ...definition } = connector
    loaded[key] = definition
  }
  return loaded
}

// Loaded once for the plugin, in file-name order (the view appends them after the built-ins).
export const externalConnectors = await loadConnectorModules()
