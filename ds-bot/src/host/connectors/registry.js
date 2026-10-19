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
// This file and test-only helpers stay out of the registry.
const NOT_A_CONNECTOR = /^(registry\.js|_.*|.*\.test\.js)$/

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
    const { id: key, ...definition } = connector
    loaded[key] = definition
  }
  return loaded
}

// Loaded once for the plugin, in file-name order (the view appends them after the built-ins).
export const externalConnectors = await loadConnectorModules()
