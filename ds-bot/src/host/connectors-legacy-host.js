// The fork connector host, kept as the legacy side of the upstream bridge. It owns the
// Telegram/ima/WeRead modules the upstream catalog does not cover, and can also host every
// fork connector while the bridge is rolled out. Its API is returned, never written onto
// `rt`: the bridge is the one place that registers `connectorsView`/`connectorEndpoint`.
import { createConnectorHost } from './connectors.js'
import { externalConnectors } from './connectors/registry.js'

// Connectors the upstream catalog does not cover and that stay on the fork host.
export const FORK_ONLY = ['telegram', 'ima', 'weread']

// `ids` undefined hosts every fork connector (the legacy-compatible bridge phase);
// an explicit list picks just those module definitions.
export function createLegacyHost(rt, { ids } = {}) {
  let connectors
  if (ids !== undefined) {
    connectors = {}
    for (const id of ids) {
      const definition = externalConnectors[id]
      if (definition !== undefined) connectors[id] = definition
    }
  }
  const host = createConnectorHost(rt, connectors)
  return {
    ids: ids === undefined ? undefined : [...ids],
    view: host.connectorsView,
    endpoint: host.connectorEndpoint,
    approvals: {
      answer: host.answerConnectorApproval,
      dismiss: host.dismissConnectorApproval,
      cancel: host.cancelConnectorApprovals,
    },
    secretsChanged: host.secretsChanged,
  }
}
