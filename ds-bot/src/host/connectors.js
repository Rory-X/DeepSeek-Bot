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
import { buildCloudflareToolIndex, CLOUDFLARE_TOOLBOX_TOOLS, createCloudflareCallTool, createCloudflareSearchTool, isBlockedCloudflareTool } from './cloudflare-toolbox.js'
import { createApprovalDesk } from './connector-approval.js'
import { McpHttpClient, mcpResultText } from './mcp.js'
import { credentialFields, connectValues } from './connector-setup.js'
import { externalConnectors, CONNECTOR_LEVELS } from './connectors/registry.js'
import { chatIdOf, createNotifyTool, NOTIFY_TEST_TEXT, parseChatId } from './notify.js'
import { createOAuthFlow } from './oauth/flow.js'
import { createRestTools } from './rest-tools.js'
import { output } from './tools.js'
import { buildToolIndex, createCallTool, createSearchTool } from './vercel-toolbox.js'

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
const BUILTIN_CONNECTORS = {
  github: {
    displayName: 'GitHub',
    mode: 'mcp-client',
    card: {
      glyph: 'github',
      about: "Issues, pull requests and repository context through GitHub's own MCP server.",
      docsUrl: 'https://docs.github.com',
      readOnlyNote: 'Only the issue, pull-request and repository tools are mounted.',
    },
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
    levels: ['read', 'write'],
    defaultLevel: 'read',
    card: {
      glyph: 'vercel',
      about: 'Projects, deployments and runtime logs from a connected Vercel account.',
      docsUrl: 'https://vercel.com/docs/mcp',
      readOnlyNote: 'Read tools run directly; the four deployment actions are off by default and each asks for approval.',
    },
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
    levels: ['read', 'write'],
    defaultLevel: 'read',
    card: {
      glyph: 'cloudflare',
      about: 'Zones, DNS records, analytics and Workers through Cloudflare\'s own MCP server.',
      docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/',
      readOnlyNote: 'The named tools only read. Full access can change your account; every write still asks for your approval first.',
      consent: {
        title: 'Choose the access level on the authorization page',
        body: 'Requested scopes is read-only, and it is all this connector asks for. Full access lets Bots change your Cloudflare account; every write still asks for your approval first.',
        acknowledge: "I'll choose the access level on the authorization page",
      },
    },
    mcpUrl: 'https://mcp.cloudflare.com/mcp?codemode=false',
    readTools: CLOUDFLARE_READ_TOOLS,
    oauth: { scopes: CLOUDFLARE_READ_SCOPES },
    toolbox: true,
    toolboxKind: 'cloudflare',
    accountTool: 'whoami',
    accountIdTool: 'get_accounts',
  },
}

// Connector modules under ./connectors/ register themselves when the plugin loads, so a
// connector line adds one file and never edits this one. A module that takes a built-in id
// is a configuration error, refused here rather than silently shadowing GitHub or Vercel.
for (const id of Object.keys(externalConnectors)) {
  if (Object.hasOwn(BUILTIN_CONNECTORS, id)) throw new Error(`Connector module "${id}" collides with a built-in connector`)
}
const CONNECTORS = { ...BUILTIN_CONNECTORS, ...externalConnectors }

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
    // A module that brings its own `configure` re-applies a grant the profile cannot widen:
    // Neon's read-only master switch survives any `url` override.
    if (typeof connector.configure === 'function') options[id] = { ...options[id], ...connector.configure(override) }
    // `imap-read` was the name the first IMAP draft used; one IMAP mode serves Gmail and QQ.
    if (options[id].mode === 'imap-read') options[id].mode = 'imap'
  }
  const ids = Object.keys(options)
  // `token` is what the current mount was made with, so a changed secret mounts again.
  const mounts = new Map()
  // The mounted toolboxes, by their call tool's name, for the blocked-target gate.
  const toolboxes = new Map()
  const statuses = new Map(ids.map(id => [id, { state: 'off' }]))
  let queue = Promise.resolve()
  let stopped = false

  // A blocked toolbox target is refused outright: no approval can make it runnable.
  // Everything else that changes something outside DS Bot asks through the plugin's own
  // card from inside the tool call (see connector-approval.js), because a Session can run
  // with DSH approvals off, where a pre-execute `ask` would simply be rejected.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const box = toolboxes.get(exec.name)
    if (box === undefined) return next()
    const target = typeof exec.arguments?.tool === 'string' ? exec.arguments.tool.trim() : ''
    if (box.blocked.has(target)) {
      return {
        kind: 'deny',
        reason: box.kind === 'cloudflare'
          ? `Cloudflare tool "${target}" can mint or read credentials, or change who reaches the account; the toolbox does not run it.`
          : `Vercel tool "${target}" can return environment values or credentials; the toolbox does not run it.`,
      }
    }
    return next()
  })

  // One approval card per conversation at a time; the write itself waits for Allow once.
  const approval = createApprovalDesk({
    rt,
    ...(Number.isFinite(rt.config.connectorApprovalTimeoutMs) && rt.config.connectorApprovalTimeoutMs > 0
      ? { timeoutMs: rt.config.connectorApprovalTimeoutMs }
      : {}),
  })
  // A connector write asks first and throws (a model-visible error) unless allowed.
  const requireApproval = async (connector, tool, exec) => {
    const outcome = await approval.approve({
      sessionId: exec?.agent?.id,
      connector: connector.displayName,
      tool,
      signal: exec?.signal,
    })
    if (outcome === 'allow') return
    if (outcome === 'timeout') throw new Error(`The user did not answer in time, so ${connector.displayName}'s ${tool} was not run.`)
    if (outcome === 'cancelled') throw new Error(`The approval was cancelled, so ${connector.displayName}'s ${tool} was not run.`)
    if (outcome === 'unavailable') throw new Error(`${connector.displayName}'s ${tool} needs your approval, but the approval card could not be shown; nothing was sent.`)
    throw new Error(`The user denied ${connector.displayName}'s ${tool}; nothing was sent.`)
  }
  const insecure = id => [options[id].url, options[id].api]
    .filter(address => address !== undefined)
    .some(address => !/^https:\/\//i.test(String(address)))
  const insecureText = id => `${options[id].displayName} addresses must start with https://`
  // What a connect or an account probe must carry over instead of dropping: the chosen
  // access level (a legacy switch maps to write through `levelOf`) and the settings.
  const switchesOf = (id) => {
    const prior = state.connectors?.[id] ?? {}
    return {
      level: levelOf(id),
      ...(prior.settings === undefined ? {} : { settings: prior.settings }),
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
        onAuthorized: async (id, grant) => {
          const level = grantLevelOf(id, grant) ?? levelOf(id)
          const prior = state.connectors?.[id] ?? {}
          state.connectors = { ...state.connectors, [id]: { ...prior, ...switchesOf(id), level, authorizedAt: Date.now() } }
          if (state.connectors[id].needsReauth === true) delete state.connectors[id].needsReauth
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
    for (const [callName, box] of toolboxes) if (box.id === id) toolboxes.delete(callName)
    if (mounted?.dispose !== undefined) for (const dispose of mounted.dispose) dispose()
    mounted?.close?.()
    mounted?.client?.close()
    const fiber = mounted?.fiber
    if (fiber !== undefined) await Promise.resolve().then(() => fiber.dispose()).catch(() => {})
  }

  // The MCP client wraps the server's answer (a 401, say) as the cause.
  const reason = (error) => {
    const text = [error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ')
    return rt.redactSecrets(text || 'error').slice(0, 300)
  }

  // Connectors that are not a single token (REST APIs with two keys, IMAP mailboxes) keep
  // their credentials in the same named secrets and mount through hooks the module brings.
  // The mount key tracks those values so a changed credential remounts; it is never logged.
  const credentialFieldNames = connector => credentialFields(connector).map(field => field.name)
  const credentialKeyOf = connector => credentialFieldNames(connector)
    .map(name => `${name}\u0000${rt.secretValue(name) ?? ''}`)
    .join('\u0001')
  const secretMapOf = connector => Object.fromEntries(credentialFieldNames(connector).map(name => [name, rt.secretValue(name)]))
  const configuredOf = (connector) => {
    const fields = credentialFields(connector)
    return fields.length > 0 && fields.every((field) => (field.required === false ? true : rt.secretValue(field.name) !== undefined))
  }

  // An access level is what the user let this connector do: read only, or read and write.
  // The level is stored in the team file. An older file with the `actions` or `toolbox`
  // switch on maps to write, so a connector that could already write never loses it; a
  // module may name its own default, and a notification connector sends, so it defaults to
  // write.
  const levelsOf = connector => (Array.isArray(connector.levels) && connector.levels.length > 0
    ? connector.levels
    : ['read'])
  const defaultLevelOf = connector => connector.defaultLevel ?? (connector.mode === 'notify' ? 'write' : 'read')
  const legacyLevelOf = (id) => {
    const prior = state.connectors?.[id] ?? {}
    return prior.actions === true || prior.toolbox === true ? 'write' : undefined
  }
  const storedLevelOf = id => state.connectors?.[id]?.level
  const levelOf = (id) => {
    if (rt.readOnly() !== undefined) return 'read'
    const stored = storedLevelOf(id)
    if (stored !== undefined && CONNECTOR_LEVELS.includes(stored)) return stored
    return legacyLevelOf(id) ?? defaultLevelOf(options[id])
  }
  const settingsOf = id => state.connectors?.[id]?.settings ?? {}
  // A module may say it is not ready for a level or for the settings it has (a missing
  // project id): the row stays off with that reason and no mount is attempted.
  const levelNoteOf = (id) => {
    const connector = options[id]
    if (typeof connector.unavailable === 'string' && connector.unavailable !== '') return connector.unavailable
    if (typeof connector.readiness !== 'function') return undefined
    try {
      const note = connector.readiness({ level: levelOf(id), settings: settingsOf(id) })
      return typeof note === 'string' && note !== '' ? note : undefined
    } catch (error) {
      return reason(error)
    }
  }
  // What the connector may expose at its level: the read tools always, the action tools
  // only at write level. A module may answer per level (`toolsOf`); otherwise its static
  // lists apply, and the action list is still emptied for a read level.
  const toolListsOf = (id) => {
    const connector = options[id]
    const level = levelOf(id)
    let declared
    if (typeof connector.toolsOf === 'function') {
      declared = connector.toolsOf({ level, settings: settingsOf(id) })
      if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
        throw new Error(`${connector.displayName}'s toolsOf must return { readTools, actionTools }`)
      }
    }
    const readTools = Array.isArray(declared?.readTools)
      ? declared.readTools
      : Array.isArray(connector.readTools) ? connector.readTools : []
    const actionTools = level === 'write'
      ? (Array.isArray(declared?.actionTools) ? declared.actionTools
        : Array.isArray(connector.actionTools) ? connector.actionTools : [])
      : []
    return { level, readTools, actionTools }
  }
  // A grant saved before levels existed is classified by its scopes: a scope the read
  // authorization never asked for means the grant can write. No scopes at all cannot be
  // classified, and the card asks for a new authorization.
  const grantLevelOf = (id, grant) => {
    if (grant?.level === 'read' || grant?.level === 'write') return grant.level
    const scopes = Array.isArray(grant?.scopes) ? grant.scopes : []
    if (scopes.length === 0) return undefined
    const read = new Set(Array.isArray(options[id].oauth?.scopes) ? options[id].oauth.scopes : [])
    return scopes.some(scope => !read.has(scope)) ? 'write' : 'read'
  }

  // The credentials a service hands out are checked once, when they are saved. A module may
  // bring its own `verify` hook (a POST login, an IMAP login); a connector with a `checkPath`
  // falls back to the GET signIn; one with neither is accepted once the credentials exist.
  const verifyConnector = async (id, connector, values) => {
    // A protocol the framework does not speak checks its own credentials; the hook gets the
    // single token and returns the state fields (an account name, usually).
    if (typeof connector.signIn === 'function') {
      const extra = await connector.signIn(values[connector.tokenSecret] ?? Object.values(values)[0])
      return extra !== null && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}
    }
    if (typeof connector.verify === 'function') {
      const token = values[connector.tokenSecret] ?? Object.values(values)[0]
      const extra = await connector.verify({ token, secrets: { ...values }, api: connector.api })
      return extra !== null && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}
    }
    if (typeof connector.checkPath === 'string' && connector.checkPath !== '') {
      const token = values[connector.tokenSecret] ?? Object.values(values)[0]
      return await signIn(id, token, { api: connector.api })
    }
    return {}
  }

  // One REST tool definition per read-only request (the module brings the method, path,
  // mapping and envelope; the framework only ever runs what it declares).
  function mountRestTools(id) {
    const connector = options[id]
    const secrets = secretMapOf(connector)
    const dispose = []
    try {
      for (const tool of createRestTools(id, connector, {
        token: secrets[connector.tokenSecret],
        secrets,
        output,
        redact: rt.redactSecrets,
      })) dispose.push(ctx.tools.register(tool))
    } catch (error) {
      for (const undo of dispose) undo()
      throw error
    }
    return { token: credentialKeyOf(connector), dispose }
  }

  // A connector whose protocol the framework does not know mounts its own tools through
  // `mountTools`, which returns disposers and an optional close.
  function mountConnectorTools(id) {
    const connector = options[id]
    const mount = connector.mountTools ?? connector.mount
    if (typeof mount !== 'function') throw new Error(`${connector.displayName} has no tools to mount`)
    const secrets = secretMapOf(connector)
    const mounted = mount({
      ctx,
      rt,
      connector,
      token: secrets[connector.tokenSecret],
      secrets,
      state: state.connectors?.[id],
      output,
      redact: rt.redactSecrets,
    })
    if (mounted === undefined || mounted === null) return { token: credentialKeyOf(connector), dispose: [] }
    // A module may hand back already-built tools or its own disposers.
    const dispose = Array.isArray(mounted.tools)
      ? mounted.tools.map(tool => ctx.tools.register(tool))
      : Array.isArray(mounted.dispose) ? mounted.dispose : []
    return {
      token: credentialKeyOf(connector),
      dispose,
      ...(typeof mounted.close === 'function' ? { close: mounted.close } : {}),
    }
  }

  // A notification connector's token is its first credential; the chat id lives in the
  // team file and is found at connect time, typed by the user, or looked for again by Test.
  const tokenNameOf = connector => connector.tokenSecret ?? credentialFields(connector)[0]?.name
  const notifyTokenOf = (connector) => {
    const name = tokenNameOf(connector)
    return name === undefined ? undefined : rt.secretValue(name)
  }
  // A module asks its service which chat wrote to the bot. A failure leaves the connector
  // connected: the card asks the user to message the bot and Test looks again.
  const discoverChat = async (connector, token) => {
    const hook = connector.notify?.discoverChatId
    if (typeof hook !== 'function' || token === undefined) return {}
    const found = await hook({ token, secrets: secretMapOf(connector), api: connector.api })
    return found !== null && typeof found === 'object' && !Array.isArray(found) ? found : {}
  }
  const rememberChat = (id, found) => {
    if (typeof found?.chatId !== 'string' || found.chatId === '') return false
    state.connectors = { ...state.connectors, [id]: { ...state.connectors?.[id], chatId: found.chatId } }
    return true
  }

  // The send tool exists only while the connector has a token and a chat to send to. A
  // valid token without a chat is still connected; the card asks for that first message.
  function mountNotify(id) {
    const connector = options[id]
    const tokenName = tokenNameOf(connector)
    if (tokenName === undefined) throw new Error(`${connector.displayName} has no token credential`)
    if (typeof connector.notify?.send !== 'function') throw new Error(`${connector.displayName} has no send hook`)
    if (levelOf(id) !== 'write') return { token: credentialKeyOf(connector), dispose: [] }
    if (connector.needsChatId === true && chatIdOf(state, id) === undefined) return { token: credentialKeyOf(connector), dispose: [] }
    const dispose = [ctx.tools.register(createNotifyTool({
      name: connector.notify.toolName ?? `notify_${id}`,
      description: connector.notify.toolDescription ?? `Send a message through ${connector.displayName}. Use it for notifications the user asked for.`,
      maxText: connector.notify.maxText,
      output,
      redact: rt.redactSecrets,
      send: text => connector.notify.send({
        token: rt.secretValue(tokenName),
        chatId: chatIdOf(state, id),
        text,
        secrets: secretMapOf(connector),
        api: connector.api,
      }),
    }))]
    return { token: credentialKeyOf(connector), dispose }
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

  // One tool of a `read-tools` connector, as a ToolRuntime definition. `approve` is set
  // for a named write action, which asks the user before it runs.
  const readOnlyTool = (id, tool, { client, teamId, approve, defaults }) => {
    const parameters = tool.inputSchema !== null && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }
    return {
      name: `${id}_${String(tool.name).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64),
      description: String(tool.description ?? tool.title ?? tool.name),
      parameters,
      output,
      async execute(args, exec) {
        if (approve !== undefined) await approve(exec)
        const call = { ...args }
        // The default team of the token's account answers the calls that need one; an
        // explicit argument wins.
        if (teamId !== undefined && parameters.properties?.teamId !== undefined && call.teamId === undefined) call.teamId = teamId
        // A connector's own default account answers account-scoped calls; an explicit
        // argument wins, and a parameter the tool does not take is never added.
        for (const [name, value] of Object.entries((typeof defaults === 'function' ? defaults() : defaults) ?? {})) {
          if (value !== undefined && parameters.properties?.[name] !== undefined && call[name] === undefined) call[name] = value
        }
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

  // A Cloudflare account id is 32 hex characters; anything else stored as `accountId` is
  // the user identity whoami reported and cannot answer an account-scoped call.
  const looksAccountId = value => typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value)

  const accountsFromText = (text) => {
    let value
    try {
      value = JSON.parse(text)
    } catch {
      return []
    }
    const list = Array.isArray(value) ? value : Array.isArray(value?.result) ? value.result : []
    return list.filter(item => item !== null && typeof item === 'object' && looksAccountId(item.id))
  }

  // An OAuth connector has no token to ask who it belongs to; its server's own read tools
  // do. One call fills the card's account line, and a second names the account that
  // account-scoped API calls default to — no re-authorization is needed for either.
  const claimOAuthAccount = async (id, client) => {
    const connector = options[id]
    if (connector.accountTool === undefined) return
    let changed = false
    const update = (fields) => {
      state.connectors = { ...state.connectors, [id]: { ...state.connectors?.[id], ...fields } }
      changed = true
    }
    try {
      if (state.connectors?.[id]?.account === undefined) {
        const text = mcpResultText(await client.callTool(connector.accountTool, {}))
        let identity
        try {
          identity = JSON.parse(text)
        } catch {
          identity = undefined
        }
        const derived = typeof connector.accountOf === 'function' ? connector.accountOf(identity) : undefined
        const account = typeof derived === 'string' && derived !== ''
          ? derived
          : typeof identity?.email === 'string' && identity.email !== ''
            ? identity.email
            : typeof identity?.name === 'string' && identity.name !== '' ? identity.name : undefined
        const identityId = typeof identity?.id === 'string' && identity.id !== '' ? identity.id : undefined
        if (account !== undefined) update({ account })
        if (identityId !== undefined && state.connectors?.[id]?.accountId === undefined) update({ accountId: identityId })
      }
      // The account list answers the account id the API tools take, even when a previous
      // run stored the user id from whoami.
      if (connector.accountIdTool !== undefined && !looksAccountId(state.connectors?.[id]?.accountId)) {
        const accounts = accountsFromText(mcpResultText(await client.callTool(connector.accountIdTool, {})))
        const first = accounts[0]
        if (first !== undefined) {
          update({ accountId: first.id, ...(typeof first.name === 'string' && first.name !== '' ? { accountName: first.name } : {}) })
        }
      }
      if (changed) await rt.save()
    } catch (error) {
      rt.warn('ds-bot: could not read the %s account: %s', connector.displayName, reason(error))
    }
  }

  async function mountReadTools(id, token, { refresh, url } = {}) {
    const connector = options[id]
    const client = new McpHttpClient(url ?? connector.url, token, refresh === undefined ? {} : { refresh })
    try {
      await client.open()
      const listed = await client.listTools()
      const { level, readTools, actionTools } = toolListsOf(id)
      // The toolbox is the write level's vendor catalog; it replaces the named action tools
      // (the action runs through the call tool, still approved per call) so nothing is
      // offered twice.
      const toolbox = connector.toolbox === true && level === 'write'
      const actions = toolbox ? [] : actionTools
      const wanted = [...readTools, ...actions]
      const picked = listed.filter(tool => wanted.includes(tool.name))
      if (picked.length === 0) throw new Error(`${connector.displayName} offers none of the read tools DS Bot exposes`)
      const cloudflareToolbox = toolbox && connector.toolboxKind === 'cloudflare'
      const index = toolbox ? (cloudflareToolbox ? buildCloudflareToolIndex(listed) : buildToolIndex(listed)) : undefined
      const teamId = state.connectors?.[id]?.teamId ?? connector.teamId
      const currentAccountId = () => (looksAccountId(state.connectors?.[id]?.accountId) ? state.connectors[id].accountId : undefined)
      const defaults = () => {
        const accountId = currentAccountId()
        return accountId === undefined ? {} : { account_id: accountId }
      }
      const actionNames = new Set(actions)
      const dispose = []
      try {
        for (const tool of picked) {
          const approve = actionNames.has(tool.name) ? exec => requireApproval(connector, tool.name, exec) : undefined
          dispose.push(ctx.tools.register(readOnlyTool(id, tool, { client, teamId, approve, defaults })))
        }
        if (index !== undefined) {
          if (cloudflareToolbox) {
            const blocked = new Set(listed.map(tool => String(tool?.name ?? '')).filter(name => name !== '' && isBlockedCloudflareTool(name)))
            dispose.push(ctx.tools.register(createCloudflareSearchTool({ index, output })))
            dispose.push(ctx.tools.register(createCloudflareCallTool({
              client,
              index,
              output,
              redact: rt.redactSecrets,
              accountId: currentAccountId,
              approve: (name, exec) => requireApproval(connector, name, exec),
            })))
            toolboxes.set(CLOUDFLARE_TOOLBOX_TOOLS[1], { id, connector, blocked, kind: 'cloudflare' })
          } else {
            dispose.push(ctx.tools.register(createSearchTool({ index, output })))
            dispose.push(ctx.tools.register(createCallTool({
              client,
              index,
              output,
              redact: rt.redactSecrets,
              teamId,
              approve: (name, exec) => requireApproval(connector, name, exec),
            })))
            const blocked = new Set(index.filter(entry => entry.class === 'blocked').map(entry => entry.name))
            toolboxes.set('vercel_call', { id, connector, blocked, kind: 'vercel' })
          }
        }
      } catch (error) {
        for (const undo of dispose) undo()
        throw error
      }
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
    let mountUrl
    if (!stopped) {
      if (oauthConnector) {
        try {
          const grant = await oauth.token(id)
          token = grant?.tokens.access
          mountUrl = grant?.mountUrl
          // The grant carries the level the user authorized. A grant saved before levels
          // existed is classified once here and stored, so the view and the mount agree.
          if (grant !== undefined) {
            const inferred = grantLevelOf(id, grant)
            const level = inferred ?? levelOf(id)
            const patch = {
              ...(storedLevelOf(id) === level ? {} : { level }),
              ...(inferred === undefined ? { needsReauth: true } : {}),
              ...(inferred !== undefined && state.connectors?.[id]?.needsReauth === true ? { needsReauth: false } : {}),
            }
            if (Object.keys(patch).length > 0) {
              state.connectors = { ...state.connectors, [id]: { ...(state.connectors?.[id] ?? {}), ...patch } }
              await rt.save()
            }
          }
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
      } else if (connector.mode === 'rest-tools' || connector.mode === 'imap' || connector.mode === 'custom' || connector.mode === 'notify') {
        token = configuredOf(connector) ? credentialKeyOf(connector) : undefined
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
    // A connector that says it is not ready for the level or settings it has shows the
    // reason on its row and is not mounted; that is a setup step, not a failure.
    const note = levelNoteOf(id)
    if (note !== undefined) {
      mounts.set(id, { token })
      statuses.set(id, { state: 'off' })
      return
    }
    statuses.set(id, { state: 'connecting' })
    const attempt = { token }
    mounts.set(id, attempt)
    if (connector.mode === 'read-tools') {
      await claimAccount(id, token, replaced)
      if (stopped || mounts.get(id) !== attempt) return
    }
    if (connector.mode === 'rest-tools' || connector.mode === 'imap' || connector.mode === 'custom' || connector.mode === 'notify') {
      try {
        const mounted = connector.mode === 'rest-tools'
          ? mountRestTools(id)
          : connector.mode === 'notify' ? mountNotify(id) : mountConnectorTools(id)
        if (stopped || mounts.get(id) !== attempt) {
          for (const undo of mounted.dispose) undo()
          mounted.close?.()
          return
        }
        mounts.set(id, mounted)
        statuses.set(id, { state: 'ready' })
      } catch (error) {
        await unmount(id)
        mounts.set(id, { token })
        statuses.set(id, { state: 'error', error: reason(error) })
        rt.warn('ds-bot: %s connector failed: %s', connector.displayName, statuses.get(id).error)
      }
      return
    }
    const loader = ctx.get?.('loader')
    if (connector.mode === 'mcp-client' && (typeof loader?.import !== 'function' || typeof ctx.plugin !== 'function')) {
      statuses.set(id, { state: 'error', error: 'This DSH cannot load connectors' })
      return
    }
    try {
      if (connector.mode !== 'mcp-client') {
        const mounted = await mountReadTools(id, token, {
          refresh: oauthConnector ? refreshFor(id) : undefined,
          ...(mountUrl === undefined ? {} : { url: mountUrl }),
        })
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
    if (connector.mode === 'rest-tools' || connector.mode === 'imap' || connector.mode === 'custom') {
      return configuredOf(connector) ? state.connectors?.[id]?.account ?? null : null
    }
    if (connector.mode === 'notify') return notifyTokenOf(connector) === undefined ? null : state.connectors?.[id]?.account ?? null
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
      // The access level the user chose; every write tool is gated by it.
      level: levelOf(id),
      levels: levelsOf(connector),
      ...(Array.isArray(connector.settings) && connector.settings.length > 0
        ? {
            settings: connector.settings.map(field => ({
              name: field.name,
              ...(typeof field.label === 'string' && field.label !== '' ? { label: field.label } : {}),
              ...(settingsOf(id)[field.name] === undefined ? {} : { value: settingsOf(id)[field.name] }),
            })),
          }
        : {}),
      ...(levelNoteOf(id) === undefined ? {} : { levelNote: levelNoteOf(id) }),
      ...(state.connectors?.[id]?.needsReauth === true ? { needsReauth: true } : {}),
      ...((connector.mode === 'rest-tools' || connector.mode === 'imap' || connector.mode === 'custom')
        ? { mode: connector.mode, inputs: credentialFields(connector) }
        : {}),
      ...(connector.mode === 'notify'
        ? {
            mode: 'notify',
            chatId: connector.needsChatId === true ? chatIdOf(state, id) ?? null : null,
            canTest: notifyTokenOf(connector) !== undefined,
            inputs: credentialFields(connector),
          }
        : {}),
      ...(connector.card === undefined ? {} : { card: connector.card }),
      // Display data only: what the connector can do and what its grant asks for. A client
      // renders what it knows and hides a block whose fields are missing.
      ...(connector.capabilities === undefined ? {} : { capabilities: connector.capabilities }),
      ...(connector.permissions === undefined ? {} : { permissions: connector.permissions }),
      ...Object.fromEntries(['readOnly', 'readOnlyNote', 'glyph', 'about', 'docsUrl']
        .filter(key => connector[key] !== undefined)
        .map(key => [key, connector[key]])),
      // Legacy fields for one release: the client reads the level now; these report what
      // the level already decides.
      ...(connector.actionTools === undefined ? {} : { actions: levelOf(id) === 'write' }),
      ...(connector.toolbox === true
        ? {
            toolbox: levelOf(id) === 'write',
            toolboxCall: connector.toolboxKind === 'cloudflare' ? CLOUDFLARE_TOOLBOX_TOOLS[1] : 'vercel_call',
          }
        : {}),
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
      if (insecure(body.id)) throw new Error(insecureText(body.id))
      if (connector.mode === 'rest-tools' || connector.mode === 'imap' || connector.mode === 'custom' || connector.mode === 'notify') {
        await rt.loadSecrets()
        const prior = state.connectors?.[body.id]
        // A single-token card may still post `token`; the module's declared credential
        // takes that value under its own name.
        const fields = credentialFields(connector)
        const single = fields.length === 1 && (body.values === null || typeof body.values !== 'object')
        const values = connectValues(connector, single ? { ...body, values: { [fields[0].name]: body.token } } : body)
        const account = await verifyConnector(body.id, connector, values)
        state.connectors = { ...state.connectors, [body.id]: { ...switchesOf(body.id), ...account, connectedAt: Date.now() } }
        try {
          for (const [name, value] of Object.entries(values)) {
            const kept = rt.secretValue(name) !== undefined
            await rt.secretEndpoint('secret-set', { name, value, purpose: `${connector.displayName} connector`, ...(kept ? {} : { scope: [] }) })
          }
        } catch (error) {
          if (prior === undefined) delete state.connectors[body.id]
          else state.connectors = { ...state.connectors, [body.id]: prior }
          throw error
        }
        // The chat the bot already hears from is filled in now. A token without a chat
        // still connects: the card asks for the first message and Test looks again.
        if (connector.mode === 'notify' && connector.needsChatId === true) {
          try {
            rememberChat(body.id, await discoverChat(connector, values[tokenNameOf(connector)]))
          } catch (error) {
            rt.warn('ds-bot: could not look for the %s chat: %s', connector.displayName, reason(error))
          }
        }
        await rt.save()
        await sync(body.id, true)
        return connectorsView()
      }
      if (token === '') throw new Error('Paste a token first')
      await rt.loadSecrets()
      const prior = state.connectors?.[body.id]
      const kept = rt.secretValue(connector.tokenSecret) !== undefined
      const account = await signIn(body.id, token, { api: connector.api })
      // The account is written before the secret, so the mount the secret change starts
      // already knows the default team it hands to the read tools.
      state.connectors = { ...state.connectors, [body.id]: { ...switchesOf(body.id), ...account, connectedAt: Date.now() } }
      try {
        await rt.secretEndpoint('secret-set', { name: connector.tokenSecret, value: token, purpose: `${connector.displayName} connector`, ...(kept ? {} : { scope: [] }) })
      } catch (error) {
        if (prior === undefined) delete state.connectors[body.id]
        else state.connectors = { ...state.connectors, [body.id]: prior }
        throw error
      }
      await rt.save()
      await sync(body.id)
      return connectorsView()
    },
    // The browser half of an OAuth connect: DS Bot answers with the provider's authorize
    // address, the client opens it, and the provider sends the browser back to the
    // callback route the flow registered. The level picks the authorization the module
    // asks for (Neon: a read-only MCP URL or a full one) and is stored with the grant.
    async 'connector-oauth-start'(body, meta) {
      known(body.id)
      const connector = options[body.id]
      if (connector.mode !== 'oauth-mcp' || oauth === undefined) throw new Error(`${connector.displayName} connects with a token, not OAuth`)
      const levels = levelsOf(connector)
      const level = body.level ?? storedLevelOf(body.id) ?? defaultLevelOf(connector)
      if (!levels.includes(level)) throw new Error(`${connector.displayName} has no ${String(level)} access level`)
      const readOnly = rt.readOnly()
      if (readOnly !== undefined && level === 'write') throw new Error(`DS Bot is read-only: ${readOnly}`)
      const note = levelNoteOf(body.id)
      if (note !== undefined) throw new Error(note)
      return await oauth.start(body.id, { origin: meta.origin, level, settings: settingsOf(body.id) })
    },
    async 'connector-disconnect'(body, meta) {
      known(body.id)
      const connector = options[body.id]
      // Who took a connector away, and from where: a connector entry disappearing is the
      // one change a user may need to trace later. No token or secret is recorded.
      rt.diagnostics?.record?.({
        source: 'connector-disconnect',
        text: `${connector.displayName} (${body.id}) disconnected from ${typeof meta?.origin === 'string' && meta.origin !== '' ? meta.origin : 'an unknown origin'}`,
      })
      // The settings and the chosen level describe the connector, not the grant: a
      // reconnect should not ask for the project id and role again.
      const kept = (id) => {
        const prior = state.connectors?.[id] ?? {}
        return {
          ...(prior.settings === undefined ? {} : { settings: prior.settings }),
          ...(prior.level === undefined ? {} : { level: prior.level }),
        }
      }
      if (connector.mode === 'oauth-mcp') {
        await oauth.disconnect(body.id)
        const remaining = kept(body.id)
        if (Object.keys(remaining).length > 0) state.connectors = { ...state.connectors, [body.id]: remaining }
        else if (state.connectors?.[body.id] !== undefined) delete state.connectors[body.id]
        await rt.save()
        await sync(body.id, true)
        return connectorsView()
      }
      await rt.loadSecrets()
      const names = new Set([...credentialFieldNames(connector), ...(connector.tokenSecret === undefined ? [] : [connector.tokenSecret])])
      for (const name of names) {
        if (rt.secretValue(name) !== undefined) await rt.secretEndpoint('secret-delete', { name })
      }
      const remaining = kept(body.id)
      if (Object.keys(remaining).length > 0) state.connectors = { ...state.connectors, [body.id]: remaining }
      else if (state.connectors?.[body.id] !== undefined) delete state.connectors[body.id]
      await rt.save()
      await sync(body.id)
      return connectorsView()
    },
    // The access level the user chose. An authorized OAuth connector has to authorize
    // again, because the level is fixed by the grant; a connector with a saved secret just
    // remounts, since the level only decides which tools are registered.
    async 'connector-set-level'(body) {
      known(body.id)
      const connector = options[body.id]
      const level = typeof body.level === 'string' ? body.level : ''
      if (!levelsOf(connector).includes(level)) throw new Error(`${connector.displayName} has no ${level === '' ? 'such' : level} access level`)
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) throw new Error(`DS Bot is read-only: ${readOnly}`)
      const prior = state.connectors?.[body.id] ?? {}
      const authorized = connector.mode === 'oauth-mcp' && (prior.authorizedAt !== undefined || prior.account !== undefined)
      if (authorized) {
        await oauth.disconnect(body.id)
        state.connectors = {
          ...state.connectors,
          [body.id]: {
            ...(prior.settings === undefined ? {} : { settings: prior.settings }),
            level,
            needsReauth: true,
          },
        }
      } else {
        state.connectors = { ...state.connectors, [body.id]: { ...prior, level } }
      }
      await rt.save()
      await sync(body.id, true)
      return connectorsView()
    },
    // Plain configuration a connector needs (a project id, a role). It is not a secret, so
    // it lives in the team file; a module may normalize and refuse the values.
    async 'connector-set-settings'(body) {
      known(body.id)
      const connector = options[body.id]
      if (!Array.isArray(connector.settings) || connector.settings.length === 0) throw new Error(`${connector.displayName} has no settings`)
      const values = body.values !== null && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {}
      let settings
      if (typeof connector.normalizeSettings === 'function') {
        const normalized = connector.normalizeSettings({ ...values })
        settings = normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized) ? normalized : {}
      } else {
        settings = {}
        for (const field of connector.settings) {
          if (typeof values[field.name] === 'string') settings[field.name] = values[field.name].trim()
        }
      }
      const prior = state.connectors?.[body.id] ?? {}
      const authorized = connector.mode === 'oauth-mcp' && typeof connector.authorize === 'function'
        && (prior.authorizedAt !== undefined || prior.account !== undefined)
      if (authorized) {
        await oauth.disconnect(body.id)
        state.connectors = { ...state.connectors, [body.id]: { ...prior, settings, needsReauth: true } }
      } else {
        state.connectors = { ...state.connectors, [body.id]: { ...prior, settings } }
      }
      await rt.save()
      await sync(body.id, true)
      return connectorsView()
    },
    async 'connector-retry'(body) {
      known(body.id)
      await rt.loadSecrets()
      await sync(body.id, true)
      return connectorsView()
    },
    // One test message through the module's real send path. The token is good, so a
    // failure shows on the card without turning the connector off.
    async 'connector-test'(body) {
      known(body.id)
      const connector = options[body.id]
      if (connector.mode !== 'notify') throw new Error('This connector has no test message')
      await rt.loadSecrets()
      const token = notifyTokenOf(connector)
      if (token === undefined) throw new Error('Connect this connector first')
      const tested = (error) => {
        statuses.set(body.id, error === undefined ? { state: 'ready' } : { state: 'ready', error })
        return connectorsView()
      }
      if (connector.needsChatId === true && chatIdOf(state, body.id) === undefined) {
        let found
        try {
          found = await discoverChat(connector, token)
        } catch (error) {
          return tested(reason(error))
        }
        if (Array.isArray(found.candidates)) return tested(connector.notify.multipleChatsText ?? 'Several chats are available: type the chat id you want.')
        if (!rememberChat(body.id, found)) return tested(connector.notify.missingChatText ?? 'Message the bot first, then press Test again.')
        await rt.save()
        await sync(body.id, true)
      }
      try {
        const text = typeof connector.notify.testText === 'string' && connector.notify.testText !== '' ? connector.notify.testText : NOTIFY_TEST_TEXT
        await connector.notify.send({ token, chatId: chatIdOf(state, body.id), text, secrets: secretMapOf(connector), api: connector.api })
      } catch (error) {
        return tested(reason(error))
      }
      return tested(undefined)
    },
    // A typed chat id, or an empty string to clear it and wait for the next message.
    async 'connector-set-chat'(body) {
      known(body.id)
      const connector = options[body.id]
      if (connector.needsChatId !== true) throw new Error('This connector has no chat id')
      const chatId = parseChatId(connector, body.chatId)
      const prior = { ...state.connectors?.[body.id] }
      if (chatId === undefined) delete prior.chatId
      else prior.chatId = chatId
      state.connectors = { ...state.connectors, [body.id]: prior }
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
      approval.dispose()
      oauth?.dispose()
      for (const id of ids) void unmount(id)
    }
  }, 'ds-bot: connectors')

  Object.assign(rt, {
    connectorsView,
    connectorEndpoint,
    secretsChanged: () => { for (const id of ids) void sync(id) },
    answerConnectorApproval: (sessionId, questionId, body) => approval.answer(sessionId, questionId, body),
    dismissConnectorApproval: (sessionId, questionId) => approval.dismiss(sessionId, questionId),
    cancelConnectorApprovals: (sessionId, outcome) => approval.cancel(sessionId, outcome),
  })
}
