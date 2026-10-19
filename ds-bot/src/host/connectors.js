// Connectors: outside services every Bot can use. A connector's tools are mounted on the
// plugin context, so every Bot and Session gets them.
//
// GitHub uses DSH's own MCP client and the toolsets GitHub's server offers. A service
// without a server-side tool filter (Vercel) goes through `mcp.js` instead: DS Bot opens
// the session itself and registers only the read tools the connector names, so the write
// tools are never in a model's context and cannot be called at all. A service with only a
// REST API gets `rest-tools`: one read-only GET per tool, defined in the registry. Slack
// and Telegram are notification connectors: they send one message a Bot was asked to send.
//
// The token is the connector's own secret (secrets.js keeps it, redacts it, and offers it
// to the shell). It reaches the service only in the MCP request headers, built here in
// memory, never written to the DSH profile. A new token is shared with no Bot's shell:
// the tools do not need it there, and a Bot that reads a planted instruction in an issue
// could send it anywhere. The Secrets page can still share it.
import { McpHttpClient, mcpResultText } from './mcp.js'
import { createSlackTool, createTelegramTool, sendSlack, sendTelegram, verifySlack, verifyTelegram } from './notify.js'
import { createRestTools } from './rest-tools.js'
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

// Every connector, by the id its tools and the team file use. A profile overrides `url`
// or `api` per service, or hides it with `false`. `mode` picks how its tools are mounted:
// `mcp-client` mounts the whole server through DSH, `read-tools` registers only
// `readTools` through DS Bot's own client. `toolsets` is a server-side filter header;
// `accountField` is the field signIn reads, and `accountExtra` keeps what else the answer
// carries (Vercel's default team).
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
  slack: {
    displayName: 'Slack',
    mode: 'notify',
    tokenSecret: 'SLACK_WEBHOOK_URL',
    accountField: 'username',
  },
  telegram: {
    displayName: 'Telegram',
    mode: 'notify',
    api: 'https://api.telegram.org',
    tokenSecret: 'TELEGRAM_BOT_TOKEN',
    needsChatId: true,
    accountField: 'username',
  },
}

// How each notification connector checks its secret, builds its tools and sends one
// message; the test button uses the same send.
const TEST_TEXT = 'DS Bot: the connection works.'
const NOTIFY = {
  slack: {
    verify: (token, { api, fetch: request }) => verifySlack(token, { api, fetch: request }),
    tools: ({ token, redact, fetch: request }) => [createSlackTool({ webhook: token, redact, fetch: request })],
    send: ({ token, text, fetch: request }) => sendSlack({ webhook: token, text, fetch: request }),
  },
  telegram: {
    verify: (token, { api, fetch: request }) => verifyTelegram(token, { api, fetch: request }),
    tools: ({ token, chatId, api, redact, fetch: request }) => [createTelegramTool({ token, chatId, api, redact, fetch: request })],
    send: ({ token, chatId, text, api, fetch: request }) => sendTelegram({ token, chatId, text, api, fetch: request }),
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
  const insecure = id => [options[id].url, options[id].api].filter(address => address !== undefined).some(address => !/^https:\/\//i.test(String(address)))
  const insecureText = id => `${options[id].displayName} addresses must start with https://`
  // The switches a connect or an account probe must carry over instead of dropping.
  const switchesOf = (id) => {
    const prior = state.connectors?.[id] ?? {}
    return {
      ...(typeof prior.actions === 'boolean' ? { actions: prior.actions } : {}),
      ...(typeof prior.toolbox === 'boolean' ? { toolbox: prior.toolbox } : {}),
    }
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

  async function mountReadTools(id, token) {
    const connector = options[id]
    const client = new McpHttpClient(connector.url, token)
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

  // A notification connector registers its one tool as soon as its secret exists. The
  // Telegram chat id lives in the team file, so mounting needs no network call.
  function mountNotify(id, token) {
    const connector = options[id]
    const chatId = state.connectors?.[id]?.chatId
    if (connector.needsChatId === true && typeof chatId !== 'string') {
      mounts.set(id, { token })
      statuses.set(id, { state: 'error', error: 'Add the chat id the message goes to.' })
      return undefined
    }
    const dispose = []
    try {
      for (const tool of NOTIFY[id].tools({ token, chatId, api: connector.api, redact: rt.redactSecrets, output })) dispose.push(ctx.tools.register(tool))
    } catch (error) {
      for (const undo of dispose) undo()
      throw error
    }
    return { token, dispose }
  }

  function mountRestTools(id, token) {
    const dispose = []
    try {
      for (const tool of createRestTools(id, options[id], { token, output, redact: rt.redactSecrets })) dispose.push(ctx.tools.register(tool))
    } catch (error) {
      for (const undo of dispose) undo()
      throw error
    }
    return { token, dispose }
  }

  async function reconcile(id, force) {
    const connector = options[id]
    const previous = mounts.get(id)?.token
    const token = !stopped ? rt.secretValue(connector.tokenSecret) : undefined
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
    if (connector.mode === 'notify' || connector.mode === 'rest-tools') {
      try {
        const mounted = connector.mode === 'notify' ? mountNotify(id, token) : mountRestTools(id, token)
        if (mounted === undefined) return
        if (stopped || mounts.get(id) !== attempt) {
          for (const undo of mounted.dispose) undo()
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
      if (connector.mode === 'read-tools') {
        const mounted = await mountReadTools(id, token)
        if (stopped || mounts.get(id) !== attempt) {
          for (const undo of mounted.dispose) undo()
          mounted.client.close()
          return
        }
        mounts.set(id, mounted)
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

  const connectorsView = () => ids.map(id => {
    const connector = options[id]
    const status = statuses.get(id) ?? { state: 'off' }
    return {
      id,
      name: connector.displayName,
      state: status.state,
      ...(status.error !== undefined ? { error: status.error } : {}),
      account: rt.secretValue(connector.tokenSecret) !== undefined ? state.connectors?.[id]?.[connector.accountField] ?? null : null,
      ...(connector.actionTools === undefined ? {} : { actions: state.connectors?.[id]?.actions === true }),
      ...(connector.toolbox === true ? { toolbox: state.connectors?.[id]?.toolbox === true } : {}),
      ...(connector.mode === 'notify' ? {
        testable: true,
        ...(typeof state.connectors?.[id]?.chatId === 'string' ? { chatId: state.connectors[id].chatId } : {}),
      } : {}),
    }
  })

  const known = id => {
    if (!Object.hasOwn(options, id)) throw new Error('No such connector')
  }

  const endpoints = {
    async 'connector-connect'(body) {
      known(body.id)
      const connector = options[body.id]
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token === '') throw new Error('Paste a token first')
      if (insecure(body.id)) throw new Error(insecureText(body.id))
      await rt.loadSecrets()
      const kept = rt.secretValue(connector.tokenSecret) !== undefined
      const account = connector.mode === 'notify' ? await NOTIFY[body.id].verify(token, { api: connector.api }) : await signIn(body.id, token, { api: connector.api })
      const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : ''
      if (connector.needsChatId === true && chatId === '') throw new Error('Add the chat id the message goes to.')
      // What the mount needs is written before the secret, so the mount the secret change
      // starts already knows the account (and a Telegram chat id).
      state.connectors = { ...state.connectors, [body.id]: { ...switchesOf(body.id), ...account, ...(chatId === '' ? {} : { chatId }), connectedAt: Date.now() } }
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
    async 'connector-disconnect'(body) {
      known(body.id)
      const connector = options[body.id]
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
    async 'connector-test'(body) {
      known(body.id)
      const connector = options[body.id]
      if (connector.mode !== 'notify') throw new Error('This connector cannot send a test message')
      await rt.loadSecrets()
      const token = rt.secretValue(connector.tokenSecret)
      if (token === undefined) throw new Error('Connect this connector first')
      try {
        await NOTIFY[body.id].send({ token, chatId: state.connectors?.[body.id]?.chatId, text: TEST_TEXT, api: connector.api })
      } catch (error) {
        throw new Error(reason(error))
      }
      return { sent: true }
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

  const connectorEndpoint = (endpoint, body) => endpoints[endpoint](body ?? {})

  ctx.effect(() => {
    stopped = false
    void rt.loadSecrets().then(() => { for (const id of ids) void sync(id) })
    return () => {
      stopped = true
      for (const id of ids) void unmount(id)
    }
  }, 'ds-bot: connectors')

  Object.assign(rt, { connectorsView, connectorEndpoint, secretsChanged: () => { for (const id of ids) void sync(id) } })
}
