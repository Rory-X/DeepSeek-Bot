import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ATTACH_MAX_BYTES, createImapTools, createImapWriteTools, decodeMailboxName, encodeMailboxName, searchCriteria } from '../src/host/connectors/_imap.js'

const CRLF = '\r\n'
const source = readFileSync(fileURLToPath(new URL('../src/host/connectors/_imap.js', import.meta.url)), 'utf8')
// Comments may name the commands they promise not to send; only code counts.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !line.trim().startsWith('//')).join('\n')

const tagOf = line => line.slice(0, line.indexOf(' '))
const ok = (socket, line, text = 'completed') => socket.send(`${tagOf(line)} OK ${text}${CRLF}`)

// One fake IMAP server: it answers the lines the client writes and keeps what it received,
// so a test can assert the exact command list — and that a refused write sends nothing.
class FakeSocket extends EventEmitter {
  constructor(onLine) {
    super()
    this.onLine = onLine
    this.buffer = Buffer.alloc(0)
    this.pending = undefined
    this.destroyed = false
    setImmediate(() => {
      this.emit('connect')
      this.send(`* OK [CAPABILITY IMAP4rev1] ready${CRLF}`)
    })
  }

  write(text) {
    this.feed(Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8'))
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.pending !== undefined) {
        const { line, size } = this.pending
        if (this.buffer.length < size) return
        const literal = this.buffer.subarray(0, size)
        this.buffer = this.buffer.subarray(size)
        this.pending = undefined
        this.onLine(line, this, literal)
        continue
      }
      const at = this.buffer.indexOf(CRLF)
      if (at === -1) return
      const line = this.buffer.subarray(0, at).toString('utf8')
      this.buffer = this.buffer.subarray(at + 2)
      const marker = /\{(\d+)\}$/.exec(line)
      if (marker !== null) {
        this.pending = { line, size: Number(marker[1]) }
        continue
      }
      this.onLine(line, this)
    }
  }

  send(text) {
    if (!this.destroyed) this.emit('data', Buffer.from(text, 'utf8'))
  }

  end() {}

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  }
}

function imapServer({ capabilities = ['IMAP4rev1'], folders = [{ name: 'INBOX' }], onLine } = {}) {
  const commands = []
  const literals = []
  const sockets = []
  const listing = folders
    .map(folder => `* LIST (${folder.flags ?? '\\HasNoChildren'}) "/" "${folder.name}"`)
    .join(CRLF)
  const connect = () => {
    const socket = new FakeSocket((line, current, literal) => {
      commands.push(line)
      if (literal !== undefined) {
        literals.push(literal.toString('utf8'))
        ok(current, line, 'APPEND completed')
        return
      }
      if (onLine?.(line, current) === true) return
      if (/^A\d+ CAPABILITY/.test(line)) return current.send(`* CAPABILITY ${capabilities.join(' ')}${CRLF}${tagOf(line)} OK CAPABILITY completed${CRLF}`)
      if (/^A\d+ LOGIN /.test(line)) return ok(current, line, '[CAPABILITY IMAP4rev1] LOGIN completed')
      if (/^A\d+ ID /.test(line)) return current.send(`${tagOf(line)} BAD Unknown command${CRLF}`)
      if (/^A\d+ (SELECT|EXAMINE) /.test(line)) return current.send(`* 3 EXISTS${CRLF}${tagOf(line)} OK completed${CRLF}`)
      if (/^A\d+ LIST /.test(line)) return current.send(`${listing}${CRLF}${tagOf(line)} OK LIST completed${CRLF}`)
      if (/^A\d+ UID SEARCH/.test(line)) return current.send(`* SEARCH 1 2 3${CRLF}${tagOf(line)} OK SEARCH completed${CRLF}`)
      if (/^A\d+ UID (STORE|MOVE|COPY|EXPUNGE)/.test(line)) return ok(current, line)
      return current.send(`${tagOf(line)} BAD Unknown command${CRLF}`)
    })
    sockets.push(socket)
    return socket
  }
  return { connect, commands, literals, sockets }
}

const sent = server => server.commands.map(line => line.replace(/^A\d+ /, ''))

const writeTools = ({ server, approve = async () => {}, redact } = {}) => createImapWriteTools({
  id: 'qq',
  displayName: 'QQ Mail',
  credential: 'user@example.com:secret-code',
  account: { mailbox: 'user@example.com' },
  connect: server.connect,
  approve,
  redact,
  timeoutMs: 1_000,
  connectTimeoutMs: 500,
})

const gmailWriteTools = ({ server, approve = async () => {} } = {}) => createImapWriteTools({
  id: 'gmail',
  displayName: 'Gmail',
  credential: 'user@example.com:secret-code',
  account: { mailbox: 'user@example.com' },
  connect: server.connect,
  approve,
  gmailLabels: true,
  timeoutMs: 1_000,
  connectTimeoutMs: 500,
})

const tool = (tools, name) => tools.find(entry => entry.name === `qq_${name}`)
const gmailTool = (tools, name) => tools.find(entry => entry.name === `gmail_${name}`)

test('IMAP search keeps the standard criteria and only nests Gmail syntax when asked', () => {
  assert.equal(searchCriteria({}), 'ALL')
  assert.equal(searchCriteria({ unseen: true }), 'UNSEEN')
  assert.equal(searchCriteria({ from: 'ann@example.com', subject: 'report' }), 'FROM "ann@example.com" SUBJECT "report"')
  // Without the Gmail switch a query is ignored, so QQ Mail never sees X-GM-RAW.
  assert.equal(searchCriteria({ unseen: true, query: 'is:unread' }), 'UNSEEN')
  // With it, the raw query is quoted and combined with the standard keys.
  assert.equal(searchCriteria({ unseen: true, query: 'is:unread has:attachment' }, { gmailQuery: true }), 'UNSEEN X-GM-RAW "is:unread has:attachment"')
  assert.equal(searchCriteria({ query: 'newer_than:7d' }, { gmailQuery: true }), 'X-GM-RAW "newer_than:7d"')
  assert.equal(searchCriteria({ query: '  ' }, { gmailQuery: true }), 'ALL')
  assert.throws(() => searchCriteria({ query: 'line\nbreak' }, { gmailQuery: true }), /line break/)
})

test('a folder name decodes from modified UTF-7 and encodes back to the same wire name', () => {
  // The names QQ Mail and Gmail send for Chinese folders.
  assert.equal(decodeMailboxName('&V4NXPpCuTvY-'), '垃圾邮件')
  assert.equal(decodeMailboxName('&XfJSIJZkkK5O9g-'), '已删除邮件')
  assert.equal(decodeMailboxName('&XfJT0ZAB-'), '已发送')
  assert.equal(decodeMailboxName('INBOX'), 'INBOX')
  assert.equal(encodeMailboxName('垃圾邮件'), '&V4NXPpCuTvY-')
  assert.equal(encodeMailboxName('已删除邮件'), '&XfJSIJZkkK5O9g-')
  assert.equal(encodeMailboxName('A&B'), 'A&-B')
  assert.equal(encodeMailboxName('INBOX'), 'INBOX')
  for (const name of ['收件箱', '已发送', '草稿箱', '垃圾邮件', '[Gmail]/所有邮件', 'A&B', '测试 Test']) {
    assert.equal(decodeMailboxName(encodeMailboxName(name)), name, name)
  }
})

test('LIST answers the decoded name and a search names the encoded one', async () => {
  const server = imapServer({ folders: [{ name: 'INBOX' }, { name: '&V4NXPpCuTvY-' }] })
  const read = createImapTools({
    id: 'qq', displayName: 'QQ Mail', credential: 'user@example.com:secret-code', account: { mailbox: 'user@example.com' },
    connect: server.connect, timeoutMs: 1_000,
  })
  try {
    const folders = await read.tools[0].execute()
    assert.match(folders, /垃圾邮件/)
    assert.equal(folders.includes('&V4NXPpCuTvY-'), false)
    await read.tools[1].execute({ folder: '垃圾邮件' })
  } finally {
    await read.close()
  }
  assert.ok(sent(server).includes('EXAMINE "&V4NXPpCuTvY-"'))
})

test('a write names the folder in its wire form, including a folder found by flag', async () => {
  const server = imapServer({
    capabilities: ['IMAP4rev1', 'MOVE'],
    folders: [{ name: 'INBOX' }, { name: '&V4NXPpCuTvY-' }, { name: '&XfJSIJZkkK5O9g-', flags: '\Trash \HasNoChildren' }],
  })
  const tools = writeTools({ server })
  await tool(tools, 'mark_read').execute({ folder: '垃圾邮件', uids: [12] })
  assert.ok(sent(server).includes('SELECT "&V4NXPpCuTvY-"'))
  await tool(tools, 'delete_messages').execute({ uids: [9] })
  assert.ok(sent(server).includes('UID MOVE 9 "&XfJSIJZkkK5O9g-"'))
})

test('only the Gmail connector offers the raw query parameter', () => {
  const make = gmailQuery => createImapTools({
    id: 'mail', displayName: 'Mail', credential: 'name@example.com:code', account: { mailbox: 'name@example.com' }, gmailQuery,
  })
  assert.equal(make(true).tools.find(tool => tool.name === 'mail_search').parameters.properties.query.type, 'string')
  assert.equal(make(false).tools.find(tool => tool.name === 'mail_search').parameters.properties.query, undefined)
})

test('the core sends a permanent delete only as UID EXPUNGE', () => {
  for (const line of code.split('\n')) {
    if (/\bEXPUNGE\b/.test(line)) assert.match(line, /UID EXPUNGE/)
  }
})

test('a connector without an approval step gets no write tools', () => {
  assert.throws(() => createImapWriteTools({
    id: 'qq', displayName: 'QQ Mail', credential: 'name@example.com:code', account: { mailbox: 'name@example.com' },
  }), /without an approval step/)
})

test('the read tools keep EXAMINE and BODY.PEEK after the write session exists', async () => {
  const server = imapServer()
  const read = createImapTools({
    id: 'qq', displayName: 'QQ Mail', credential: 'user@example.com:secret-code', account: { mailbox: 'user@example.com' },
    connect: server.connect, timeoutMs: 1_000,
  })
  try {
    await read.tools[0].execute()
    await read.tools[1].execute({ unseen: true })
  } finally {
    await read.close()
  }
  const text = server.commands.join('\n')
  for (const command of ['STORE', 'APPEND', 'COPY', 'MOVE', 'EXPUNGE', 'SELECT']) {
    assert.equal(new RegExp(`\\b${command}\\b`).test(text), false, command)
  }
  assert.match(text, /EXAMINE "INBOX"/)
})

test('a refused write asks first and sends no command at all', async () => {
  const server = imapServer()
  let asked
  const tools = writeTools({ server, approve: async (request) => { asked = request; throw new Error('The user denied it; nothing changed.') } })
  const exec = { agent: { id: 'm1' } }
  await assert.rejects(tool(tools, 'mark_read').execute({ uids: [12, 13] }, exec), /The user denied it/)
  assert.equal(asked.tool, 'qq_mark_read')
  assert.match(asked.line, /Mark 2 message\(s\) in "INBOX" as read \(UID 12,13\)/)
  // The framework aims its approval card at the Session that asked, so the call carries it.
  assert.equal(asked.exec, exec)
  assert.equal(asked.exec.agent.id, 'm1')
  assert.equal(server.sockets.length, 0)
})

test('mark_read opens the folder for writing and stores the flag', async () => {
  const server = imapServer()
  const tools = writeTools({ server })
  const text = await tool(tools, 'mark_read').execute({ folder: 'Archive', uids: [12, 13] })
  assert.equal(text, 'Marked 2 message(s) in "Archive" as read.')
  assert.deepEqual(sent(server).filter(line => /^(SELECT|UID STORE)/.test(line)), [
    'SELECT "Archive"',
    'UID STORE 12,13 +FLAGS.SILENT (\\Seen)',
  ])
  assert.equal(/\bEXAMINE\b/.test(server.commands.join('\n')), false)
})

test('move uses MOVE when the server advertises it', async () => {
  const server = imapServer({ capabilities: ['IMAP4rev1', 'MOVE'] })
  const tools = writeTools({ server })
  await tool(tools, 'move_messages').execute({ to: 'Archive', uids: [4] })
  assert.ok(sent(server).includes('UID MOVE 4 "Archive"'))
  assert.equal(sent(server).some(line => line.startsWith('UID COPY')), false)
})

test('without MOVE a move copies and flags, and never expunges', async () => {
  const server = imapServer({ capabilities: ['IMAP4rev1'] })
  const tools = writeTools({ server })
  await tool(tools, 'move_messages').execute({ to: 'Archive', uids: [4] })
  assert.ok(sent(server).includes('UID COPY 4 "Archive"'))
  assert.ok(sent(server).includes('UID STORE 4 +FLAGS.SILENT (\\Deleted)'))
  assert.equal(/EXPUNGE/.test(server.commands.join('\n')), false)
})

test('delete moves to Trash by default', async () => {
  const server = imapServer({
    capabilities: ['IMAP4rev1', 'MOVE'],
    folders: [{ name: 'INBOX' }, { name: 'Trash', flags: '\\Trash \\HasNoChildren' }],
  })
  let asked
  const tools = writeTools({ server, approve: async (request) => { asked = request } })
  const text = await tool(tools, 'delete_messages').execute({ uids: [9] })
  assert.match(text, /to Trash/)
  assert.match(asked.line, /from "INBOX" to Trash/)
  assert.equal(asked.danger, undefined)
  assert.equal(asked.reversible, undefined)
  assert.equal(asked.change, undefined)
  assert.ok(sent(server).includes('UID MOVE 9 "Trash"'))
})

test('a permanent delete is refused when the server has no UIDPLUS', async () => {
  const server = imapServer({ capabilities: ['IMAP4rev1'] })
  let asked
  const tools = writeTools({ server, approve: async (request) => { asked = request } })
  await assert.rejects(tool(tools, 'delete_messages').execute({ uids: [9], permanent: true }), /cannot permanently delete/)
  assert.equal(asked.danger, true)
  assert.equal(asked.reversible, false)
  assert.equal(asked.change, 'Permanently removes messages from the mailbox')
  assert.match(asked.line, /cannot be undone/)
  assert.equal(sent(server).some(line => /^(UID STORE|UID EXPUNGE)/.test(line)), false)
})

test('a permanent delete on a UIDPLUS server flags then expunges by UID', async () => {
  const server = imapServer({ capabilities: ['IMAP4rev1', 'UIDPLUS'] })
  const tools = writeTools({ server })
  await tool(tools, 'delete_messages').execute({ uids: [9], permanent: true })
  assert.deepEqual(sent(server).filter(line => /^(UID STORE|EXPUNGE|UID EXPUNGE)/.test(line)), [
    'UID STORE 9 +FLAGS.SILENT (\\Deleted)',
    'UID EXPUNGE 9',
  ])
  assert.deepEqual(server.commands.filter(line => /\bEXPUNGE\b/.test(line) && !/UID EXPUNGE/.test(line)), [])
})

test('too many UIDs and a line break are refused before anything is asked or sent', async () => {
  const server = imapServer()
  let asks = 0
  const tools = writeTools({ server, approve: async () => { asks += 1 } })
  await assert.rejects(tool(tools, 'mark_read').execute({ uids: Array.from({ length: 101 }, (_, index) => index + 1) }), /At most 100 messages/)
  await assert.rejects(tool(tools, 'mark_read').execute({}), /at least one message UID/)
  await assert.rejects(tool(tools, 'move_messages').execute({ uids: [1], to: 'x\r\nSTORE 1 +FLAGS (\\Deleted)' }), /line break/)
  await assert.rejects(tool(tools, 'mark_read').execute({ uids: [0] }), /positive whole number/)
  assert.equal(asks, 0)
  assert.equal(server.sockets.length, 0)
})

test('a folder with a quote is escaped, not injected', async () => {
  const server = imapServer({ capabilities: ['IMAP4rev1', 'MOVE'] })
  const tools = writeTools({ server })
  await tool(tools, 'move_messages').execute({ uids: [1], to: 'A"B' })
  assert.ok(sent(server).some(line => line.includes('UID MOVE 1 "A\\"B"')))
})

test('save_draft appends a draft, keeps the body in the body and sends no mail', async () => {
  const server = imapServer({ folders: [{ name: 'INBOX' }, { name: 'Drafts', flags: '\\Drafts \\HasNoChildren' }] })
  const tools = writeTools({ server })
  const text = await tool(tools, 'save_draft').execute({
    to: 'ann@example.com',
    subject: '周报',
    body: 'line one\nBcc: evil@example.com\nline three',
  })
  assert.match(text, /Saved a draft in "Drafts"/)
  const append = sent(server).find(line => line.startsWith('APPEND'))
  assert.match(append, /^APPEND "Drafts" \(\\Draft\) "[^"]+" \{\d+\}$/)
  const literal = server.literals[0]
  assert.match(literal, /^From: user@example\.com$/m)
  assert.match(literal, /^To: ann@example\.com$/m)
  assert.match(literal, /^Subject: =\?UTF-8\?B\?/m)
  assert.match(literal, /^Content-Transfer-Encoding: base64$/m)
  const body = Buffer.from(literal.split(`${CRLF}${CRLF}`)[1].replace(/\r\n/g, ''), 'base64').toString('utf8')
  assert.equal(body, 'line one\nBcc: evil@example.com\nline three')
  assert.equal(server.commands.some(line => /SMTP|MAIL FROM|RCPT TO/.test(line)), false)
})

test('a failing write names no credential', async () => {
  const server = imapServer({
    onLine: (line, socket) => {
      if (!/^A\d+ LOGIN /.test(line)) return false
      socket.send(`${tagOf(line)} NO [AUTHENTICATIONFAILED] Authentication failed${CRLF}`)
      return true
    },
  })
  const tools = writeTools({ server, redact: text => String(text).replaceAll('secret-code', '[redacted]') })
  await assert.rejects(tool(tools, 'mark_read').execute({ uids: [1] }), (error) => {
    assert.ok(!error.message.includes('secret-code'))
    return true
  })
})


test('Gmail label tools are opt-in, ask first and quote labels on the wire', async () => {
  const server = imapServer({ capabilities: ['IMAP4rev1', 'X-GM-EXT-1'], folders: [{ name: 'INBOX' }, { name: 'Work' }] })
  const asked = []
  const tools = gmailWriteTools({ server, approve: async (request) => { asked.push(request) } })
  assert.deepEqual(
    tools.map(entry => entry.name).filter(name => /labels|archive/.test(name)),
    ['gmail_add_labels', 'gmail_remove_labels', 'gmail_archive'],
  )

  const added = await gmailTool(tools, 'add_labels').execute({ uids: [1, 2], labels: ['Work', '\\Starred'] }, { agent: { id: 'm1' } })
  assert.match(added, /Added 2 label\(s\) to 2 message\(s\)/)
  assert.match(asked[0].line, /Add 2 label\(s\) to 2 message\(s\) in "INBOX" \(UID 1,2\)/)
  assert.equal(asked[0].exec.agent.id, 'm1')
  assert.ok(sent(server).includes('UID STORE 1,2 +X-GM-LABELS ("Work" "\\\\Starred")'))

  await gmailTool(tools, 'remove_labels').execute({ uids: [3], labels: ['Work'] }, { agent: { id: 'm1' } })
  assert.ok(sent(server).includes('UID STORE 3 -X-GM-LABELS ("Work")'))

  // Archive keeps every other label and only takes the message out of the Inbox.
  await gmailTool(tools, 'archive').execute({ uids: [4] }, { agent: { id: 'm1' } })
  assert.ok(sent(server).includes('UID STORE 4 -X-GM-LABELS ("\\\\Inbox")'))
  assert.match(asked.at(-1).line, /Archive 1 message\(s\)/)
})

test('a label write on a server without X-GM-EXT-1 fails before any write command', async () => {
  const server = imapServer({ capabilities: ['IMAP4rev1'] })
  const tools = gmailWriteTools({ server })
  await assert.rejects(gmailTool(tools, 'archive').execute({ uids: [1] }), /does not support Gmail labels/)
  assert.equal(server.commands.some(line => /X-GM-LABELS|UID STORE/.test(line)), false)
})

test('a plain mail connector gets no label tools, and an unknown tool name stays absent', () => {
  const tools = writeTools({ server: imapServer() })
  assert.deepEqual(tools.filter(entry => /labels|archive/.test(entry.name)), [])
})


test('adding a label that does not exist is refused before any write', async () => {
  const server = imapServer({ capabilities: ['IMAP4rev1', 'X-GM-EXT-1'], folders: [{ name: 'INBOX' }, { name: 'Work' }] })
  const tools = gmailWriteTools({ server })
  await assert.rejects(
    gmailTool(tools, 'add_labels').execute({ uids: [1], labels: ['Wrok'] }, { agent: { id: 'm1' } }),
    /The label "Wrok" does not exist in this account/,
  )
  assert.equal(server.commands.some(line => /X-GM-LABELS/.test(line)), false)
  // Case does not decide existence, so the real label still goes through.
  await gmailTool(tools, 'add_labels').execute({ uids: [1], labels: ['work'] }, { agent: { id: 'm1' } })
  assert.ok(sent(server).includes('UID STORE 1 +X-GM-LABELS ("work")'))
})

test('removing a label needs no pre-check, and a system label is known without LIST', async () => {
  const server = imapServer({ capabilities: ['IMAP4rev1', 'X-GM-EXT-1'], folders: [{ name: 'INBOX' }] })
  const tools = gmailWriteTools({ server })
  await gmailTool(tools, 'remove_labels').execute({ uids: [2], labels: ['Never Created'] }, { agent: { id: 'm1' } })
  assert.ok(sent(server).includes('UID STORE 2 -X-GM-LABELS ("Never Created")'))
  await gmailTool(tools, 'add_labels').execute({ uids: [3], labels: ['\\Starred'] }, { agent: { id: 'm1' } })
  assert.ok(sent(server).includes('UID STORE 3 +X-GM-LABELS ("\\\\Starred")'))
})


// A message with four parts: the body, a text attachment, a PDF, and one whose name is an
// RFC 2047 encoded word. Sizes are what the server declares.
const ATTACH_STRUCTURE = '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 21 1 NIL NIL NIL NIL)' +
  '("TEXT" "PLAIN" ("CHARSET" "UTF-8" "NAME" "notes.txt") NIL NIL "BASE64" 24 1 NIL ("ATTACHMENT" ("FILENAME" "notes.txt")) NIL NIL)' +
  '("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 1234 NIL NIL ("ATTACHMENT" ("filename" "../../evil.pdf")) NIL NIL)' +
  '("TEXT" "PLAIN" ("CHARSET" "UTF-8" "NAME" "=?UTF-8?B?5Lya6K6uLnR4dA==?=") NIL NIL "BASE64" 12 1 NIL ("ATTACHMENT" ("FILENAME" "=?UTF-8?B?5Lya6K6uLnR4dA==?=")) NIL NIL)' +
  ' "MIXED" ("BOUNDARY" "x") NIL NIL NIL)'
const ATTACH_LITERAL = Buffer.from('aGVsbG8gYXR0YWNobWVudA==', 'utf8') // base64 of "hello attachment"

const attachmentServer = ({ structure = ATTACH_STRUCTURE } = {}) => imapServer({
  folders: [{ name: 'INBOX' }],
  onLine: (line, socket) => {
    const tag = tagOf(line)
    if (/^A\d+ UID FETCH 9 \(UID BODYSTRUCTURE\)$/.test(line)) {
      socket.send(`* 1 FETCH (UID 9 BODYSTRUCTURE ${structure})${CRLF}${tag} OK completed${CRLF}`)
      return true
    }
    if (/^A\d+ UID FETCH 9 \(UID BODY\.PEEK\[2\]<\d+\.\d+>\)$/.test(line)) {
      socket.send(`* 1 FETCH (UID 9 BODY[2]<0> {${ATTACH_LITERAL.length}}${CRLF}`)
      socket.send(ATTACH_LITERAL.toString('utf8'))
      socket.send(`${CRLF})${CRLF}${tag} OK completed${CRLF}`)
      return true
    }
    return false
  },
})

const gmailRead = server => createImapTools({
  id: 'gmail',
  displayName: 'Gmail',
  credential: 'user@example.com:secret-code',
  account: { mailbox: 'user@example.com' },
  connect: server.connect,
  attachments: true,
  timeoutMs: 1_000,
  connectTimeoutMs: 500,
}).tools

const readTool = (tools, name) => tools.find(entry => entry.name === `gmail_${name}`)

test('attachments are listed by name, type and size, never by content', async () => {
  const server = attachmentServer()
  const tools = gmailRead(server)
  const listed = await readTool(tools, 'list_attachments').execute({ uid: 9 })
  assert.match(listed, /3 attachment\(s\) in message UID 9/)
  assert.match(listed, /\[1\] notes\.txt \(TEXT\/PLAIN, 24 bytes\)/)
  // The PDF's name is stripped to its base name, and the encoded word is decoded.
  assert.match(listed, /\[2\] evil\.pdf \(APPLICATION\/PDF, 1234 bytes\)/)
  assert.match(listed, /\[3\] 会议\.txt \(TEXT\/PLAIN, 12 bytes\)/)
  assert.ok(!listed.includes('aGVsbG8'))
})

test('a text attachment is read with BODY.PEEK, and a non-text one is refused without content', async () => {
  const server = attachmentServer()
  const tools = gmailRead(server)
  const text = await readTool(tools, 'read_attachment').execute({ uid: 9, index: 1 })
  assert.equal(text, 'hello attachment')
  const commands = sent(server)
  assert.ok(commands.some(line => line.startsWith('EXAMINE "INBOX"')))
  assert.ok(commands.some(line => /BODY\.PEEK\[2\]/.test(line)))
  assert.equal(commands.some(line => /^(SELECT|STORE|APPEND|EXPUNGE)/.test(line)), false)

  await assert.rejects(
    readTool(tools, 'read_attachment').execute({ uid: 9, index: 2 }),
    /APPLICATION\/PDF, 1234 bytes; only text attachments can be read/,
  )
  assert.equal(sent(server).some(line => /BODY\.PEEK\[3\]/.test(line)), false)

  // An index past the list is refused before the part body is even asked for.
  const fetches = () => sent(server).filter(line => /BODY\.PEEK\[/.test(line)).length
  const before = fetches()
  await assert.rejects(readTool(tools, 'read_attachment').execute({ uid: 9, index: 99 }), /no attachment 99/)
  assert.equal(fetches(), before)
})

test('an attachment over the byte limit is refused before its body is fetched', async () => {
  const tooBig = ATTACH_STRUCTURE.replace('"BASE64" 24 1', `"BASE64" ${ATTACH_MAX_BYTES + 1} 1`)
  const server = attachmentServer({ structure: tooBig })
  const tools = gmailRead(server)
  await assert.rejects(readTool(tools, 'read_attachment').execute({ uid: 9, index: 1 }), /over the 2097152-byte limit/)
  assert.equal(sent(server).some(line => /BODY\.PEEK\[2\]/.test(line)), false)
})
