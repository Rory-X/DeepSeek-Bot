// Readwise Reader — the official Reader API. One static access token in a `Token` header,
// plain JSON, cursor paging: no MCP server, no OAuth, so this is a `rest-tools` module.
//
// The tools are read-only and every request target is a fixed constant. Nothing lets the
// model choose a URL or a path: a pass-through would hand it everything the token can read.
//
// The library is a reading profile — saved articles, highlights and the notes attached to
// them — so list answers are projected down to identity, metadata and counts. Note text and
// article bodies never come back in a list; `readwise_get_document` is the one deliberate
// exception, because a reader who names one document is asking for that document.
//
// Writes exist on this API (`/api/v3/save/`, `update/`, `delete/`) and are deliberately
// absent here: they change the reader's library and would need the write level and a
// per-call approval. This module declares the read level only, so the adapter builds no
// write tool at all.
export const READWISE_BASE = 'https://readwise.io'
export const READWISE_TOKEN_SECRET = 'READWISE_TOKEN'
export const READWISE_ID = 'readwise'
const LIST = '/api/v3/list/'
const TAGS = '/api/v3/tags/'
const AUTH = '/api/v2/auth/'
const TIMEOUT_MS = 15_000
// The fields a browsing answer keeps. Anything else — `notes`, `content`, `summary` of a
// highlight, source and image URLs — stays out of a list answer.
const DOCUMENT_FIELDS = ['id', 'title', 'author', 'category', 'location', 'site_name', 'word_count', 'reading_time', 'created_at', 'updated_at', 'saved_at', 'published_date', 'parent_id', 'reading_progress', 'summary']
const HIGHLIGHT_FIELDS = ['id', 'parent_id', 'created_at', 'updated_at', 'highlight_offset', 'highlight_location', 'location']
const NOTE_FIELDS = ['id', 'parent_id', 'created_at', 'updated_at', 'location']

const pick = (source, fields) => Object.fromEntries(fields.filter(field => source?.[field] !== undefined).map(field => [field, source[field]]))
const hasText = value => typeof value === 'string' && value.trim() !== ''

// `notes` on a document is the user's own note text; a list answer says only whether one
// exists, never what it says. The same rule covers notes attached to a highlight.
const listAnswer = fields => ({ body }) => ({
  count: typeof body?.count === 'number' ? body.count : undefined,
  nextPageCursor: body?.nextPageCursor ?? null,
  results: (Array.isArray(body?.results) ? body.results : []).map(document => ({
    ...pick(document, fields),
    has_note: hasText(document?.notes),
  })),
})

const CURSOR = { type: 'string', description: 'Page cursor from the previous answer; omit it for the first page.' }
const LIMIT = { type: 'integer', minimum: 1, maximum: 100, description: 'How many documents to return (1-100). Defaults to 25 here, not the API default of 100.' }
const UPDATED_AFTER = { type: 'string', description: 'ISO 8601 date; only documents updated after it.' }
const LOCATION = { type: 'string', enum: ['new', 'later', 'shortlist', 'archive', 'feed'], description: 'Where the document sits in the reader: new, later, shortlist, archive or feed.' }
const CATEGORY = { type: 'string', enum: ['article', 'email', 'rss', 'highlight', 'note', 'pdf', 'epub', 'tweet', 'video'], description: 'Document type.' }

// Checks the token against the API's own auth endpoint: 204 means this token is valid. It
// reads no library data, so connecting cannot show a document.
export async function verifyReadwise({ token, api = READWISE_BASE, fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(`${String(api).replace(/\/$/, '')}${AUTH}`, {
      headers: { Authorization: `Token ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Readwise')
  }
  if (response.status === 204 || response.ok) return {}
  if (response.status === 401 || response.status === 403) throw new Error('Readwise did not accept this token')
  throw new Error(`Readwise answered ${response.status}`)
}

export default {
  id: READWISE_ID,
  displayName: 'Readwise Reader',
  mode: 'rest-tools',
  api: READWISE_BASE,
  tokenSecret: READWISE_TOKEN_SECRET,
  credentials: [{ name: READWISE_TOKEN_SECRET, label: 'Readwise access token' }],
  // No write tools exist here, so the card only ever offers the read level.
  levels: ['read'],
  defaultLevel: 'read',
  card: {
    // No glyph: the client draws marks for the services it ships with, and a new one falls
    // back to its generic mark. Naming one here would need a client change in this branch.
    about: 'Saved articles, highlights and notes from Readwise Reader',
    docsUrl: 'https://readwise.io/access_token',
    readOnlyNote: 'Read-only: Bots can read your saved documents, highlights and note counts. Lists return metadata only — note and highlight text stay out of them.',
  },
  capabilities: [
    { key: 'browse_library', title: 'Browse saved documents', description: 'List saved articles by location, type or tag; each answer carries titles, authors, dates and counts, not note text.', risk: 'read' },
    { key: 'read_highlights', title: 'Read highlight and note counts', description: 'See how many highlights and notes you saved, and which document each belongs to.', risk: 'read' },
    { key: 'read_tags', title: 'List tags', description: 'See the tags on your saved documents and use them to narrow a browse.', risk: 'read' },
  ],
  permissions: { summary: 'Reads your saved documents, highlights, note counts and tags. Nothing in the library is changed.' },
  auth: ({ token }) => ({ Authorization: `Token ${token}` }),
  verify: verifyReadwise,
  restTools: [
    {
      name: 'list_documents',
      description: 'List saved documents: title, author, type, location, dates and reading progress. Filter by location, category or tag; page with pageCursor. Note text is not included.',
      method: 'GET',
      path: `${LIST}?limit=25`,
      query: { location: 'location', category: 'category', tag: 'tag', updatedAfter: 'updatedAfter', limit: 'limit', pageCursor: 'pageCursor' },
      answer: listAnswer(DOCUMENT_FIELDS),
      parameters: {
        type: 'object',
        properties: { location: LOCATION, category: CATEGORY, tag: { type: 'string', description: 'Only documents with this tag.' }, updatedAfter: UPDATED_AFTER, limit: LIMIT, pageCursor: CURSOR },
      },
    },
    {
      name: 'get_document',
      description: 'One saved document by id, with its own metadata and note. This is the explicit single read: the reader named one document.',
      method: 'GET',
      path: LIST,
      query: { id: 'id' },
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Document id from readwise_list_documents.' } }, required: ['id'] },
    },
    {
      name: 'list_highlights',
      description: 'Highlights in the library as their own documents: which document each belongs to and whether it carries a note. Highlight text stays out; use get_document on the id when the reader wants one.',
      method: 'GET',
      path: `${LIST}?category=highlight&limit=25`,
      query: { updatedAfter: 'updatedAfter', limit: 'limit', pageCursor: 'pageCursor' },
      answer: listAnswer(HIGHLIGHT_FIELDS),
      parameters: { type: 'object', properties: { updatedAfter: UPDATED_AFTER, limit: LIMIT, pageCursor: CURSOR } },
    },
    {
      name: 'list_notes',
      description: 'Notes written in Reader as their own documents: which document each belongs to and when it changed. Note text stays out; use get_document on the id to read one.',
      method: 'GET',
      path: `${LIST}?category=note&limit=25`,
      query: { updatedAfter: 'updatedAfter', limit: 'limit', pageCursor: 'pageCursor' },
      answer: listAnswer(NOTE_FIELDS),
      parameters: { type: 'object', properties: { updatedAfter: UPDATED_AFTER, limit: LIMIT, pageCursor: CURSOR } },
    },
    {
      name: 'list_tags',
      description: 'The tags on saved documents, to narrow a browse. Tags only; no document content.',
      method: 'GET',
      path: TAGS,
      parameters: { type: 'object', properties: {} },
    },
  ],
}
