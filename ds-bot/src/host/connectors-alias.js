// The bridge's alias layer: every old connector tool name stays callable while the six
// covered connectors run on the upstream catalog+gateway host. Read and write aliases point
// at the same upstream MCP tool the server publishes; Gmail and QQ Mail keep the fork's
// `_imap` tools through the mail shim, because upstream mail has no folders, attachments or
// labels. The alias host mounts only names the old connector exposed at its old level, and
// every old write still asks on the connector approval card before anything runs.
import { buildCloudflareToolIndex, createCloudflareCallTool, createCloudflareSearchTool } from './cloudflare-toolbox.js'
import { createMailShim } from './connectors-mail-shim.js'
import { McpHttpClient, mcpResultText } from './mcp.js'
import { output } from './tools.js'
import { buildToolIndex, createCallTool, createSearchTool } from './vercel-toolbox.js'
import { ACTION_TOOLS as GITHUB_ACTION_TOOLS, approvalFor as githubApproval, READ_TOOLS as GITHUB_READ_TOOLS } from './connectors/github.js'
import { GMAIL_SEND_TOOLS, GMAIL_TOOLS, GMAIL_WRITE_TOOLS } from './connectors/gmail.js'
import { NEON_READ_TOOLS, NEON_WRITE_TOOLS, neonActionApproval } from './connectors/neon.js'
import { QQMAIL_TOOLS, QQMAIL_WRITE_TOOLS } from './connectors/qqmail.js'
import { CLOUDFLARE_READ_TOOLS, VERCEL_ACTION_TOOLS, VERCEL_READ_TOOLS } from './connectors.js'
import { mailSecretName } from './connectors/mail/presets.js'
import { tokenSecretOf } from './connectors/catalog.js'

export const NEON_ID = /^neon(-\d+)?$/
export const MCP_CONNECTORS = ['github', 'vercel', 'cloudflare']

const MCP_READ = {
  github: GITHUB_READ_TOOLS,
  vercel: VERCEL_READ_TOOLS,
  cloudflare: CLOUDFLARE_READ_TOOLS,
  neon: NEON_READ_TOOLS,
}

const aliasesOf = (id, tools) => tools.map(tool => ({ old: `${id}_${tool}`, connector: id, tool, kind: 'mcp' }))

export const READ_ALIASES = Object.freeze({
  ...Object.fromEntries(Object.entries(MCP_READ).map(([id, tools]) => [id, aliasesOf(id, tools)])),
  gmail: GMAIL_TOOLS.map(name => ({ old: name, connector: 'gmail', tool: name, kind: 'mail-shim' })),
  qqmail: QQMAIL_TOOLS.map(name => ({ old: name, connector: 'qqmail', tool: name, kind: 'mail-shim' })),
})

export const WRITE_ALIASES = Object.freeze({
  github: aliasesOf('github', GITHUB_ACTION_TOOLS).map(alias => ({ ...alias, write: true })),
  vercel: aliasesOf('vercel', VERCEL_ACTION_TOOLS).map(alias => ({ ...alias, write: true })),
  neon: aliasesOf('neon', NEON_WRITE_TOOLS).map(alias => ({ ...alias, write: true })),
  gmail: [...GMAIL_WRITE_TOOLS, ...GMAIL_SEND_TOOLS].map(name => ({ old: name, connector: 'gmail', tool: name, kind: 'mail-shim', write: true })),
  qqmail: QQMAIL_WRITE_TOOLS.map(name => ({ old: name, connector: 'qqmail', tool: name, kind: 'mail-shim', write: true })),
})

const baseOf = id => (NEON_ID.test(id) ? 'neon' : id)
const instanceAliases = (id, list) => {
  const base = baseOf(id)
  if (id === base) return list
  return list.map(alias => ({
    ...alias,
    old: alias.old.replace(new RegExp(`^${base}_`), `${id}_`),
    connector: id,
  }))
}

export function readAliases(id) {
  return instanceAliases(id, READ_ALIASES[baseOf(id)] ?? [])
}

export function writeAliases(id) {
  return instanceAliases(id, WRITE_ALIASES[baseOf(id)] ?? [])
}

export function isReadAlias(id, name) {
  return readAliases(id).some(alias => alias.old === name)
}

export function isWriteAlias(id, name) {
  return writeAliases(id).some(alias => alias.old === name)
}

// The legacy level of a connector: the P2 snapshot first, then the old state the fork host
// wrote. `readOnly` is the migrated upstream shape and is only a fallback for a bridge that
// was opened without running the migration.
export function legacyLevelOf(state, id) {
  const saved = state?.connectors?.[id] ?? {}
  const legacy = saved.legacy ?? {}
  // The upstream switch is authoritative while bridge mode is on: the new card changes it
  // and never updates the old `level` field.
  if (saved.readOnly === true) return 'read'
  if (saved.readOnly === false) return 'write'
  if (saved.level === 'read' || saved.level === 'write') return saved.level
  if (legacy.level === 'read' || legacy.level === 'write') return legacy.level
  return 'read'
}

export function legacySwitchesOf(state, id) {
  const saved = state?.connectors?.[id] ?? {}
  const legacy = saved.legacy ?? {}
  return {
    actions: (saved.actions ?? legacy.actions) === true,
    toolbox: saved.toolbox ?? legacy.toolbox,
  }
}

export function neonSettingsOf(state, id) {
  const saved = state?.connectors?.[id] ?? {}
  const legacy = saved.legacy ?? {}
  const projectId = saved.projectId ?? legacy.projectId
  const roleName = saved.roleName ?? saved.role ?? legacy.roleName ?? legacy.role
  return {
    ...(typeof projectId === 'string' && projectId !== '' ? { projectId } : {}),
    ...(typeof roleName === 'string' && roleName !== '' ? { roleName } : {}),
  }
}

const displayNameOf = id => {
  if (id === 'github') return 'GitHub'
  if (id === 'vercel') return 'Vercel'
  if (id === 'cloudflare') return 'Cloudflare'
  if (id === 'gmail') return 'Gmail'
  if (id === 'qqmail') return 'QQ Mail'
  if (NEON_ID.test(id)) return id === 'neon' ? 'Neon' : `Neon ${id.slice('neon-'.length)}`
  return id
}

// A write alias asks exactly like the fork host did: the plugin's own card, one call at a
// time per Session, and a refusal or a timeout leaves the upstream tool unrun.
async function requireApproval(rt, approval, { sessionId, connector, tool, signal, summary }) {
  const readOnly = rt.readOnly?.()
  if (readOnly !== undefined) throw new Error(`DS Bot is read-only: ${readOnly}`)
  const outcome = await approval.approve({ sessionId, connector, tool, signal, ...(summary === undefined ? {} : { summary }) })
  if (outcome === 'allow') return
  if (outcome === 'timeout') throw new Error(`The user did not answer in time, so ${connector}'s ${tool} was not run.`)
  if (outcome === 'cancelled') throw new Error(`The approval was cancelled, so ${connector}'s ${tool} was not run.`)
  if (outcome === 'unavailable') throw new Error(`${connector}'s ${tool} needs your approval, but the approval card could not be shown; nothing was sent.`)
  throw new Error(`The user denied ${connector}'s ${tool}; nothing was sent.`)
}

const summaryFor = (state, id, tool, args) => {
  if (id === 'github') return githubApproval(tool, args)
  if (NEON_ID.test(id)) return neonActionApproval(tool, args, { settings: neonSettingsOf(state, id) })
  return { line: `${tool}${args !== null && typeof args === 'object' ? ` ${JSON.stringify(args).slice(0, 200)}` : ''}` }
}

const defaultMakeClient = rt => async (id) => {
  const gateway = rt.connectorsInternals?.gateway
  if (typeof gateway !== 'function') throw new Error('The upstream connector gateway is not available')
  const gw = await gateway()
  const client = new McpHttpClient(gw.urlFor(id), gw.nonce)
  await client.open()
  return client
}

// The alias host mounts and unmounts the old tool names as one set. It is rebuilt whenever
// the old level, the toolbox/action switches or the mail accounts change; a rebuild closes
// the clients it opened, so no session leaks into the next level.
export function createAliasHost(rt, { makeClient, createShim = createMailShim, approval } = {}) {
  const make = makeClient ?? defaultMakeClient(rt)
  let disposers = []
  let shims = []
  let clients = new Map()
  let signature
  let disposed = false
  let queue = Promise.resolve()

  const closeSet = ({ tools, mail, sessions }) => {
    for (const dispose of tools.splice(0)) {
      try { dispose() } catch { /* an already-lifted tool is fine */ }
    }
    for (const shim of mail.splice(0)) {
      try { shim.close?.() } catch { /* best effort */ }
    }
    for (const client of sessions.values()) {
      try { client.close?.() } catch { /* best effort */ }
    }
    sessions.clear()
  }
  const disposeOld = () => closeSet({ tools: disposers, mail: shims, sessions: clients })

  const register = (tool) => {
    disposers.push(rt.ctx.tools.register(tool))
  }

  const mountMcp = async (spec) => {
    const client = await make(spec.id)
    clients.set(spec.id, client)
    const listed = await client.listTools()
    const byName = new Map(listed.filter(tool => typeof tool?.name === 'string').map(tool => [tool.name, tool]))
    const writes = new Map(writeAliases(spec.id).map(alias => [alias.old, alias]))
    // The old toolbox replaced the named action tools, never ran beside them.
    const namedWrites = spec.toolbox ? new Map() : writes
    const mounted = new Set()

    const mountAlias = (alias, tool, write) => {
      if (mounted.has(alias.old)) return
      mounted.add(alias.old)
      register({
        name: alias.old,
        description: typeof tool.description === 'string' && tool.description !== '' ? tool.description : alias.old,
        parameters: tool.inputSchema !== null && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        output,
        async execute(args, exec) {
          if (write) {
            await requireApproval(rt, approval, {
              sessionId: exec?.agent?.id,
              connector: displayNameOf(spec.id),
              tool: alias.old,
              signal: exec?.signal,
              summary: summaryFor(rt.state ?? {}, spec.id, alias.tool, args),
            })
          }
          try {
            return mcpResultText(await client.callTool(alias.tool, args ?? {}))
          } catch (error) {
            throw new Error(rt.redactSecrets?.(String(error?.message ?? error))?.slice(0, 300) ?? String(error?.message ?? error))
          }
        },
      })
    }

    for (const alias of readAliases(spec.id)) {
      const tool = byName.get(alias.tool)
      if (tool === undefined) continue
      mountAlias(alias, tool, spec.level === 'write' && writes.has(alias.old))
    }
    if (spec.level === 'write') {
      for (const [old, alias] of namedWrites) {
        const tool = byName.get(alias.tool)
        if (tool === undefined) continue
        mountAlias({ ...alias, old }, tool, true)
      }
    }

    // Vercel and Cloudflare old write levels offered their vendor toolbox: the same two
    // tools, over the same upstream server, keep working on the old names.
    if (spec.level === 'write' && spec.id === 'vercel' && spec.toolbox) {
      const index = buildToolIndex(listed)
      register(createSearchTool({ index, output }))
      register(createCallTool({
        client,
        index,
        output,
        redact: rt.redactSecrets,
        approve: (name, args, exec) => requireApproval(rt, approval, {
          sessionId: exec?.agent?.id,
          connector: 'Vercel',
          tool: name,
          signal: exec?.signal,
          summary: summaryFor(rt.state ?? {}, 'vercel', name, args),
        }),
      }))
    }
    if (spec.level === 'write' && spec.id === 'cloudflare' && spec.toolbox) {
      const index = buildCloudflareToolIndex(listed)
      register(createCloudflareSearchTool({ index, output }))
      register(createCloudflareCallTool({
        client,
        index,
        output,
        redact: rt.redactSecrets,
        approve: (name, args, exec) => requireApproval(rt, approval, {
          sessionId: exec?.agent?.id,
          connector: 'Cloudflare',
          tool: name,
          signal: exec?.signal,
          summary: summaryFor(rt.state ?? {}, 'cloudflare', name, args),
        }),
      }))
    }
  }

  const mountMail = (spec) => {
    const shim = createShim({
      provider: spec.provider,
      secrets: spec.secrets,
      level: spec.level,
      redact: rt.redactSecrets,
      ...(typeof spec.connect === 'function' ? { connect: spec.connect } : {}),
      approve: (request) => requireApproval(rt, approval, {
        sessionId: request?.exec?.agent?.id,
        connector: spec.displayName,
        tool: String(request?.tool ?? spec.provider),
        signal: request?.exec?.signal,
        summary: {
          ...(typeof request?.line === 'string' ? { line: request.line } : {}),
          ...(typeof request?.target === 'string' ? { target: request.target } : {}),
          ...(typeof request?.change === 'string' ? { change: request.change } : {}),
          ...(typeof request?.reversible === 'boolean' ? { reversible: request.reversible } : {}),
          ...(request?.danger === true ? { danger: true } : {}),
        },
      }),
    })
    shims.push(shim)
    for (const tool of shim.tools) register(tool)
  }

  const mailSpecs = () => {
    const state = rt.state ?? {}
    const accounts = state.connectors?.mail?.accounts ?? {}
    const specs = []
    for (const [key, account] of Object.entries(accounts)) {
      if (account === null || typeof account !== 'object' || account.status !== 'ready') continue
      // Only the migrated old Gmail/QQ accounts get the shim; a mailbox added through the
      // upstream card uses the native mail_* tools.
      if (account.compat !== 'mail-shim') continue
      const provider = account.provider === 'gmail' ? 'gmail' : account.provider === 'qq' || account.provider === 'qqmail' ? 'qqmail' : account.id === 'gmail' ? 'gmail' : account.id === 'qqmail' ? 'qqmail' : undefined
      if (provider === undefined) continue
      const address = typeof account.address === 'string' ? account.address : ''
      if (address === '') continue
      const password = rt.secretValue?.(mailSecretName(address, 'PASSWORD'))
        ?? rt.secretValue?.(provider === 'gmail' ? 'GMAIL_APP_PASSWORD' : 'QQMAIL_AUTH_CODE')
      if (password === undefined) continue
      const level = account.legacyLevel === 'write' ? 'write' : account.legacyLevel === 'read' ? 'read' : legacyLevelOf(state, key)
      specs.push({
        id: key,
        provider,
        displayName: provider === 'gmail' ? 'Gmail' : 'QQ Mail',
        level,
        secrets: provider === 'gmail'
          ? { GMAIL_ADDRESS: address, GMAIL_APP_PASSWORD: password }
          : { QQMAIL_ADDRESS: address, QQMAIL_AUTH_CODE: password },
      })
    }
    return specs
  }

  const mcpSpecs = () => {
    const state = rt.state ?? {}
    const specs = []
    for (const id of [...MCP_CONNECTORS, ...Object.keys(state.connectors ?? {}).filter(id => NEON_ID.test(id))]) {
      const token = rt.secretValue?.(tokenSecretOf(id))
      if (token === undefined) continue
      const level = legacyLevelOf(state, id)
      const switches = legacySwitchesOf(state, id)
      specs.push({
        id,
        level,
        // The old built-ins defaulted to the toolbox; a stored false is what turns it off.
        toolbox: id === 'vercel' || id === 'cloudflare' ? switches.toolbox !== false : false,
        actions: switches.actions,
      })
    }
    return specs
  }

  const runSync = async ({ force = false } = {}) => {
    if (disposed) return
    await rt.loadSecrets?.()
    const mcp = mcpSpecs()
    const mail = mailSpecs()
    const next = JSON.stringify({
      mcp: mcp.map(spec => [spec.id, spec.level, spec.actions, spec.toolbox]),
      mail: mail.map(spec => [spec.id, spec.provider, spec.level, spec.secrets.GMAIL_ADDRESS ?? spec.secrets.QQMAIL_ADDRESS]),
    })
    if (!force && next === signature) return
    signature = next
    // Build the new set before closing the old one: a transient gateway failure keeps the
    // tools the Bot already had instead of leaving it with none until the next change.
    const previous = { tools: disposers, mail: shims, sessions: clients }
    disposers = []
    shims = []
    clients = new Map()
    let failed = false
    for (const spec of mcp) {
      try { await mountMcp(spec) } catch (error) {
        failed = true
        rt.warn?.('ds-bot: bridge aliases for %s failed: %s', spec.id, String(error?.message ?? error).slice(0, 300))
      }
    }
    for (const spec of mail) {
      try { mountMail(spec) } catch (error) {
        failed = true
        rt.warn?.('ds-bot: bridge mail shim for %s failed: %s', spec.id, String(error?.message ?? error).slice(0, 300))
      }
    }
    if (failed) {
      closeSet({ tools: disposers, mail: shims, sessions: clients })
      disposers = previous.tools
      shims = previous.mail
      clients = previous.sessions
      return
    }
    closeSet(previous)
  }

  const sync = ({ force = false } = {}) => {
    queue = queue.then(() => runSync({ force })).catch(error => {
      rt.warn?.('ds-bot: bridge alias sync failed: %s', String(error?.message ?? error).slice(0, 300))
    })
    return queue
  }

  return {
    sync,
    invalidate() { signature = undefined },
    async dispose() {
      disposed = true
      await queue.catch(() => {})
      disposeOld()
    },
  }
}
