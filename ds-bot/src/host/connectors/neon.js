// Neon's managed MCP server, in both access levels. `?readonly=true` is what makes the
// server drop every write tool and run each `run_sql` in a READ ONLY transaction; a grant
// fixed at authorization keeps its access, so a write grant is a full URL without that
// parameter plus the write scope, and switching levels means authorizing again (see
// docs/plans/2026-10-20-connector-neon.md).
//
// DS Bot registers only the tools below: the read whitelist always, the four branch/SQL/
// snapshot writes only at the write level, and every write asks the user first. A tool
// cannot reach a model unless it is named here.
export const NEON_MCP_URL = 'https://mcp.neon.tech/mcp'
export const NEON_SCOPES = ['read']
export const NEON_WRITE_SCOPES = ['read', 'write']
export const NEON_LEVELS = ['read', 'write']
export const NEON_DEFAULT_LEVEL = 'read'
export const NEON_READ_CATEGORIES = ['projects', 'branches', 'endpoints', 'schema', 'querying']
export const NEON_WRITE_CATEGORIES = ['branches', 'querying', 'snapshots']

// Neon's own names, as its `/api/list-tools?readonly=true` publishes them.
export const NEON_READ_TOOLS = [
  'list_organizations',
  'list_projects',
  'describe_project',
  'list_branches',
  'describe_branch',
  'get_default_branch',
  'list_postgres_databases',
  'list_postgres_roles',
  'list_postgres_endpoints',
  'list_branch_computes',
  'get_database_tables',
  'describe_table_schema',
  'run_sql',
  'explain_sql_statement',
  'list_slow_queries',
  'inspect_database',
]

// The first batch of writes: one branch lifecycle on one project. Everything else Neon can
// change (projects, endpoints, migrations, auth, storage) stays out until its own batch.
export const NEON_WRITE_TOOLS = ['create_branch', 'run_sql', 'create_snapshot', 'delete_branch']

// Plain configuration, not a secret: it lives in the team file and reaches Neon as query
// parameters of the authorization. The write level needs both; the read level may pin the
// project it can see.
export const NEON_SETTINGS = [
  { name: 'projectId', label: 'Project ID' },
  { name: 'roleName', label: 'SQL role' },
]

const PROJECT_ID = /^[a-z0-9-]{1,60}$/
const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const PLAIN_ADDRESS = 'The Neon server address must be a plain https:// URL'
const SQL_PREVIEW = 200

function plainAddress(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error(PLAIN_ADDRESS)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') throw new Error(PLAIN_ADDRESS)
  return url
}

// A configured address keeps the parameters it was given (a pinned project or role) and can
// never turn read-only off.
export function readOnlyNeonUrl(value) {
  const url = plainAddress(value)
  url.searchParams.set('readonly', 'true')
  return url.href
}

export function neonUrl({ projectId, roleName } = {}) {
  const url = new URL(NEON_MCP_URL)
  url.searchParams.set('readonly', 'true')
  for (const category of NEON_READ_CATEGORIES) url.searchParams.append('category', category)
  // The grammars Neon accepts; anything else is dropped here, where the mistake is visible,
  // rather than left to fail on the server before any SQL runs.
  if (typeof projectId === 'string' && PROJECT_ID.test(projectId)) url.searchParams.set('projectId', projectId)
  if (typeof roleName === 'string' && ROLE_NAME.test(roleName)) url.searchParams.set('roleName', roleName)
  return readOnlyNeonUrl(url.href)
}

// The write grant Neon's authorization page shows: the branch/SQL/snapshot categories on one
// project, run as one restricted Postgres role. Both pins are required: without them a write
// grant would reach every project and run as the database owner.
export function neonWriteUrl({ projectId, roleName } = {}) {
  const id = typeof projectId === 'string' ? projectId.trim() : ''
  const role = typeof roleName === 'string' ? roleName.trim() : ''
  if (!PROJECT_ID.test(id)) throw new Error('Full access needs a Neon project ID, for example spring-brook-12345678')
  if (!ROLE_NAME.test(role)) throw new Error('Full access needs a restricted Postgres role that exists on the branches you query')
  const url = new URL(NEON_MCP_URL)
  for (const category of NEON_WRITE_CATEGORIES) url.searchParams.append('category', category)
  url.searchParams.set('projectId', id)
  url.searchParams.set('roleName', role)
  return plainAddress(url.href).href
}

// The tools out of a `tools/list` answer that may be mounted: the whitelist, in the server's
// order, and nothing else.
export function neonTools(listed) {
  const wanted = new Set(NEON_READ_TOOLS)
  if (!Array.isArray(listed)) return []
  return listed.filter(tool => typeof tool?.name === 'string' && wanted.has(tool.name))
}

// The tool surface of one access level. The write tools exist only at the write level, so a
// read grant cannot reach them even by name.
export function neonToolsOf({ level } = {}) {
  return {
    readTools: [...NEON_READ_TOOLS],
    actionTools: level === 'write' ? [...NEON_WRITE_TOOLS] : [],
  }
}

// The authorization the chosen level asks for. The framework passes the level stored in the
// team file and the connector's settings.
export function neonAuthorize({ level, settings } = {}) {
  const values = settings !== null && typeof settings === 'object' ? settings : {}
  if (level === 'write') return { url: neonWriteUrl(values), scopes: [...NEON_WRITE_SCOPES] }
  return { url: neonUrl({ projectId: values.projectId }), scopes: [...NEON_SCOPES] }
}

// What the full level still needs before it may authorize. A read grant never needs the pins.
export function neonReadiness({ level, settings } = {}) {
  if (level !== 'write') return undefined
  const values = settings !== null && typeof settings === 'object' ? settings : {}
  if (!PROJECT_ID.test(typeof values.projectId === 'string' ? values.projectId : '')) {
    return 'Set the Neon project ID before connecting with full access.'
  }
  if (!ROLE_NAME.test(typeof values.roleName === 'string' ? values.roleName : '')) {
    return 'Create a restricted Postgres role in Neon first (it must exist on every branch you query), then set its name here.'
  }
  return undefined
}

// The settings endpoint hands over the raw form values; a refused value comes back to the
// form as an error. An emptied field is dropped so the card shows no stale value.
export function normalizeNeonSettings(values = {}) {
  const given = values !== null && typeof values === 'object' ? values : {}
  const normalized = {}
  const projectId = typeof given.projectId === 'string' ? given.projectId.trim() : ''
  if (projectId !== '') {
    if (!PROJECT_ID.test(projectId)) throw new Error('A Neon project ID looks like spring-brook-12345678: lowercase letters, digits and hyphens.')
    normalized.projectId = projectId
  }
  const roleName = typeof given.roleName === 'string' ? given.roleName.trim() : ''
  if (roleName !== '') {
    if (!ROLE_NAME.test(roleName)) throw new Error('A Postgres role name starts with a letter or underscore, then letters, digits, _ or $.')
    normalized.roleName = roleName
  }
  return normalized
}

// The one SQL preview an approval card may carry; the framework redacts and truncates the
// line again, so nothing longer than this can reach a log.
export function sqlPreview(sql) {
  const text = String(sql ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= SQL_PREVIEW ? text : `${text.slice(0, SQL_PREVIEW - 1)}…`
}

async function branchNameOf(client, branchId) {
  if (client === undefined || typeof client.callTool !== 'function' || typeof branchId !== 'string' || branchId === '') return undefined
  try {
    const result = await client.callTool('list_branches', {})
    const text = (Array.isArray(result?.content) ? result.content : [])
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
    const body = JSON.parse(text)
    const list = Array.isArray(body) ? body : Array.isArray(body?.branches) ? body.branches : Array.isArray(body?.result) ? body.result : []
    const match = list.find(item => item?.id === branchId)
    return typeof match?.name === 'string' && match.name !== '' ? match.name : undefined
  } catch {
    return undefined
  }
}

// What the approval card says before a write runs. `danger` marks the one write that discards
// data; the branch name is resolved for the reader when the mounted client can answer.
export async function neonActionApproval(name, args, context = {}) {
  const given = args !== null && typeof args === 'object' ? args : {}
  const pinned = context.settings !== null && typeof context.settings === 'object' ? context.settings : {}
  const projectId = typeof given.project_id === 'string' && given.project_id !== '' ? given.project_id : pinned.projectId
  const project = typeof projectId === 'string' && projectId !== '' ? projectId : 'the pinned project'
  const branchId = typeof given.branch_id === 'string' ? given.branch_id : ''
  const branch = branchId === '' ? 'the default branch' : (await branchNameOf(context.client, branchId)) ?? branchId
  if (name === 'delete_branch') {
    return { line: `Delete branch ${branch} on ${project}: all data on that branch is deleted and cannot be recovered.`, danger: true }
  }
  if (name === 'create_branch') {
    const parent = typeof given.parent_id === 'string' && given.parent_id !== '' ? given.parent_id : 'the default branch'
    return { line: `Create branch ${typeof given.name === 'string' && given.name !== '' ? given.name : '(generated name)'} on ${project}, from ${parent}.`, danger: false }
  }
  if (name === 'create_snapshot') {
    const snapshot = typeof given.name === 'string' && given.name !== '' ? ` named ${given.name}` : ''
    return { line: `Take a snapshot of ${branch} on ${project}${snapshot}.`, danger: false }
  }
  if (name === 'run_sql') {
    const role = typeof given.role_name === 'string' && given.role_name !== '' ? given.role_name : (typeof pinned.roleName === 'string' ? pinned.roleName : 'the pinned role')
    return { line: `Run SQL as ${role} on ${branch} (${project}): ${sqlPreview(given.sql)}`, danger: false }
  }
  return { line: `Run ${String(name)} on ${project}.`, danger: false }
}

// What the card shows for "connected as": the person a token names, else the organizations
// Neon answers for the grant.
export function neonAccount(value) {
  const owner = [value?.email, value?.name].find(text => typeof text === 'string' && text !== '')
  if (owner !== undefined) return owner
  const list = Array.isArray(value) ? value : Array.isArray(value?.organizations) ? value.organizations : []
  const names = list.map(item => item?.name).filter(name => typeof name === 'string' && name !== '')
  if (names.length === 0) return undefined
  return names.length === 1 ? names[0] : `${names[0]} and ${names.length - 1} more`
}

export const NEON_CARD = {
  glyph: 'neon',
  about: 'Projects, branches, schemas, and SQL on your Neon databases',
  docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
  readOnlyNote: 'Read-only asks Neon for the read scope and runs SQL in a READ ONLY transaction. Full access adds branches, writes and snapshots on one project; every write asks for your approval first.',
}

// The connector definition the registry loads. Neon has no whoami tool, so the organization
// list is the closest thing to an account line on the card; it is one of the read tools.
const neon = {
  id: 'neon',
  displayName: 'Neon',
  mode: 'oauth-mcp',
  levels: [...NEON_LEVELS],
  defaultLevel: NEON_DEFAULT_LEVEL,
  mcpUrl: neonUrl(),
  readTools: [...NEON_READ_TOOLS],
  oauth: { scopes: [...NEON_SCOPES] },
  settings: NEON_SETTINGS.map(field => ({ ...field })),
  authorize: neonAuthorize,
  toolsOf: neonToolsOf,
  readiness: neonReadiness,
  normalizeSettings: normalizeNeonSettings,
  actionApproval: neonActionApproval,
  accountTool: 'list_organizations',
  accountOf: neonAccount,
  card: NEON_CARD,
  // The registry keeps the fields of the default export, so the hook has to be one of them;
  // connectors.js calls it with the profile override.
  configure,
}

export default neon

// The framework hands a module's `configure` hook the profile override and merges what it
// returns over the merged definition (see connectors.js). A profile may override the address
// to pin a project or a Postgres role; the default is the read-only address, so a profile
// that says nothing gets the read grant, and the level the user chose picks the real one at
// authorization time.
export function configure(override = {}) {
  const configured = typeof override === 'object' && override !== null && typeof override.url === 'string' && override.url !== ''
    ? override.url
    : neon.mcpUrl
  return {
    url: readOnlyNeonUrl(configured),
    mode: neon.mode,
    readTools: [...NEON_READ_TOOLS],
    oauth: { scopes: [...NEON_SCOPES] },
    accountOf: neonAccount,
  }
}
