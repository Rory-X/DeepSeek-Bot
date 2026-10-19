// The Vercel toolbox: two meta tools over the server's whole catalog, so a Bot can reach
// every capability without hundreds of schemas in its context. `vercel_search_tools`
// searches an index built once at mount; `vercel_call` runs one tool. The connector's
// tools/pre-execute gate reads the same index to decide which calls need approval, so a
// tool is never run here that the gate would not allow.
import { mcpResultText } from './mcp.js'

export const TOOLBOX_TOOLS = ['vercel_search_tools', 'vercel_call']
export const SEARCH_DEFAULT_LIMIT = 8
export const SEARCH_MAX_LIMIT = 20
export const INDEX_DESCRIPTION_MAX = 240
export const SEARCH_DESCRIPTION_MAX = 120
export const SEARCH_RESULT_MAX = 2_000
export const CALL_RESULT_MAX = 20_000
export const CALL_ERROR_MAX = 2_000

// Tools that return environment values or credentials. They are not offered by the
// toolbox at all: not in search, not callable, and the approval gate denies them.
export const BLOCKED_TOOLS = [
  'get_project_env',
  'filter_project_envs',
  'get_shared_env_var',
  'get_edge_config_token',
  'get_edge_config_tokens',
  'create_edge_config_token',
]
const READ_VERBS = /^(list|get|search|read|fetch)_/
const CREDENTIAL_WORD = /(^|_)(env_vars?|project_envs?|shared_env|edge_config_token|secret|credential|password|api_key|token)(_|$)/i
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with', 'tool', 'tools'])

const words = text => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word !== '')
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim()

// Read, write (approval per call), or blocked (never offered). Tool annotations are the
// main signal: Vercel marks every tool. A name-based fallback covers a server that stops
// sending them; uncertain tools count as write, never read.
export function classifyTool(tool) {
  const name = String(tool?.name ?? '').trim()
  if (BLOCKED_TOOLS.includes(name)) return 'blocked'
  if (READ_VERBS.test(name) && CREDENTIAL_WORD.test(name)) return 'blocked'
  const annotations = tool?.annotations
  if (annotations !== null && typeof annotations === 'object') {
    if (annotations.destructiveHint === true) return 'write'
    return annotations.readOnlyHint === true ? 'read' : 'write'
  }
  return READ_VERBS.test(name) ? 'read' : 'write'
}

// One entry per tool, kept for the life of the mount. Long descriptions are cut here so
// the index and every search answer stay bounded.
export function buildToolIndex(tools) {
  return (Array.isArray(tools) ? tools : []).map(tool => {
    const schema = tool?.inputSchema !== null && typeof tool?.inputSchema === 'object' ? tool.inputSchema : {}
    const properties = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required.filter(name => typeof name === 'string') : []
    const params = Object.keys(properties)
    return {
      name: String(tool?.name ?? ''),
      description: oneLine(tool?.description ?? tool?.title ?? tool?.name).slice(0, INDEX_DESCRIPTION_MAX),
      class: classifyTool(tool),
      required,
      params: params.slice(0, 12),
      hasTeamId: Object.hasOwn(properties, 'teamId'),
      types: Object.fromEntries(params.filter(name => typeof properties[name]?.type === 'string').map(name => [name, properties[name].type])),
    }
  }).filter(entry => entry.name !== '')
}

function clampLimit(limit) {
  const value = Number.isInteger(limit) ? limit : SEARCH_DEFAULT_LIMIT
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, value))
}

function parameterSummary(entry) {
  if (entry.params.length === 0) return 'none'
  const shown = entry.params.slice(0, 8).map(name => (entry.required.includes(name) ? `${name}*` : name))
  return shown.join(', ') + (entry.params.length > 8 ? `, … (${entry.params.length} total)` : '')
}

function scoreEntry(entry, terms) {
  const nameWords = words(entry.name)
  const bodyWords = words(entry.description)
  let score = 0
  for (const term of terms) {
    if (nameWords.includes(term)) score += 8
    else if (nameWords.some(word => word.includes(term))) score += 5
    if (bodyWords.includes(term)) score += 2
    else if (bodyWords.some(word => word.includes(term))) score += 1
  }
  return score
}

// Matching tools, best first. `total` counts every match before the limit; `blocked`
// counts matches that are not offered, so the answer can say so.
export function searchToolIndex(index, query, limit = SEARCH_DEFAULT_LIMIT) {
  const terms = words(query).filter(word => !STOP_WORDS.has(word))
  if (terms.length === 0) return { tools: [], total: 0, blocked: 0 }
  let total = 0
  let blocked = 0
  const hits = []
  for (const entry of index) {
    const score = scoreEntry(entry, terms)
    if (score === 0) continue
    if (entry.class === 'blocked') {
      blocked += 1
      continue
    }
    total += 1
    hits.push({ entry, score })
  }
  hits.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
  return { tools: hits.slice(0, clampLimit(limit)).map(hit => hit.entry), total, blocked }
}

export function searchResultText(result, query) {
  const shown = oneLine(query).slice(0, 80)
  if (result.total === 0) {
    if (result.blocked > 0) return `Only tools that return environment values or credentials match "${shown}"; the toolbox does not offer them.`
    return `No Vercel tool matches "${shown}". Try a broader word such as deploy, project, domain, log or team.`
  }
  const header = `Found ${result.total} tool${result.total === 1 ? '' : 's'} for "${shown}" (showing ${result.tools.length}${result.blocked > 0 ? `; ${result.blocked} not offered here` : ''}):`
  const lines = result.tools.map(entry => `- ${entry.name} [${entry.class === 'read' ? 'read' : 'write: needs approval'}] — ${oneLine(entry.description).slice(0, SEARCH_DESCRIPTION_MAX)}; params: ${parameterSummary(entry)}`)
  const fit = (list, more) => [header, ...list, ...(more ? ['… (cut)'] : [])].join('\n')
  let text = fit(lines, false)
  while (lines.length > 1 && Buffer.byteLength(text, 'utf8') > SEARCH_RESULT_MAX) {
    lines.pop()
    text = fit(lines, true)
  }
  return text
}

export function createSearchTool({ index, output }) {
  return {
    name: TOOLBOX_TOOLS[0],
    description: 'Search the Vercel MCP server by keyword. Returns matching tool names with a one-line description, their parameters and whether the tool only reads; run one with vercel_call. Tools that return environment values or credentials are not offered here.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for in a tool name or description.' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_LIMIT, description: `How many tools to return; default ${SEARCH_DEFAULT_LIMIT}.` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output,
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('vercel_search_tools needs a keyword, for example "deploy" or "domain".')
      return searchResultText(searchToolIndex(index, query, args?.limit), query)
    },
  }
}

function matchesType(value, type) {
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

export function createCallTool({ client, index, output, redact = text => String(text), teamId }) {
  const cut = text => {
    const safe = redact(String(text))
    if (safe.length <= CALL_RESULT_MAX) return safe
    return `${safe.slice(0, CALL_RESULT_MAX)}\n… (result cut: ${safe.length} characters in all; narrow the request, for example a smaller limit or a shorter time window)`
  }
  const fail = error => new Error(redact(String(error?.message ?? error)).slice(0, CALL_ERROR_MAX))
  return {
    name: TOOLBOX_TOOLS[1],
    description: 'Run one Vercel MCP tool by name with its arguments. Read tools run directly; tools that change something ask the user for approval first. Find tools with vercel_search_tools. A result longer than 20000 characters is cut with a note.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Exact tool name from vercel_search_tools.' },
        args: { type: 'object', description: 'Arguments for that tool, matching the parameters vercel_search_tools shows.', additionalProperties: true },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    output,
    async execute(args) {
      const requested = typeof args?.tool === 'string' ? args.tool.trim() : ''
      if (requested === '') throw new Error('vercel_call needs a tool name; find one with vercel_search_tools.')
      const entry = index.find(item => item.name === requested)
      if (entry === undefined) throw new Error(`No Vercel tool named "${requested}". Use vercel_search_tools to find one, for example query "deploy".`)
      if (entry.class === 'blocked') throw new Error(`"${requested}" can return environment values or credentials; DS Bot's toolbox does not run it. Use the Vercel dashboard instead.`)
      const given = args?.args
      if (given !== undefined && given !== null && (typeof given !== 'object' || Array.isArray(given))) throw new Error(`vercel_call.args must be an object of arguments for "${requested}".`)
      const call = { ...given }
      // The token's default team answers the calls that need one; an explicit argument wins.
      if (teamId !== undefined && entry.hasTeamId && call.teamId === undefined) call.teamId = teamId
      const missing = entry.required.filter(name => call[name] === undefined)
      if (missing.length > 0) throw new Error(`"${requested}" needs: ${entry.required.join(', ')}. Missing: ${missing.join(', ')}. vercel_search_tools shows its parameters.`)
      for (const [name, type] of Object.entries(entry.types)) {
        if (call[name] === undefined) continue
        if (!matchesType(call[name], type)) throw new Error(`"${requested}" expects "${name}" to be ${type}.`)
      }
      try {
        return cut(mcpResultText(await client.callTool(requested, call)))
      } catch (error) {
        throw fail(error)
      }
    },
  }
}
