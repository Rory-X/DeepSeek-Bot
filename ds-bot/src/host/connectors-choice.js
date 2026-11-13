// Chooses which connector host the plugin installs. `legacy` is the default and is the
// fork host used in production; `bridge` is the opt-in compatibility shell for the
// upstream catalog+gateway migration (P1: same fork connectors behind the new view shape).
import * as legacy from './connectors.js'
import * as bridge from './connectors-bridge.js'

export const CONNECTOR_FRAMEWORKS = ['legacy', 'bridge']

export function connectorFrameworkOf(config = {}) {
  const choice = config.connectorFramework
  if (choice === undefined) return 'legacy'
  if (!CONNECTOR_FRAMEWORKS.includes(choice)) throw new Error(`Unknown connector framework: ${choice}`)
  return choice
}

export function install(rt) {
  if (connectorFrameworkOf(rt.config) === 'bridge') return bridge.install(rt)
  return legacy.install(rt)
}
