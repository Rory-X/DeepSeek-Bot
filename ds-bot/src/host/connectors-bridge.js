// The bridge between the fork connector host and the upstream catalog+gateway host.
//
// P1 (this file's first phase) has no upstream host yet: it wraps the fork host behind a
// single `connectorsView`/`connectorEndpoint` pair and a `{connectors, mail}` view, so the
// upstream-shaped client page can be rendered while every connector still runs on the fork
// path. Later phases pass an upstream host and a fork-only legacy host; the same pair then
// routes by connector id. The legacy API is kept at `rt.connectorCompat`, never registered
// beside the bridge API: two views under one name would overwrite each other.
import { createLegacyHost } from './connectors-legacy-host.js'

const rowsOf = view => {
  if (Array.isArray(view)) return { connectors: view, mail: undefined }
  return { connectors: view?.connectors ?? [], mail: view?.mail }
}

export function createBridgeHost(rt, { upstream, legacy }) {
  const legacyIds = new Set(legacy.ids ?? [])
  const viewOf = host => rowsOf(host.view?.())

  const connectorsView = () => {
    const upstreamView = upstream === undefined ? undefined : viewOf(upstream)
    const legacyView = viewOf(legacy)
    const rows = [...(upstreamView?.connectors ?? [])]
    for (const row of legacyView.connectors) {
      if (!rows.some(item => item.id === row.id)) rows.push(row)
    }
    return {
      connectors: rows,
      mail: upstreamView?.mail ?? legacyView.mail ?? rt.mailView?.() ?? { accounts: [], google: false },
    }
  }

  const connectorEndpoint = (endpoint, body, meta) => {
    const id = body?.id === undefined ? undefined : String(body.id)
    if (id !== undefined && legacyIds.has(id)) return legacy.endpoint(endpoint, body, meta)
    if (upstream !== undefined) return upstream.endpoint(endpoint, body, meta)
    return legacy.endpoint(endpoint, body, meta)
  }

  // P1 has no upstream host. P3 extends this with per-question routing once upstream
  // approvals exist; the legacy approval hooks stay the only ones registered now.
  const approvals = legacy.approvals

  return { connectorsView, connectorEndpoint, approvals }
}

export function install(rt) {
  const legacy = createLegacyHost(rt)
  const host = createBridgeHost(rt, { legacy })
  // The old view stays reachable for compatibility endpoints only, under its own name.
  rt.connectorCompat = {
    view: legacy.view,
    endpoint: legacy.endpoint,
    ...legacy.approvals,
    secretsChanged: legacy.secretsChanged,
  }
  Object.assign(rt, {
    connectorsView: host.connectorsView,
    connectorEndpoint: host.connectorEndpoint,
    answerConnectorApproval: host.approvals.answer,
    dismissConnectorApproval: host.approvals.dismiss,
    cancelConnectorApprovals: host.approvals.cancel,
    secretsChanged: () => void legacy.secretsChanged?.(),
  })
}
