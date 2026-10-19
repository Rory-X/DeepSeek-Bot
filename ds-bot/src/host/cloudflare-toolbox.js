// The Cloudflare toolbox: two meta tools over the server's endpoint mode
// (`?codemode=false`, one native tool per API endpoint). Unlike Vercel, Cloudflare's
// catalog is classified by the HTTP method the tool name starts with: GET and HEAD read
// and run directly, the rest change something and ask on the plugin's approval card
// before every call. Credential and identity-management endpoints never enter the index:
// they are not searchable, not callable, and refused before any card can be made.
import { mcpResultText } from './mcp.js'

export const CLOUDFLARE_TOOLBOX_TOOLS = ['cloudflare_search_tools', 'cloudflare_call']
export const CLOUDFLARE_SEARCH_DEFAULT_LIMIT = 8
export const CLOUDFLARE_SEARCH_MAX_LIMIT = 20
export const CLOUDFLARE_DESCRIPTION_MAX = 240
export const CLOUDFLARE_SEARCH_DESCRIPTION_MAX = 120
export const CLOUDFLARE_SEARCH_RESULT_MAX = 2_000
export const CLOUDFLARE_CALL_RESULT_MAX = 20_000
export const CLOUDFLARE_CALL_ERROR_MAX = 2_000

// Endpoints that mint or read credentials, or change who may reach the account. A tool
// name is `<method>_<path segments without parameters>`, so the path family is still
// visible here. This list is derived from Cloudflare's published OpenAPI document
// (paths under /user/tokens, /accounts/{account_id}/tokens, workers secrets, the secrets
// store, basic-auth credentials, signing/stream/TURN keys, members, SSO connectors and
// certificate authority material).
export const BLOCKED_TOOL_PATTERNS = [
  // API tokens: minting one hands out the account, and /value reads the token itself.
  /^(?:get|head|post|put|patch|delete)_user_tokens(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_tokens(?:_.*)?$/,
  // Secrets: Workers secrets, the secrets store and basic-auth credentials.
  /^(?:get|head|post|put|patch|delete)_accounts_workers_scripts_secrets(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_workers_dispatch_namespaces_scripts_secrets(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_secrets_store(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_cws_basic_auth_credentials(?:_.*)?$/,
  // Keys and credentials: Access keys, image signing keys, Stream keys, TURN keys.
  /^(?:get|head|post|put|patch|delete)_accounts_access_keys(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_images_v1_keys(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_stream_keys(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_stream_live_inputs(?:_.*)?_rotate_keys$/,
  /^(?:get|head|post|put|patch|delete)_accounts_calls_turn_keys(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_workers_observability_telemetry_keys(?:_.*)?$/,
  // Who may reach the account: members, memberships, SSO connectors.
  /^(?:get|head|post|put|patch|delete)_accounts_members(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_memberships(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_user_memberships(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_tenants_.*_memberships(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_organizations_.*_members(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_sso_connectors(?:_.*)?$/,
  // Certificate authority material: Origin CA, mTLS, Access, Gateway and client certs.
  /^(?:get|head|post|put|patch|delete)_certificates(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_mtls_certificates(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_access_certificates(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_zones_access_certificates(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_access_saml_certificates(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_accounts_gateway_certificates(?:_.*)?$/,
  /^(?:get|head|post|put|patch|delete)_zones_client_certificates(?:_.*)?$/,
  // Fallback: any name that says token, secret, credential or API/HMAC key never enters.
  /^(?:get|head|post|put|patch|delete)_.*(?:^|_)(?:tokens?|secrets?|credentials?|api_keys?|hmac_keys?)(?:_|$).*$/,
]

const READ_METHODS = new Set(['get', 'head'])
const METHOD = /^(get|head|post|put|patch|delete)_/
const TYPE_METHODS = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with', 'tool', 'tools'])

const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim()
const words = text => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word !== '' && !STOP_WORDS.has(word))

export function isBlockedCloudflareTool(name) {
  const value = String(name ?? '').trim()
  return value !== '' && BLOCKED_TOOL_PATTERNS.some(pattern => pattern.test(value))
}

// GET and HEAD read; everything else changes something and needs approval. Unknown names
// (the code-mode tools, if a profile points at that endpoint) are treated as writes.
export function classifyCloudflareTool(tool) {
  const name = String(tool?.name ?? '').trim()
  if (isBlockedCloudflareTool(name)) return 'blocked'
  if (name === 'whoami' || name === 'docs') return 'read'
  const method = METHOD.exec(name)?.[1]
  if (method === undefined) return 'write'
  return READ_METHODS.has(method) ? 'read' : 'write'
}

// One entry per callable tool; blocked tools are left out entirely, so neither search nor
// call can name them.
export function buildCloudflareToolIndex(tools) {
  return (Array.isArray(tools) ? tools : []).flatMap((tool) => {
    const name = String(tool?.name ?? '').trim()
    if (name === '') return []
    const kind = classifyCloudflareTool(tool)
    if (kind === 'blocked') return []
    const schema = tool?.inputSchema !== null && typeof tool?.inputSchema === 'object' ? tool.inputSchema : {}
    const properties = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : {}
    const types = {}
    for (const [property, definition] of Object.entries(properties)) {
      if (definition !== null && typeof definition === 'object' && TYPE_METHODS.has(definition.type)) types[property] = definition.type
    }
    const required = Array.isArray(schema.required) ? schema.required.filter(item => typeof item === 'string') : []
    return [{
      name,
      description: oneLine(tool?.description ?? tool?.title ?? name).slice(0, CLOUDFLARE_DESCRIPTION_MAX),
      class: kind,
      params: Object.keys(properties),
      required,
      types,
      hasAccountId: Object.hasOwn(properties, 'account_id'),
    }]
  })
}

function score(entry, terms) {
  let total = 0
  const name = entry.name.toLowerCase()
  const description = entry.description.toLowerCase()
  for (const term of terms) {
    if (name === term) total += 10
    else if (name.startsWith(term)) total += 6
    else if (name.includes(term)) total += 4
    if (description.includes(term)) total += 1
  }
  return total
}

export function searchCloudflareIndex(index, query, limit = CLOUDFLARE_SEARCH_DEFAULT_LIMIT) {
  const terms = words(query)
  if (terms.length === 0) return []
  return index
    .map(entry => ({ entry, score: score(entry, terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => (b.score - a.score) || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map(item => item.entry)
}

const paramsText = (entry) => {
  if (entry.params.length === 0) return ''
  const shown = entry.params.slice(0, 8).map((name) => {
    const mark = entry.required.includes(name) ? '*' : ''
    const type = entry.types[name] === undefined ? '' : `: ${entry.types[name]}`
    return `${name}${mark}${type}`
  })
  const more = entry.params.length > 8 ? `, … (${entry.params.length} in all)` : ''
  return `; params: ${shown.join(', ')}${more}`
}

export function searchCloudflareResultText(index, query, limit = CLOUDFLARE_SEARCH_DEFAULT_LIMIT) {
  const asked = oneLine(query)
  if (asked === '') return 'Give a keyword to search Cloudflare tools for, such as zone, dns, workers or analytics.'
  let shown = limit
  for (;;) {
    const found = searchCloudflareIndex(index, asked, shown)
    if (found.length === 0) {
      return `No Cloudflare tool matches "${asked.slice(0, 60)}". Try a broader word such as zone, dns, workers or analytics.`
    }
    const header = `Found ${found.length === shown && found.length === limit ? `${found.length}+` : found.length} Cloudflare tools for "${asked.slice(0, 60)}" (showing ${found.length}; run one with cloudflare_call):`
    const lines = found.map((entry) => {
      const label = entry.class === 'write' ? 'write: needs approval' : 'read'
      return `- ${entry.name} [${label}] — ${entry.description.slice(0, CLOUDFLARE_SEARCH_DESCRIPTION_MAX)}${paramsText(entry)}`
    })
    const text = [header, ...lines].join('\n')
    if (Buffer.byteLength(text) <= CLOUDFLARE_SEARCH_RESULT_MAX || shown <= 1) {
      if (Buffer.byteLength(text) <= CLOUDFLARE_SEARCH_RESULT_MAX) return text
      return `${text.slice(0, CLOUDFLARE_SEARCH_RESULT_MAX)}\n… (search result cut; ask for a narrower word)`
    }
    shown -= 1
  }
}

export function createCloudflareSearchTool({ index, output }) {
  return {
    name: CLOUDFLARE_TOOLBOX_TOOLS[0],
    description: 'Search Cloudflare\'s API tools by keyword. Returns matching tool names with whether they only read or need approval, and their parameters; run one with cloudflare_call. Credential and account-management endpoints are not offered.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, such as zone, dns, workers, analytics or deploy.' },
        limit: { type: 'integer', description: 'How many tools to show, 1–20. Default 8.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output,
    async execute(args) {
      const raw = typeof args?.limit === 'number' ? Math.floor(args.limit) : CLOUDFLARE_SEARCH_DEFAULT_LIMIT
      const limit = Math.min(CLOUDFLARE_SEARCH_MAX_LIMIT, Math.max(1, Number.isFinite(raw) ? raw : CLOUDFLARE_SEARCH_DEFAULT_LIMIT))
      return searchCloudflareResultText(index, String(args?.query ?? ''), limit)
    },
  }
}

const matchesType = (value, type) => {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value)
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    default: return true
  }
}

export function createCloudflareCallTool({ client, index, output, redact = text => String(text), accountId, approve }) {
  const cut = (text) => {
    const safe = redact(String(text))
    if (safe.length <= CLOUDFLARE_CALL_RESULT_MAX) return safe
    return `${safe.slice(0, CLOUDFLARE_CALL_RESULT_MAX)}\n… (result cut: ${safe.length} characters in all; narrow the request, for example a smaller limit or a shorter time window)`
  }
  const fail = error => new Error(redact(String(error?.message ?? error)).slice(0, CLOUDFLARE_CALL_ERROR_MAX))
  return {
    name: CLOUDFLARE_TOOLBOX_TOOLS[1],
    description: 'Run one Cloudflare API tool by name. GET and HEAD tools read and run directly; tools that change something ask the user for approval first. Find one with cloudflare_search_tools. A result longer than 20000 characters is cut with a note. Credential and account-management endpoints are never offered.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Exact tool name from cloudflare_search_tools.' },
        args: { type: 'object', description: 'Arguments for that tool, matching the parameters cloudflare_search_tools shows.', additionalProperties: true },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      const requested = typeof args?.tool === 'string' ? args.tool.trim() : ''
      if (requested === '') throw new Error('cloudflare_call needs a tool name; find one with cloudflare_search_tools.')
      if (isBlockedCloudflareTool(requested)) {
        throw new Error(`"${requested}" can mint or read credentials, or change who reaches the account; DS Bot's toolbox does not run it. Use the Cloudflare dashboard instead.`)
      }
      const entry = index.find(item => item.name === requested)
      if (entry === undefined) throw new Error(`No Cloudflare tool named "${requested}". Use cloudflare_search_tools to find one, for example query "zone".`)
      const given = args?.args
      if (given !== undefined && given !== null && (typeof given !== 'object' || Array.isArray(given))) {
        throw new Error(`cloudflare_call.args must be an object of arguments for "${requested}".`)
      }
      const call = { ...given }
      // The connected account answers account-scoped calls; an explicit argument wins.
      if (entry.hasAccountId && call.account_id === undefined && typeof accountId === 'string' && accountId !== '') call.account_id = accountId
      const missing = entry.required.filter(name => call[name] === undefined)
      if (missing.length > 0) throw new Error(`"${requested}" needs: ${entry.required.join(', ')}. Missing: ${missing.join(', ')}. cloudflare_search_tools shows its parameters.`)
      for (const [name, type] of Object.entries(entry.types)) {
        if (call[name] === undefined) continue
        if (!matchesType(call[name], type)) throw new Error(`"${requested}" expects "${name}" to be ${type}.`)
      }
      // A write asks on the connector's own approval card before anything reaches Cloudflare.
      if (entry.class === 'write' && typeof approve === 'function') await approve(requested, exec)
      try {
        return cut(mcpResultText(await client.callTool(requested, call)))
      } catch (error) {
        throw fail(error)
      }
    },
  }
}
