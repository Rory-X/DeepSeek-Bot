// 微信读书 (WeRead) — the official Agent Gateway from Tencent/WeChatReading (Apache-2.0,
// skill v1.0.5). One POST endpoint, one Bearer key, and a body that names the API it calls.
//
// Why this is a `rest-tools` connector and not an MCP client: Tencent ships no MCP server.
// What it ships is a skill pack whose every documented call is a read (`/shelf/sync`,
// `/book/info`, `/user/notebooks`, `/readdata/detail`, …), so the connector is the same
// bounded HTTP-JSON adapter ima uses — a fixed origin, a connector-owned Authorization
// header, and one definition per tool. There is no pass-through: the model never chooses an
// `api_name`, never names a path, and never supplies a header.
//
// The API key is bound to the reader's identity server-side (the vid is injected for us), so
// every answer is that reader's own shelf, notes and reading statistics. Treat it as private
// data: the tools are read-only, the key lives in DSH's secret store, and no request is made
// from the browser (the gateway's CORS origin is fixed to weread.qq.com).
//
// Request shape — every business parameter sits flat next to `api_name`, never under
// `params`, and `skill_version` is required on every call:
//   {"api_name":"/user/notebooks","count":20,"lastSort":0,"skill_version":"1.0.5"}
// Answer shape — a success carries NO `errcode`; a failure answers `errcode` (negative) plus
// `errmsg`, often with the non-standard status 499. That is what `envelope` below says.
// An `upgrade_info` field means the skill pack moved on and the version below should be
// re-read from Tencent/WeChatReading's SKILL.md.

const GATEWAY = '/api/agent/gateway'
export const SKILL_VERSION = '1.0.5'
const ORIGIN = 'https://i.weread.qq.com'
const VERIFY_TIMEOUT_MS = 15_000

const EMPTY = { type: 'object', properties: {} }

// One tool = one fixed `api_name` plus the arguments its own schema names. The body mapping is
// explicit because the adapter refuses a POST that does not spell every field out.
const call = (name, description, apiName, parameters = EMPTY, fields = {}, extra = {}) => ({
  name,
  description,
  method: 'POST',
  path: GATEWAY,
  readOnly: true,
  parameters,
  body: { api_name: { const: apiName }, skill_version: { const: SKILL_VERSION }, ...fields },
  ...extra,
})

const bookId = { type: 'string', description: 'Book id (from weread_search or weread_shelf).' }

// Checks a key by asking for the shelf; the gateway answers 401 for a key it does not accept
// and an `errcode` for anything else it refuses. No account name comes back — the key itself
// is the identity — so the card shows a connected row without an account line.
export async function verifyWeread({ token, api = ORIGIN, fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(`${String(api).replace(/\/$/, '')}${GATEWAY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ api_name: '/shelf/sync', skill_version: SKILL_VERSION }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach WeRead')
  }
  if (response.status === 401) throw new Error('WeRead did not accept this token or key')
  const body = await response.json().catch(() => undefined)
  const code = body?.errcode
  if (response.ok && (code === undefined || code === 0)) return {}
  const detail = typeof body?.errmsg === 'string' && body.errmsg !== ''
    ? body.errmsg.slice(0, 160)
    : code === undefined ? `WeRead answered ${response.status}` : `WeRead answered code ${String(code)}`
  throw new Error(`WeRead: ${detail}`)
}

export default {
  id: 'weread',
  displayName: 'WeRead',
  // Card copy: the client draws the `glyph` mark itself (no WeRead artwork is copied) and
  // shows `about`, the key page and the read-only sentence around the row.
  card: {
    glyph: 'weread',
    about: 'Shelf, notes, highlights and reading statistics',
    docsUrl: 'https://weread.qq.com/r/weread-skills',
    readOnlyNote: 'Read-only: Bots can read your shelf, notes, highlights and reading statistics; nothing in the account is ever changed.',
  },
  mode: 'rest-tools',
  api: ORIGIN,
  // Display only: the client draws this list by risk. Every tool of this connector reads;
  // the mounted tool list is the real boundary.
  capabilities: [
    { key: 'browse_shelf', title: 'Browse the shelf and the store', description: "Read the reader's shelf, search the store, and open a book's details, table of contents, progress and similar or recommended titles.", risk: 'read' },
    { key: 'read_notes', title: 'Read notes and highlights', description: "Read the notebooks overview, a book's highlights and own notes and reviews, and the most-highlighted passages of a book or chapter.", risk: 'read' },
    { key: 'read_reviews', title: 'Read public reviews', description: "Read the public reviews of a book and one review's comments and likes.", risk: 'read' },
    { key: 'read_stats', title: 'Read reading statistics', description: "Read the reader's reading statistics.", risk: 'read' },
  ],
  permissions: { summary: "Reads the reader's WeRead shelf, notes, highlights, book details and reading statistics; nothing in the account is ever changed." },
  // One key is the whole credential; the label is what the card's single input says.
  credentials: [{ name: 'WEREAD_API_KEY', label: 'WeRead API key' }],
  tokenSecret: 'WEREAD_API_KEY',
  // A success omits `errcode` entirely, so an absent status is a success; a failure carries
  // `errcode` and `errmsg`. The two auth codes keep the sentence the card already shows.
  envelope: {
    ok: 'errcode',
    allowAbsent: true,
    error: 'errmsg',
    errors: {
      '-2010': 'WeRead did not accept this token or key',
      '-2013': 'WeRead did not accept this token or key',
    },
  },
  verify: verifyWeread,
  // The key is the whole credential: no OAuth, no scope, no client id.
  auth: ({ token }) => ({ Authorization: `Bearer ${token}` }),
  restTools: [
    // A shelf can run past the 20k answer limit, and there is no way to ask for less of it, so
    // this one definition allows a complete answer for a normal shelf.
    call('shelf', 'The reader\'s WeRead shelf: ebooks in `books`, audiobooks/albums in `albums`, plus their archive lists. Count entries as books + albums + (mp ? 1 : 0).', '/shelf/sync', EMPTY, {}, { resultMax: 40_000 }),
    call('search', 'Search the WeRead store. scope: 0 all, 10 ebooks, 14 audiobooks, 16 web novels, 6 authors, 12 full text, 13 book lists, 2 official accounts, 4 articles. Page with maxIdx (start 0).', '/store/search', {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search words.' },
        scope: { type: 'integer', enum: [0, 10, 14, 16, 6, 12, 13, 2, 4], description: 'Result group to search; omit for the store default (ebooks, 10).' },
        maxIdx: { type: 'integer', description: 'Page offset; 0 for the first page.' },
        count: { type: 'integer', description: 'Page size; omit to use the server default (15).' },
      },
      required: ['keyword'],
    }, { keyword: 'keyword', scope: 'scope', maxIdx: 'maxIdx', count: 'count' }),
    call('book', 'Details of one book: title, author, rating, publisher, word count. `readerLink` opens the reader.', '/book/info', {
      type: 'object', properties: { bookId }, required: ['bookId'],
    }, { bookId: 'bookId' }),
    call('chapters', 'Table of contents of one book. `chapters[].chapterUid` is the id the heat tool takes.', '/book/chapterinfo', {
      type: 'object', properties: { bookId }, required: ['bookId'],
    }, { bookId: 'bookId' }),
    call('progress', 'The reader\'s progress in one book. `book.progress` is a 0–100 integer (1 means 1%).', '/book/getprogress', {
      type: 'object', properties: { bookId }, required: ['bookId'],
    }, { bookId: 'bookId' }),
    call('notebooks', 'Overview of the books the reader has notes in: reviewCount, noteCount (highlights), bookmarkCount, readingProgress, markedStatus. Page with lastSort (the previous page\'s last `sort`), not offset.', '/user/notebooks', {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'Page size, default 20.' },
        lastSort: { type: 'integer', description: 'Cursor: the last `sort` value of the previous page.' },
      },
    }, { count: 'count', lastSort: 'lastSort' }),
    call('highlights', 'The reader\'s highlight texts in one book, with chapter ids. Bookmarks are filtered out; this is highlights only.', '/book/bookmarklist', {
      type: 'object', properties: { bookId }, required: ['bookId'],
    }, { bookId: 'bookId' }),
    call('my_notes', 'The reader\'s own thoughts and reviews in one book: `reviews[].review.content` is the thought, `abstract` the highlighted text it replies to. Page with synckey.', '/review/list/mine', {
      type: 'object',
      properties: {
        bookid: { ...bookId, description: 'Book id (this API spells the field `bookid`).' },
        synckey: { type: 'integer', description: 'Cursor: the previous answer\'s synckey; 0 first.' },
        count: { type: 'integer', description: 'Page size, default 20.' },
      },
      required: ['bookid'],
    }, { bookid: 'bookid', synckey: 'synckey', count: 'count' }),
    call('popular_highlights', 'The most-highlighted passages in a whole book (first 20), optionally one chapter. No personal data.', '/book/bestbookmarks', {
      type: 'object',
      properties: {
        bookId,
        chapterUid: { type: 'integer', description: 'Only this chapter (from weread_chapters); omit for the whole book.' },
      },
      required: ['bookId'],
    }, { bookId: 'bookId', chapterUid: 'chapterUid' }),
    call('stats', 'The reader\'s reading statistics. mode: weekly, monthly, annually or overall (default monthly). All durations are SECONDS (totalReadTime is the total; readTimes is the per-bucket breakdown). readDays counts days with at least one minute.', '/readdata/detail', {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['weekly', 'monthly', 'annually', 'overall'], description: 'Period; default monthly.' },
        baseTime: { type: 'integer', description: 'Unix seconds inside the wanted period (0 = current period). overall takes 0.' },
      },
    }, { mode: 'mode', baseTime: 'baseTime' }),
    call('recommend', 'Personalised recommendations for this reader, from their own reading. Page with maxIdx (start 0); count defaults to 12.', '/book/recommend', {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'Page size; omit for the server default (12).' },
        maxIdx: { type: 'integer', description: 'Page offset; 0 first, then the last item\'s searchIdx.' },
      },
    }, { count: 'count', maxIdx: 'maxIdx' }),
    call('similar', 'Books similar to one book. count and maxIdx must both be sent: start with count 12, maxIdx 0; page with the last item\'s idx and the returned sessionId.', '/book/similar', {
      type: 'object',
      properties: {
        bookId,
        count: { type: 'integer', description: 'Page size; send 12 unless the reader asked for another size.' },
        maxIdx: { type: 'integer', description: 'Page offset; 0 first, then the last item\'s idx.' },
        sessionId: { type: 'string', description: 'Paging session returned by the previous answer; omit on the first call.' },
      },
      required: ['bookId', 'count', 'maxIdx'],
    }, { bookId: 'bookId', count: 'count', maxIdx: 'maxIdx', sessionId: 'sessionId' }),
    call('reviews', 'Public reviews of one book. reviewListType: 0 all, 1 recommended, 2 not recommended, 3 newest, 4 average. Page with maxIdx and synckey. Some newer `CB_…` book ids are refused with "参数格式错误" even though the shelf lists them; report that instead of retrying.', '/review/list', {
      type: 'object',
      properties: {
        bookId,
        reviewListType: { type: 'integer', enum: [0, 1, 2, 3, 4], description: 'Review filter; default 0 (all).' },
        count: { type: 'integer', description: 'Page size, default 20.' },
        maxIdx: { type: 'integer', description: 'Page offset; 0 first.' },
        synckey: { type: 'integer', description: 'Cursor from the previous answer; 0 first.' },
      },
      required: ['bookId'],
    }, { bookId: 'bookId', reviewListType: 'reviewListType', count: 'count', maxIdx: 'maxIdx', synckey: 'synckey' }),
    call('review_single', 'One public review with its comments and likes. reviewId comes from weread_reviews (reviews[].review.reviewId) or weread_my_notes.', '/review/single', {
      type: 'object',
      properties: {
        reviewId: { type: 'string', description: 'Review id from weread_reviews or weread_my_notes.' },
        commentsCount: { type: 'integer', description: 'How many comments to return.' },
        commentsDirection: { type: 'integer', description: 'Comment paging direction.' },
        likesCount: { type: 'integer', description: 'How many likes to return.' },
        likesDirection: { type: 'integer', description: 'Like paging direction.' },
        synckey: { type: 'integer', description: 'Cursor from the previous answer; 0 first.' },
      },
      required: ['reviewId'],
    }, { reviewId: 'reviewId', commentsCount: 'commentsCount', commentsDirection: 'commentsDirection', likesCount: 'likesCount', likesDirection: 'likesDirection', synckey: 'synckey' }),
    call('chapter_heat', 'How many readers highlighted each passage of one chapter (counts and scores only, no text). Take chapterUid from weread_chapters.', '/book/underlines', {
      type: 'object',
      properties: {
        bookId,
        chapterUid: { type: 'integer', description: 'Chapter uid from weread_chapters.' },
      },
      required: ['bookId', 'chapterUid'],
    }, { bookId: 'bookId', chapterUid: 'chapterUid' }),
  ],
}
