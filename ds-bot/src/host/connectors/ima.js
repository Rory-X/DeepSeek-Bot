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
  '/openapi/wiki/v1/get_addable_knowledge_base_list',
]

const AUTH_CODES = new Set([20004, 200002])
const RATE_CODES = new Set([20002, 110021])
const PRIVATE_CODES = new Set([210005, 210011, 210034, 110030])

// ima reports a refused business call as HTTP 200 with a non-zero code, so the envelope,
// not the status line, decides whether a call succeeded.
export function imaError(code, msg) {
  const text = typeof msg === 'string' ? msg.trim() : ''
  if (AUTH_CODES.has(code)) return 'ima did not accept this client id or API key'
  if (RATE_CODES.has(code)) return 'ima is rate limiting this key; try again later'
  if (PRIVATE_CODES.has(code)) return text === '' ? 'ima says this account may not read that' : `ima says this account may not read that: ${text}`
  const named = text === '' ? '' : `: ${text}`
  return `ima answered ${code}${named}`
}

// Turns an ima response body into the tool's answer: the `data` payload on success, a
// thrown error on a business failure. A body that is not an envelope (a gateway page, an
// empty body) is passed through unchanged rather than guessed at.
export function imaAnswer(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return String(text)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'code')) return String(text)
  if (body.code === 0) return JSON.stringify(body.data ?? {})
  throw new Error(imaError(body.code, body.msg))
}

// The card and the team file keep two credentials for ima, not one token, so both are
// named here instead of being folded into `tokenSecret`.
export const IMA_CREDENTIALS = [IMA_CLIENT_ID_SECRET, IMA_API_KEY_SECRET]

// The client id is the connector's own stored secret and arrives as `token`; the API key
// is a second named secret. Both headers travel on every call.
export const restHeaders = ({ token, readSecret = () => undefined } = {}) => {
  const clientId = typeof token === 'string' && token !== '' ? token : readSecret(IMA_CLIENT_ID_SECRET)
  const apiKey = readSecret(IMA_API_KEY_SECRET)
  return {
    ...(typeof clientId === 'string' && clientId !== '' ? { 'ima-openapi-clientid': clientId } : {}),
    ...(typeof apiKey === 'string' && apiKey !== '' ? { 'ima-openapi-apikey': apiKey } : {}),
    'ima-openapi-ctx': `skill_version=${IMA_SKILL_VERSION}`,
  }
}

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
]

// The registry loads this object by its default export, takes `id` as the key, and hands
// the rest to connectors.js. `extraSecrets` names the second credential the card has to
// collect (the adapter resolves it through readSecret). `parseAnswer` unwraps ima's
// envelope: without it a refused business call would read as a successful tool answer.
export const connector = {
  id: IMA_TOOL_PREFIX,
  displayName: 'ima',
  mode: 'rest-tools',
  api: IMA_BASE,
  tokenSecret: IMA_CLIENT_ID_SECRET,
  extraSecrets: IMA_CREDENTIALS,
  restHeaders,
  restTools: IMA_REST_TOOLS,
  parseAnswer: imaAnswer,
  // ima has no "who is this key" call. A credential check is one empty-query search on
  // the knowledge base list: code 0 means the pair works, and nothing else is read.
  verify: verifyIma,
}

export default connector

// Confirms a client id / API key pair without reading any user content. Returns
// `{ ok: true }`; the framework shows the connector as connected without an account name.
export async function verifyIma({ token, readSecret = () => undefined, fetch: request = fetch } = {}) {
  const headers = restHeaders({ token, readSecret })
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
  if (!response.ok) throw new Error(`ima answered ${response.status}`)
  imaAnswer(await response.text())
  return { ok: true }
}
