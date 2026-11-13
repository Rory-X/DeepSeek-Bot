// The bridge between the fork connector host and the upstream catalog+gateway host.
//
// `legacy` keeps the fork host as the only host, as production runs it. `bridge` mounts the
// upstream host for the six connectors the upstream catalog covers, keeps the fork host
// only for Telegram/ima/WeRead, and mounts the old tool names as aliases over the upstream
// gateway or the mail shim. There is one `connectorsView`/`connectorEndpoint` pair: the
// legacy API stays at `rt.connectorCompat`, never beside it under the same name.
import { createApprovalDesk } from './connector-approval.js'
import { createAliasHost, NEON_ID } from './connectors-alias.js'
import { FORK_ONLY, createLegacyHost } from './connectors-legacy-host.js'
import { migrateConnectors } from './connectors-migration.js'
import * as upstreamHost from './connectors/index.js'

const rowsOf = view => {
  if (Array.isArray(view)) return { connectors: view, mail: undefined }
  return { connectors: view?.connectors ?? [], mail: view?.mail }
}

const MAIL_IDS = new Set(['gmail', 'qqmail'])
const SIX = new Set(['github', 'vercel', 'cloudflare', 'neon', 'gmail', 'qqmail'])
const MUTATING = new Set(['connector-connect', 'connector-disconnect', 'connector-set', 'connector-set-level', 'connector-set-settings', 'connector-oauth-start', 'connector-retry', 'connector-cancel'])

// Neon's first instance is the catalog entry; each saved extra instance is one more card.
// An overlay entry replaces the catalog entry with the same id, so the base instance keeps
// its pinned project/role too. Old state is read only, never rewritten.
export function neonCatalogOverlay(state) {
  const rows = []
  for (const [id, saved] of Object.entries(state?.connectors ?? {})) {
    if (!NEON_ID.test(id) || saved === null || typeof saved !== 'object') continue
    const legacy = saved.legacy ?? {}
    const projectId = saved.projectId ?? legacy.projectId
    const roleName = saved.roleName ?? saved.role ?? legacy.roleName ?? legacy.role
    const url = new URL('https://mcp.neon.tech/mcp')
    if (typeof projectId === 'string' && projectId !== '') url.searchParams.set('projectId', projectId)
    if (typeof roleName === 'string' && roleName !== '') url.searchParams.set('roleName', roleName)
    const label = [saved.label, legacy.label, saved.projectName, legacy.projectName].find(value => typeof value === 'string' && value.trim() !== '')
    rows.push({
      id,
      name: label?.trim() ?? (id === 'neon' ? 'Neon' : `Neon ${id.slice('neon-'.length)}`),
      category: 'data',
      about: 'Postgres databases and branches',
      remote: { url: url.href },
      auth: { kind: 'oauth' },
    })
  }
  if (rows.length > 0 && !rows.some(row => row.id === 'neon')) {
    rows.unshift({
      id: 'neon', name: 'Neon', category: 'data', about: 'Postgres databases and branches',
      remote: { url: 'https://mcp.neon.tech/mcp' }, auth: { kind: 'oauth' },
    })
  }
  return rows
}

export function createBridgeHost(rt, { upstream, legacy, adapters } = {}) {
  const legacyIds = new Set(legacy?.ids ?? [])
  const viewOf = host => rowsOf(host?.view?.())

  const connectorsView = () => {
    const upstreamView = upstream === undefined ? undefined : viewOf(upstream)
    const legacyView = viewOf(legacy)
    const rows = [...(upstreamView?.connectors ?? [])]
    for (const row of legacyView.connectors) {
      if (!rows.some(item => item.id === row.id)) rows.push(row)
    }
    const mail = upstreamView?.mail ?? legacyView.mail ?? rt.mailView?.() ?? { accounts: [], google: false }
    const saved = rt.state?.connectors?.mail?.accounts ?? {}
    return {
      connectors: rows,
      mail: {
        ...mail,
        accounts: (mail.accounts ?? []).map((account) => {
          const own = saved[account.id] ?? {}
          return {
            ...account,
            ...(own.compat === undefined ? {} : { compat: own.compat }),
            ...(own.status === 'needs-reconnect' ? { state: 'error', error: 'Sign in again' } : {}),
          }
        }),
      },
    }
  }

  const connectorEndpoint = async (endpoint, body, meta) => {
    const id = body?.id === undefined ? undefined : String(body.id)
    if (id !== undefined && legacyIds.has(id)) return legacy.endpoint(endpoint, body, meta)
    if (adapters?.[endpoint] !== undefined) return adapters[endpoint](endpoint, body, meta)
    if (upstream !== undefined) return upstream.endpoint(endpoint, body, meta)
    return legacy.endpoint(endpoint, body, meta)
  }

  return { connectorsView, connectorEndpoint }
}

// The old endpoint names, mapped onto the upstream host or the mail account model. Only
// endpoints with a real mapping appear here; everything else goes straight upstream.
export function createEndpointAdapters({ rt, upstream, aliasHost }) {
  const saveState = async (id, patch) => {
    rt.state.connectors = { ...(rt.state.connectors ?? {}), [id]: { ...rt.state.connectors?.[id], ...patch } }
    await rt.save?.()
  }
  const mailAccountOf = (id) => {
    const accounts = Object.values(rt.state.connectors?.mail?.accounts ?? {})
    const exact = accounts.find(item => item.id === id)
    if (exact !== undefined) return exact
    const provider = id === 'gmail' ? 'gmail' : 'qq'
    return accounts.find(item => item.compat === 'mail-shim' && (item.provider === provider || (provider === 'qq' && item.provider === 'qqmail')))
  }
  const setLevel = async (id, level) => {
    if (level !== 'read' && level !== 'write') throw new Error(`${id} has no ${String(level)} access level`)
    const prior = rt.state.connectors?.[id] ?? {}
    await saveState(id, { level, ...(prior.legacy === undefined ? {} : { legacy: { ...prior.legacy, level } }) })
    if (MAIL_IDS.has(id)) {
      const account = mailAccountOf(id)
      if (account !== undefined) account.legacyLevel = level
      await rt.save?.()
      await aliasHost?.sync({ force: true })
      return upstream.view()
    }
    return upstream.endpoint('connector-set', { id, readOnly: level !== 'write' })
  }
  const mailCredentials = (id, body) => {
    const values = body?.values !== null && typeof body?.values === 'object' ? body.values : {}
    let address = values.GMAIL_ADDRESS ?? values.QQMAIL_ADDRESS ?? body?.address
    let password = values.GMAIL_APP_PASSWORD ?? values.QQMAIL_AUTH_CODE ?? body?.password
    if (password === undefined && typeof body?.token === 'string' && body.token.includes(':')) {
      const at = body.token.indexOf(':')
      address = body.token.slice(0, at).trim()
      password = body.token.slice(at + 1).trim()
    }
    if (typeof address !== 'string' || address.trim() === '') throw new Error('Enter the mailbox address')
    if (typeof password !== 'string' || password.trim() === '') throw new Error('Enter the app password or authorization code')
    return { address: address.trim().toLowerCase(), password: password.trim() }
  }

  return {
    async 'connector-connect'(endpoint, body, meta) {
      const id = String(body?.id ?? '')
      if (!MAIL_IDS.has(id)) return upstream.endpoint(endpoint, body, meta)
      const { address, password } = mailCredentials(id, body)
      const view = await upstream.endpoint('mail-account-add', { address, password }, meta)
      const account = Object.values(rt.state.connectors?.mail?.accounts ?? {}).find(item => item.address === address)
      if (account !== undefined) {
        account.compat = 'mail-shim'
        account.legacyLevel = rt.state.connectors?.[id]?.level === 'write' ? 'write' : 'read'
        await rt.save?.()
      }
      return view
    },
    async 'connector-disconnect'(endpoint, body, meta) {
      const id = String(body?.id ?? '')
      if (!MAIL_IDS.has(id)) return upstream.endpoint(endpoint, body, meta)
      const account = mailAccountOf(id)
      if (account === undefined) return upstream.view()
      return upstream.endpoint('mail-account-remove', { id: account.id }, meta)
    },
    async 'connector-set-level'(endpoint, body) {
      const id = String(body?.id ?? '')
      if (!SIX.has(id) && !NEON_ID.test(id)) return upstream.endpoint(endpoint, body)
      const result = await setLevel(id, body?.level)
      await aliasHost?.sync({ force: true })
      return result
    },
    async 'connector-oauth-start'(endpoint, body, meta) {
      const id = String(body?.id ?? '')
      if (!SIX.has(id) && !NEON_ID.test(id)) return upstream.endpoint(endpoint, body, meta)
      const level = body?.level === 'write' ? 'write' : 'read'
      await saveState(id, { level, readOnly: level !== 'write' })
      return upstream.endpoint('connector-connect', { id }, meta)
    },
    async 'connector-set-settings'(endpoint, body, meta) {
      const id = String(body?.id ?? '')
      if (!NEON_ID.test(id)) return upstream.endpoint(endpoint, body, meta)
      const values = body?.values !== null && typeof body?.values === 'object' ? body.values : {}
      const prior = rt.state.connectors?.[id] ?? {}
      const legacy = { ...(prior.legacy ?? {}) }
      for (const key of ['projectId', 'roleName', 'label']) {
        if (typeof values[key] !== 'string') continue
        if (values[key].trim() === '') delete legacy[key]
        else legacy[key] = values[key].trim()
      }
      await saveState(id, { legacy, ...(typeof values.projectId === 'string' ? { projectId: values.projectId.trim() } : {}) })
      return upstream.view()
    },
  }
}

export function install(rt) {
  // The migration is additive and safe to run on every bridge start; a failure leaves the
  // fork state and secrets untouched and only warns.
  const migration = rt.config?.connectorMigration === false
    ? Promise.resolve()
    : Promise.resolve(rt.load?.()).then(() => migrateConnectors(rt))
      .then(result => result.changed ? rt.save?.() : undefined)
      .catch(error => rt.warn?.('ds-bot: connector migration failed: %s', error))

  // The upstream host reads this before every entries()/entryFor() call, so Neon's extra
  // instances appear as ordinary catalog rows with their own grant and project settings.
  rt.connectorCatalogOverlay = () => neonCatalogOverlay(rt.state)

  upstreamHost.install(rt)
  const upstream = {
    view: rt.connectorsView,
    endpoint: rt.connectorEndpoint,
    internals: rt.connectorsInternals,
  }
  const upstreamOffFor = rt.connectorOffFor
  const upstreamSecretsChanged = rt.secretsChanged

  const legacy = createLegacyHost(rt, { ids: FORK_ONLY })
  const approval = createApprovalDesk({ rt })
  const aliasHost = createAliasHost(rt, { approval })
  const adapters = createEndpointAdapters({ rt, upstream, aliasHost })
  const host = createBridgeHost(rt, { upstream, legacy, adapters })

  const nativePrefixes = () => {
    const ids = ['github', 'vercel', 'cloudflare', ...Object.keys(rt.state.connectors ?? {}).filter(id => NEON_ID.test(id))]
    return [...new Set(ids)].map(id => `mcp__${id}__`)
  }

  // The old view stays reachable for compatibility endpoints only, under its own name.
  rt.connectorCompat = {
    view: legacy.view,
    endpoint: legacy.endpoint,
    ...legacy.approvals,
    secretsChanged: legacy.secretsChanged,
  }
  Object.assign(rt, {
    connectorsView: host.connectorsView,
    connectorEndpoint: async (endpoint, body, meta) => {
      const result = await host.connectorEndpoint(endpoint, body, meta)
      if (MUTATING.has(endpoint) || endpoint.startsWith('mail-')) await aliasHost.sync({ force: true })
      // Mail endpoints answer with the mail view; the bridge always answers one shape.
      return result !== null && typeof result === 'object' && Array.isArray(result.accounts) && !Array.isArray(result.connectors)
        ? host.connectorsView()
        : result
    },
    answerConnectorApproval: async (sessionId, questionId, body) => {
      const own = await approval.answer(sessionId, questionId, body)
      return own !== 'stale' ? own : legacy.approvals.answer?.(sessionId, questionId, body)
    },
    dismissConnectorApproval: async (sessionId, questionId) => {
      const own = await approval.dismiss(sessionId, questionId)
      return own !== 'stale' ? own : legacy.approvals.dismiss?.(sessionId, questionId)
    },
    cancelConnectorApprovals: async (sessionId, outcome) => {
      await approval.cancel(sessionId, outcome)
      return legacy.approvals.cancel?.(sessionId, outcome)
    },
    // The upstream host mounts every catalog connector as mcp__<id>__*; the bridge offers
    // the old names for the six instead, so their native twins stay out of Bot sessions.
    connectorOffFor: botId => [...(upstreamOffFor?.(botId) ?? []), ...nativePrefixes()],
    secretsChanged: () => {
      void upstreamSecretsChanged?.()
      aliasHost.invalidate()
      void aliasHost.sync({ force: true })
    },
  })

  void migration.then(() => aliasHost.sync({ force: true }))
    .catch(error => rt.warn?.('ds-bot: bridge alias startup failed: %s', error))
  return host
}
