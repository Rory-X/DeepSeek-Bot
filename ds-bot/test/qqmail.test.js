// QQ Mail's tools speak IMAP over its own TLS port, so the tests drive a fake server on an
// in-memory socket: it answers the exact lines the client writes, and every byte the client
// sends is kept, so a test can assert that only read commands ever reach the wire.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { decodeMailboxName, decodeWords, extractText, parseCredential, parseHeaders, searchCriteria } from '../src/host/connectors/_imap.js'
import qqmail, { QQMAIL_TOOLS, createQQMailTools, signInQQMail } from '../src/host/connectors/qqmail.js'

const CRLF = '\r\n'
const HEADER_FIELDS = 'FROM TO CC BCC SUBJECT DATE MESSAGE-ID IN-REPLY-TO CONTENT-TYPE CONTENT-TRANSFER-ENCODING'
const tagOf = line => line.slice(0, line.indexOf(' '))
const ok = (socket, line, text = 'completed') => socket.send(`${tagOf(line)} OK ${text}${CRLF}`)
const bad = (socket, line, text = 'not supported') => socket.send(`${tagOf(line)} BAD ${text}${CRLF}`)

const DEFAULT_GREETING = '* OK [CAPABILITY IMAP4rev1 ID] ready'

// One fake server: `handler` answers a command line, `commands` keeps what the client wrote.
// `greeting: null` is a server that accepts the connection and then says nothing.
function fakeServer({ greeting = DEFAULT_GREETING, handler } = {}) {
  const sockets = []
  const commands = []
  const connect = () => {
    const socket = new EventEmitter()
    socket.written = ''
    socket.destroyed = false
    let buffer = ''
    socket.write = (text) => {
      socket.written += text
      buffer += text
      for (;;) {
        const at = buffer.indexOf(CRLF)
        if (at === -1) return
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        commands.push(line)
        handler?.(line, socket)
      }
    }
    socket.send = (text) => { if (!socket.destroyed) socket.emit('data', Buffer.from(text)) }
    socket.end = () => socket.emit('end')
    socket.destroy = () => {
      if (socket.destroyed) return
      socket.destroyed = true
      socket.emit('close')
    }
    sockets.push(socket)
    setImmediate(() => {
      socket.emit('connect')
      if (greeting !== null) socket.send(`${greeting}${CRLF}`)
    })
    return socket
  }
  return { connect, commands, sockets }
}

// The plain answers a quiet QQ Mail server gives, unless `onLine` takes the command first.
function imapServer({ greeting, exists = 3, onLine } = {}) {
  return fakeServer({
    greeting,
    handler: (line, socket) => {
      if (onLine?.(line, socket) === true) return
      if (/^A\d+ LOGIN /.test(line)) return ok(socket, line, '[CAPABILITY IMAP4rev1 ID] LOGIN completed')
      if (/^A\d+ ID /.test(line)) return bad(socket, line, 'Unknown command')
      if (/^A\d+ EXAMINE /.test(line)) return socket.send(`* ${exists} EXISTS\r\n${tagOf(line)} OK [READ-ONLY] EXAMINE completed\r\n`)
      if (/^A\d+ LIST /.test(line)) return socket.send(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tagOf(line)} OK LIST completed\r\n`)
      if (/^A\d+ UID SEARCH /.test(line)) return socket.send(`* SEARCH\r\n${tagOf(line)} OK SEARCH completed\r\n`)
      if (/^A\d+ UID FETCH /.test(line)) return socket.send(`${tagOf(line)} OK FETCH completed\r\n`)
      if (/^A\d+ LOGOUT/.test(line)) return socket.send(`* BYE closing\r\n${tagOf(line)} OK LOGOUT completed\r\n`)
      return bad(socket, line, 'Unknown command')
    },
  })
}

const fetchHeader = (seq, uid, header) => `* ${seq} FETCH (UID ${uid} BODY[HEADER.FIELDS (${HEADER_FIELDS})] {${Buffer.byteLength(header)}}${CRLF}${header})${CRLF}`

const plain = (line) => line.replace(/^A\d+ /, '')

test('the connector is one read-only IMAP module the registry can load', async () => {
  assert.equal(qqmail.id, 'qqmail')
  assert.equal(qqmail.displayName, 'QQ Mail')
  assert.equal(qqmail.mode, 'imap')
  assert.equal(qqmail.accountField, 'account')
  assert.equal(qqmail.readOnly, true)
  assert.equal(typeof qqmail.verify, 'function')
  assert.equal(typeof qqmail.mount, 'function')
  assert.deepEqual(qqmail.credentials.map(field => field.name), ['QQMAIL_ADDRESS', 'QQMAIL_AUTH_CODE'])
  // The two fields are checked before anything is saved: a missing code is refused at once.
  await assert.rejects(qqmail.verify({ secrets: { QQMAIL_ADDRESS: 'user@qq.com' } }), /authorization code is missing/)
  await assert.rejects(qqmail.verify({ values: { QQMAIL_ADDRESS: 'user@qq.com' } }), /authorization code is missing/)
  assert.throws(() => qqmail.mount({ secrets: { QQMAIL_AUTH_CODE: 'abcdefghijklmnop' }, redact: String }), /joined by a colon/)
  // Mounting is lazy: it answers the four tools without opening a connection.
  const mounted = qqmail.mount({ secrets: { QQMAIL_ADDRESS: 'user@qq.com', QQMAIL_AUTH_CODE: 'abcdefghijklmnop' }, redact: String })
  assert.equal(mounted.mailbox, 'user@qq.com')
  assert.deepEqual(mounted.tools.map(tool => tool.name), QQMAIL_TOOLS)
  await mounted.close()
  assert.deepEqual(QQMAIL_TOOLS, ['qqmail_list_folders', 'qqmail_search', 'qqmail_list_messages', 'qqmail_get_message'])
})

test('the framework registry loads the module and maps the card onto its two credentials', async (t) => {
  // The connector base (registry + credential setup) is a separate line that lands with the
  // connector batch; on a mainline tree that predates it there is nothing to load.
  let registry
  try {
    registry = await import('../src/host/connectors/registry.js')
  } catch {
    return t.skip('the connector base is not in this tree')
  }
  const { connectValues, credentialFields } = await import('../src/host/connector-setup.js')
  const loaded = registry.externalConnectors.qqmail
  assert.equal(loaded.displayName, 'QQ Mail')
  assert.equal(loaded.mode, 'imap')
  assert.equal(loaded.readOnly, true)
  assert.deepEqual(credentialFields(loaded).map(field => field.name), ['QQMAIL_ADDRESS', 'QQMAIL_AUTH_CODE'])
  assert.deepEqual(credentialFields(loaded).map(field => field.label), ['QQ Mail address', 'Authorization code'])
  assert.deepEqual(connectValues(loaded, { values: { QQMAIL_ADDRESS: 'user@qq.com', QQMAIL_AUTH_CODE: 'abcdefghijklmnop' } }), { QQMAIL_ADDRESS: 'user@qq.com', QQMAIL_AUTH_CODE: 'abcdefghijklmnop' })
  // Two fields, so the older single-token form cannot fill them in.
  assert.throws(() => connectValues(loaded, { token: 'user@qq.com:abcdefghijklmnop' }), /Paste QQ Mail address first/)
  assert.throws(() => connectValues(loaded, { values: { QQMAIL_ADDRESS: 'user@qq.com' } }), /Paste Authorization code first/)
  assert.throws(() => connectValues(loaded, {}), /Paste/)
})

test('a credential is address:code, and a bad one never echoes the code', () => {
  assert.deepEqual(parseCredential('user@qq.com:abcdefghijklmnop'), { mailbox: 'user@qq.com', secret: 'abcdefghijklmnop' })
  assert.deepEqual(parseCredential('  user@qq.com : abcd  '), { mailbox: 'user@qq.com', secret: 'abcd' })
  assert.throws(() => parseCredential('user@qq.com'), /joined by a colon/)
  assert.throws(() => parseCredential('justcode'), /joined by a colon/)
  assert.throws(() => parseCredential(''), /joined by a colon/)
  assert.throws(() => parseCredential('not-an-address:code'), /mailbox address/)
  assert.throws(() => parseCredential('user@qq.com:'), /app password or authorization code/)
  try {
    parseCredential('only-a-secret-code')
  } catch (error) {
    assert.ok(!error.message.includes('only-a-secret-code'))
  }
})

test('a mount reads the address from two stored fields and never answers with the code', async () => {
  const server = imapServer()
  const mounted = createQQMailTools({ credential: 'abcdefghijklmnop', account: { mailbox: 'user@qq.com' }, connect: server.connect, timeoutMs: 2_000 })
  try {
    const text = await mounted.tools[0].execute()
    assert.equal(mounted.mailbox, 'user@qq.com')
    assert.ok(!text.includes('abcdefghijklmnop'))
    assert.ok(server.commands.some(line => line === 'A1 LOGIN "user@qq.com" "abcdefghijklmnop"'))
  } finally {
    await mounted.close()
  }
})

test('a mount still takes the older one-string form and never answers with the code', async () => {
  const server = imapServer()
  const mounted = createQQMailTools({ credential: 'user@qq.com:abcdefghijklmnop', connect: server.connect, timeoutMs: 2_000 })
  try {
    const text = await mounted.tools[0].execute()
    assert.equal(mounted.mailbox, 'user@qq.com')
    assert.ok(!text.includes('abcdefghijklmnop'))
    assert.ok(server.commands.some(line => line === 'A1 LOGIN "user@qq.com" "abcdefghijklmnop"'))
  } finally {
    await mounted.close()
  }
})

test('headers unfold and RFC 2047 words decode in UTF-8 and GBK', () => {
  const raw = [
    'From: =?UTF-8?B?5byg5LiJ?= <zs@qq.com>',
    'Subject: =?UTF-8?B?5L2g5aW977yM?=',
    ' =?UTF-8?B?5LiW55WM?=',
    'Date: Mon, 19 Oct 2026 10:00:00 +0800',
    '',
  ].join(CRLF)
  const headers = parseHeaders(raw)
  assert.equal(headers.date, 'Mon, 19 Oct 2026 10:00:00 +0800')
  assert.equal(decodeWords(headers.subject), '你好，世界')
  assert.equal(decodeWords(headers.from), '张三 <zs@qq.com>')
  assert.equal(decodeWords('=?GBK?B?xOO6ww==?='), '你好')
  assert.equal(decodeWords('plain subject'), 'plain subject')
})

test('QQ folder names arrive in modified UTF-7', () => {
  assert.equal(decodeMailboxName('INBOX'), 'INBOX')
  assert.equal(decodeMailboxName('&XfJT0ZAB-'), '已发送')
  assert.equal(decodeMailboxName('A&-B'), 'A&B')
})

test('a message body becomes readable text, including multipart and encodings', () => {
  assert.equal(extractText({ 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('hello')), 'hello')
  assert.equal(extractText({ 'content-type': 'text/plain; charset=utf-8', 'content-transfer-encoding': 'quoted-printable' }, Buffer.from('caf=C3=A9')), 'café')
  assert.equal(extractText({ 'content-type': 'text/plain; charset=gbk' }, Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), '你好')
  const multipart = Buffer.from('--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n5L2g5aW9\r\n--b1--\r\n')
  assert.equal(extractText({ 'content-type': 'multipart/alternative; boundary="b1"' }, multipart), '你好')
  assert.equal(extractText({ 'content-type': 'multipart/alternative; boundary="b1"' }, Buffer.from('--b1--\r\n')), '')
})

test('search keys only come from named arguments, and a line break is refused', () => {
  assert.equal(searchCriteria({}), 'ALL')
  assert.equal(searchCriteria({ unseen: true }), 'UNSEEN')
  assert.equal(searchCriteria({ from: 'a"b', since: '2026-10-01' }), 'FROM "a\\"b" SINCE 01-Oct-2026')
  assert.equal(searchCriteria({ subject: '你好' }), 'CHARSET UTF-8 SUBJECT "你好"')
  assert.throws(() => searchCriteria({ from: 'x\r\nSTORE 1 +FLAGS' }), /line break/)
  assert.throws(() => searchCriteria({ since: '2026-13-01' }), /YYYY-MM-DD/)
})

test('signIn checks the credential read-only, then hangs up', async () => {
  const server = imapServer()
  const account = await signInQQMail('user@qq.com:abcdefghijklmnop', { connect: server.connect, timeoutMs: 2_000 })
  assert.deepEqual(account, { mailbox: 'user@qq.com' })
  const sent = server.commands.map(plain)
  assert.ok(sent.includes('LOGIN "user@qq.com" "abcdefghijklmnop"'))
  assert.ok(sent.includes('EXAMINE "INBOX"'))
  assert.ok(!sent.some(command => /^(SELECT|STORE|EXPUNGE|APPEND|COPY|MOVE|DELETE|RENAME|SUBSCRIBE|CREATE)\b/.test(command)))
  assert.equal(server.sockets[0]?.destroyed, true)
})

test('a refused credential is one plain sentence without the code', async () => {
  const secret = 'supersecretcode'
  const server = fakeServer({
    handler: (line, socket) => {
      if (/^A\d+ LOGIN /.test(line)) return socket.send(`${tagOf(line)} NO [AUTHENTICATIONFAILED] Authentication failed.${CRLF}`)
      return bad(socket, line)
    },
  })
  await assert.rejects(signInQQMail(`user@qq.com:${secret}`, { connect: server.connect, timeoutMs: 2_000 }), (error) => {
    assert.match(error.message, /did not accept/)
    assert.ok(!error.message.includes(secret))
    return true
  })
})

test('a server that never answers fails in time, at connect and at command', async () => {
  const mute = fakeServer({ greeting: null, handler: () => {} })
  await assert.rejects(signInQQMail('user@qq.com:code', { connect: mute.connect, connectTimeoutMs: 60 }), /did not answer in time/)
  const rude = fakeServer({ handler: () => {} })
  await assert.rejects(signInQQMail('user@qq.com:code', { connect: rude.connect, timeoutMs: 60 }), /did not answer in time/)
})

test('an unreachable server is a plain error', async () => {
  const connect = () => {
    const socket = new EventEmitter()
    socket.write = () => {}
    socket.end = () => {}
    socket.destroy = () => {}
    setImmediate(() => socket.emit('error', new Error('ECONNREFUSED')))
    return socket
  }
  await assert.rejects(signInQQMail('user@qq.com:code', { connect, connectTimeoutMs: 500 }), /Could not reach the mail server/)
})

test('list_folders decodes folder names, even a literal one split across packets', async () => {
  const server = imapServer({
    onLine: (line, socket) => {
      if (!/^A\d+ LIST /.test(line)) return false
      socket.send(`* LIST (\\HasNoChildren) "/" "INBOX"${CRLF}* LIST (\\HasNoChildren) "/" {10}${CRLF}`)
      socket.send('&XfJ')
      socket.send(`T0ZAB-)${CRLF}`)
      ok(socket, line, 'LIST completed')
      return true
    },
  })
  const session = createQQMailTools({ credential: 'user@qq.com:code', connect: server.connect, timeoutMs: 2_000 })
  try {
    const text = await session.tools[0].execute()
    assert.equal(text.split('\n')[0], 'INBOX (delimiter "/")')
    assert.match(text, /已发送 \(delimiter "\/"\)/)
  } finally {
    await session.close()
  }
})

test('search names the newest UIDs and asks with the read commands only', async () => {
  let searchLine
  const server = imapServer({
    onLine: (line, socket) => {
      if (!/^A\d+ UID SEARCH /.test(line)) return false
      searchLine = plain(line)
      socket.send(`* SEARCH 4 5 6${CRLF}`)
      ok(socket, line, 'SEARCH completed')
      return true
    },
  })
  const session = createQQMailTools({ credential: 'user@qq.com:code', connect: server.connect, timeoutMs: 2_000 })
  try {
    const tool = session.tools.find(tool => tool.name === 'qqmail_search')
    const text = await tool.execute({ unseen: true, from: 'boss', limit: 2 })
    assert.equal(searchLine, 'UID SEARCH UNSEEN FROM "boss"')
    assert.match(text, /3 message\(s\) in "INBOX" match/)
    assert.match(text, /newest 2, oldest first: 5, 6/i)
  } finally {
    await session.close()
  }
})

test('list_messages shows the decoded sender, date and subject of each message', async () => {
  const first = 'From: =?UTF-8?B?5byg5LiJ?= <zs@qq.com>\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nDate: Mon, 19 Oct 2026 10:00:00 +0800\r\n\r\n'
  const second = 'From: li@qq.com\r\nSubject: second\r\nDate: Tue, 20 Oct 2026 09:00:00 +0800\r\n\r\n'
  const server = imapServer({
    onLine: (line, socket) => {
      if (/^A\d+ UID SEARCH /.test(line)) {
        socket.send(`* SEARCH 7 8${CRLF}`)
        ok(socket, line, 'SEARCH completed')
        return true
      }
      if (/^A\d+ UID FETCH /.test(line)) {
        socket.send(fetchHeader(1, 7, first))
        socket.send(fetchHeader(2, 8, second))
        ok(socket, line, 'FETCH completed')
        return true
      }
      return false
    },
  })
  const session = createQQMailTools({ credential: 'user@qq.com:code', connect: server.connect, timeoutMs: 2_000 })
  try {
    const tool = session.tools.find(tool => tool.name === 'qqmail_list_messages')
    const text = await tool.execute({ newest: 2 })
    assert.match(text, /UID 7 \| Mon, 19 Oct 2026 10:00:00 \+0800 \| 张三 <zs@qq\.com> \| 你好/)
    assert.match(text, /UID 8 \|/)
    assert.ok(server.commands.some(line => /BODY\.PEEK\[HEADER\.FIELDS/.test(line)))
  } finally {
    await session.close()
  }
})

test('get_message reads headers and text with BODY.PEEK, split across packets', async () => {
  const header = 'From: zs@qq.com\r\nTo: me@qq.com\r\nSubject: 周报\r\nDate: Mon, 19 Oct 2026 10:00:00 +0800\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n'
  const body = '--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n5L2g5aW9\r\n--b1--\r\n'
  const server = imapServer({
    onLine: (line, socket) => {
      if (!/^A\d+ UID FETCH /.test(line)) return false
      if (/BODY\.PEEK\[HEADER/.test(line)) {
        socket.send(fetchHeader(1, 42, header))
      } else {
        const split = Math.floor(body.length / 2)
        socket.send(`* 1 FETCH (UID 42 BODY[TEXT] {${Buffer.byteLength(body)}}${CRLF}${body.slice(0, split)}`)
        socket.send(body.slice(split) + `)${CRLF}`)
      }
      ok(socket, line, 'FETCH completed')
      return true
    },
  })
  const session = createQQMailTools({ credential: 'user@qq.com:code', connect: server.connect, timeoutMs: 2_000 })
  try {
    const tool = session.tools.find(tool => tool.name === 'qqmail_get_message')
    const text = await tool.execute({ uid: 42 })
    assert.match(text, /^UID: 42$/m)
    assert.match(text, /^Subject: 周报$/m)
    assert.match(text, /^你好$/m)
    const fetches = server.commands.filter(line => /FETCH/.test(line))
    assert.ok(fetches.length > 0)
    for (const line of fetches) assert.match(line, /BODY\.PEEK\[/)
  } finally {
    await session.close()
  }
})

test('every command this connector writes is a read command', async () => {
  const server = imapServer()
  const session = createQQMailTools({ credential: 'user@qq.com:code', connect: server.connect, timeoutMs: 2_000 })
  try {
    await session.tools[0].execute()
    await session.tools[1].execute({ unseen: true })
    await session.tools[2].execute({ newest: 1 })
    await session.tools[3].execute({ uid: 1 }).catch(() => {})
  } finally {
    await session.close()
  }
  const written = server.commands.map(plain).join('\n')
  assert.doesNotMatch(written, /^(SELECT|STORE|EXPUNGE|APPEND|COPY|MOVE|DELETE|RENAME|SUBSCRIBE|UNSUBSCRIBE|CREATE|CLOSE|CHECK)\b/m)
  const fetches = server.commands.filter(line => /FETCH/.test(line))
  assert.ok(fetches.length > 0)
  for (const line of fetches) assert.match(line, /BODY\.PEEK\[/)
})

test('a tool error is redacted before the model reads it', async () => {
  const secret = 'qqmail-secret-code'
  const server = imapServer({
    onLine: (line, socket) => {
      if (!/^A\d+ UID SEARCH /.test(line)) return false
      socket.send(`${tagOf(line)} NO ${secret} rejected${CRLF}`)
      return true
    },
  })
  const session = createQQMailTools({
    credential: `user@qq.com:${secret}`,
    connect: server.connect,
    timeoutMs: 2_000,
    redact: text => String(text).replaceAll(secret, '[redacted]'),
  })
  try {
    await assert.rejects(session.tools[1].execute({}), error => {
      assert.ok(!error.message.includes(secret))
      assert.match(error.message, /\[redacted\]/)
      return true
    })
  } finally {
    await session.close()
  }
})
