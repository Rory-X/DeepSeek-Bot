// A mail connector whose service offers no API: the only way in is IMAP with an app
// password or an authorization code. This module speaks just enough of RFC 3501 to list
// folders, search UIDs and fetch headers or one message's text.
//
// Reading a mail must never change it. Every mailbox is opened with EXAMINE (never
// SELECT), every body is asked for with BODY.PEEK (never BODY), and no command that
// writes is implemented at all: there is no STORE, EXPUNGE, APPEND, COPY or MOVE. A
// test asserts the bytes written to the socket contain no such command.
//
// The credential is one string, `address:secret`, because a connector card asks for one
// token: the address names the mailbox and the secret is the app password or code. It
// never leaves the process except in the LOGIN line, and an error is passed through the
// caller's redaction before a model sees it.
import { connect as tlsConnect } from 'node:tls'

// The same result shape tools.js registers everywhere; defined here so a connector module
// loads (and its tests run) without the plugin's own tool runtime.
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export const IMAP_PORT = 993
export const IMAP_MODE = 'imap-read'

const CONNECT_TIMEOUT_MS = 15_000
const COMMAND_TIMEOUT_MS = 20_000
const FOLDER_MAX = 200
const UID_MAX = 200
const BODY_MAX = 20_000
const CRLF = Buffer.from('\r\n')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const HEADER_FIELDS = 'FROM TO CC BCC SUBJECT DATE MESSAGE-ID IN-REPLY-TO CONTENT-TYPE CONTENT-TRANSFER-ENCODING'

const messageOf = error => String(error?.message ?? error ?? 'error')

// One IMAP string, quoted. A CR or LF would end the command early, so it is refused
// instead of escaped: nothing a model writes may reach the protocol as another command.
export function quote(value) {
  const text = String(value ?? '')
  if (/[\r\n]/.test(text)) throw new Error('A value cannot contain a line break.')
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const unquote = value => String(value ?? '').replace(/\\(.)/g, '$1')

// ---------------------------------------------------------------- credentials

// `address:secret`. The secret never contains a colon (QQ's authorization codes are 16
// characters, Gmail's app passwords are 16 letters), so the first colon separates them and
// an address with an odd colon cannot eat part of the secret.
export function parseCredential(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const at = text.indexOf(':')
  if (at <= 0) throw new Error('Paste the mailbox address and the app password or authorization code, joined by a colon: name@example.com:code')
  const mailbox = text.slice(0, at).trim()
  const secret = text.slice(at + 1).trim()
  if (!/^[^\s@]+@[^\s@]+$/.test(mailbox)) throw new Error('The part before the colon must be a mailbox address, such as name@example.com')
  if (secret === '') throw new Error('The part after the colon must be the app password or authorization code')
  return { mailbox, secret }
}

// A credential arrives from the card as one string, `address:secret`, and is split before
// it is saved: the secret store keeps only `secret`, the team file keeps only the address.
// A later mount therefore hands back the stored address beside the stored secret.
export function credentialParts(credential, account) {
  if (account !== null && typeof account === 'object' && typeof account.mailbox === 'string' && account.mailbox !== '') {
    const secret = typeof credential === 'string' ? credential.trim() : ''
    if (secret === '') throw new Error('The authorization code is missing; connect this mailbox again')
    return { mailbox: account.mailbox, secret }
  }
  return parseCredential(credential)
}

// ---------------------------------------------------------------- headers

export function decodeCharset(bytes, charset) {
  const name = String(charset ?? 'utf-8').trim().toLowerCase()
  try {
    return new TextDecoder(name, { fatal: false }).decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

// Quoted-printable, on bytes. `_` is not a space here: RFC 2047's Q encoding is decoded
// separately, after its own `_` replacement, so this stays a byte decoder.
export function decodeQuotedPrintable(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer ?? '')
  const bytes = []
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] !== '=') {
      bytes.push(text.charCodeAt(at))
      continue
    }
    if (text[at + 1] === '\r' && text[at + 2] === '\n') {
      at += 2
      continue
    }
    if (text[at + 1] === '\n') {
      at += 1
      continue
    }
    const hex = text.slice(at + 1, at + 3)
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16))
      at += 2
      continue
    }
    bytes.push(61)
  }
  return Buffer.from(bytes)
}

// One repeated word can be split into several encoded words; the whitespace between two
// of them is formatting, not part of the text.
export function decodeWords(value) {
  const text = String(value ?? '')
  if (!text.includes('=?')) return text
  return text
    .replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset, encoding, body) => {
      const bytes = encoding.toLowerCase() === 'b'
        ? Buffer.from(body, 'base64')
        : decodeQuotedPrintable(Buffer.from(body.replace(/_/g, ' '), 'latin1'))
      return decodeCharset(bytes, charset)
    })
}

// An unfolded header block, lower-cased names. The first blank line ends it.
export function parseHeaders(text) {
  const headers = {}
  let key
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    if (line === '') break
    if (/^[ \t]/.test(line) && key !== undefined) {
      headers[key] = `${headers[key]} ${line.trim()}`
      continue
    }
    const at = line.indexOf(':')
    if (at <= 0) continue
    key = line.slice(0, at).trim().toLowerCase()
    headers[key] = line.slice(at + 1).trim()
  }
  return headers
}

// `text/plain; charset="utf-8"` as `{ type, params }`.
export function parseHeaderValue(value) {
  const text = String(value ?? '')
  const at = text.indexOf(';')
  const type = (at === -1 ? text : text.slice(0, at)).trim().toLowerCase()
  const params = {}
  if (at !== -1) {
    for (const match of text.slice(at + 1).matchAll(/([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g)) {
      const raw = match[2].trim()
      params[match[1].toLowerCase()] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw
    }
  }
  return { type, params }
}

// RFC 3501's modified UTF-7: `&` starts a run of base64 of UTF-16BE, `,` stands for `/`,
// and `&-` is a literal `&`. A folder name in a Chinese mailbox arrives this way.
export function decodeMailboxName(name) {
  return String(name ?? '').replace(/&([^-]*)-/g, (whole, chunk) => {
    if (chunk === '') return '&'
    const bytes = Buffer.from(chunk.replace(/,/g, '/'), 'base64')
    const units = []
    for (let at = 0; at + 1 < bytes.length; at += 2) units.push((bytes[at] << 8) | bytes[at + 1])
    return String.fromCharCode(...units)
  })
}

// ---------------------------------------------------------------- message text

function bodyBytes(raw, transferEncoding) {
  const encoding = String(transferEncoding ?? '').trim().toLowerCase()
  if (encoding === 'base64') return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(raw)
  return raw
}

function decodePart(type, transferEncoding, raw) {
  return decodeCharset(bodyBytes(raw, transferEncoding), type.params.charset)
}

// The parts of a multipart body, as their own bytes. Boundaries are ASCII, so the raw body
// is split as latin1 and each part is handed back byte for byte.
function multipartParts(raw, boundary) {
  const marker = `--${boundary}`
  const text = raw.toString('latin1')
  const parts = []
  for (const chunk of text.split(marker).slice(1)) {
    if (chunk.startsWith('--')) break
    const body = chunk.replace(/^\r\n/, '')
    const split = body.indexOf('\r\n\r\n')
    if (split === -1) continue
    parts.push({
      headers: Buffer.from(body.slice(0, split), 'latin1').toString('utf8'),
      raw: Buffer.from(body.slice(split + 4), 'latin1'),
    })
  }
  return parts
}

// A readable text for one message: its text/plain part when there is one, else its
// text/html part, else an honest note that there is no text. Nested multiparts are walked
// one level, which covers what mail clients send in practice.
export function extractText(headers, raw) {
  const type = parseHeaderValue(headers?.['content-type'] ?? 'text/plain')
  const encoding = headers?.['content-transfer-encoding']
  if (!type.type.startsWith('multipart/')) return decodePart(type, encoding, raw).trim()
  const boundary = type.params.boundary
  if (boundary === undefined || boundary === '') return decodePart({ type: 'text/plain', params: {} }, encoding, raw).trim()
  const parts = multipartParts(raw, boundary)
  const decoded = parts.map(part => ({ type: parseHeaderValue(parseHeaders(part.headers)['content-type'] ?? 'text/plain'), headers: parseHeaders(part.headers), raw: part.raw }))
  const walk = (list) => {
    for (const part of list) {
      if (part.type.type === 'text/plain') return decodePart(part.type, part.headers['content-transfer-encoding'], part.raw)
      if (part.type.type.startsWith('multipart/') && part.type.params.boundary !== undefined) {
        const nested = multipartParts(part.raw, part.type.params.boundary)
          .map(item => ({ type: parseHeaderValue(parseHeaders(item.headers)['content-type'] ?? 'text/plain'), headers: parseHeaders(item.headers), raw: item.raw }))
        const found = walk(nested)
        if (found !== '') return found
      }
    }
    return ''
  }
  const plain = walk(decoded)
  if (plain.trim() !== '') return plain.trim()
  for (const part of decoded) if (part.type.type === 'text/html') return decodePart(part.type, part.headers['content-transfer-encoding'], part.raw).trim()
  return ''
}

// ---------------------------------------------------------------- response parsing

// `LIST` answers, paired with a literal mailbox name when the server sends one that way.
export function parseListItems(items) {
  const folders = []
  let waiting
  for (const item of items) {
    if (item.line !== undefined) {
      const match = /^\* LIST \(([^)]*)\) (NIL|"(?:[^"\\]|\\.)*") (?:"((?:[^"\\]|\\.)*)"|\{(\d+)\})$/.exec(item.line)
      if (match === null) continue
      const folder = {
        name: unquote(match[3]),
        flags: match[1].split(/\s+/).filter(Boolean),
        delimiter: match[2] === 'NIL' ? undefined : unquote(match[2].slice(1, -1)),
      }
      if (match[4] === undefined) folders.push(folder)
      else waiting = folder
      continue
    }
    if (waiting !== undefined) {
      waiting.name = decodeMailboxName(item.literal.toString('utf8'))
      folders.push(waiting)
      waiting = undefined
    }
  }
  return folders.filter(folder => folder.name !== '').slice(0, FOLDER_MAX)
}

export function parseSearchUids(items) {
  const uids = []
  for (const item of items) {
    if (item.line === undefined) continue
    const match = /^\* SEARCH(?: (.*))?$/.exec(item.line)
    if (match === null) continue
    for (const part of (match[1] ?? '').trim().split(/\s+/)) if (/^\d+$/.test(part)) uids.push(Number(part))
  }
  return uids
}

// Each `* n FETCH` answer with the literals the server sent for it, in order.
export function parseFetchItems(items) {
  const messages = []
  let current
  for (const item of items) {
    if (item.line !== undefined) {
      const start = /^\* (\d+) FETCH \(/.exec(item.line)
      if (start !== null) {
        current = { seq: Number(start[1]), literals: [] }
        messages.push(current)
      }
      if (current === undefined) continue
      const uid = /\bUID (\d+)/.exec(item.line)
      if (uid !== null) current.uid = Number(uid[1])
      if (current.literals.length === 0) current.section ??= /BODY(?:\.PEEK)?\[([^\]]*)\]/.exec(item.line)?.[1]
      continue
    }
    if (current !== undefined) current.literals.push(item.literal)
  }
  return messages
}

// ---------------------------------------------------------------- IMAP client

export class ImapClient {
  // `connect` is `tls.connect` in production and a fake in tests; both answer with a
  // duplex socket. A command that writes is not among this class's methods.
  constructor({ host = 'imap.example.com', port = IMAP_PORT, connect = tlsConnect, timeoutMs = COMMAND_TIMEOUT_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) {
    this.host = host
    this.port = port
    this.connect = connect
    this.timeoutMs = timeoutMs
    this.connectTimeoutMs = connectTimeoutMs
    this.socket = undefined
    this.buffer = Buffer.alloc(0)
    this.pendingLiteral = undefined
    this.pending = undefined
    this.greeting = undefined
    this.greeted = false
    this.greetingError = undefined
    this.tag = 0
    this.queue = Promise.resolve()
    this.closed = false
  }

  async open() {
    if (this.socket !== undefined) throw new Error('The mail connection is already open')
    const socket = this.connect({ host: this.host, port: this.port, servername: this.host })
    this.socket = socket
    socket.on?.('data', chunk => this.#feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
    socket.on?.('error', error => this.#fail(new Error(`Could not reach the mail server: ${messageOf(error)}`)))
    socket.on?.('close', () => this.#fail(new Error('The mail server closed the connection')))
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Could not reach the mail server: the connection timed out'))
        socket.destroy?.()
      }, this.connectTimeoutMs)
      let settled = false
      const done = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error === undefined) resolve()
        else reject(error)
      }
      socket.once?.('connect', () => done())
      socket.once?.('error', error => done(new Error(`Could not reach the mail server: ${messageOf(error)}`)))
      socket.once?.('close', () => done(new Error('Could not reach the mail server: the connection closed before it was ready')))
    })
    await this.#waitGreeting()
  }

  async #waitGreeting() {
    if (this.greetingError !== undefined) throw this.greetingError
    if (this.greeted) return
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.greeting = undefined
        this.#fail(new Error('The mail server did not answer in time'))
        reject(new Error('The mail server did not answer in time'))
      }, this.connectTimeoutMs)
      this.greeting = {
        resolve: () => { clearTimeout(timer); resolve() },
        reject: (error) => { clearTimeout(timer); reject(error) },
      }
    })
  }

  #feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.#drain()
  }

  #drain() {
    while (!this.closed) {
      if (this.pendingLiteral !== undefined) {
        if (this.buffer.length < this.pendingLiteral) return
        const size = this.pendingLiteral
        this.#push({ literal: this.buffer.subarray(0, size) })
        this.buffer = this.buffer.subarray(size)
        this.pendingLiteral = undefined
        continue
      }
      const at = this.buffer.indexOf(CRLF)
      if (at === -1) return
      const line = this.buffer.subarray(0, at).toString('utf8')
      this.buffer = this.buffer.subarray(at + 2)
      this.#push({ line })
      const literal = /\{(\d+)\}$/.exec(line)
      if (literal !== null) this.pendingLiteral = Number(literal[1])
    }
  }

  #push(item) {
    const pending = this.pending
    if (pending !== undefined) {
      if (item.line !== undefined) {
        const done = /^A(\d+) (OK|NO|BAD)\b(.*)$/.exec(item.line)
        if (done !== null && Number(done[1]) === pending.tag) {
          this.#finish(done[2].toUpperCase(), done[3].trim())
          return
        }
      }
      pending.items.push(item)
      return
    }
    if (item.line === undefined) return
    if (/^\* (OK|PREAUTH)\b/i.test(item.line)) {
      // The first packet can carry the greeting before anything awaits it.
      if (this.greeting === undefined) {
        this.greeted = true
        return
      }
      const greeting = this.greeting
      this.greeting = undefined
      greeting.resolve()
      return
    }
    if (/^\* (BYE|NO)\b/i.test(item.line)) {
      const error = new Error(`The mail server refused the connection: ${item.line.replace(/^\* /, '')}`)
      if (this.greeting === undefined) {
        this.greetingError = error
        return
      }
      const greeting = this.greeting
      this.greeting = undefined
      greeting.reject(error)
    }
  }

  #finish(status, text) {
    const pending = this.pending
    this.pending = undefined
    if (pending === undefined) return
    clearTimeout(pending.timer)
    if (status === 'OK') {
      pending.resolve({ status, text, items: pending.items })
      return
    }
    const error = new Error(text === '' ? `The mail server answered ${status}` : text)
    error.status = status
    pending.reject(error)
  }

  #fail(error) {
    if (this.closed) return
    this.closed = true
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    const greeting = this.greeting
    this.greeting = undefined
    greeting?.reject(error)
    try { this.socket?.destroy?.() } catch { /* already gone */ }
  }

  #command(text) {
    const run = () => new Promise((resolve, reject) => {
      if (this.closed || this.socket === undefined) {
        reject(new Error('The mail connection is closed'))
        return
      }
      const tag = (this.tag += 1)
      const timer = setTimeout(() => {
        this.#fail(new Error('The mail server did not answer in time'))
        reject(new Error('The mail server did not answer in time'))
      }, this.timeoutMs)
      this.pending = { tag, resolve, reject, items: [], timer }
      try {
        this.socket.write(`A${tag} ${text}\r\n`)
      } catch (error) {
        this.pending = undefined
        clearTimeout(timer)
        reject(new Error(`Could not send to the mail server: ${messageOf(error)}`))
      }
    })
    const result = this.queue.then(run)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  // A server that wants the client's name (some mail providers refuse work before it) is
  // told once, best effort: one that does not know ID simply answers BAD, which is fine.
  async sendId() {
    try {
      await this.#command('ID ("name" "ds-bot" "version" "1" "vendor" "DeepSeek Harness")')
    } catch { /* optional */ }
  }

  async login(mailbox, secret) {
    let answer
    try {
      answer = await this.#command(`LOGIN ${quote(mailbox)} ${quote(secret)}`)
    } catch (error) {
      if (isAuthFailure(error)) {
        this.close()
        throw new Error('The mailbox did not accept the address and the app password or authorization code')
      }
      if (isRateLimited(error)) throw new Error('The mail server limits how often this mailbox may connect; try again later')
      throw error
    }
    await this.sendId()
    return answer
  }

  async list() {
    const answer = await this.#command('LIST "" "*"')
    return parseListItems(answer.items)
  }

  // EXAMINE, never SELECT: the mailbox stays read-only, so a fetch cannot change flags.
  async examine(folder) {
    const answer = await this.#command(`EXAMINE ${quote(folder)}`)
    const lines = answer.items.map(item => item.line ?? '').join('\n')
    return { messages: Number(/^\* (\d+) EXISTS/.exec(lines)?.[1] ?? 0) }
  }

  async search(criteria) {
    const answer = await this.#command(`UID SEARCH ${criteria}`)
    return parseSearchUids(answer.items)
  }

  async fetchHeaders(uids) {
    const list = uids.join(',')
    if (list === '') return []
    const answer = await this.#command(`UID FETCH ${list} (UID BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})])`)
    return parseFetchItems(answer.items)
      .filter(message => typeof message.uid === 'number')
      .map(message => ({ uid: message.uid, section: message.section, headers: parseHeaders(message.literals[0]?.toString('utf8') ?? '') }))
  }

  // BODY.PEEK, never BODY: reading a message here does not mark it as read.
  async fetchText(uid) {
    const answer = await this.#command(`UID FETCH ${uid} (UID BODY.PEEK[TEXT])`)
    const message = parseFetchItems(answer.items).find(item => typeof item.uid === 'number')
    return message?.literals[0]
  }

  close() {
    if (this.closed) return
    this.closed = true
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The mail connection was closed'))
    }
    const greeting = this.greeting
    this.greeting = undefined
    greeting?.reject(new Error('The mail connection was closed'))
    try {
      this.socket?.write?.('A0 LOGOUT\r\n')
      this.socket?.end?.()
      this.socket?.destroy?.()
    } catch { /* already gone */ }
  }
}

const isAuthFailure = error => /auth|login fail|password|credential|unsafe login|authorization code/i.test(messageOf(error)) && error?.status === 'NO'
const isRateLimited = error => /frequency|too many|rate|limit/i.test(messageOf(error))

// ---------------------------------------------------------------- tools

const bounded = (value, fallback, min, max) => {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

const folderName = value => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return 'INBOX'
  if (text.length > 200 || /[\r\n]/.test(text)) throw new Error('A folder name cannot contain a line break or be that long.')
  return text
}

const imapDate = (value, label) => {
  const match = DATE.exec(typeof value === 'string' ? value.trim() : '')
  if (match === null) throw new Error(`${label} must be a date as YYYY-MM-DD.`)
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`${label} must be a date as YYYY-MM-DD.`)
  return `${String(day).padStart(2, '0')}-${MONTHS[month - 1]}-${year}`
}

// Only the arguments a caller passed become search keys; nothing else reaches the command.
export function searchCriteria(args, { gmailQuery = false } = {}) {
  const parts = []
  if (args?.unseen === true) parts.push('UNSEEN')
  if (typeof args?.from === 'string' && args.from.trim() !== '') parts.push(`FROM ${quote(args.from.trim())}`)
  if (typeof args?.subject === 'string' && args.subject.trim() !== '') parts.push(`SUBJECT ${quote(args.subject.trim())}`)
  if (args?.since !== undefined && args.since !== '') parts.push(`SINCE ${imapDate(args.since, 'since')}`)
  if (args?.before !== undefined && args.before !== '') parts.push(`BEFORE ${imapDate(args.before, 'before')}`)
  // Gmail's own search syntax needs the X-GM-RAW extension; QQ Mail and other servers do
  // not understand it, so it is only offered when the connector asks for it.
  if (gmailQuery && typeof args?.query === 'string' && args.query.trim() !== '') parts.push(`X-GM-RAW ${quote(args.query.trim())}`)
  if (parts.length === 0) parts.push('ALL')
  const text = parts.join(' ')
  return /[^\x20-\x7e]/.test(text) ? `CHARSET UTF-8 ${text}` : text
}

const summary = (headers) => {
  const from = decodeWords(headers.from ?? '')
  const subject = decodeWords(headers.subject ?? '')
  const date = decodeWords(headers.date ?? '')
  return { from, subject, date }
}

const lineOf = (message) => {
  const { from, subject, date } = summary(message.headers)
  return `UID ${message.uid} | ${date || 'no date'} | ${from || 'unknown sender'} | ${subject || '(no subject)'}`
}

export function createImapTools({ id, displayName, credential, account, host, port = IMAP_PORT, redact = String, connect, timeoutMs, connectTimeoutMs, gmailQuery = false } = {}) {
  const { mailbox, secret } = credentialParts(credential, account)
  let client
  let chain = Promise.resolve()

  const describe = error => redact(messageOf(error)).slice(0, 300)

  const openClient = async () => {
    if (client !== undefined && !client.closed) return client
    const next = new ImapClient({ host, port, connect, timeoutMs, connectTimeoutMs })
    await next.open()
    await next.login(mailbox, secret)
    client = next
    return client
  }

  // Tool calls share one connection and never interleave: IMAP has one selected mailbox,
  // so two searches at once would answer about the wrong folder.
  const run = (work) => {
    const result = chain.then(async () => work(await openClient()))
    chain = result.then(() => {}, () => {})
    return result.catch(error => { throw new Error(describe(error)) })
  }

  const tools = [
    {
      name: `${id}_list_folders`,
      description: `List the folders of the connected ${displayName} mailbox (read-only).`,
      parameters: { type: 'object', properties: {} },
      output,
      execute: () => run(async (imap) => {
        const folders = await imap.list()
        if (folders.length === 0) return `${displayName} returned no folders.`
        return folders.map(folder => folder.delimiter === undefined ? folder.name : `${folder.name} (delimiter "${folder.delimiter}")`).join('\n')
      }),
    },
    {
      name: `${id}_search`,
      description: `Search the connected ${displayName} mailbox and answer message UIDs (read-only).`,
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Folder name; default INBOX' },
          unseen: { type: 'boolean', description: 'Only messages that are not read yet' },
          from: { type: 'string', description: 'Sender contains this text' },
          subject: { type: 'string', description: 'Subject contains this text' },
          since: { type: 'string', description: 'On or after this date, YYYY-MM-DD' },
          before: { type: 'string', description: 'Before this date, YYYY-MM-DD' },
          ...(gmailQuery ? { query: { type: 'string', description: 'Gmail search syntax, such as is:unread, has:attachment or newer_than:7d' } } : {}),
          limit: { type: 'integer', description: `How many of the newest matches to name, 1-${UID_MAX}; default 20` },
        },
      },
      output,
      execute: args => run(async (imap) => {
        const folder = folderName(args?.folder)
        const criteria = searchCriteria(args, { gmailQuery })
        await imap.examine(folder)
        const uids = await imap.search(criteria)
        const limit = bounded(args?.limit, 20, 1, UID_MAX)
        const picked = uids.slice(-limit)
        if (picked.length === 0) return `No message in "${folder}" matches.`
        return `${uids.length} message(s) in "${folder}" match. Newest ${picked.length}, oldest first: ${picked.join(', ')}`
      }),
    },
    {
      name: `${id}_list_messages`,
      description: `List the newest messages of a ${displayName} folder with sender, date and subject (read-only).`,
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Folder name; default INBOX' },
          unseen: { type: 'boolean', description: 'Only messages that are not read yet' },
          newest: { type: 'integer', description: 'How many messages to list, 1-50; default 20' },
        },
      },
      output,
      execute: args => run(async (imap) => {
        const folder = folderName(args?.folder)
        const limit = bounded(args?.newest, 20, 1, 50)
        await imap.examine(folder)
        const uids = (await imap.search(args?.unseen === true ? 'UNSEEN' : 'ALL')).slice(-limit)
        if (uids.length === 0) return `No message in "${folder}".`
        const messages = await imap.fetchHeaders(uids)
        if (messages.length === 0) return `The server listed ${uids.length} message(s) but sent no headers.`
        return [`${messages.length} message(s) in "${folder}", newest last:`, ...messages.map(lineOf)].join('\n')
      }),
    },
    {
      name: `${id}_get_message`,
      description: `Read one message of a ${displayName} folder: headers and its plain text body (read-only).`,
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'integer', description: 'Message UID, from search or list_messages' },
          folder: { type: 'string', description: 'Folder name; default INBOX' },
        },
        required: ['uid'],
      },
      output,
      execute: args => run(async (imap) => {
        const raw = typeof args?.uid === 'number' ? args.uid : Number.parseInt(String(args?.uid ?? ''), 10)
        if (!Number.isInteger(raw) || raw <= 0) throw new Error('uid must be a positive number, from search or list_messages.')
        const folder = folderName(args?.folder)
        await imap.examine(folder)
        const [message] = await imap.fetchHeaders([raw])
        if (message === undefined) throw new Error(`No message with UID ${raw} in "${folder}".`)
        const body = await imap.fetchText(raw)
        const headers = message.headers
        const { subject, date } = summary(headers)
        const lines = [
          `UID: ${raw}`,
          `From: ${decodeWords(headers.from ?? '') || 'unknown'}`,
          `To: ${decodeWords(headers.to ?? '') || 'unknown'}`,
          `Date: ${date || 'unknown'}`,
          `Subject: ${subject || '(no subject)'}`,
          `Message-ID: ${headers['message-id'] ?? 'unknown'}`,
        ]
        const text = body === undefined || body.length === 0 ? '' : extractText(headers, body)
        if (text === '') {
          lines.push('', 'No readable text part in this message.')
        } else if (text.length > BODY_MAX) {
          lines.push('', text.slice(0, BODY_MAX), `… (text cut: ${text.length} characters in all)`)
        } else {
          lines.push('', text)
        }
        return lines.join('\n')
      }),
    },
  ]

  return {
    mailbox,
    tools,
    async close() {
      client?.close()
      client = undefined
    },
  }
}

// A connect-time check: the credential can log in and the INBOX can be opened read-only.
// The connection is closed again, so a connector card can check a pasted credential
// before it mounts anything.
export async function signInImap(credential, { account, host, port = IMAP_PORT, connect, timeoutMs, connectTimeoutMs } = {}) {
  const { mailbox, secret } = credentialParts(credential, account)
  const client = new ImapClient({ host, port, connect, timeoutMs, connectTimeoutMs })
  try {
    await client.open()
    await client.login(mailbox, secret)
    await client.examine('INBOX')
    return { mailbox }
  } finally {
    client.close()
  }
}
