// Gmail's tools speak IMAP over its own TLS port, so the tests drive a fake server on an
// in-memory socket: it answers the exact lines the client writes, and every byte the client
// sends is kept, so a test can assert that only read commands ever reach the wire. The IMAP
// protocol, the parsers and the MIME handling are the shared core's own tests' job; these
// tests check that Gmail is wired onto that core correctly.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { parseCredential } from '../src/host/connectors/_imap.js'
import { connectValues, credentialFields } from '../src/host/connector-setup.js'
import { externalConnectors } from '../src/host/connectors/registry.js'
import gmail, { GMAIL_HOST, GMAIL_TOOLS, createGmailTools, signInGmail } from '../src/host/connectors/gmail.js'

const CRLF = '\r\n'
const HEADER_FIELDS = 'FROM TO CC BCC SUBJECT DATE MESSAGE-ID IN-REPLY-TO CONTENT-TYPE CONTENT-TRANSFER-ENCODING'
const tagOf = line => line.slice(0, line.indexOf(' '))
const ok = (socket, line, text = 'completed') => socket.send(`${tagOf(line)} OK ${text}${CRLF}`)
const bad = (socket, line, text = 'not supported') => socket.send(`${tagOf(line)} BAD ${text}${CRLF}`)

const DEFAULT_GREETING = '* OK [CAPABILITY IMAP4rev1 ID X-GM-EXT-1] ready'

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

// The plain answers a quiet Gmail server gives, unless `onLine` takes the command first.
function imapServer({ greeting, exists = 3, onLine } = {}) {
  return fakeServer({
    greeting,
    handler: (line, socket) => {
      if (onLine?.(line, socket) === true) return
      if (/^A\d+ LOGIN /.test(line)) return ok(socket, line, '[CAPABILITY IMAP4rev1 X-GM-EXT-1] LOGIN completed')
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
const plain = line => line.replace(/^A\d+ /, '')
const ADDRESS = 'user@gmail.com'
const APP_PASSWORD = 'abcdefghijklmnop'
const FIELDS = { GMAIL_ADDRESS: ADDRESS, GMAIL_APP_PASSWORD: APP_PASSWORD }

test('the connector is one read-only IMAP module the registry can load', async () => {
  assert.equal(gmail.id, 'gmail')
  assert.equal(gmail.displayName, 'Gmail')
  assert.equal(gmail.mode, 'imap')
  assert.equal(gmail.accountField, 'account')
  assert.equal(gmail.readOnly, true)
  assert.equal(gmail.glyph, 'gmail')
  assert.equal(GMAIL_HOST, 'imap.gmail.com')
  assert.match(gmail.docsUrl, /apppasswords/)
  assert.equal(typeof gmail.verify, 'function')
  assert.equal(typeof gmail.mount, 'function')
  assert.deepEqual(gmail.credentials.map(field => field.name), ['GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD'])
  // The two fields are checked before anything is saved: a missing password is refused.
  await assert.rejects(gmail.verify({ secrets: { GMAIL_ADDRESS: ADDRESS } }), /authorization code is missing/)
  await assert.rejects(gmail.verify({ values: { GMAIL_ADDRESS: ADDRESS } }), /authorization code is missing/)
  assert.throws(() => gmail.mount({ secrets: { GMAIL_APP_PASSWORD: APP_PASSWORD }, redact: String }), /mailbox address/)
  // Mounting is lazy: it answers the four tools without opening a connection.
  const mounted = gmail.mount({ secrets: FIELDS, redact: String })
  assert.equal(mounted.mailbox, ADDRESS)
  assert.deepEqual(mounted.tools.map(tool => tool.name), GMAIL_TOOLS)
  await mounted.close()
  assert.deepEqual(GMAIL_TOOLS, ['gmail_list_folders', 'gmail_search', 'gmail_list_messages', 'gmail_get_message'])
})

test('the framework registry loads the module and maps the card onto its two credentials', () => {
  const loaded = externalConnectors.gmail
  assert.equal(loaded.displayName, 'Gmail')
  assert.equal(loaded.mode, 'imap')
  assert.equal(loaded.readOnly, true)
  assert.deepEqual(credentialFields(loaded).map(field => field.name), ['GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD'])
  assert.deepEqual(credentialFields(loaded).map(field => field.label), ['Gmail address', 'App password'])
  assert.deepEqual(connectValues(loaded, { values: FIELDS }), FIELDS)
  // Two fields, so the older single-token form cannot fill them in.
  assert.throws(() => connectValues(loaded, { token: `${ADDRESS}:${APP_PASSWORD}` }), /Paste Gmail address first/)
  assert.throws(() => connectValues(loaded, { values: { GMAIL_ADDRESS: ADDRESS } }), /Paste App password first/)
  assert.throws(() => connectValues(loaded, {}), /Paste/)
})

test('a bad credential never echoes the app password', () => {
  const secret = 'supersecretapppass'
  assert.deepEqual(parseCredential(`${ADDRESS}:${secret}`), { mailbox: ADDRESS, secret })
  assert.throws(() => parseCredential(`not-an-address:${secret}`), (error) => {
    assert.match(error.message, /mailbox address/)
    assert.ok(!error.message.includes(secret))
    return true
  })
  assert.throws(() => parseCredential('just-the-app-password'), (error) => {
    assert.ok(!error.message.includes('just-the-app-password'))
    return true
  })
})

test('signIn checks the credential read-only, then hangs up', async () => {
  const server = imapServer()
  const account = await signInGmail(APP_PASSWORD, { account: { mailbox: ADDRESS }, connect: server.connect, timeoutMs: 2_000 })
  assert.deepEqual(account, { mailbox: ADDRESS })
  const sent = server.commands.map(plain)
  assert.ok(sent.includes('LOGIN "user@gmail.com" "abcdefghijklmnop"'))
  assert.ok(sent.includes('EXAMINE "INBOX"'))
  assert.ok(!sent.some(command => /^(SELECT|STORE|EXPUNGE|APPEND|COPY|MOVE|DELETE|RENAME|SUBSCRIBE|CREATE)\b/.test(command)))
  assert.equal(server.sockets[0]?.destroyed, true)
})

test('a refused credential is one plain sentence without the app password', async () => {
  const secret = 'supersecretapppass'
  const server = fakeServer({
    handler: (line, socket) => {
      if (/^A\d+ LOGIN /.test(line)) return socket.send(`${tagOf(line)} NO [AUTHENTICATIONFAILED] Authentication failed.${CRLF}`)
      return bad(socket, line)
    },
  })
  await assert.rejects(signInGmail(secret, { account: { mailbox: ADDRESS }, connect: server.connect, timeoutMs: 2_000 }), (error) => {
    assert.match(error.message, /did not accept/)
    assert.ok(!error.message.includes(secret))
    return true
  })
})

test('a mount reads the address and the app password from two stored fields', async () => {
  const server = imapServer()
  const mounted = createGmailTools({ credential: APP_PASSWORD, account: { mailbox: ADDRESS }, connect: server.connect, timeoutMs: 2_000 })
  try {
    const text = await mounted.tools[0].execute()
    assert.equal(mounted.mailbox, ADDRESS)
    assert.ok(!text.includes(APP_PASSWORD))
    assert.ok(server.commands.some(line => line === 'A1 LOGIN "user@gmail.com" "abcdefghijklmnop"'))
  } finally {
    await mounted.close()
  }
})

test('list_folders names the folders the Gmail server offers', async () => {
  const server = imapServer({
    onLine: (line, socket) => {
      if (!/^A\d+ LIST /.test(line)) return false
      socket.send(`* LIST (\\HasNoChildren) "/" "INBOX"${CRLF}* LIST (\\HasNoChildren) "/" "[Gmail]/All Mail"${CRLF}`)
      ok(socket, line, 'LIST completed')
      return true
    },
  })
  const session = createGmailTools({ credential: APP_PASSWORD, account: { mailbox: ADDRESS }, connect: server.connect, timeoutMs: 2_000 })
  try {
    const text = await session.tools[0].execute()
    assert.equal(text.split('\n')[0], 'INBOX (delimiter "/")')
    assert.match(text, /\[Gmail\]\/All Mail \(delimiter "\/"\)/)
  } finally {
    await session.close()
  }
})

test('search answers the newest UIDs and asks with read commands only', async () => {
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
  const session = createGmailTools({ credential: APP_PASSWORD, account: { mailbox: ADDRESS }, connect: server.connect, timeoutMs: 2_000 })
  try {
    const tool = session.tools.find(item => item.name === 'gmail_search')
    const text = await tool.execute({ unseen: true, from: 'boss', since: '2026-10-01', limit: 2 })
    assert.equal(searchLine, 'UID SEARCH UNSEEN FROM "boss" SINCE 01-Oct-2026')
    assert.match(text, /3 message\(s\) in "INBOX" match/)
    assert.match(text, /newest 2, oldest first: 5, 6/i)
  } finally {
    await session.close()
  }
})

test('search offers Gmail\'s own query syntax and sends it as X-GM-RAW', async () => {
  let searchLine
  const server = imapServer({
    onLine: (line, socket) => {
      if (!/^A\d+ UID SEARCH /.test(line)) return false
      searchLine = plain(line)
      socket.send(`* SEARCH 9${CRLF}`)
      ok(socket, line, 'SEARCH completed')
      return true
    },
  })
  const session = createGmailTools({ credential: APP_PASSWORD, account: { mailbox: ADDRESS }, connect: server.connect, timeoutMs: 2_000 })
  try {
    const tool = session.tools.find(item => item.name === 'gmail_search')
    assert.equal(tool.parameters.properties.query.type, 'string')
    assert.match(tool.parameters.properties.query.description, /Gmail search syntax/)
    const text = await tool.execute({ query: 'from:boss has:attachment newer_than:7d', unseen: true, limit: 1 })
    assert.equal(searchLine, 'UID SEARCH UNSEEN X-GM-RAW "from:boss has:attachment newer_than:7d"')
    assert.match(text, /1 message\(s\) in "INBOX" match/)
  } finally {
    await session.close()
  }
})

test('list_messages shows the decoded sender, date and subject of each message', async () => {
  const first = 'From: =?UTF-8?B?5byg5LiJ?= <zs@gmail.com>\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nDate: Mon, 19 Oct 2026 10:00:00 +0800\r\n\r\n'
  const second = 'From: li@gmail.com\r\nSubject: second\r\nDate: Tue, 20 Oct 2026 09:00:00 +0800\r\n\r\n'
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
  const session = createGmailTools({ credential: APP_PASSWORD, account: { mailbox: ADDRESS }, connect: server.connect, timeoutMs: 2_000 })
  try {
    const tool = session.tools.find(item => item.name === 'gmail_list_messages')
    const text = await tool.execute({ newest: 2 })
    assert.match(text, /UID 7 \| Mon, 19 Oct 2026 10:00:00 \+0800 \| 张三 <zs@gmail\.com> \| 你好/)
    assert.match(text, /UID 8 \|/)
    assert.ok(server.commands.some(line => /BODY\.PEEK\[HEADER\.FIELDS/.test(line)))
  } finally {
    await session.close()
  }
})

test('get_message reads headers and text with BODY.PEEK, split across packets', async () => {
  const header = 'From: zs@gmail.com\r\nTo: me@gmail.com\r\nSubject: 周报\r\nDate: Mon, 19 Oct 2026 10:00:00 +0800\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n'
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
  const session = createGmailTools({ credential: APP_PASSWORD, account: { mailbox: ADDRESS }, connect: server.connect, timeoutMs: 2_000 })
  try {
    const tool = session.tools.find(item => item.name === 'gmail_get_message')
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
  const session = createGmailTools({ credential: APP_PASSWORD, account: { mailbox: ADDRESS }, connect: server.connect, timeoutMs: 2_000 })
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
  const secret = 'gmail-secret-app-pass'
  const server = imapServer({
    onLine: (line, socket) => {
      if (!/^A\d+ UID SEARCH /.test(line)) return false
      socket.send(`${tagOf(line)} NO ${secret} rejected${CRLF}`)
      return true
    },
  })
  const session = createGmailTools({
    credential: secret,
    account: { mailbox: ADDRESS },
    redact: text => String(text).replaceAll(secret, '[secret]'),
    connect: server.connect,
    timeoutMs: 2_000,
  })
  try {
    const tool = session.tools.find(item => item.name === 'gmail_search')
    await assert.rejects(tool.execute({ unseen: true }), (error) => {
      assert.ok(!error.message.includes(secret))
      return true
    })
  } finally {
    await session.close()
  }
})

test('the module names Gmail\'s server and card strings', () => {
  assert.equal(GMAIL_HOST, 'imap.gmail.com')
  assert.match(gmail.about, /Gmail/)
  assert.match(gmail.readOnlyNote, /Read-only/)
  assert.equal(gmail.docsUrl, 'https://myaccount.google.com/apppasswords')
})
