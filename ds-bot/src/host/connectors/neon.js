// Neon's managed MCP server in its read-only mode. `?readonly=true` is what makes the
// server drop every write tool and run each `run_sql` in a READ ONLY transaction; it is a
// grant fixed at authorization, so the token keeps it through a refresh and editing the URL
// later cannot widen it. `category` narrows the same grant to the tool families below, and
// `projectId` / `roleName` may pin one project and one Postgres login role — the strongest
// boundary Neon offers, because Postgres itself then decides what the SQL can read.
//
// DS Bot still registers only the read tools below: a tool cannot reach a model unless it is
// named here, so even a server that published a write tool in read-only mode would leave it
// unreachable.
export const NEON_MCP_URL = 'https://mcp.neon.tech/mcp'
export const NEON_SCOPES = ['read']
export const NEON_READ_CATEGORIES = ['projects', 'branches', 'endpoints', 'schema', 'querying']

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

const PLAIN_ADDRESS = 'The Neon server address must be a plain https:// URL'

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
  if (typeof projectId === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(projectId)) url.searchParams.set('projectId', projectId)
  if (typeof roleName === 'string' && /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(roleName)) url.searchParams.set('roleName', roleName)
  return readOnlyNeonUrl(url.href)
}

// The tools out of a `tools/list` answer that may be mounted: the whitelist, in the server's
// order, and nothing else.
export function neonTools(listed) {
  const wanted = new Set(NEON_READ_TOOLS)
  if (!Array.isArray(listed)) return []
  return listed.filter(tool => typeof tool?.name === 'string' && wanted.has(tool.name))
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

// What the connector card says about a read-only grant before the browser leaves for it. The
// scope is `read` and the server runs each query in a READ ONLY transaction, so nothing a Bot
// sends can change a database.
export const NEON_CARD = {
  glyph: 'neon',
  about: 'Projects, branches, schemas, and read-only SQL',
  docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
  readOnlyNote: 'Read-only: DS Bot can query your databases but cannot change or delete data.',
  consent: {
    title: 'Read-only access to your Neon projects',
    body: 'DS Bot asks Neon for the read scope only. It can list projects, branches, schemas and run SQL in a read-only transaction, so it cannot create, change or delete anything.',
  },
}

// The connector definition the registry loads. Neon has no whoami tool, so the organization
// list is the closest thing to an account line on the card; it is one of the read tools.
const neon = {
  id: 'neon',
  displayName: 'Neon',
  mode: 'oauth-mcp',
  mcpUrl: neonUrl(),
  readTools: [...NEON_READ_TOOLS],
  oauth: { scopes: [...NEON_SCOPES] },
  accountTool: 'list_organizations',
  accountOf: neonAccount,
  card: NEON_CARD,
}

export default neon

// The framework hands a module's `configure` hook the profile override and merges what it
// returns over the merged definition (see connectors.js). A profile may override the address
// to pin a project or a Postgres role; the read-only mode, the read scope and the whitelist
// survive any override, so a config typo cannot turn this connector into a write connection.
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
