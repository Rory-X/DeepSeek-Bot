// Shared SMTP for connectors that send mail (Gmail first, QQ Mail next). IMAP has no send
// verb, so a connector with an app password sends over SMTP: implicit TLS on 465 by
// default, AUTH LOGIN, then MAIL FROM / RCPT TO / DATA. Node has no SMTP client and DS Bot
// takes no new dependency for one, so the protocol lives here over node:tls.
//
// Two rules shape this file. First, a send is irreversible: the client refuses a From that
// is not the connected account before it opens a socket, the tools ask for approval before
// any connection, and nothing is retried automatically. Second, credentials never appear in
// an error: the client redacts through the caller's function and the auth failure is one
// plain sentence.
//
// The MIME builder is separate from the protocol so a reply or a forward can be assembled
// from material another module read over IMAP: text/plain with an optional HTML part,
// base64 attachments (at most 10 files and 15 MB in all), RFC 2047 headers, Message-ID and
// Date, and In-Reply-To / References for a reply.
import { randomUUID } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'

const CRLF = '\r\n'
const CONNECT_TIMEOUT_MS = 15_000
const COMMAND_TIMEOUT_MS = 20_000
export const MAX_RECIPIENTS = 20
export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
const MAX_BODY_BYTES = 256 * 1024
const MAX_SUBJECT_LENGTH = 900
const MAX_HEADER_LENGTH = 900
const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+$/
const MESSAGE_ID = /^<[^<>\s]+@[^<>\s]+>$/

const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const messageOf = error => String(error?.message ?? error ?? 'error')

export class SmtpError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SmtpError'
    this.code = code
  }
}

// ---------------------------------------------------------------- validators

function lineOf(value, label, max = MAX_HEADER_LENGTH) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new Error(`${label} cannot be empty.`)
  if (/[\r\n\u0000]/.test(text)) throw new Error(`${label} cannot contain a line break.`)
  if (text.length > max) throw new Error(`${label} is too long; keep it under ${max} characters.`)
  return text
}

function addressOf(value, label = 'An address') {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ADDRESS.test(text)) throw new Error(`${label} must be a plain email address, such as name@example.com.`)
  return text
}

const addressesOf = (value, label) => {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map(item => addressOf(item, `${label[0].toUpperCase()}${label.slice(1)} address`))
}

function bodyOf(value, label) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`${label} must be text.`)
  if (Buffer.byteLength(value, 'utf8') > MAX_BODY_BYTES) throw new Error(`${label} is too large; keep it under ${MAX_BODY_BYTES} bytes.`)
  return value
}

function attachmentOf(item, index) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Attachment ${index + 1} must be an object.`)
  const filename = lineOf(item.filename, `Attachment ${index + 1} filename`, 200)
  const contentType = typeof item.contentType === 'string' && item.contentType.trim() !== ''
    ? lineOf(item.contentType, `Attachment ${index + 1} type`, 120)
    : 'application/octet-stream'
  let content
  if (Buffer.isBuffer(item.content)) content = item.content
  else if (item.content instanceof Uint8Array) content = Buffer.from(item.content)
  else if (typeof item.contentBase64 === 'string') {
    const base = item.contentBase64.replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base) || base.length % 4 !== 0) throw new Error(`Attachment ${index + 1} content is not valid base64.`)
    content = Buffer.from(base, 'base64')
  } else if (typeof item.content === 'string') content = Buffer.from(item.content, 'utf8')
  else throw new Error(`Attachment ${index + 1} needs content or contentBase64.`)
  if (content.length === 0) throw new Error(`Attachment ${index + 1} is empty.`)
  return { filename, contentType, content }
}

export function attachmentsOf(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('attachments must be a list.')
  if (value.length > MAX_ATTACHMENTS) throw new Error(`A message can carry at most ${MAX_ATTACHMENTS} attachments.`)
  const list = value.map((item, index) => attachmentOf(item, index))
  const total = list.reduce((sum, item) => sum + item.content.length, 0)
  if (total > MAX_ATTACHMENT_BYTES) throw new Error(`The attachments are too large; keep them under ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB in all.`)
  return list
}

// ---------------------------------------------------------------- MIME

const wrapBase64 = (buffer) => {
  const encoded = Buffer.from(buffer).toString('base64')
  return encoded === '' ? '' : encoded.match(/.{1,76}/g).join(CRLF)
}

// RFC 2047 encoded words for a header that carries non-ASCII text. ASCII stays readable
// and is folded at a boundary so a long subject still fits on lines.
export function encodeHeader(value, max = 70) {
  const text = String(value ?? '')
  if (!/[^\x20-\x7e]/.test(text)) {
    if (text.length <= max) return text
    const chunks = []
    for (let at = 0; at < text.length; at += max) chunks.push(text.slice(at, at + max))
    return chunks.join(`${CRLF} `)
  }
  const chunks = []
  let bytes = []
  const flush = () => {
    if (bytes.length === 0) return
    chunks.push(`=?UTF-8?B?${Buffer.from(bytes).toString('base64')}?=`)
    bytes = []
  }
  for (const char of text) {
    const encoded = Buffer.from(char, 'utf8')
    if (bytes.length + encoded.length > 45) flush()
    for (const byte of encoded) bytes.push(byte)
  }
  flush()
  return chunks.join(`${CRLF} `)
}

const encodeFilename = (name) => {
  if (/^[\x20-\x7e]*$/.test(name) && !/["\\]/.test(name)) return `filename="${name}"`
  return `filename*=UTF-8''${encodeURIComponent(name)}`
}

const dateLine = (value) => {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) throw new Error('date is not a date.')
  return date.toUTCString().replace(/GMT$/, '+0000')
}

const headerBlock = (fields) => fields.map(([name, value]) => `${name}: ${value}`).join(CRLF)

const textPart = (boundary, contentType, body) => [
  `--${boundary}`,
  `Content-Type: ${contentType}; charset=utf-8`,
  'Content-Transfer-Encoding: base64',
  '',
  wrapBase64(Buffer.from(body, 'utf8')),
].join(CRLF)

const filePart = (boundary, file) => {
  const disposition = encodeFilename(file.filename)
  return [
    `--${boundary}`,
    `Content-Type: ${file.contentType}; ${disposition.replace(/^filename/, 'name')}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; ${disposition}`,
    '',
    wrapBase64(file.content),
  ].join(CRLF)
}

// The whole message as SMTP DATA wants it: CRLF line endings, no dot stuffing (the client
// does that) and one blank line between the headers and the body.
export function buildMime({
  from,
  to,
  cc = [],
  subject,
  text,
  html,
  attachments = [],
  inReplyTo,
  references,
  date,
  messageId,
} = {}) {
  const sender = addressOf(from, 'From address')
  const recipients = addressesOf(to, 'To')
  const copies = addressesOf(cc, 'Cc')
  if (recipients.length === 0) throw new Error('A message needs at least one To address.')
  if (recipients.length + copies.length > MAX_RECIPIENTS) throw new Error(`A message can go to at most ${MAX_RECIPIENTS} recipients.`)
  const subjectLine = lineOf(subject, 'Subject', MAX_SUBJECT_LENGTH)
  const textBody = bodyOf(text, 'The text body')
  const htmlBody = bodyOf(html, 'The HTML body')
  const files = attachmentsOf(attachments)
  if (textBody === '' && htmlBody === '' && files.length === 0) throw new Error('A message needs a text body, an HTML body or an attachment.')
  const replyTo = inReplyTo === undefined || inReplyTo === null || inReplyTo === '' ? undefined : lineOf(inReplyTo, 'In-Reply-To', MAX_HEADER_LENGTH)
  if (replyTo !== undefined && !MESSAGE_ID.test(replyTo)) throw new Error('In-Reply-To must look like <id@example.com>.')
  const referenceList = references === undefined || references === null
    ? []
    : (Array.isArray(references) ? references : [references]).map(item => lineOf(item, 'Reference', MAX_HEADER_LENGTH))
  for (const reference of referenceList) if (!MESSAGE_ID.test(reference)) throw new Error('References must look like <id@example.com>.')

  const id = messageId === undefined || messageId === null
    ? `<${randomUUID()}@${sender.split('@')[1]}>`
    : (() => {
        const given = lineOf(messageId, 'Message-ID', MAX_HEADER_LENGTH)
        if (!MESSAGE_ID.test(given)) throw new Error('Message-ID must look like <id@example.com>.')
        return given
      })()

  const headers = [
    ['From', sender],
    ['To', recipients.join(', ')],
    ...(copies.length === 0 ? [] : [['Cc', copies.join(', ')]]),
    ['Subject', encodeHeader(subjectLine)],
    ['Date', dateLine(date)],
    ['Message-ID', id],
    ['MIME-Version', '1.0'],
    ...(replyTo === undefined ? [] : [['In-Reply-To', replyTo]]),
    ...(referenceList.length === 0 ? [] : [['References', referenceList.join(' ')]]),
  ]

  const hasHtml = htmlBody !== ''
  const hasFiles = files.length > 0

  if (!hasHtml && !hasFiles) {
    return [
      headerBlock([...headers, ['Content-Type', 'text/plain; charset=utf-8'], ['Content-Transfer-Encoding', 'base64']]),
      '',
      wrapBase64(Buffer.from(textBody, 'utf8')),
      '',
    ].join(CRLF)
  }

  if (!hasFiles) {
    const boundary = `ds-bot-alt-${randomUUID()}`
    const parts = [textPart(boundary, 'text/plain', textBody)]
    if (hasHtml) parts.push(textPart(boundary, 'text/html', htmlBody))
    return [
      headerBlock([...headers, ['Content-Type', `multipart/alternative; boundary="${boundary}"`]]),
      '',
      parts.join(CRLF),
      CRLF,
      `--${boundary}--`,
      '',
    ].join(CRLF)
  }

  const boundary = `ds-bot-mixed-${randomUUID()}`
  const parts = []
  if (hasHtml) {
    const alternative = `ds-bot-alt-${randomUUID()}`
    const inner = [textPart(alternative, 'text/plain', textBody), textPart(alternative, 'text/html', htmlBody)].join(CRLF)
    parts.push([
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${alternative}"`,
      '',
      inner,
      CRLF,
      `--${alternative}--`,
    ].join(CRLF))
  } else {
    parts.push(textPart(boundary, 'text/plain', textBody))
  }
  for (const file of files) parts.push(filePart(boundary, file))
  return [
    headerBlock([...headers, ['Content-Type', `multipart/mixed; boundary="${boundary}"`]]),
    '',
    parts.join(CRLF),
    CRLF,
    `--${boundary}--`,
    '',
  ].join(CRLF)
}

// ---------------------------------------------------------------- the client

const defaultConnect = ({ host, port }) => tlsConnect({ host, port, servername: host, rejectUnauthorized: true })

const reasonOf = (error) => {
  const code = error?.code ?? error?.cause?.code
  return typeof code === 'string' && code !== '' ? code : 'no answer'
}

// One SMTP conversation. `open` and `login` are public so a caller can check the account
// first; `send` opens and signs in lazily after the From check, so a mismatched sender
// never reaches the network.
export class SmtpClient {
  #options
  #socket
  #lines = []
  #waiter
  #buffer = ''
  #closed = false
  #failure
  #user
  #authenticated = false

  constructor({
    host,
    port = 465,
    account,
    credential,
    connect = defaultConnect,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    commandTimeoutMs = COMMAND_TIMEOUT_MS,
    clientName = 'localhost',
    displayName = 'The mail server',
    redact = text => String(text),
  } = {}) {
    this.#options = { host, port, account, credential, connect, connectTimeoutMs, commandTimeoutMs, clientName, displayName, redact }
    this.closed = false
  }

  get account() {
    return this.#options.account
  }

  async #waitForData(timeoutMs, message) {
    if (this.#failure !== undefined) throw this.#failure
    if (this.closed) throw new SmtpError(`${this.#options.displayName} is not connected.`, 'smtp-connection')
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SmtpError(message, 'smtp-timeout')), timeoutMs)
    })
    const ready = new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject }
    })
    try {
      await Promise.race([ready, timeout])
    } finally {
      clearTimeout(timer)
      this.#waiter = undefined
    }
  }

  async #readResponse() {
    for (;;) {
      if (this.#lines.length === 0) {
        await this.#waitForData(this.#options.commandTimeoutMs, `${this.#options.displayName} did not answer in time.`)
        continue
      }
      const lines = []
      let complete = false
      while (this.#lines.length > 0) {
        const line = this.#lines.shift()
        lines.push(line)
        if (line.length < 4 || line[3] !== '-') {
          complete = true
          break
        }
      }
      if (!complete) {
        this.#lines.unshift(...lines)
        await this.#waitForData(this.#options.commandTimeoutMs, `${this.#options.displayName} did not answer in time.`)
        continue
      }
      const last = lines[lines.length - 1]
      const code = Number(last.slice(0, 3))
      if (!Number.isInteger(code)) throw new SmtpError(`${this.#options.displayName} sent a reply DS Bot could not read.`, 'smtp-protocol')
      return { code, text: lines.map(line => line.slice(4)).join(' ').trim() }
    }
  }

  #onData(chunk) {
    this.#buffer += chunk.toString('utf8')
    for (;;) {
      const at = this.#buffer.indexOf(CRLF)
      if (at < 0) break
      this.#lines.push(this.#buffer.slice(0, at))
      this.#buffer = this.#buffer.slice(at + 2)
    }
    this.#waiter?.resolve()
  }

  #fail(error) {
    if (this.closed) return
    this.closed = true
    this.#failure = error
    this.#waiter?.reject(error)
    this.#waiter = undefined
    try {
      this.#socket?.destroy?.()
    } catch {
      // The socket is already gone.
    }
  }

  #write(raw) {
    if (this.#socket === undefined || this.closed) throw this.#failure ?? new SmtpError(`${this.#options.displayName} is not connected.`, 'smtp-connection')
    try {
      this.#socket.write(raw)
    } catch (cause) {
      this.#fail(new SmtpError(`${this.#options.displayName} dropped the connection (${reasonOf(cause)}).`, 'smtp-connection'))
      throw this.#failure
    }
  }

  async #command(line, expected, label) {
    this.#write(`${line}${CRLF}`)
    const reply = await this.#readResponse()
    if (!expected.includes(reply.code)) {
      throw new SmtpError(`${this.#options.displayName} refused ${label} (${this.#clean(reply)}).`, 'smtp-refused')
    }
    return reply
  }

  async open() {
    if (this.closed) throw this.#failure ?? new SmtpError(`${this.#options.displayName} is not connected.`, 'smtp-connection')
    if (this.#socket !== undefined) return
    const { host, port, connect, connectTimeoutMs, displayName } = this.#options
    const socket = await new Promise((resolve, reject) => {
      const candidate = connect({ host, port })
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        candidate.destroy?.()
        reject(new SmtpError(`Could not reach ${displayName} (the connection timed out).`, 'smtp-connection'))
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
        reject(new SmtpError(`Could not reach ${displayName} (${reasonOf(error)}).`, 'smtp-connection'))
      })
      candidate.once('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new SmtpError(`Could not reach ${displayName} (the server closed the connection).`, 'smtp-connection'))
      })
    })
    this.#socket = socket
    socket.setNoDelay?.(true)
    socket.on('data', chunk => this.#onData(chunk))
    socket.on('error', error => this.#fail(new SmtpError(`${displayName} dropped the connection (${reasonOf(error)}).`, 'smtp-connection')))
    socket.on('close', () => this.#fail(new SmtpError(`${displayName} closed the connection.`, 'smtp-connection')))
    const greeting = await this.#readResponse()
    if (greeting.code !== 220) throw new SmtpError(`${displayName} did not answer as an SMTP server.`, 'smtp-protocol')
    await this.#command(`EHLO ${this.#options.clientName}`, [250], 'the greeting')
  }

  async login(user = this.#user ?? this.#options.account, secret = this.#options.credential) {
    if (this.closed) throw this.#failure ?? new SmtpError(`${this.#options.displayName} is not connected.`, 'smtp-connection')
    if (this.#socket === undefined) await this.open()
    const address = addressOf(user, 'The mailbox address')
    if (typeof secret !== 'string' || secret === '') throw new Error('The app password is missing.')
    this.#user = address
    try {
      await this.#command('AUTH LOGIN', [334], 'the login')
      await this.#command(Buffer.from(address, 'utf8').toString('base64'), [334], 'the login')
      await this.#command(Buffer.from(secret, 'utf8').toString('base64'), [235], 'the app password')
    } catch {
      throw this.#authFailure()
    }
    this.#authenticated = true
  }

  #authFailure() {
    return new SmtpError(`${this.#options.displayName} did not accept this address and app password.`, 'smtp-auth')
  }

  async send({ from, to, cc = [], data }) {
    const account = this.#options.account
    const sender = from ?? account
    if (typeof sender !== 'string' || sender.trim() === '') throw new Error('A message needs a From address.')
    if (account !== undefined && addressOf(sender, 'From address').toLowerCase() !== addressOf(account, 'The connected account').toLowerCase()) {
      throw new SmtpError('The From address must be the connected account; nothing was sent.', 'smtp-from')
    }
    const recipients = [...addressesOf(to, 'To'), ...addressesOf(cc, 'Cc')]
    if (recipients.length === 0) throw new Error('A message needs at least one recipient.')
    if (recipients.length > MAX_RECIPIENTS) throw new Error(`A message can go to at most ${MAX_RECIPIENTS} recipients.`)
    if (typeof data !== 'string' || data === '') throw new Error('A message needs its MIME text.')
    if (this.#socket === undefined) await this.open()
    if (!this.#authenticated) await this.login(this.#user ?? account, this.#options.credential)
    await this.#command(`MAIL FROM:<${sender}>`, [250], 'the sender')
    const accepted = []
    const refused = []
    for (const recipient of recipients) {
      this.#write(`RCPT TO:<${recipient}>${CRLF}`)
      const reply = await this.#readResponse()
      if (reply.code === 250 || reply.code === 251) accepted.push(recipient)
      else refused.push({ recipient, text: this.#clean(reply) })
    }
    if (accepted.length === 0) {
      throw new SmtpError(`${this.#options.displayName} refused every recipient (${refused.map(item => `${item.recipient}: ${item.text}`).join('; ')}).`, 'smtp-refused')
    }
    await this.#command('DATA', [354], 'the message')
    const body = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(line => (line.startsWith('.') ? `.${line}` : line)).join(CRLF)
    this.#write(`${body}${CRLF}.${CRLF}`)
    const sent = await this.#readResponse()
    if (sent.code !== 250) throw new SmtpError(`${this.#options.displayName} did not accept the message (${this.#clean(sent)}).`, 'smtp-refused')
    return { accepted, refused }
  }

  #clean(reply) {
    return this.#options.redact(`${reply.code} ${reply.text}`.trim()).slice(0, 200)
  }

  close() {
    if (this.closed) return
    this.closed = true
    const socket = this.#socket
    if (socket === undefined) return
    try {
      socket.write(`QUIT${CRLF}`)
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

// ---------------------------------------------------------------- the tools

const toolName = (id, name) => `${id}_${name}`.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '_')

const approveLine = (tool, { to, cc, subject, text, files }) => {
  const action = tool === 'reply_email' ? 'Reply to' : tool === 'forward_email' ? 'Forward to' : 'Send to'
  const recipients = [...to, ...(cc ?? [])]
  const people = recipients.length === 0 ? '(nobody)' : recipients.join(', ')
  const preview = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const attachmentText = files.length === 0
    ? ''
    : ` · ${files.length} attachment${files.length === 1 ? '' : 's'} (${files.map(file => file.filename).join(', ')})`
  return `${action} ${people} · Subject: ${String(subject ?? '').slice(0, 120) || '(none)'} · ${String(text ?? '').length} chars${preview === '' ? '' : `: "${preview}"`}${attachmentText}`
}

export function createSmtpTools({
  id,
  displayName,
  credential,
  account,
  smtp = {},
  redact = text => String(text),
  approve = async () => {},
  connect,
} = {}) {
  const address = typeof account === 'string' ? account : account?.mailbox
  const accountAddress = addressOf(address, 'The connected account')
  const credentialText = typeof credential === 'string' ? credential.trim() : ''
  if (credentialText === '') throw new Error('The app password is missing; connect this mailbox again.')
  const host = typeof smtp.host === 'string' && smtp.host !== '' ? smtp.host : 'smtp.gmail.com'
  const port = Number.isInteger(smtp.port) ? smtp.port : 465
  const clientName = smtp.clientName ?? 'localhost'

  const deliver = async ({ tool, line, mime, exec }) => {
    // Approval comes before any connection: a refused or timed-out card must leave the
    // network untouched. `exec` is the running Session, so the card reaches that chat.
    await approve({ tool, line, danger: true, exec })
    const client = new SmtpClient({
      host,
      port,
      account: accountAddress,
      credential: credentialText,
      clientName,
      displayName,
      redact,
      ...(connect === undefined ? {} : { connect }),
    })
    try {
      const result = await client.send({ from: accountAddress, to: mime.to, cc: mime.cc, data: mime.data })
      const refused = result.refused.length === 0 ? '' : ` The server refused ${result.refused.map(item => item.recipient).join(', ')}.`
      return `Sent to ${result.accepted.join(', ')} from ${accountAddress}.${refused}`
    } catch (error) {
      throw new Error(redact(messageOf(error)).slice(0, 300))
    } finally {
      client.close()
    }
  }

  const build = (args) => {
    const to = addressesOf(args?.to, 'To')
    const cc = addressesOf(args?.cc, 'Cc')
    if (to.length === 0) throw new Error('A message needs at least one To address.')
    if (to.length + cc.length > MAX_RECIPIENTS) throw new Error(`A message can go to at most ${MAX_RECIPIENTS} recipients.`)
    const subject = lineOf(args?.subject, 'Subject', MAX_SUBJECT_LENGTH)
    const text = bodyOf(args?.text, 'The text body')
    const html = bodyOf(args?.html, 'The HTML body')
    const files = attachmentsOf(args?.attachments)
    const data = buildMime({
      from: accountAddress,
      to,
      cc,
      subject,
      text,
      html,
      attachments: files,
      inReplyTo: args?.inReplyTo,
      references: args?.references,
    })
    return { to, cc, subject, text, files, data }
  }

  const attachmentsSchema = {
    type: 'array',
    description: `Files to attach (at most ${MAX_ATTACHMENTS}, ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB in all).`,
    items: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name the reader sees.' },
        contentType: { type: 'string', description: 'MIME type; application/octet-stream by default.' },
        contentBase64: { type: 'string', description: 'The file content, base64 encoded.' },
      },
      required: ['filename', 'contentBase64'],
    },
  }

  const tools = [
    {
      name: toolName(id, 'send_email'),
      description: `Send an email from the connected ${displayName} address. Every call asks for approval first; sending cannot be undone.`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses.' },
          cc: { type: 'array', items: { type: 'string' }, description: 'Copied addresses.' },
          subject: { type: 'string', description: 'Subject line.' },
          text: { type: 'string', description: 'Plain-text body.' },
          html: { type: 'string', description: 'Optional HTML body.' },
          attachments: attachmentsSchema,
        },
        required: ['to', 'subject', 'text'],
      },
      output: textOutput,
      async execute(args, exec) {
        const mime = build(args)
        return await deliver({ tool: 'send_email', line: approveLine('send_email', mime), mime, exec })
      },
    },
    {
      name: toolName(id, 'reply_email'),
      description: `Reply to a message from the connected ${displayName} address. The caller supplies the original Message-ID and References. Every call asks for approval first; sending cannot be undone.`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'Reply recipients.' },
          cc: { type: 'array', items: { type: 'string' }, description: 'Copied addresses.' },
          subject: { type: 'string', description: 'Subject line, usually the original with Re:.' },
          text: { type: 'string', description: 'Plain-text body.' },
          html: { type: 'string', description: 'Optional HTML body.' },
          inReplyTo: { type: 'string', description: 'The Message-ID this reply answers.' },
          references: { type: 'array', items: { type: 'string' }, description: 'Message-ID chain of the thread.' },
          attachments: attachmentsSchema,
        },
        required: ['to', 'subject', 'text'],
      },
      output: textOutput,
      async execute(args, exec) {
        const mime = build(args)
        return await deliver({ tool: 'reply_email', line: approveLine('reply_email', mime), mime, exec })
      },
    },
    {
      name: toolName(id, 'forward_email'),
      description: `Forward a message from the connected ${displayName} address, keeping the attachments the caller passes. Every call asks for approval first; sending cannot be undone.`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses.' },
          cc: { type: 'array', items: { type: 'string' }, description: 'Copied addresses.' },
          subject: { type: 'string', description: 'Subject line, usually Fwd: followed by the original.' },
          text: { type: 'string', description: 'Plain-text body, usually the forwarded text.' },
          html: { type: 'string', description: 'Optional HTML body.' },
          attachments: attachmentsSchema,
        },
        required: ['to', 'subject', 'text'],
      },
      output: textOutput,
      async execute(args, exec) {
        const mime = build(args)
        return await deliver({ tool: 'forward_email', line: approveLine('forward_email', mime), mime, exec })
      },
    },
  ]

  return tools
}
