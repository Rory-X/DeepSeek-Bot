// Connectors: outside services every Bot can use. A connector's tools are mounted on the
// plugin context, so every Bot and Session gets them.
//
// GitHub uses DSH's own MCP client and the toolsets GitHub's server offers. A service
// without a server-side tool filter (Vercel, and the OAuth connectors) goes through
// `mcp.js` instead: DS Bot opens the session itself and registers only the read tools the
// connector names, so the write tools are never in a model's context and cannot be called
// at all.
//
// A connector with a saved token (GitHub, Vercel) keeps it in secrets.js; the token
// reaches the service only in the MCP request headers, built here in memory, never
// written to the DSH profile. A new token is shared with no Bot's shell: the tools do not
// need it there, and a Bot that reads a planted instruction in an issue could send it
// anywhere. The Secrets page can still share it.
//
// An OAuth connector (`mode: 'oauth-mcp'`) has no secret of its own: the user authorizes
// once in the browser, and the grant lives in DSH's credential store (see oauth/flow.js),
// outside the team file, the Secrets page and every shell.
import { McpHttpClient, mcpResultText } from './mcp.js'
import { createOAuthFlow } from './oauth/flow.js'
import { output } from './tools.js'
import { buildToolIndex, createCallTool, createSearchTool, TOOLBOX_TOOLS } from './vercel-toolbox.js'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const CHECK_TIMEOUT_MS = 15_000

// The read tools Vercel's server offers that DS Bot exposes. Everything else it lists
// (write and destructive calls, environment values) is never registered.
const VERCEL_READ_TOOLS = [
  'search_vercel_documentation',
  'list_projects',
  'get_project',
  'list_deployments',
  'get_deployment',
  'list_deployment_events',
  'get_runtime_logs',
  'get_runtime_errors',
  'list_project_domains',
  'list_domains',
  'list_teams',
  'get_team',
  'get_git_deployment_context',
]

// The deployment actions Vercel's server offers. They change something outside DS Bot,
// so they are registered only when the user turns them on, and every call asks first.
const VERCEL_ACTION_TOOLS = ['create_deployment', 'cancel_deployment', 'request_promote', 'request_rollback']

// Cloudflare's API server in its endpoint mode (`?codemode=false`): one tool per API
// endpoint, no code execution. Only these read endpoints are registered; every write
// endpoint, and the code-mode tools (`docs`, `search`, `execute`), stay unregistered.
const CLOUDFLARE_READ_TOOLS = [
  'whoami',
  'get_accounts',
  'get_zones',
  'get_zones_by_zone_id',
  'get_zones_dns_records',
  'get_zones_dns_records_by_dns_record_id',
  'get_zones_dns_analytics_report',
  'get_zones_dns_analytics_report_bytime',
  'get_zones_analytics_latency',
  'get_zones_rate_limit_analytics',
  'get_zones_workers_routes',
  'get_zones_workers_routes_by_route_id',
  'get_accounts_workers_scripts',
  'get_accounts_workers_scripts_by_script_name',
]

// The scopes Cloudflare needs: the identity baseline its server requires (including
// `offline_access` for a refresh token) plus one read scope per endpoint family above.
// No write scope is ever requested.
const CLOUDFLARE_READ_SCOPES = [
  'user:read',
  'account:read',
  'zone.read',
  'dns.read',
  'analytics.read',
  'workers-routes.read',
  'workers-scripts.read',
  'offline_access',
]

// Every connector, by the id its tools and the team file use. A profile overrides `url`
// or `api` per service, or hides it with `false`. `mode` picks how its tools are mounted:
// `mcp-client` mounts the whole server through DSH, `read-tools` registers only
// `readTools` through DS Bot's own client, and `oauth-mcp` does the same with a grant the
// user gave in the browser instead of a pasted token (`oauth.scopes` names the scopes to
// ask for). `toolsets` is a server-side filter header; `accountField` is the field signIn
// reads, and `accountExtra` keeps what else the answer carries (Vercel's default team).
// `accountTool` is a read tool that names the connected account after an OAuth mount.
const CONNECTORS = {
  github: {
    displayName: 'GitHub',
    mode: 'mcp-client',
    mcpUrl: 'https://api.githubcopilot.com/mcp/',
    api: 'https://api.github.com',
    tokenSecret: 'GITHUB_TOKEN',
    toolsets: 'context,repos,issues,pull_requests',
    accountField: 'login',
    checkPath: '/user',
    checkHeaders: token => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ds-bot', 'X-GitHub-Api-Version': '2022-11-28' }),
    accountOf: user => user?.login,
  },
  vercel: {
    displayName: 'Vercel',
    mode: 'read-tools',
    mcpUrl: 'https://mcp.vercel.com',
    api: 'https://api.vercel.com',
    tokenSecret: 'VERCEL_TOKEN',
    readTools: VERCEL_READ_TOOLS,
    actionTools: VERCEL_ACTION_TOOLS,
    toolbox: true,
    accountField: 'username',
    checkPath: '/v2/user',
    checkHeaders: token => ({ Authorization: `Bearer ${token}` }),
    accountOf: body => body?.user?.username,
    accountExtra: body => (typeof body?.user?.defaultTeamId === 'string' ? { teamId: body.user.defaultTeamId } : {}),
  },
  cloudflare: {
    displayName: 'Cloudflare',
    mode: 'oauth-mcp',
    mcpUrl: 'https://mcp.cloudflare.com/mcp?codemode=false',
    readTools: CLOUDFLARE_READ_TOOLS,
    oauth: { scopes: CLOUDFLARE_READ_SCOPES },
    accountTool: 'whoami',
  },
}

export const GITHUB = 'github'
export const GITHUB_SECRET = 'GITHUB_TOKEN'

// Asks the service who the token belongs to. Any token it accepts passes.
export async function signIn(id, token, { api, fetch: request = fetch } = {}) {
  const connector = CONNECTORS[id]
  if (connector === undefined) throw new Error('No such connector')
  const address = api ?? connector.api
  let response
  try {
    response = await request(`${address.replace(/\/$/, '')}${connector.checkPath}`, {
      headers: connector.checkHeaders(token),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error(`Could not reach ${connector.displayName}`)
  }
  if (response.status === 401) throw new Error(`${connector.displayName} did not accept this token`)
  if (!response.ok) throw new Error(`${connector.displayName} answered ${response.status}`)
  const body = await response.json().catch(() => ({}))
  const account = connector.accountOf(body)
  if (typeof account !== 'string') throw new Error(`${connector.displayName} did not say who this token belongs to`)
  return { [connector.accountField]: account, ...connector.accountExtra?.(body) }
}

export function install(rt) {
  const { ctx, state } = rt
  const options = {}
  for (const [id, connector] of Object.entries(CONNECTORS)) {
    if (rt.config[id] === false) continue
    const setting = rt.config[id]
    const override = setting !== null && typeof setting === 'object' ? setting : {}
    options[id] = { ...connector, ...override, url: override.url ?? connector.mcpUrl, api: override.api ?? connector.api }
  }
  const ids = Object.keys(options)
  // `token` is what the current mount was made with, so a changed secret mounts again.
  const mounts = new Map()
  // The catalog index of a connector whose toolbox is mounted, for the approval gate.
  const toolIndexes = new Map()
  const statuses = new Map(ids.map(id => [id, { state: 'off' }]))
  let queue = Promise.resolve()
  let stopped = false

  // A connector action changes something outside DS Bot, so each call asks the user
  // through DSH's own approval card before it runs. The toolbox carries the same gate:
  // its call tool names the target, and a blocked target is refused outright.
  const actionTools = new Map()
  for (const [id, connector] of Object.entries(options)) {
    for (const name of connector.actionTools ?? []) actionTools.set(`${id}_${name}`, { connector: connector.displayName, name })
  }
  const toolboxCall = TOOLBOX_TOOLS[1]
  const askAction = (connector, name) => ({
    kind: 'ask',
    reason: `${connector}: ${name} changes the connected account`,
    displayReason: {
      en: `Run ${connector}'s ${name} on the connected account? It changes your projects or deployments.`,
      zh: `要在已连接的 ${connector} 账号上执行 ${name} 吗？这会改动你的项目或部署。`,
    },
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const action = actionTools.get(exec.name)
    if (action !== undefined) return askAction(action.connector, action.name)
    if (exec.name !== toolboxCall) return next()
    const owner = ids.find(id => options[id].toolbox === true)
    if (owner === undefined) return next()
    const target = typeof exec.arguments?.tool === 'string' ? exec.arguments.tool.trim() : ''
    const entry = toolIndexes.get(owner)?.find(item => item.name === target)
    if (entry === undefined) return next()
    if (entry.class === 'blocked') return { kind: 'deny', reason: `Vercel tool "${target}" can return environment values or credentials; the toolbox does not run it.` }
    if (entry.class === 'write') return askAction(options[owner].displayName, target)
    return next()
  })
  const insecure = id => [options[id].url, options[id].api]
    .filter(address => address !== undefined)
    .some(address => !/^https:\/\//i.test(String(address)))
  const insecureText = id => `${options[id].displayName} addresses must start with https://`
  // The switches a connect or an account probe must carry over instead of dropping.
  const switchesOf = (id) => {
    const prior = state.connectors?.[id] ?? {}
    return {
      ...(typeof prior.actions === 'boolean' ? { actions: prior.actions } : {}),
      ...(typeof prior.toolbox === 'boolean' ? { toolbox: prior.toolbox } : {}),
    }
  }

  // The OAuth connectors. The flow registers its callback route on DSH's web server when
  // the user first starts a connect, and keeps each attempt in memory for ten minutes.
  const oauth = ids.some(id => options[id].mode === 'oauth-mcp')
    ? createOAuthFlow({
        ctx,
        connectorOf: id => options[id],
        origin: rt.config.oauthOrigin,
        canWrite: () => rt.readOnly() === undefined,
        warn: (template, ...args) => rt.warn(template, ...args),
        redact: text => rt.redactSecrets(text),
        onConnecting: (id) => {
          if (statuses.get(id)?.state !== 'ready') statuses.set(id, { state: 'connecting' })
        },
        onAuthorized: async (id) => {
          state.connectors = { ...state.connectors, [id]: { ...switchesOf(id), authorizedAt: Date.now() } }
          await rt.save()
          await sync(id, true)
        },
        onFailed: (id, message) => {
          statuses.set(id, { state: 'error', error: message })
        },
        onExpired: (id) => {
          if (statuses.get(id)?.state === 'connecting') statuses.set(id, { state: 'off' })
        },
      })
    : undefined

  // DSH's credential store is a service of its own; on a fresh start it can come up a
  // moment after this plugin. An OAuth connector that finds none waits as off and is
  // tried again, instead of reporting a dead authorization it never read.
  const storeAttempts = new Map()
  const retryWithoutStore = (id) => {
    if (stopped) return
    const count = storeAttempts.get(id) ?? 0
    if (count >= 5) return
    storeAttempts.set(id, count + 1)
    const timer = setTimeout(() => {
      if (!stopped) void sync(id)
    }, 500 * (count + 1))
    timer.unref?.()
  }

  const unmount = async (id) => {
    const mounted = mounts.get(id)
    mounts.delete(id)
    toolIndexes.delete(id)
    if (mounted?.dispose !== undefined) for (const dispose of mounted.dispose) dispose()
    mounted?.client?.close()
    const fiber = mounted?.fiber
    if (fiber !== undefined) await Promise.resolve().then(() => fiber.dispose()).catch(() => {})
  }

  // The MCP client wraps the server's answer (a 401, say) as the cause.
  const reason = (error) => {
    const text = [error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ')
    return rt.redactSecrets(text || 'error').slice(0, 300)
  }

  // A mounted OAuth tool the server refuses (401/403) asks for one refresh. A failed
  // refresh marks the connector for Reconnect; the tool call fails with its reason.
  const refreshFor = id => async () => {
    try {
      const grant = await oauth.refresh(id, { force: true })
      const mounted = mounts.get(id)
      if (mounted?.client !== undefined) mounted.token = grant.tokens.access
      return grant.tokens.access
    } catch (error) {
      statuses.set(id, { state: 'error', error: reason(error) })
      throw error
    }
  }

  // One read tool of a `read-tools` connector, as a ToolRuntime definition.
  const readOnlyTool = (id, tool, { client, teamId }) => {
    const parameters = tool.inputSchema !== null && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }
    return {
      name: `${id}_${String(tool.name).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64),
      description: String(tool.description ?? tool.title ?? tool.name),
      parameters,
      output,
      async execute(args) {
        const call = { ...args }
        // The default team of the token's account answers the calls that need one; an
        // explicit argument wins.
        if (teamId !== undefined && parameters.properties?.teamId !== undefined && call.teamId === undefined) call.teamId = teamId
        try {
          return mcpResultText(await client.callTool(tool.name, call))
        } catch (error) {
          throw new Error(rt.redactSecrets(String(error?.message ?? error)).slice(0, 300))
        }
      },
    }
  }

  // A connector whose token was saved somewhere else (a secret card, a copied team) has
  // no account in the team file. Ask the service once so the page shows it and the
  // default team answers the read tools; a failed check leaves the mount to carry on.
  // `replace`: the token changed under the mount, so the stored account may be another
  // account's and is read again even when one is already there.
  const claimAccount = async (id, token, replace = false) => {
    const connector = options[id]
    if (!replace && state.connectors?.[id]?.[connector.accountField] !== undefined) return
    try {
      const account = await signIn(id, token, { api: connector.api })
      state.connectors = { ...state.connectors, [id]: { ...switchesOf(id), ...account, connectedAt: Date.now() } }
      await rt.save()
    } catch (error) {
      rt.warn('ds-bot: could not read the %s account of the saved token: %s', connector.displayName, reason(error))
    }
  }

  // An OAuth connector has no token to ask who it belongs to; its server's own read tool
  // does. One call, once per authorization, fills the card's account line.
  const claimOAuthAccount = async (id, client) => {
    const connector = options[id]
    if (connector.accountTool === undefined || state.connectors?.[id]?.account !== undefined) return
    try {
      const text = mcpResultText(await client.callTool(connector.accountTool, {}))
      let identity
      try {
        identity = JSON.parse(text)
      } catch {
        identity = undefined
      }
      const account = typeof identity?.email === 'string' && identity.email !== ''
        ? identity.email
        : typeof identity?.name === 'string' && identity.name !== '' ? identity.name : undefined
      const accountId = typeof identity?.id === 'string' && identity.id !== '' ? identity.id : undefined
      if (account === undefined && accountId === undefined) return
      state.connectors = {
        ...state.connectors,
        [id]: { ...state.connectors?.[id], ...(account === undefined ? {} : { account }), ...(accountId === undefined ? {} : { accountId }) },
      }
      await rt.save()
    } catch (error) {
      rt.warn('ds-bot: could not read the %s account: %s', connector.displayName, reason(error))
    }
  }

  async function mountReadTools(id, token, { refresh } = {}) {
    const connector = options[id]
    const client = new McpHttpClient(connector.url, token, refresh === undefined ? {} : { refresh })
    try {
      await client.open()
      const listed = await client.listTools()
      // The toolbox replaces the four named action tools: with it on, an action is run
      // through vercel_call (and still approved per call), so it is not offered twice.
      const toolbox = connector.toolbox === true && state.connectors?.[id]?.toolbox === true
      const actions = !toolbox && state.connectors?.[id]?.actions === true
      const wanted = [...connector.readTools, ...(actions ? connector.actionTools ?? [] : [])]
      const picked = listed.filter(tool => wanted.includes(tool.name))
      if (picked.length === 0) throw new Error(`${connector.displayName} offers none of the read tools DS Bot exposes`)
      const index = toolbox ? buildToolIndex(listed) : undefined
      const teamId = state.connectors?.[id]?.teamId ?? connector.teamId
      const dispose = []
      try {
        for (const tool of picked) dispose.push(ctx.tools.register(readOnlyTool(id, tool, { client, teamId })))
        if (index !== undefined) {
          dispose.push(ctx.tools.register(createSearchTool({ index, output })))
          dispose.push(ctx.tools.register(createCallTool({ client, index, output, redact: rt.redactSecrets, teamId })))
        }
      } catch (error) {
        for (const undo of dispose) undo()
        throw error
      }
      if (index !== undefined) toolIndexes.set(id, index)
      return { token, client, dispose }
    } catch (error) {
      client.close()
      throw error
    }
  }

  async function reconcile(id, force) {
    const connector = options[id]
    const previous = mounts.get(id)?.token
    const oauthConnector = connector.mode === 'oauth-mcp'
    let token
    if (!stopped) {
      if (oauthConnector) {
        try {
          token = (await oauth.token(id))?.tokens.access
        } catch (error) {
          // A grant the provider no longer honors shows as Reconnect, with its reason,
          // and whatever was mounted with the dead grant goes away.
          await unmount(id)
          if (stopped) return
          mounts.set(id, { token: undefined })
          if (error?.code === 'oauth/store') {
            // DSH's credential store came up after this plugin, or this DSH has none: the
            // connector waits as off until the store answers, rather than reporting a
            // failed authorization it never read.
            statuses.set(id, { state: 'off' })
            retryWithoutStore(id)
            return
          }
          statuses.set(id, { state: 'error', error: reason(error) })
          return
        }
      } else {
        token = rt.secretValue(connector.tokenSecret)
      }
    }
    if (!force && previous === token) return
    const replaced = previous !== undefined && previous !== token
    await unmount(id)
    if (token === undefined) {
      statuses.set(id, { state: 'off' })
      return
    }
    if (insecure(id)) {
      mounts.set(id, { token })
      statuses.set(id, { state: 'error', error: insecureText(id) })
      return
    }
    statuses.set(id, { state: 'connecting' })
    const attempt = { token }
    mounts.set(id, attempt)
    if (connector.mode === 'read-tools') {
      await claimAccount(id, token, replaced)
      if (stopped || mounts.get(id) !== attempt) return
    }
    const loader = ctx.get?.('loader')
    if (connector.mode === 'mcp-client' && (typeof loader?.import !== 'function' || typeof ctx.plugin !== 'function')) {
      statuses.set(id, { state: 'error', error: 'This DSH cannot load connectors' })
      return
    }
    try {
      if (connector.mode !== 'mcp-client') {
        const mounted = await mountReadTools(id, token, { refresh: oauthConnector ? refreshFor(id) : undefined })
        if (stopped || mounts.get(id) !== attempt) {
          for (const undo of mounted.dispose) undo()
          mounted.client.close()
          return
        }
        mounts.set(id, mounted)
        if (oauthConnector) await claimOAuthAccount(id, mounted.client)
        if (stopped || mounts.get(id) !== mounted) {
          for (const undo of mounted.dispose) undo()
          mounted.client.close()
          return
        }
        storeAttempts.delete(id)
        statuses.set(id, { state: 'ready' })
        return
      }
      const exports = await loader.import(MCP_CLIENT)
      const plugin = loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      const fiber = ctx.plugin(plugin, {
        transport: 'streamable-http',
        serverName: id,
        url: connector.url,
        headers: { Authorization: `Bearer ${token}`, ...(connector.toolsets === undefined ? {} : { 'X-MCP-Toolsets': connector.toolsets }) },
        failOnStartupError: true,
      })
      attempt.fiber = fiber
      await fiber.await()
      if (mounts.get(id) !== attempt) return
      statuses.set(id, { state: 'ready' })
    } catch (error) {
      await unmount(id)
      mounts.set(id, { token })
      statuses.set(id, { state: 'error', error: reason(error) })
      rt.warn('ds-bot: %s connector failed: %s', connector.displayName, statuses.get(id).error)
    }
  }

  // One change at a time; `force` connects again even when the token is the same.
  const sync = (id, force = false) => {
    queue = queue.then(() => reconcile(id, force)).catch(error => { rt.warn('ds-bot: connectors: %s', reason(error)) })
    return queue
  }

  // A token connector shows the account signIn read; an OAuth connector shows what its
  // own account tool answered after the mount.
  const accountOf = (id) => {
    const connector = options[id]
    if (connector.mode === 'oauth-mcp') return state.connectors?.[id]?.account ?? null
    if (rt.secretValue(connector.tokenSecret) === undefined) return null
    return state.connectors?.[id]?.[connector.accountField] ?? null
  }

  const connectorsView = () => ids.map(id => {
    const connector = options[id]
    const status = statuses.get(id) ?? { state: 'off' }
    const oauthConnector = connector.mode === 'oauth-mcp'
    return {
      id,
      name: connector.displayName,
      state: status.state,
      ...(status.error !== undefined ? { error: status.error } : {}),
      // An OAuth connector has no account before it is connected; the client draws
      // Connect from `oauth` and shows `account` once the server named it.
      account: accountOf(id),
      ...(oauthConnector ? { oauth: true } : {}),
      ...(connector.actionTools === undefined ? {} : { actions: state.connectors?.[id]?.actions === true }),
      ...(connector.toolbox === true ? { toolbox: state.connectors?.[id]?.toolbox === true } : {}),
    }
  })

  const known = id => {
    if (!Object.hasOwn(options, id)) throw new Error('No such connector')
  }

  const endpoints = {
    async 'connector-connect'(body) {
      known(body.id)
      const connector = options[body.id]
      if (connector.mode === 'oauth-mcp') throw new Error(`${connector.displayName} connects with OAuth, not a token`)
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token === '') throw new Error('Paste a token first')
      if (insecure(body.id)) throw new Error(insecureText(body.id))
      await rt.loadSecrets()
      const kept = rt.secretValue(connector.tokenSecret) !== undefined
      const account = await signIn(body.id, token, { api: connector.api })
      // The account is written before the secret, so the mount the secret change starts
      // already knows the default team it hands to the read tools.
      state.connectors = { ...state.connectors, [body.id]: { ...switchesOf(body.id), ...account, connectedAt: Date.now() } }
      try {
        await rt.secretEndpoint('secret-set', { name: connector.tokenSecret, value: token, purpose: `${connector.displayName} connector`, ...(kept ? {} : { scope: [] }) })
      } catch (error) {
        delete state.connectors[body.id]
        throw error
      }
      await rt.save()
      await sync(body.id)
      return connectorsView()
    },
    // The browser half of an OAuth connect: DS Bot answers with the provider's authorize
    // address, the client opens it, and the provider sends the browser back to the
    // callback route the flow registered.
    async 'connector-oauth-start'(body, meta) {
      known(body.id)
      const connector = options[body.id]
      if (connector.mode !== 'oauth-mcp' || oauth === undefined) throw new Error(`${connector.displayName} connects with a token, not OAuth`)
      return await oauth.start(body.id, { origin: meta.origin })
    },
    async 'connector-disconnect'(body) {
      known(body.id)
      const connector = options[body.id]
      if (connector.mode === 'oauth-mcp') {
        await oauth.disconnect(body.id)
        if (state.connectors?.[body.id] !== undefined) {
          delete state.connectors[body.id]
          await rt.save()
        }
        await sync(body.id, true)
        return connectorsView()
      }
      await rt.loadSecrets()
      if (rt.secretValue(connector.tokenSecret) !== undefined) await rt.secretEndpoint('secret-delete', { name: connector.tokenSecret })
      if (state.connectors?.[body.id] !== undefined) {
        delete state.connectors[body.id]
        await rt.save()
      }
      await sync(body.id)
      return connectorsView()
    },
    async 'connector-retry'(body) {
      known(body.id)
      await rt.loadSecrets()
      await sync(body.id, true)
      return connectorsView()
    },
    async 'connector-set-actions'(body) {
      known(body.id)
      const connector = options[body.id]
      if (connector.actionTools === undefined) throw new Error('This connector has no actions')
      const enabled = body.enabled === true
      state.connectors = { ...state.connectors, [body.id]: { ...state.connectors?.[body.id], actions: enabled } }
      await rt.save()
      await sync(body.id, true)
      return connectorsView()
    },
    async 'connector-set-toolbox'(body) {
      known(body.id)
      const connector = options[body.id]
      if (connector.toolbox !== true) throw new Error('This connector has no toolbox')
      const enabled = body.enabled === true
      state.connectors = { ...state.connectors, [body.id]: { ...state.connectors?.[body.id], toolbox: enabled } }
      await rt.save()
      await sync(body.id, true)
      return connectorsView()
    },
  }

  const connectorEndpoint = (endpoint, body, meta) => endpoints[endpoint](body ?? {}, meta ?? {})

  ctx.effect(() => {
    stopped = false
    void rt.loadSecrets().then(() => { for (const id of ids) void sync(id) })
    return () => {
      stopped = true
      oauth?.dispose()
      for (const id of ids) void unmount(id)
    }
  }, 'ds-bot: connectors')

  Object.assign(rt, { connectorsView, connectorEndpoint, secretsChanged: () => { for (const id of ids) void sync(id) } })
}
