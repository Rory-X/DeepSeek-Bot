// Neon's managed MCP server, in both access levels. `?readonly=true` is what makes the
// server drop every write tool and run each `run_sql` in a READ ONLY transaction; a grant
// fixed at authorization keeps its access, so a write grant is a full URL without that
// parameter plus the write scope, and switching levels means authorizing again (see
// docs/plans/2026-10-20-connector-neon.md).
//
// DS Bot registers only the tools below: the read whitelist always, the four branch/SQL/
// snapshot writes only at the write level, and every write asks the user first. A tool
// cannot reach a model unless it is named here.
//
// One module, several cards: every Neon project is its own connector instance (`neon`,
// `neon-2`, …), with its own grant, level and settings. The per-card state lives in the
// closure `neonInstanceHooks()` creates, never at module level: two mounted cards must not
// be able to overwrite each other's approval line (see docs/plans/2026-10-20-neon-multi-instance.md).
export const NEON_MCP_URL = 'https://mcp.neon.tech/mcp'
export const NEON_SCOPES = ['read']
export const NEON_WRITE_SCOPES = ['read', 'write']
export const NEON_LEVELS = ['read', 'write']
export const NEON_DEFAULT_LEVEL = 'read'
export const NEON_READ_CATEGORIES = ['projects', 'branches', 'endpoints', 'schema', 'querying']
export const NEON_WRITE_CATEGORIES = ['branches', 'querying', 'snapshots']

// How many cards this module may own, and the id every card starts from. The registry keys
// each instance by its connector id: `state.connectors.<id>`, the grant
// `ds-bot/connector-<id>`, the callback `/oauth/ds-bot/<id>` and the tool prefix `<id>_*`.
export const NEON_INSTANCES = { prefix: 'neon', min: 1, max: 8 }

// The card name an instance id gets when the user has not labeled it: the first card is
// "Neon", the ones after it count up.
export function neonDisplayNameFor(id) {
  const match = /^neon-(\d+)$/.exec(String(id))
  return match === null ? 'Neon' : `Neon ${Number(match[1])}`
}

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

// Plain configuration, not a secret: it lives in the team file. `label` is the card's own
// name (a rename never touches the id, the tool prefix or the grant); `projectId` and
// `roleName` reach Neon as query parameters of the authorization. The write level needs
// both pins; the read level may pin the project it can see.
export const NEON_SETTINGS = [
  { name: 'label', label: 'Card name' },
  { name: 'projectId', label: 'Project ID' },
  { name: 'roleName', label: 'SQL role' },
]

const PROJECT_ID = /^[a-z0-9-]{1,60}$/
const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
// A card name is the user's; it is not a secret and it never becomes part of an id, a tool
// name or a grant. Control characters are dropped and a long name is cut, not refused.
const LABEL_LENGTH = 60
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

// The plain MCP address behind a configured one: a profile may keep the grant parameters
// from an earlier run, and they are re-applied per level here.
function baseOf(value) {
  const url = plainAddress(value)
  for (const name of ['readonly', 'category', 'projectId', 'roleName']) url.searchParams.delete(name)
  return url.href
}

// The address a profile override names for one instance, kept as it was given (a pinned
// project or role in the query stays visible on the card). The default is Neon's own server.
function configuredAddressOf(override) {
  const configured = override !== null && typeof override === 'object' && typeof override.url === 'string' && override.url !== ''
    ? override.url
    : NEON_MCP_URL
  return plainAddress(configured).href
}

// The plain address that instance builds its grants on: the profile's parameters are
// stripped here and re-applied per level, so a configured read-only URL cannot leak into a
// write grant.
function addressOf(override) {
  return baseOf(configuredAddressOf(override))
}

function readUrl(address, { projectId, roleName } = {}) {
  const url = new URL(address)
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
function writeUrl(address, { projectId, roleName } = {}) {
  const id = typeof projectId === 'string' ? projectId.trim() : ''
  const role = typeof roleName === 'string' ? roleName.trim() : ''
  if (!PROJECT_ID.test(id)) throw new Error('Full access needs a Neon project ID, for example spring-brook-12345678')
  if (!ROLE_NAME.test(role)) throw new Error('Full access needs a restricted Postgres role that exists on the branches you query')
  const url = new URL(address)
  for (const category of NEON_WRITE_CATEGORIES) url.searchParams.append('category', category)
  url.searchParams.set('projectId', id)
  url.searchParams.set('roleName', role)
  return plainAddress(url.href).href
}

export function neonUrl(settings) {
  return readUrl(NEON_MCP_URL, settings)
}

export function neonWriteUrl(settings) {
  return writeUrl(NEON_MCP_URL, settings)
}

// The tools out of a `tools/list` answer that may be mounted: the whitelist, in the server's
// order, and nothing else.
export function neonTools(listed) {
  const wanted = new Set(NEON_READ_TOOLS)
  if (!Array.isArray(listed)) return []
  return listed.filter(tool => typeof tool?.name === 'string' && wanted.has(tool.name))
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
  // The card name is free text: an emptied field drops it, so the card falls back to the
  // project name a mount learned and then to "Neon N". Control characters would break the
  // card's one-line layout, so they are dropped rather than refused.
  const label = typeof given.label === 'string'
    ? [...given.label].filter(char => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f).join('').trim().slice(0, LABEL_LENGTH)
    : ''
  if (label !== '') normalized.label = label
  return normalized
}

// The tools of one access level. The write tools exist only at the write level, so a read
// grant cannot reach them even by name.
export function neonToolsByLevel(level) {
  return {
    readTools: [...NEON_READ_TOOLS],
    actionTools: level === 'write' ? [...NEON_WRITE_TOOLS] : [],
  }
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
// data; the branch name is resolved for the reader when the mounted client can answer. The
// pinned settings are handed in by the instance that mounts the tools, never read from a
// module-wide value: the card has to name the project and role of the card the user is on.
async function approvalLine(pinnedSettings, name, args, context = {}) {
  const given = args !== null && typeof args === 'object' ? args : {}
  const fromContext = context.settings !== null && typeof context.settings === 'object' ? context.settings : undefined
  const pinned = fromContext ?? (pinnedSettings !== null && typeof pinnedSettings === 'object' ? pinnedSettings : {})
  const projectId = typeof given.project_id === 'string' && given.project_id !== '' ? given.project_id : pinned.projectId
  const project = typeof projectId === 'string' && projectId !== '' ? projectId : 'the pinned project'
  const branchId = typeof given.branch_id === 'string' ? given.branch_id : ''
  const branch = branchId === '' ? 'the default branch' : (await branchNameOf(context.client, branchId)) ?? branchId
  if (name === 'delete_branch') {
    return {
      line: `Delete branch ${branch} on ${project}: all data on that branch is deleted and cannot be recovered.`,
      change: 'A whole branch and its data are removed.',
      target: branch,
      reversible: false,
      danger: true,
    }
  }
  if (name === 'create_branch') {
    const parent = typeof given.parent_id === 'string' && given.parent_id !== '' ? given.parent_id : 'the default branch'
    return {
      line: `Create branch ${typeof given.name === 'string' && given.name !== '' ? given.name : '(generated name)'} on ${project}, from ${parent}.`,
      target: project,
      reversible: true,
    }
  }
  if (name === 'create_snapshot') {
    const snapshot = typeof given.name === 'string' && given.name !== '' ? ` named ${given.name}` : ''
    return { line: `Take a snapshot of ${branch} on ${project}${snapshot}.`, target: branch, reversible: true }
  }
  if (name === 'run_sql') {
    const role = typeof given.role_name === 'string' && given.role_name !== '' ? given.role_name : (typeof pinned.roleName === 'string' ? pinned.roleName : 'the pinned role')
    return { line: `Run SQL as ${role} on ${branch} (${project}): ${sqlPreview(given.sql)}`, target: branch, reversible: false }
  }
  return { line: `Run ${String(name)} on ${project}.`, target: project }
}

// One instance's half of the definition. Everything mutable lives in this closure: the
// address a profile moved for this card, and the settings its mounted level runs with. Two
// cards therefore cannot overwrite each other's approval line (the module-level singletons
// `baseAddress`/`mountedSettings` did exactly that once two cards were mounted).
function neonInstanceHooks(address) {
  let mountedSettings = {}

  const authorize = ({ level, settings } = {}) => {
    const values = settings !== null && typeof settings === 'object' ? settings : {}
    if (level === 'write') return { url: writeUrl(address, values), scopes: [...NEON_WRITE_SCOPES] }
    return { url: readUrl(address, { projectId: values.projectId }), scopes: [...NEON_SCOPES] }
  }

  // The settings the card needs are kept here too: the approval card is built from the tool
  // call alone, so the pinned project and role have to survive from this instance's mount.
  const toolsOf = ({ level, settings } = {}) => {
    mountedSettings = settings !== null && typeof settings === 'object' ? { ...settings } : {}
    return neonToolsByLevel(level)
  }

  const actionApproval = (name, args, context = {}) => approvalLine(mountedSettings, name, args, context)

  return { authorize, toolsOf, actionApproval }
}

// The definition fields every instance shares; the hooks and the address are the parts that
// differ. Kept in one place so the first card and the ones after it cannot drift apart.
function neonDefinition(displayName, hooks, address) {
  return {
    displayName,
    mode: 'oauth-mcp',
    levels: [...NEON_LEVELS],
    defaultLevel: NEON_DEFAULT_LEVEL,
    mcpUrl: readUrl(address),
    readTools: [...NEON_READ_TOOLS],
    oauth: { scopes: [...NEON_SCOPES] },
    settings: NEON_SETTINGS.map(field => ({ ...field })),
    authorize: hooks.authorize,
    toolsOf: hooks.toolsOf,
    readiness: neonReadiness,
    normalizeSettings: normalizeNeonSettings,
    actionApproval: hooks.actionApproval,
    accountTool: 'list_organizations',
    accountOf: neonAccount,
    card: NEON_CARD,
    // Display only: the client draws this list by risk. The mounted tool list stays the real
    // boundary, and the four writes only exist at the write level.
    capabilities: [
      { key: 'browse_projects', title: 'Browse projects and branches', description: 'List projects, branches, databases, roles and compute endpoints; nothing is changed.', risk: 'read' },
      { key: 'inspect_schema', title: 'Inspect schemas and tables', description: "List the tables in a database and read one table's columns, types and constraints.", risk: 'read' },
      { key: 'read_sql', title: 'Run read-only SQL', description: 'Run one SQL statement in a READ ONLY transaction, and ask for a query plan.', risk: 'read' },
      { key: 'diagnose', title: 'Check slow queries and database health', description: 'List the slowest queries and run the predefined read-only database diagnostics.', risk: 'read' },
      { key: 'create_branch', title: 'Create a branch', description: 'Copy the current state of a branch into a new branch on the pinned project.', risk: 'write', preview: { change: 'Creates a new branch; existing branches stay as they are', reversible: true } },
      { key: 'create_snapshot', title: 'Create a snapshot', description: 'Save a snapshot of a branch that can be restored later.', risk: 'write', preview: { change: 'Adds a snapshot; nothing on the branch changes', reversible: true } },
      { key: 'write_sql', title: 'Write SQL', description: 'Run one SQL statement as the pinned Postgres role, changing data on the pinned project.', risk: 'write', preview: { change: 'Changes data in the pinned project and branch', reversible: false } },
      { key: 'delete_branch', title: 'Delete a branch', description: 'Delete a branch and all the data on it; this cannot be undone.', risk: 'destructive', preview: { change: 'Deletes the branch and all its data', reversible: false } },
    ],
    permissions: { summary: 'Lists projects, branches and schemas and runs read-only SQL. With full capabilities it can create branches and snapshots, write SQL as the pinned role, and delete a branch, which removes its data.' },
    instances: { ...NEON_INSTANCES },
  }
}

// The first card's hooks. The exported functions below are this instance's hooks, so a test
// or a caller that reaches for `neonAuthorize` talks to the default card and to nothing else.
const DEFAULT_HOOKS = neonInstanceHooks(NEON_MCP_URL)
const DEFAULT_ADDRESS = NEON_MCP_URL

export const neonAuthorize = DEFAULT_HOOKS.authorize
export const neonToolsOf = DEFAULT_HOOKS.toolsOf
export const neonActionApproval = DEFAULT_HOOKS.actionApproval

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
  id: NEON_INSTANCES.prefix,
  ...neonDefinition('Neon', DEFAULT_HOOKS, DEFAULT_ADDRESS),
  // The registry keeps the fields of the default export, so the hook has to be one of them;
  // connectors.js calls it with the profile override.
  configure,
}

export default neon

// The definition of one card. The registry enumerates the instance ids (the first one always
// exists) and asks for each card's definition here; every call gets its own closure, so the
// cards never share the address or the pinned settings. A framework that only merges
// `configure()`'s answer per instance gets the same isolation: configure() builds a fresh
// hook set for the instance whose override it was handed.
export function neonInstance({ id = NEON_INSTANCES.prefix, displayName, override = {} } = {}) {
  const address = addressOf(override)
  const hooks = neonInstanceHooks(address)
  const name = typeof displayName === 'string' && displayName !== '' ? displayName : neonDisplayNameFor(id)
  return {
    id,
    ...neonDefinition(name, hooks, address),
    url: readOnlyNeonUrl(configuredAddressOf(override)),
    configure,
  }
}

// The framework hands a module's `configure` hook the profile override and merges what it
// returns over the merged definition (see connectors.js). A profile may move the address of
// the instance whose override this is; the default is the read-only address, so a profile
// that says nothing gets the read grant, and the level the user chose picks the real one at
// authorization time. The hooks come back fresh on every call: they belong to that instance.
export function configure(override = {}) {
  const configured = configuredAddressOf(override)
  const hooks = neonInstanceHooks(baseOf(configured))
  return {
    url: readOnlyNeonUrl(configured),
    mcpUrl: readOnlyNeonUrl(configured),
    mode: neon.mode,
    readTools: [...NEON_READ_TOOLS],
    oauth: { scopes: [...NEON_SCOPES] },
    accountOf: neonAccount,
    authorize: hooks.authorize,
    toolsOf: hooks.toolsOf,
    actionApproval: hooks.actionApproval,
    instances: { ...NEON_INSTANCES },
  }
}
