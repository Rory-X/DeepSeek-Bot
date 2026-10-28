// ima (ima.qq.com) has no MCP server. Its official OpenAPI is POST-only with a
// `{ code, msg, data }` envelope, authenticated by a client id and an API key pair.
// This file is the ima declaration for the shared REST adapter (src/host/rest-tools.js):
// it names the service, the two credentials, the headers, and the nine read calls.
//
// The write endpoints are deliberately absent: import_doc, append_doc, create_media,
// add_knowledge and import_urls change the user's notes or knowledge base, and
// check_repeated_names / get_addable_knowledge_base_list only exist to prepare a write.
// A tool the adapter has no definition for cannot be called, whatever a model asks for.
//
// The credential pair is long-lived and carries write rights at the service, so read-only
// is enforced here, not by ima. Notes and knowledge bases are private data: a tool answer
// is shown to the acting conversation, so these tools must not be used to post into groups.
export const IMA_BASE = 'https://ima.qq.com'
export const IMA_CLIENT_ID_SECRET = 'IMA_OPENAPI_CLIENTID'
export const IMA_API_KEY_SECRET = 'IMA_OPENAPI_APIKEY'
// ima's own skill package sends its version in this header; the API reads it there.
export const IMA_SKILL_VERSION = '1.1.10'
export const IMA_TOOL_PREFIX = 'ima'
const TIMEOUT_MS = 20_000

// Endpoints the declaration must never reach. Kept next to the declarations so a test can
// prove the map and the write list stay disjoint.
export const IMA_WRITE_PATHS = [
  '/openapi/note/v1/import_doc',
  '/openapi/note/v1/append_doc',
  '/openapi/wiki/v1/create_media',
  '/openapi/wiki/v1/add_knowledge',
  '/openapi/wiki/v1/import_urls',
  '/openapi/wiki/v1/check_repeated_names',
]

const AUTH_CODES = new Set([20004, 200002])
const RATE_CODES = new Set([20002, 110021])
const PRIVATE_CODES = new Set([210005, 210011, 210034, 110030])
// The notes module documents one table (1000xx, 310001) and the reference file another
// (2100xx); both are mapped so a write failure says what to do whichever table the
// service answers with.
const NOTE_CODES = new Map([
  [100001, 'ima rejected the request parameters'],
  [100002, 'ima says one of the ids is not valid'],
  [100003, 'ima had an internal error; try again later'],
  [100004, 'ima rejected the size: too large, or the account is out of space'],
  [100005, 'ima says this account may not do that'],
  [100006, 'that ima note no longer exists'],
  [100008, 'the note changed since it was read; read it again before writing'],
  [100009, 'the content is over ima\'s size limit; split it into smaller parts'],
  [310001, 'that ima notebook does not exist'],
  [210006, 'that ima note no longer exists'],
  [210008, 'the note changed since it was read; read it again before writing'],
  [210009, 'the content is over ima\'s size limit; split it into smaller parts'],
  [210035, 'that ima notebook does not exist'],
])

// ima reports a refused business call as HTTP 200 with a non-zero code, so the envelope,
// not the status line, decides whether a call succeeded.
export function imaError(code, msg) {
  const text = typeof msg === 'string' ? msg.trim() : ''
  if (AUTH_CODES.has(code)) return 'ima did not accept this client id or API key'
  if (RATE_CODES.has(code)) return 'ima is rate limiting this key; try again later'
  if (PRIVATE_CODES.has(code)) return text === '' ? 'ima says this account may not read that' : `ima says this account may not read that: ${text}`
  if (NOTE_CODES.has(code)) {
    const said = NOTE_CODES.get(code)
    return text === '' ? said : `${said}: ${text}`
  }
  const named = text === '' ? '' : `: ${text}`
  return `ima answered ${code}${named}`
}

// A successful call is unwrapped here instead of through `envelope`, because the adapter
// checks a non-2xx status before it runs this hook: a 429 or 401 with an empty or odd body
// then says what happened instead of "code undefined". The service's own status field is
// still authoritative for the business errors it reports inside a 200.
export function imaAnswer({ body, status } = {}) {
  if (status === 429) throw new Error('ima is rate limiting this key; try again later')
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'code')) {
    throw new Error('ima answered something this connector cannot read.')
  }
  if (body.code === 0) return JSON.stringify(body.data ?? {})
  throw new Error(imaError(body.code, body.msg))
}

// The card and the team file keep two credentials for ima, not one token: the client id
// identifies the key pair and the API key is the secret. Names are DSH secret names.
export const IMA_CREDENTIALS = [
  { name: IMA_CLIENT_ID_SECRET, label: 'Client ID' },
  { name: IMA_API_KEY_SECRET, label: 'API key' },
]

// Both headers travel on every call, plus the skill version ima's own package sends.
export const auth = ({ secrets = {} } = {}) => {
  const clientId = secrets[IMA_CLIENT_ID_SECRET]
  const apiKey = secrets[IMA_API_KEY_SECRET]
  return {
    ...(typeof clientId === 'string' && clientId !== '' ? { 'ima-openapi-clientid': clientId } : {}),
    ...(typeof apiKey === 'string' && apiKey !== '' ? { 'ima-openapi-apikey': apiKey } : {}),
    'ima-openapi-ctx': `skill_version=${IMA_SKILL_VERSION}`,
  }
}
export const restHeaders = auth

const CURSOR = {
  type: 'string',
  description: 'Page cursor. Send the empty string "" for the first page, then next_cursor from the previous answer.',
}
const LIMIT = (max, what) => ({
  type: 'number',
  minimum: 1,
  maximum: max,
  description: `How many ${what} to return (1-${max}).`,
})

// Each entry is one model tool. `body` names only the fields that may be sent, each from
// one argument or a fixed value, so an argument outside these names never reaches ima.
export const IMA_REST_TOOLS = [
  {
    name: 'search_notes',
    description: 'Search the user\'s ima notes by title or by body text. Returns matching notes with their note_id, then read one with get_note.',
    method: 'POST',
    readOnly: true,
    path: '/openapi/note/v1/search_note',
    body: {
      search_type: 'search_type',
      sort_type: 'sort_type',
      'query_info.title': 'query',
      'query_info.content': 'query',
      start: 'start',
      end: 'end',
    },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The words to look for.' },
        search_type: { type: 'number', enum: [0, 1], description: '0 searches note titles (default), 1 searches note bodies.' },
        sort_type: { type: 'number', enum: [0, 1, 2, 3], description: '0 modified time (default), 1 created time, 2 title, 3 size.' },
        start: { type: 'number', minimum: 0, description: 'First hit to return; send 0 for the first page, then add 20 per page.' },
        end: { type: 'number', minimum: 1, description: 'Hit to stop at; must be at most 20 past start. Send 20 for the first page.' },
      },
      required: ['query', 'start', 'end'],
    },
  },
  {
    name: 'list_notebooks',
    description: 'List the user\'s ima notebooks (folders of notes).',
    method: 'POST',
    readOnly: true,
    path: '/openapi/note/v1/list_notebook',
    body: { cursor: 'cursor', limit: 'limit', version: 'version' },
    parameters: {
      type: 'object',
      properties: {
        cursor: { ...CURSOR, description: 'Page cursor. Send "0" for the first page, then next_cursor from the previous answer.' },
        limit: LIMIT(20, 'notebooks'),
        version: { type: 'string', description: 'Version from the previous answer, for an incremental check; omit it for a full list.' },
      },
      required: ['cursor', 'limit'],
    },
  },
  {
    name: 'list_notes',
    description: 'List the user\'s ima notes, newest first, optionally inside one notebook.',
    method: 'POST',
    readOnly: true,
    path: '/openapi/note/v1/list_note',
    body: { folder_id: 'folder_id', sort_type: 'sort_type', cursor: 'cursor', limit: 'limit' },
    parameters: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'Notebook id from list_notebooks; omit it to list notes across all notebooks.' },
        sort_type: { type: 'number', enum: [0, 1, 2, 3], description: '0 modified time (default), 1 created time, 2 title, 3 size.' },
        cursor: { ...CURSOR, description: 'Page cursor. Send "" for the first page, then the cursor ima returned.' },
        limit: LIMIT(20, 'notes'),
      },
      required: ['cursor', 'limit'],
    },
  },
  {
    name: 'get_note',
    description: 'Read one ima note as plain text. Use a note_id from search_notes, list_notes or get_media.',
    method: 'POST',
    readOnly: true,
    path: '/openapi/note/v1/get_doc_content',
    body: { note_id: 'note_id', target_content_format: { const: 0 } },
    parameters: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'The note to read. Only the owner\'s own notes can be read.' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'get_kb',
    description: 'Read the name and description of one or more ima knowledge bases, by id.',
    method: 'POST',
    readOnly: true,
    path: '/openapi/wiki/v1/get_knowledge_base',
    body: { ids: 'ids' },
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Knowledge base ids, 1-20, without repeats.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'list_kb',
    description: 'Browse one ima knowledge base: its files and folders at the root, or inside one folder.',
    method: 'POST',
    readOnly: true,
    path: '/openapi/wiki/v1/get_knowledge_list',
    body: { knowledge_base_id: 'knowledge_base_id', folder_id: 'folder_id', cursor: 'cursor', limit: 'limit' },
    parameters: {
      type: 'object',
      properties: {
        knowledge_base_id: { type: 'string', description: 'The knowledge base to browse.' },
        folder_id: { type: 'string', description: 'Folder to enter; omit it for the root. The root folder id equals the knowledge base id.' },
        cursor: CURSOR,
        limit: LIMIT(50, 'items'),
      },
      required: ['knowledge_base_id', 'cursor', 'limit'],
    },
  },
  {
    name: 'search_kb',
    description: 'Search inside one ima knowledge base. Returns matching files and folders with a highlight.',
    method: 'POST',
    readOnly: true,
    path: '/openapi/wiki/v1/search_knowledge',
    body: { query: 'query', cursor: 'cursor', knowledge_base_id: 'knowledge_base_id' },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The words to look for.' },
        cursor: CURSOR,
        knowledge_base_id: { type: 'string', description: 'The knowledge base to search.' },
      },
      required: ['query', 'cursor', 'knowledge_base_id'],
    },
  },
  {
    name: 'search_kb_list',
    description: 'Find ima knowledge bases by name. Send an empty query to list every knowledge base the user has.',
    method: 'POST',
    readOnly: true,
    path: '/openapi/wiki/v1/search_knowledge_base',
    body: { query: 'query', cursor: 'cursor', limit: 'limit' },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words in the knowledge base name; "" lists all of them.' },
        cursor: CURSOR,
        limit: LIMIT(20, 'knowledge bases'),
      },
      required: ['query', 'cursor', 'limit'],
    },
  },
  {
    name: 'get_media',
    description: 'Get the original-file entry for a knowledge base item by media_id: a short-lived download URL, or a notebook_id when the item is an ima note (read that with get_note).',
    method: 'POST',
    readOnly: true,
    path: '/openapi/wiki/v1/get_media_info',
    body: { media_id: 'media_id' },
    parameters: {
      type: 'object',
      properties: {
        media_id: { type: 'string', description: 'The media id from a knowledge base listing or search.' },
      },
      required: ['media_id'],
    },
  },
  {
    name: 'list_addable_kb',
    description: 'List the ima knowledge bases this account may add notes or pages to.',
    method: 'POST',
    readOnly: true,
    path: '/openapi/wiki/v1/get_addable_knowledge_base_list',
    body: { cursor: 'cursor', limit: 'limit' },
    parameters: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Page cursor; send "" for the first page.' },
        limit: { type: 'number', minimum: 1, maximum: 50, description: 'How many knowledge bases to return (1-50).' },
      },
      required: ['cursor', 'limit'],
    },
  },
]

// The registry loads this object by its default export, takes `id` as the key, and hands
// the rest to connectors.js. ima has no MCP server, so it mounts through the REST adapter:
// `credentials` asks the card for both secrets, `auth` builds both headers, `envelope`
// unwraps code/msg/data, and `verify` proves the pair without reading user content.
// Third batch: the four write calls. The shared adapter builds them only at the write level
// and asks on the approval card before each call; the read level never sees them.
// ima cannot take these even over HTTP (its own docs exclude Bilibili, YouTube and file://),
// and a private or loopback address would make ima fetch something inside the network, so the
// checks run before the approval card and before any request.
export const IMA_URL_RULES = {
  protocols: ['http:', 'https:'],
  deniedHosts: ['bilibili.com', 'www.bilibili.com', 'b23.tv', 'youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'],
  deniedHostSuffixes: ['.local', '.internal', '.lan'],
  deniedHostnames: ['localhost', 'localhost.localdomain'],
}

const isPrivateAddress = (hostname) => {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const [a, b] = hostname.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  return hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80') || hostname === '[::1]'
}

// Throws before anything is sent or shown on the card; returns the URLs unchanged.
export function assertImportUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('Give at least one URL to import')
  if (urls.length > 10) throw new Error('ima imports at most 10 URLs at a time')
  for (const raw of urls) {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '') throw new Error('A URL to import is empty')
    let url
    try {
      url = new URL(text)
    } catch {
      throw new Error(`Not a URL: ${text.slice(0, 120)}`)
    }
    if (!IMA_URL_RULES.protocols.includes(url.protocol)) throw new Error(`ima imports http(s) URLs only; "${text.slice(0, 120)}" uses ${url.protocol}`)
    const host = url.hostname.toLowerCase()
    if (IMA_URL_RULES.deniedHostnames.includes(host) || IMA_URL_RULES.deniedHostSuffixes.some(suffix => host.endsWith(suffix)) || isPrivateAddress(host)) {
      throw new Error(`ima cannot import "${text.slice(0, 120)}": the address is local, private or not a public page`)
    }
    if (IMA_URL_RULES.deniedHosts.some(denied => host === denied || host.endsWith(`.${denied}`))) {
      throw new Error(`ima cannot import "${text.slice(0, 120)}": Bilibili and YouTube pages are not supported`)
    }
  }
  return urls
}

// Any write argument the host must refuse before the approval card is drawn.
export function validateWriteArgs(name, args = {}) {
  if (name === 'import_url') assertImportUrls(args.urls)
}

const cutLine = text => (text.length <= 180 ? text : `${text.slice(0, 180)}…`)
const firstUrl = (args) => (Array.isArray(args?.urls) && typeof args.urls[0] === 'string' ? args.urls[0] : '')

// What the approval card says for one write call. The framework cuts and redacts the line
// again; `reversible: false` is what asks the client for its "cannot be undone" checkbox.
export function approvalFor(name, args = {}) {
  switch (name) {
    case 'create_note':
      return {
        line: cutLine(`Create an ima note (${String(args.content ?? '').length} characters). This cannot be undone through the API.`),
        danger: false,
        reversible: false,
        change: 'creates a new note',
        target: 'ima notes',
      }
    case 'append_note':
      return {
        line: cutLine(`Append ${String(args.content ?? '').length} characters to ima note ${String(args.note_id ?? '')}. This cannot be undone through the API.`),
        danger: false,
        reversible: false,
        change: 'appends to an existing note',
        target: String(args.note_id ?? ''),
      }
    case 'add_note_to_kb':
      return {
        line: cutLine(`Add ima note ${String(args.note_id ?? '')} to knowledge base ${String(args.knowledge_base_id ?? '')}. This cannot be undone through the API.`),
        danger: false,
        reversible: false,
        change: 'adds a note to a knowledge base',
        target: String(args.knowledge_base_id ?? ''),
      }
    case 'import_url': {
      const urls = Array.isArray(args.urls) ? args.urls : []
      return {
        line: cutLine(`Import ${urls.length} URL${urls.length === 1 ? '' : 's'} into knowledge base ${String(args.knowledge_base_id ?? '')} (first: ${firstUrl(args)}). This cannot be undone through the API.`),
        danger: false,
        reversible: false,
        change: 'imports web pages into a knowledge base',
        target: String(args.knowledge_base_id ?? ''),
      }
    }
    default:
      return { line: `ima ${name}`, danger: false, reversible: false }
  }
}

export const IMA_WRITE_TOOLS = [
  {
    name: 'create_note',
    description: 'Create a new ima note from Markdown text. The first line becomes the title. Ask before running: this cannot be undone through the API.',
    method: 'POST',
    write: true,
    path: '/openapi/note/v1/import_doc',
    body: { content_format: { const: 1 }, content: 'content', folder_id: 'folder_id', folder_name: 'folder_name' },
    approval: args => approvalFor('create_note', args),
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The note body in Markdown. The first line becomes the title.' },
        folder_id: { type: 'string', description: 'Notebook id to put the note in; omit it for the default notebook.' },
        folder_name: { type: 'string', description: 'Notebook name, when the id is not at hand.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'append_note',
    description: 'Append Markdown text to an existing ima note. Read it with get_note first; this cannot be undone through the API.',
    method: 'POST',
    write: true,
    path: '/openapi/note/v1/append_doc',
    body: { note_id: 'note_id', content_format: { const: 1 }, content: 'content' },
    approval: args => approvalFor('append_note', args),
    parameters: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'The note to append to; only the owner\'s own notes can be changed.' },
        content: { type: 'string', description: 'The Markdown text to append.' },
      },
      required: ['note_id', 'content'],
    },
  },
  {
    name: 'add_note_to_kb',
    description: 'Add an ima note to a knowledge base. Use list_addable_kb to find the knowledge base id.',
    method: 'POST',
    write: true,
    path: '/openapi/wiki/v1/add_knowledge',
    body: { media_type: { const: 11 }, title: 'title', knowledge_base_id: 'knowledge_base_id', folder_id: 'folder_id', 'note_info.content_id': 'note_id' },
    approval: args => approvalFor('add_note_to_kb', args),
    parameters: {
      type: 'object',
      properties: {
        knowledge_base_id: { type: 'string', description: 'The knowledge base to add the note to.' },
        note_id: { type: 'string', description: 'The note to add.' },
        title: { type: 'string', description: 'The title the item gets in the knowledge base.' },
        folder_id: { type: 'string', description: 'Folder inside the knowledge base; omit it for the root.' },
      },
      required: ['knowledge_base_id', 'note_id', 'title'],
    },
  },
  {
    name: 'import_url',
    description: 'Import web pages or WeChat articles into an ima knowledge base. Bilibili, YouTube and file:// URLs are not supported.',
    method: 'POST',
    write: true,
    path: '/openapi/wiki/v1/import_urls',
    body: { knowledge_base_id: 'knowledge_base_id', folder_id: 'folder_id', urls: 'urls' },
    approval: (args) => {
      // Refused before the card is drawn and before anything leaves the host.
      assertImportUrls(args?.urls)
      return approvalFor('import_url', args)
    },
    parameters: {
      type: 'object',
      properties: {
        knowledge_base_id: { type: 'string', description: 'The knowledge base to import into.' },
        folder_id: { type: 'string', description: 'Folder inside the knowledge base; send the knowledge base id for its root.' },
        urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Web page URLs, 1-10.' },
      },
      required: ['knowledge_base_id', 'folder_id', 'urls'],
    },
  },
]

// Display only: the client draws this list and the one permission sentence. It never
// registers a tool; the mounted tools are still `restTools`.
export const IMA_CAPABILITIES = [
  { key: 'read_notes', title: 'Read notes and knowledge bases', description: 'Search, list and read your notes, search inside knowledge bases, and list the ones you can add to.', risk: 'read' },
  { key: 'read_media', title: 'Read original files', description: 'Get the download entry for an item in a knowledge base.', risk: 'read' },
  { key: 'create_note', title: 'Create a note', description: 'Write a new note from Markdown. It cannot be undone through the API.', risk: 'destructive', preview: { change: 'creates a new note', reversible: false } },
  { key: 'append_note', title: 'Append to a note', description: 'Add text to the end of an existing note. It cannot be undone through the API.', risk: 'destructive', preview: { change: 'appends to an existing note', reversible: false } },
  { key: 'add_note_to_kb', title: 'Add a note to a knowledge base', description: 'File one of your notes into a knowledge base. It cannot be undone through the API.', risk: 'destructive', preview: { change: 'adds a note to a knowledge base', reversible: false } },
  { key: 'import_url', title: 'Import web pages', description: 'Save web pages or WeChat articles into a knowledge base. It cannot be undone through the API.', risk: 'destructive', preview: { change: 'imports web pages into a knowledge base', reversible: false } },
]

export const IMA_PERMISSIONS = {
  summary: 'Read your ima notes and knowledge bases; with Full capabilities, create and append notes and add items to a knowledge base, each after your approval.',
}

export const connector = {
  id: IMA_TOOL_PREFIX,
  displayName: 'ima',
  mode: 'rest-tools',
  api: IMA_BASE,
  levels: ['read', 'write'],
  defaultLevel: 'read',
  credentials: IMA_CREDENTIALS,
  auth,
  restTools: [...IMA_REST_TOOLS, ...IMA_WRITE_TOOLS],
  answer: imaAnswer,
  verify: verifyIma,
  // The card reads its copy from `card` only (see the client's cardText): glyph, about,
  // docsUrl and readOnlyNote at the top level are ignored by the view.
  capabilities: IMA_CAPABILITIES,
  permissions: IMA_PERMISSIONS,
  card: {
    glyph: 'ima',
    about: 'Read your ima notes and knowledge bases; with Full capabilities it can create and append notes and add items to a knowledge base.',
    docsUrl: 'https://ima.qq.com/agent-interface',
    readOnlyNote: 'At the default read level nothing is changed; Full capabilities adds four write tools, each asks first, and none can be undone through the API.',
  },
}

export default connector

// Confirms a client id / API key pair without reading any user content. Returns
// `{ ok: true }`; ima has no account name to show, so the card stays account-less.
export async function verifyIma({ secrets = {}, fetch: request = fetch } = {}) {
  const headers = auth({ secrets })
  const missing = [
    ...(headers['ima-openapi-clientid'] === undefined ? [IMA_CLIENT_ID_SECRET] : []),
    ...(headers['ima-openapi-apikey'] === undefined ? [IMA_API_KEY_SECRET] : []),
  ]
  if (missing.length > 0) throw new Error(`ima needs both a client id and an API key; missing ${missing.join(' and ')}`)
  let response
  try {
    response = await request(`${IMA_BASE}/openapi/wiki/v1/search_knowledge_base`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query: '', cursor: '', limit: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error('ima did not answer in time')
    throw new Error('Could not reach ima')
  }
  if (response.status === 401) throw new Error('ima did not accept this client id or API key')
  if (response.status === 429) throw new Error('ima is rate limiting this key; try again later')
  if (!response.ok) throw new Error(`ima answered ${response.status}`)
  let body
  try {
    body = JSON.parse(await response.text())
  } catch {
    throw new Error('ima answered something this connector cannot read')
  }
  if (body?.code !== 0) throw new Error(imaError(body?.code, body?.msg))
  return { ok: true }
}
