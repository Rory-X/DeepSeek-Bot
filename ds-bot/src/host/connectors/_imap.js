// A small read-only IMAP client and the mail tools built on it. IMAP is not HTTP, so the
// connector framework cannot mount a mail service through an MCP client: a connector
// definition with `mode: 'imap'` names its host and supplies `verify` and `mountTools`,
// and the framework calls those.
//
// Node has no IMAP client and DS Bot takes no dependency for one, so the protocol lives
// here, over node:tls: tagged commands, untagged responses with literals, and the FETCH
// items the tools need. Everything is read-only by construction. The session can send
// only a fixed set of commands (LIST, EXAMINE, UID SEARCH, UID FETCH, LOGIN, LOGOUT), a
// mailbox is opened with EXAMINE, which the server marks read-only, and messages are read
// with BODY.PEEK, which does not set \Seen. There is no SELECT, STORE, APPEND, COPY, MOVE
// or EXPUNGE anywhere in this file, and the tools build every command from their own
// typed arguments rather than from free text.
//
// The file name starts with an underscore so the connector registry skips it: it is a
// shared core, not a connector of its own. Gmail and QQ Mail both use it.
import { connect as tlsConnect } from 'node:tls'

const CR = 13
const LF = 10
const SPACE = 32
const OPEN = 40
const CLOSE = 41
const QUOTE = 34
const LBRACE = 123
const RBRACE = 125
const NEED_MORE = Symbol('need-more')

const CONNECT_TIMEOUT_MS = 15_000
const COMMAND_TIMEOUT_MS = 30_000
const BODY_FETCH_BYTES = 200_000
const MESSAGE_TEXT_MAX = 8_000
const MESSAGE_TEXT_LIMIT = 12_000
const RESULT_MAX = 20_000
const MAILBOX_MAX = 200
const SEARCH_MAX = 25
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const textOf = value => (Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : String(value ?? ''))
const upper = value => textOf(value).toUpperCase()

// The credential card takes one value, so the mailbox address and the app password travel
// together as "you@example.com:app-password". App passwords are shown in groups of four
// and the spaces people copy are dropped.
export function parseCredential(token) {
  const text = typeof token === 'string' ? token : ''
  // A credential never travels with a line break; refusing it here keeps a pasted value
  // from starting a second IMAP command and keeps the form free of control characters.
  if (/\p{Cc}/u.test(text)) throw new Error('The credential cannot contain a line break or a control character.')
  const at = text.indexOf(':')
  if (at <= 0) throw new Error('Paste the mailbox address and its app password together, as "you@example.com:app-password".')
  const user = text.slice(0, at).trim()
  const password = text.slice(at + 1).replace(/\s+/g, '')
  if (!/^[^\s@:]+@[^\s@:]+$/.test(user)) throw new Error('The mailbox address before the colon is not an email address.')
  if (!/^[A-Za-z0-9]{8,64}$/.test(password)) throw new Error('The app password after the colon is not a plain app password; an app password is letters and digits only.')
  return { user, password }
}

// An IMAP quoted string. Line breaks are refused here so a mailbox name or a credential
// can never start a second command.
function quote(value) {
  const text = String(value)
  if (/\p{Cc}/u.test(text)) throw new Error('A mailbox name cannot contain a line break.')
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Mailbox names travel as modified UTF-7 (RFC 3501 §5.1.3), so a Chinese folder that the
// server lists can be opened again by name.
function encodeMailbox(name) {
  if (/\p{Cc}/u.test(name)) throw new Error('A mailbox name cannot contain a line break or a control character.')
  if (/^[\x20-\x7e]*$/.test(name)) return name
  let out = ''
  let run = ''
  const flush = () => {
    if (run === '') return
    const bytes = Buffer.alloc(run.length * 2)
    for (let i = 0; i < run.length; i += 1) bytes.writeUInt16BE(run.charCodeAt(i), i * 2)
    out += `&${bytes.toString('base64').replace(/\//g, ',').replace(/=+$/, '')}-`
    run = ''
  }
  for (const char of name) {
    if (char.codePointAt(0) < 0x20 || char.codePointAt(0) > 0x7e) {
      run += char
      continue
    }
    flush()
    out += char === '&' ? '&-' : char
  }
  flush()
  return out
}

function decodeMailbox(name) {
  if (!name.includes('&')) return name
  return name.replace(/&([^-]*)-/g, (whole, body) => {
    if (body === '') return '&'
    const base64 = body.replace(/,/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const bytes = Buffer.from(padded, 'base64')
    let out = ''
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i))
    return out
  })
}

// The day an IMAP SEARCH SINCE expects, in UTC.
export function imapDate(time) {
  const date = new Date(time)
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`
}

function parseInternalDate(value) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(textOf(value))
  if (match === null) return undefined
  const month = MONTHS.indexOf(`${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()}`)
  if (month < 0) return undefined
  const offset = (Number(match[8]) * 60 + Number(match[9])) * (match[7] === '-' ? -1 : 1)
  const time = Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]))
  return new Date(time - offset * 60_000).toISOString()
}

// ---------------------------------------------------------------- the response parser

// One server response is a token list: atoms and quoted strings as strings, literals as
// Buffers, and parenthesised groups as nested arrays. A response can carry literals, and
// the CRLF after a literal does not end it, so a line-based reader is not enough.
class ResponseParser {
  #buffer = Buffer.alloc(0)
  #pos = 0

  feed(chunk) {
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, Buffer.from(chunk)])
  }

  // Returns one complete response, or undefined when more bytes are needed.
  next() {
    const start = this.#pos
    const tokens = []
    const stack = [tokens]
    try {
      for (;;) {
        const current = stack[stack.length - 1]
        while (this.#pos < this.#buffer.length && this.#buffer[this.#pos] === SPACE) this.#pos += 1
        if (this.#pos >= this.#buffer.length) throw NEED_MORE
        const byte = this.#buffer[this.#pos]
        if (byte === CR) {
          if (this.#pos + 1 >= this.#buffer.length) throw NEED_MORE
          if (this.#buffer[this.#pos + 1] !== LF) throw new Error('an unexpected carriage return')
          if (stack.length !== 1) throw new Error('a list that never closed')
          this.#pos += 2
          this.#trim()
          return tokens
        }
        if (byte === OPEN) {
          this.#pos += 1
          const list = []
          current.push(list)
          stack.push(list)
          continue
        }
        if (byte === CLOSE) {
          this.#pos += 1
          if (stack.length === 1) throw new Error('an unmatched ")"')
          stack.pop()
          continue
        }
        if (byte === QUOTE) {
          current.push(this.#quoted())
          continue
        }
        if (byte === LBRACE) {
          current.push(this.#literal())
          continue
        }
        current.push(this.#atom())
      }
    } catch (error) {
      if (error !== NEED_MORE) throw error
      this.#pos = start
      return undefined
    }
  }

  // Keeps the unread tail only, so a long-lived session does not hold every answer.
  #trim() {
    if (this.#pos === this.#buffer.length) {
      this.#buffer = Buffer.alloc(0)
      this.#pos = 0
      return
    }
    if (this.#pos > 65_536) {
      this.#buffer = Buffer.from(this.#buffer.subarray(this.#pos))
      this.#pos = 0
    }
  }

  #quoted() {
    this.#pos += 1
    const bytes = []
    for (;;) {
      if (this.#pos >= this.#buffer.length) throw NEED_MORE
      const byte = this.#buffer[this.#pos]
      if (byte === QUOTE) {
        this.#pos += 1
        return Buffer.from(bytes).toString('utf8')
      }
      if (byte === 92) {
        if (this.#pos + 1 >= this.#buffer.length) throw NEED_MORE
        bytes.push(this.#buffer[this.#pos + 1])
        this.#pos += 2
        continue
      }
      bytes.push(byte)
      this.#pos += 1
    }
  }

  #literal() {
    this.#pos += 1
    const digits = []
    for (;;) {
      if (this.#pos >= this.#buffer.length) throw NEED_MORE
      const byte = this.#buffer[this.#pos]
      if (byte === RBRACE) {
        this.#pos += 1
        break
      }
      if (byte < 48 || byte > 57) throw new Error('a literal heading that is not a number')
      digits.push(byte)
      this.#pos += 1
    }
    if (this.#pos + 1 >= this.#buffer.length) throw NEED_MORE
    if (this.#buffer[this.#pos] !== CR || this.#buffer[this.#pos + 1] !== LF) throw new Error('a literal that does not start a new line')
    this.#pos += 2
    const length = Number(Buffer.from(digits).toString('ascii'))
    if (this.#pos + length > this.#buffer.length) throw NEED_MORE
    const literal = Buffer.from(this.#buffer.subarray(this.#pos, this.#pos + length))
    this.#pos += length
    return literal
  }

  #atom() {
    const start = this.#pos
    while (this.#pos < this.#buffer.length) {
      const byte = this.#buffer[this.#pos]
      if (byte === SPACE || byte === CR || byte === OPEN || byte === CLOSE) break
      this.#pos += 1
    }
    if (this.#pos === this.#buffer.length) throw NEED_MORE
    return this.#buffer.subarray(start, this.#pos).toString('utf8')
  }
}

// ---------------------------------------------------------------- the session

const defaultSocket = ({ host, port }) => tlsConnect({ host, port, servername: host, rejectUnauthorized: true })

const reasonOf = (error) => {
  const code = error?.code ?? error?.cause?.code
  if (typeof code === 'string' && code !== '') return code
  return 'no answer'
}

export class ImapExchangeError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ImapExchangeError'
    this.code = code
  }
}

// One connection and its command queue. The tools share one session until it dies; a
// later call opens a new one.
export class ImapSession {
  #options
  #socket
  #parser = new ResponseParser()
  #responses = []
  #waiters = []
  #tag = 0
  #queue = Promise.resolve()
  #opening
  #failure

  constructor({ host, port = 993, user, password, displayName = 'The mail server', createSocket = defaultSocket, connectTimeoutMs = CONNECT_TIMEOUT_MS, commandTimeoutMs = COMMAND_TIMEOUT_MS }) {
    this.#options = { host, port, user, password, displayName, createSocket, connectTimeoutMs, commandTimeoutMs }
    this.closed = false
  }

  get displayName() {
    return this.#options.displayName
  }

  async open() {
    if (this.closed) throw new ImapExchangeError(`${this.displayName} is not connected.`, 'imap-connection')
    if (this.#opening !== undefined) return await this.#opening
    const opening = this.#connect()
    this.#opening = opening.catch((error) => {
      this.#opening = undefined
      this.close()
      throw error
    })
    return await this.#opening
  }

  async #connect() {
    const { host, port, createSocket, connectTimeoutMs, displayName } = this.#options
    const socket = await new Promise((resolve, reject) => {
      const candidate = createSocket({ host, port })
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        candidate.destroy?.()
        reject(new ImapExchangeError(`Could not reach ${displayName} (the connection timed out).`, 'imap-connection'))
      }, connectTimeoutMs)
      timer.unref?.()
      const ready = candidate.encrypted === true ? 'secureConnect' : 'connect'
      candidate.once(ready, () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(candidate)
      })
      candidate.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new ImapExchangeError(`Could not reach ${displayName} (${reasonOf(error)}).`, 'imap-connection'))
      })
      candidate.once('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new ImapExchangeError(`Could not reach ${displayName} (the server closed the connection).`, 'imap-connection'))
      })
    })
    this.#socket = socket
    socket.setNoDelay?.(true)
    socket.on('data', (chunk) => {
      this.#parser.feed(chunk)
      this.#pump()
    })
    socket.on('error', (error) => {
      this.#fail(new ImapExchangeError(`${displayName} dropped the connection (${reasonOf(error)}).`, 'imap-connection'))
    })
    socket.on('close', () => {
      this.#fail(new ImapExchangeError(`${displayName} closed the connection.`, 'imap-connection'))
    })
    const greeting = await this.#nextResponse().catch((error) => {
      throw error instanceof ImapExchangeError ? error : new ImapExchangeError(`${displayName} sent no greeting.`, 'imap-connection')
    })
    if (greeting[0] !== '*' || !['OK', 'PREAUTH'].includes(upper(greeting[1]))) {
      throw new ImapExchangeError(`${displayName} did not answer as an IMAP server.`, 'imap-connection')
    }
    if (upper(greeting[1]) === 'PREAUTH') return
    try {
      await this.command(`LOGIN ${quote(this.#options.user)} ${quote(this.#options.password)}`)
    } catch (error) {
      if (error?.code === 'imap-refused') throw new ImapExchangeError(this.#loginFailure(), 'imap-auth')
      throw error
    }
  }

  #loginFailure() {
    const hint = this.#options.hint
    return `${this.displayName} did not accept this mailbox address and app password.${typeof hint === 'string' && hint !== '' ? ` ${hint}` : ''}`
  }

  #fail(error) {
    if (this.closed) return
    this.closed = true
    this.#failure = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
    try {
      this.#socket?.destroy?.()
    } catch {
      // The socket is already gone.
    }
  }

  #pump() {
    for (;;) {
      let response
      try {
        response = this.#parser.next()
      } catch (error) {
        this.#fail(new ImapExchangeError(`${this.#options.displayName} sent an answer DS Bot could not read (${error?.message ?? error}).`, 'imap-protocol'))
        return
      }
      if (response === undefined) return
      const waiter = this.#waiters.shift()
      if (waiter === undefined) this.#responses.push(response)
      else waiter.resolve(response)
    }
  }

  #nextResponse() {
    if (this.#responses.length > 0) return Promise.resolve(this.#responses.shift())
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    if (this.closed) return Promise.reject(new ImapExchangeError(`${this.#options.displayName} is not connected.`, 'imap-connection'))
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }

  async #withTimeout(promise, message) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ImapExchangeError(message, 'imap-timeout')), this.#options.commandTimeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async #send(text) {
    if (this.closed) throw this.#failure ?? new ImapExchangeError(`${this.#options.displayName} is not connected.`, 'imap-connection')
    const tag = `a${(this.#tag += 1)}`
    this.#socket.write(`${tag} ${text}\r\n`)
    const untagged = []
    for (;;) {
      const response = await this.#withTimeout(this.#nextResponse(), `${this.#options.displayName} did not answer in time.`)
      const first = response[0]
      if (first === tag) {
        const status = upper(response[1])
        if (status === 'OK') return untagged
        const detail = response.slice(2).map(textOf).filter(part => part !== '').join(' ').slice(0, 200)
        throw new ImapExchangeError(`${this.#options.displayName} refused the request${detail === '' ? '' : ` (${detail})`}.`, 'imap-refused')
      }
      if (first === '+') throw new ImapExchangeError(`${this.#options.displayName} asked for continuation data DS Bot does not send.`, 'imap-protocol')
      if (first === '*' && upper(response[1]) === 'BYE') {
        this.#fail(new ImapExchangeError(`${this.#options.displayName} ended the connection.`, 'imap-connection'))
        throw new ImapExchangeError(`${this.#options.displayName} ended the connection.`, 'imap-connection')
      }
      untagged.push(response)
    }
  }

  command(text) {
    const run = () => this.#send(text)
    const next = this.#queue.then(run, run)
    this.#queue = next.catch(() => {})
    return next
  }

  async listMailboxes() {
    const untagged = await this.command('LIST "" "*"')
    const boxes = []
    for (const response of untagged) {
      if (response[0] !== '*' || upper(response[1]) !== 'LIST') continue
      const attributes = Array.isArray(response[2]) ? response[2].map(textOf) : []
      const name = textOf(response[4])
      boxes.push({ name: decodeMailbox(name), attributes })
    }
    return boxes
  }

  async examine(mailbox) {
    const untagged = await this.command(`EXAMINE ${quote(encodeMailbox(mailbox))}`)
    let exists = 0
    let uidValidity
    for (const response of untagged) {
      if (response[0] !== '*' || upper(response[2]) !== 'EXISTS') continue
      const count = Number(textOf(response[1]))
      if (Number.isInteger(count) && count >= 0) exists = count
      const code = response.find(part => Array.isArray(part) === false && typeof part === 'string' && part.startsWith('[UIDVALIDITY'))
      if (typeof code === 'string') uidValidity = code
    }
    return { exists, uidValidity }
  }

  async search(criteria) {
    const untagged = await this.command(`UID SEARCH ${criteria}`)
    const uids = []
    for (const response of untagged) {
      if (response[0] !== '*' || upper(response[1]) !== 'SEARCH') continue
      for (const token of response.slice(2)) {
        const text = textOf(token)
        if (/^\d{1,10}$/.test(text)) uids.push(Number(text))
      }
    }
    return uids
  }

  async fetchSummaries(uids) {
    if (uids.length === 0) return []
    const set = uids.join(',')
    const untagged = await this.command(`UID FETCH ${set} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])`)
    return fetchEntries(untagged)
  }

  async fetchMessage(uid, maxBytes = BODY_FETCH_BYTES) {
    const untagged = await this.command(`UID FETCH ${uid} (UID RFC822.SIZE BODY.PEEK[]<0.${maxBytes}>)`)
    const entries = fetchEntries(untagged)
    if (entries.length === 0) return undefined
    const entry = entries[0]
    const size = Number(textOf(entry['RFC822.SIZE']))
    const raw = findBody(entry)
    return { uid, size: Number.isFinite(size) ? size : undefined, raw }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.#failure = new ImapExchangeError(`${this.#options.displayName} is not connected.`, 'imap-connection')
    for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#failure)
    const socket = this.#socket
    if (socket === undefined) return
    try {
      socket.write(`a${(this.#tag += 1)} LOGOUT\r\n`)
    } catch {
      // The socket is already gone.
    }
    try {
      socket.end?.()
    } catch {
      // The socket is already gone.
    }
    const timer = setTimeout(() => {
      try {
        socket.destroy?.()
      } catch {
        // The socket is already gone.
      }
    }, 2_000)
    timer.unref?.()
  }
}

// The pairs of a `* n FETCH (...)` response, keyed by their item name; the value keeps the
// token the server sent (a string, a Buffer for a literal, or an array for FLAGS).
function fetchEntries(untagged) {
  const entries = []
  for (const response of untagged) {
    if (response[0] !== '*' || upper(response[2]) !== 'FETCH' || Array.isArray(response[3]) === false) continue
    const pairs = {}
    const list = response[3]
    for (let at = 0; at + 1 < list.length; at += 2) pairs[upper(list[at])] = list[at + 1]
    entries.push(pairs)
  }
  return entries
}

function findBody(entry) {
  for (const [key, value] of Object.entries(entry)) {
    if (key.startsWith('BODY[]') && Buffer.isBuffer(value)) return value
  }
  return undefined
}

// ---------------------------------------------------------------- message parsing

function splitMessage(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))
  const crlf = buffer.indexOf('\r\n\r\n')
  const lf = buffer.indexOf('\n\n')
  let at = -1
  let width = 4
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    at = crlf
    width = 4
  } else if (lf >= 0) {
    at = lf
    width = 2
  }
  if (at < 0) return { headerBuffer: buffer, bodyBuffer: Buffer.alloc(0) }
  return { headerBuffer: buffer.subarray(0, at), bodyBuffer: buffer.subarray(at + width) }
}

export function parseHeaders(headerBuffer) {
  const headers = new Map()
  let lastName
  const text = Buffer.isBuffer(headerBuffer) ? headerBuffer.toString('utf8') : String(headerBuffer)
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue
    if (/^[ \t]/.test(line) && lastName !== undefined) {
      const values = headers.get(lastName)
      values[values.length - 1] += ` ${line.trim()}`
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    const values = headers.get(name) ?? []
    values.push(value)
    headers.set(name, values)
    lastName = name
  }
  return headers
}

function headerValue(headers, name) {
  const values = headers.get(name)
  return Array.isArray(values) && values.length > 0 ? values[0] : ''
}

function decodeCharset(bytes, charset) {
  const name = String(charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '')
  const label = name === '' || name === 'us-ascii' || name === 'ascii' ? 'utf-8' : name
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

// RFC 2047 encoded words in a header: =?charset?B?base64?= or =?charset?Q?quoted?=.
export function decodeWords(value) {
  const text = String(value ?? '')
  if (!text.includes('=?')) return text
  const joined = text.replace(/\?=\s+=\?/g, '?==?')
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, kind, payload) => {
    try {
      let bytes
      if (kind.toUpperCase() === 'B') {
        bytes = Buffer.from(payload.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
      } else {
        const bytesList = []
        for (let at = 0; at < payload.length; at += 1) {
          const char = payload[at]
          if (char === '_') {
            bytesList.push(32)
            continue
          }
          if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(payload.slice(at + 1, at + 3))) {
            bytesList.push(Number.parseInt(payload.slice(at + 1, at + 3), 16))
            at += 2
            continue
          }
          bytesList.push(char.charCodeAt(0))
        }
        bytes = Buffer.from(bytesList)
      }
      return decodeCharset(bytes, charset)
    } catch {
      return whole
    }
  })
}

export function parseContentType(value) {
  const text = String(value ?? '').trim()
  if (text === '') return { type: 'text/plain', params: {} }
  const pieces = text.split(';')
  const params = {}
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf('=')
    if (eq <= 0) continue
    let item = piece.slice(eq + 1).trim()
    if (item.startsWith('"') && item.endsWith('"') && item.length >= 2) item = item.slice(1, -1)
    params[piece.slice(0, eq).trim().toLowerCase()] = item
  }
  return { type: pieces[0].trim().toLowerCase(), params }
}

function decodeTransfer(bytes, encoding) {
  const name = String(encoding ?? '').trim().toLowerCase()
  if (name === 'base64') return Buffer.from(bytes.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (name !== 'quoted-printable') return bytes
  const out = []
  for (let at = 0; at < bytes.length; at += 1) {
    const byte = bytes[at]
    if (byte !== 61) {
      out.push(byte)
      continue
    }
    if (bytes[at + 1] === CR && bytes[at + 2] === LF) {
      at += 2
      continue
    }
    if (bytes[at + 1] === LF) {
      at += 1
      continue
    }
    const pair = bytes.subarray(at + 1, at + 3).toString('ascii')
    if (/^[0-9A-Fa-f]{2}$/.test(pair)) {
      out.push(Number.parseInt(pair, 16))
      at += 2
      continue
    }
    out.push(byte)
  }
  return Buffer.from(out)
}

function htmlToText(html) {
  const decodeEntity = (whole, name) => {
    switch (name.toLowerCase()) {
      case 'nbsp': return ' '
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      case '#39': return "'"
      default: return whole
    }
  }
  const decodeNumber = (whole, digits) => {
    const code = Number(digits)
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole
    try {
      return String.fromCodePoint(code)
    } catch {
      return whole
    }
  }
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([A-Za-z#][A-Za-z0-9]*);/g, decodeEntity)
    .replace(/&#(\d+);/g, decodeNumber)
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex) => decodeNumber(whole, Number.parseInt(hex, 16)))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitParts(bodyBuffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`)
  const parts = []
  let index = bodyBuffer.indexOf(delimiter)
  while (index >= 0) {
    let contentStart = index + delimiter.length
    if (bodyBuffer.subarray(contentStart, contentStart + 2).toString('latin1') === '--') break
    if (bodyBuffer[contentStart] === CR && bodyBuffer[contentStart + 1] === LF) contentStart += 2
    else if (bodyBuffer[contentStart] === LF) contentStart += 1
    const next = bodyBuffer.indexOf(delimiter, contentStart)
    parts.push(bodyBuffer.subarray(contentStart, next < 0 ? bodyBuffer.length : next))
    if (next < 0) break
    index = next
  }
  return parts
}

function normalizeText(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// The first readable text part of a message: text/plain when there is one, otherwise
// text/html turned into text. `depth` stops a hostile nesting of multiparts.
function partText(part, depth) {
  if (depth > 4) return { kind: 'other', text: '' }
  const { headerBuffer, bodyBuffer } = splitMessage(part)
  const headers = parseHeaders(headerBuffer)
  const { type, params } = parseContentType(headerValue(headers, 'content-type'))
  const encoding = headerValue(headers, 'content-transfer-encoding')
  if (type.startsWith('multipart/')) {
    if (typeof params.boundary !== 'string' || params.boundary === '') return { kind: 'other', text: '' }
    const results = splitParts(bodyBuffer, params.boundary).map(item => partText(item, depth + 1))
    const plain = results.find(result => result.kind === 'plain' && result.text !== '')
    if (plain !== undefined) return plain
    const html = results.find(result => result.kind === 'html' && result.text !== '')
    if (html !== undefined) return html
    return { kind: 'other', text: results.map(result => result.text).filter(Boolean).join('\n\n') }
  }
  if (type === 'text/plain') {
    return { kind: 'plain', text: normalizeText(decodeCharset(decodeTransfer(bodyBuffer, encoding), params.charset)) }
  }
  if (type === 'text/html') {
    return { kind: 'html', text: normalizeText(htmlToText(decodeCharset(decodeTransfer(bodyBuffer, encoding), params.charset))) }
  }
  return { kind: 'other', text: '' }
}

export function messageText(raw) {
  const { headerBuffer, bodyBuffer } = splitMessage(raw)
  const headers = parseHeaders(headerBuffer)
  const { type, params } = parseContentType(headerValue(headers, 'content-type'))
  if (type.startsWith('multipart/') && typeof params.boundary === 'string') {
    const results = splitParts(bodyBuffer, params.boundary).map(item => partText(item, 0))
    const plain = results.find(result => result.kind === 'plain' && result.text !== '')
    return plain?.text ?? results.find(result => result.kind === 'html' && result.text !== '')?.text ?? ''
  }
  return partText(raw, 0).text
}

export function messageHeaders(raw) {
  return parseHeaders(splitMessage(raw).headerBuffer)
}

const cutText = (text, max) => {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (cut: ${text.length} characters in all)`
}
const oneLine = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}
const sizeLabel = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ---------------------------------------------------------------- the tools

const toolName = (id, name) => `${id}_${name}`.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '_')

const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

function imapConfigOf(connector) {
  const imap = connector?.imap ?? {}
  return {
    host: typeof imap.host === 'string' && imap.host !== '' ? imap.host : 'imap.gmail.com',
    port: Number.isInteger(imap.port) ? imap.port : 993,
    mailbox: typeof imap.mailbox === 'string' && imap.mailbox !== '' ? imap.mailbox : 'INBOX',
    gmail: imap.gmail === true,
    hint: typeof imap.credentialHint === 'string' ? imap.credentialHint : undefined,
  }
}

function newSession(connector, token, createSocket) {
  const credential = parseCredential(token)
  const config = imapConfigOf(connector)
  return new ImapSession({
    host: config.host,
    port: config.port,
    user: credential.user,
    password: credential.password,
    displayName: connector.displayName,
    ...(config.hint === undefined ? {} : { hint: config.hint }),
    ...(createSocket === undefined ? {} : { createSocket }),
  })
}

// Asks the mail server who the saved credential belongs to. The framework calls this
// instead of the HTTP sign-in when a connector is connected.
export async function verifyImapCredential(connector, token, { createSocket } = {}) {
  const session = newSession(connector, token, createSocket)
  try {
    await session.open()
    const credential = parseCredential(token)
    return { account: credential.user }
  } finally {
    session.close()
  }
}

function summaryLine(entry) {
  const headers = Buffer.isBuffer(entry['BODY[HEADER]']) ? parseHeaders(entry['BODY[HEADER]']) : new Map()
  const from = oneLine(decodeWords(headerValue(headers, 'from')), 90)
  const subject = oneLine(decodeWords(headerValue(headers, 'subject')), 120)
  const flags = Array.isArray(entry.FLAGS) ? entry.FLAGS.map(textOf) : []
  const seen = flags.some(flag => flag.toUpperCase() === '\\SEEN')
  const uid = textOf(entry.UID)
  const date = parseInternalDate(entry.INTERNALDATE) ?? ''
  const size = Number(textOf(entry['RFC822.SIZE'] ?? ''))
  return `uid ${uid} | ${date} | ${seen ? 'read' : 'unread'} | ${sizeLabel(size)} | from: ${from || '(unknown)'} | subject: ${subject || '(none)'}`
}

const SEARCH_LIMIT_DEFAULT = 10

// The three read tools of a mail connector. They share one session: the first call opens
// it, later calls reuse it, and a session the server closed is replaced once.
export function createImapTools(id, connector, { token, output = textOutput, redact = text => String(text), createSocket } = {}) {
  const config = imapConfigOf(connector)
  const displayName = connector.displayName
  let session

  const sessionNow = async () => {
    if (session !== undefined && session.closed === false) return session
    const candidate = newSession(connector, token, createSocket)
    await candidate.open()
    session = candidate
    return session
  }

  const withSession = async (run) => {
    for (let attempt = 0; ; attempt += 1) {
      let current
      try {
        current = await sessionNow()
      } catch (error) {
        throw new Error(redact(String(error?.message ?? error)).slice(0, 300))
      }
      try {
        return await run(current)
      } catch (error) {
        const lost = current.closed === true || error?.code === 'imap-connection'
        if (attempt === 0 && lost) {
          session = undefined
          continue
        }
        throw new Error(redact(String(error?.message ?? error)).slice(0, 300))
      }
    }
  }

  const mailboxArg = (args) => {
    if (args?.mailbox === undefined || args.mailbox === null || args.mailbox === '') return config.mailbox
    if (typeof args.mailbox !== 'string') throw new Error('mailbox must be a mailbox name.')
    return args.mailbox
  }

  const listTool = {
    name: toolName(id, 'list_mailboxes'),
    description: `List the folders (IMAP mailboxes) of the ${displayName} account, with the names the other tools take as \`mailbox\`.`,
    parameters: { type: 'object', properties: {} },
    output,
    async execute() {
      return await withSession(async (mail) => {
        const boxes = await mail.listMailboxes()
        if (boxes.length === 0) return `${displayName} lists no mailboxes.`
        const visible = boxes.slice(0, MAILBOX_MAX)
        const lines = visible.map(box => `- ${box.name}${box.attributes.includes('\\Noselect') ? ' (cannot be opened)' : ''}`)
        const more = boxes.length > visible.length ? `\n… (${boxes.length - visible.length} more mailboxes not shown)` : ''
        return `${displayName}: ${boxes.length} mailbox${boxes.length === 1 ? '' : 'es'}:\n${lines.join('\n')}${more}`
      })
    },
  }

  const searchTool = {
    name: toolName(id, 'search_messages'),
    description: config.gmail
      ? `Search the messages of a ${displayName} mailbox. Read-only: nothing is marked, moved or deleted. \`query\` uses the same syntax as the Gmail search box. The newest matches are listed first.`
      : `Search the messages of a ${displayName} mailbox. Read-only: nothing is marked, moved or deleted. \`query\` is plain text that must appear in the message. The newest matches are listed first.`,
    parameters: {
      type: 'object',
      properties: {
        mailbox: { type: 'string', description: `Mailbox to search; defaults to ${config.mailbox}.` },
        query: {
          type: 'string',
          description: config.gmail
            ? 'Gmail search query, for example "from:alice is:unread has:attachment newer_than:7d". Leave it out to match every message.'
            : 'Text that must appear in the message. Leave it out to match every message.',
        },
        from: { type: 'string', description: 'Only messages whose From header contains this text.' },
        subject: { type: 'string', description: 'Only messages whose Subject contains this text.' },
        unread: { type: 'boolean', description: 'Only messages that are not marked as read.' },
        days: { type: 'integer', description: 'Only messages that arrived in the last N days (1–365).' },
        limit: { type: 'integer', description: `How many messages to list, newest first (1–${SEARCH_MAX}, default ${SEARCH_LIMIT_DEFAULT}).` },
      },
    },
    output,
    async execute(args) {
      const mailbox = mailboxArg(args)
      const criteria = []
      if (typeof args?.query === 'string' && args.query.trim() !== '') {
        criteria.push(`${config.gmail ? 'X-GM-RAW' : 'TEXT'} ${quote(args.query.trim().slice(0, 512))}`)
      }
      if (typeof args?.from === 'string' && args.from.trim() !== '') criteria.push(`FROM ${quote(args.from.trim().slice(0, 200))}`)
      if (typeof args?.subject === 'string' && args.subject.trim() !== '') criteria.push(`SUBJECT ${quote(args.subject.trim().slice(0, 200))}`)
      if (args?.unread === true) criteria.push('UNSEEN')
      if (args?.days !== undefined && args.days !== null) {
        const days = Number(args.days)
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be a whole number from 1 to 365.')
        criteria.push(`SINCE ${imapDate(Date.now() - days * 86_400_000)}`)
      }
      const requested = Number(args?.limit ?? SEARCH_LIMIT_DEFAULT)
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), SEARCH_MAX) : SEARCH_LIMIT_DEFAULT
      return await withSession(async (mail) => {
        await mail.examine(mailbox)
        const uids = await mail.search(criteria.length === 0 ? 'ALL' : criteria.join(' '))
        if (uids.length === 0) return `${displayName}: no messages in ${mailbox} match.`
        const newest = uids.slice(-limit).reverse()
        const entries = await mail.fetchSummaries(newest)
        const order = new Map(newest.map((uid, index) => [String(uid), index]))
        entries.sort((left, right) => (order.get(textOf(left.UID)) ?? 0) - (order.get(textOf(right.UID)) ?? 0))
        const lines = entries.map(summaryLine)
        const older = uids.length - newest.length
        const more = older === 1 ? ' (1 older match not listed)' : older > 1 ? ` (${older} older matches not listed)` : ''
        return cutText(`${displayName} ${mailbox}: ${uids.length} message${uids.length === 1 ? '' : 's'} match${more}.\n${lines.join('\n')}`, RESULT_MAX)
      })
    },
  }

  const messageTool = {
    name: toolName(id, 'get_message'),
    description: `Read one message from a ${displayName} mailbox by its uid (the uid that search_messages lists). Read-only: the message is fetched with BODY.PEEK, so it is not marked as read.`,
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'integer', description: 'The uid of the message, as search_messages lists it.' },
        mailbox: { type: 'string', description: `Mailbox that holds the message; defaults to ${config.mailbox}.` },
        maxChars: { type: 'integer', description: `Longest body text to return, in characters (500–${MESSAGE_TEXT_LIMIT}, default ${MESSAGE_TEXT_MAX}).` },
      },
      required: ['uid'],
    },
    output,
    async execute(args) {
      const uid = Number(args?.uid)
      if (!Number.isInteger(uid) || uid < 1 || uid > 4_294_967_295) throw new Error('uid must be the whole number search_messages listed.')
      const mailbox = mailboxArg(args)
      const requested = Number(args?.maxChars ?? MESSAGE_TEXT_MAX)
      const maxChars = Number.isInteger(requested) ? Math.min(Math.max(requested, 500), MESSAGE_TEXT_LIMIT) : MESSAGE_TEXT_MAX
      return await withSession(async (mail) => {
        await mail.examine(mailbox)
        const message = await mail.fetchMessage(uid)
        if (message === undefined || message.raw === undefined) return `${displayName}: ${mailbox} has no message with uid ${uid}.`
        const headers = messageHeaders(message.raw)
        const from = decodeWords(headerValue(headers, 'from'))
        const to = decodeWords(headerValue(headers, 'to'))
        const date = decodeWords(headerValue(headers, 'date'))
        const subject = decodeWords(headerValue(headers, 'subject'))
        const text = messageText(message.raw)
        const truncated = Number.isFinite(message.size) && message.size > message.raw.length
        const lines = [
          `From: ${oneLine(from, 300) || '(unknown)'}`,
          `To: ${oneLine(to, 300) || '(unknown)'}`,
          `Date: ${oneLine(date, 120) || '(none)'}`,
          `Subject: ${oneLine(subject, 300) || '(none)'}`,
          `Mailbox: ${mailbox} · uid ${uid}${Number.isFinite(message.size) ? ` · ${sizeLabel(message.size)}` : ''}`,
          '',
          text === '' ? '(the message has no readable text part; it may hold only attachments)' : cutText(text, maxChars),
        ]
        if (truncated) lines.push('', `Note: the message is ${sizeLabel(message.size)}; only its first ${sizeLabel(message.raw.length)} were read.`)
        return cutText(lines.join('\n'), RESULT_MAX)
      })
    },
  }

  return {
    tools: [listTool, searchTool, messageTool],
    close: () => {
      session?.close()
      session = undefined
    },
  }
}

// The framework's mount hook: register the three read tools, and close the shared session
// when the connector is disconnected.
export function mountImapTools({ ctx, connector, token, output = textOutput, redact, createSocket } = {}) {
  const created = createImapTools(connector.id, connector, { token, output, redact, createSocket })
  const dispose = created.tools.map(tool => ctx.tools.register(tool))
  // `token` is what the mount was made with, so the framework can tell a changed secret
  // from the same one and skip a pointless remount.
  return { token, dispose, close: created.close }
}
