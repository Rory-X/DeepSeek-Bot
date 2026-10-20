// SMTP is a conversation of plain lines, so the tests drive a fake server on an
// in-memory socket: it answers the exact lines the client writes, and every line the client
// sends is kept, so a test can assert the protocol order, the AUTH LOGIN exchange, dot
// stuffing and that a refused approval opens no connection at all.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_RECIPIENTS,
  SmtpClient,
  attachmentsOf,
  buildMime,
  createSmtpTools,
  encodeHeader,
} from '../src/host/connectors/_smtp.js'

const PASS = 'abcdefghijklmnop'
const CRLF = '\r\n'

// One fake server. `rejectAuth` answers 535 instead of 235, `refuse` answers 550 for the
// named recipient, `mute` accepts the connection and says nothing.
function fakeSmtp({ password = PASS, rejectAuth = false, refuse = [], mute = false } = {}) {
  const state = {
    connections: 0,
    commands: [],
    data: '',
    user: '',
    password: '',
    mailFrom: '',
    recipients: [],
  }
  const connect = () => {
    state.connections += 1
    const socket = new EventEmitter()
    socket.written = ''
    socket.destroyed = false
    let buffer = ''
    let inData = false
    let dataLines = []
    let phase = 'command'
    const send = text => setImmediate(() => { if (!socket.destroyed) socket.emit('data', Buffer.from(text)) })
    const handle = (line) => {
      if (inData) {
        if (line === '.') {
          inData = false
          state.data = dataLines.join(CRLF)
          dataLines = []
          send(`250 2.0.0 OK queued${CRLF}`)
          return
        }
        dataLines.push(line.startsWith('..') ? line.slice(1) : line)
        return
      }
      state.commands.push(line)
      if (phase === 'username') {
        phase = 'password'
        state.user = Buffer.from(line, 'base64').toString('utf8')
        send(`334 UGFzc3dvcmQ6${CRLF}`)
        return
      }
      if (phase === 'password') {
        phase = 'command'
        state.password = Buffer.from(line, 'base64').toString('utf8')
        send(state.password === password && !rejectAuth ? `235 2.7.0 authenticated${CRLF}` : `535 5.7.8 Authentication failed${CRLF}`)
        return
      }
      if (line.startsWith('EHLO ')) {
        send(`250-fake greets you${CRLF}250-AUTH LOGIN${CRLF}250 SIZE 35882577${CRLF}`)
        return
      }
      if (line === 'AUTH LOGIN') {
        if (rejectAuth) {
          send(`535 5.7.8 Authentication failed${CRLF}`)
          return
        }
        phase = 'username'
        send(`334 VXNlcm5hbWU6${CRLF}`)
        return
      }
      if (line.startsWith('MAIL FROM:')) {
        state.mailFrom = line.slice(10)
        send(`250 2.1.0 sender ok${CRLF}`)
        return
      }
      if (line.startsWith('RCPT TO:')) {
        const recipient = line.slice(8).replace(/^<|>$/g, '')
        if (refuse.includes(recipient)) {
          send(`550 5.1.1 no such user${CRLF}`)
          return
        }
        state.recipients.push(recipient)
        send(`250 2.1.5 recipient ok${CRLF}`)
        return
      }
      if (line === 'DATA') {
        inData = true
        send(`354 end with a line containing only a period${CRLF}`)
        return
      }
      if (line === 'QUIT') {
        send(`221 2.0.0 bye${CRLF}`)
        socket.end()
        return
      }
      send(`500 5.5.1 unknown command${CRLF}`)
    }
    socket.write = (text) => {
      socket.written += text
      buffer += text
      for (;;) {
        const at = buffer.indexOf(CRLF)
        if (at < 0) return
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        handle(line)
      }
    }
    socket.end = () => {
      if (socket.destroyed) return
      socket.destroyed = true
      socket.emit('close')
    }
    socket.destroy = () => socket.end()
    setImmediate(() => {
      socket.emit('connect')
      if (!mute) send(`220 fake ESMTP ready${CRLF}`)
    })
    return socket
  }
  return { connect, state }
}

const splitMessage = (mime) => {
  const at = mime.indexOf(`${CRLF}${CRLF}`)
  const head = mime.slice(0, at).split(CRLF)
  const rest = mime.slice(at + 4)
  const headers = new Map()
  for (const line of head) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers.set(name, (headers.has(name) ? `${headers.get(name)} ` : '') + value)
  }
  return { headers, body: rest }
}

const decodeBase64Body = (text) => Buffer.from(text.trim().replace(/\s+/g, ''), 'base64').toString('utf8')

const decodeEncodedWords = (value) => value.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_whole, base64) => Buffer.from(base64, 'base64').toString('utf8'))

test('buildMime writes the headers a reader expects', () => {
  const mime = buildMime({
    from: 'me@gmail.com',
    to: 'a@b.com',
    cc: ['c@d.com'],
    subject: '你好，邮件',
    text: 'hello there',
    date: new Date('2026-10-20T04:00:00Z'),
    messageId: '<fixed@example.com>',
  })
  assert.match(mime, /^From: me@gmail\.com\r\nTo: a@b\.com\r\nCc: c@d\.com\r\n/)
  assert.match(mime, /Date: Tue, 20 Oct 2026 04:00:00 \+0000/)
  assert.match(mime, /Message-ID: <fixed@example\.com>/)
  assert.match(mime, /MIME-Version: 1\.0/)
  const { headers, body } = splitMessage(mime)
  assert.equal(decodeEncodedWords(headers.get('subject')), '你好，邮件')
  assert.equal(headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(decodeBase64Body(body), 'hello there')
})

test('buildMime puts text and HTML in a multipart alternative, and keeps attachments', () => {
  const mime = buildMime({
    from: 'me@gmail.com',
    to: ['a@b.com'],
    subject: 'Report',
    text: 'plain version',
    html: '<p>html version</p>',
    attachments: [{ filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('fake pdf bytes') }],
  })
  const { headers, body } = splitMessage(mime)
  assert.match(headers.get('content-type'), /^multipart\/mixed; boundary="/)
  const boundary = /boundary="([^"]+)"/.exec(headers.get('content-type'))[1]
  assert.match(body, new RegExp(`--${boundary}`))
  assert.match(body, /Content-Type: multipart\/alternative/)
  assert.match(body, /Content-Type: application\/pdf/)
  assert.match(body, /Content-Disposition: attachment; filename="report\.pdf"/)
  assert.match(body, /--ds-bot-alt-/)
  assert.match(body, /Content-Transfer-Encoding: base64/)
  // The attachment body survives the trip through base64.
  const pdf = /Content-Type: application\/pdf[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/.exec(body)
  assert.equal(Buffer.from(pdf[1].replace(/\s+/g, ''), 'base64').toString('utf8'), 'fake pdf bytes')
})

test('buildMime accepts an HTML body without a text body', () => {
  const mime = buildMime({
    from: 'me@gmail.com',
    to: ['a@b.com'],
    subject: 'HTML only',
    text: '',
    html: '<p>only html</p>',
  })
  const { headers, body } = splitMessage(mime)
  assert.match(headers.get('content-type'), /^multipart\/alternative/)
  assert.match(body, /Content-Type: text\/plain; charset=utf-8/)
  assert.match(body, /Content-Type: text\/html; charset=utf-8/)
  const html = /Content-Type: text\/html; charset=utf-8[\s\S]*?\r\n\r\n([\s\S]*?)(?:\r\n--|$)/.exec(body)
  assert.equal(decodeBase64Body(html[1]), '<p>only html</p>')
})

test('buildMime carries the thread headers of a reply', () => {
  const mime = buildMime({
    from: 'me@gmail.com',
    to: ['a@b.com'],
    subject: 'Re: hello',
    text: 'thanks',
    inReplyTo: '<original@example.com>',
    references: ['<older@example.com>', '<original@example.com>'],
  })
  const { headers } = splitMessage(mime)
  assert.equal(headers.get('in-reply-to'), '<original@example.com>')
  assert.match(headers.get('references'), /<older@example\.com> <original@example\.com>/)
})

test('accepted controls the message size and count', () => {
  assert.equal(attachmentsOf(undefined).length, 0)
  assert.throws(() => attachmentsOf(Array.from({ length: 11 }, (_item, index) => ({ filename: `${index}.txt`, content: 'x' }))), /at most 10 attachments/)
  assert.throws(() => attachmentsOf([{ filename: 'huge.bin', content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }]), /too large/)
  assert.throws(() => attachmentsOf([{ filename: 'a.txt', contentBase64: 'not base64!' }]), /valid base64/)
  assert.throws(() => buildMime({ from: 'me@gmail.com', to: ['a@b.com'], subject: 'x', text: 'y', inReplyTo: 'not-a-message-id' }), /In-Reply-To/)
  assert.throws(() => buildMime({ from: 'me@gmail.com', to: ['a@b.com'], subject: 'x', text: 'y', references: ['nope'] }), /References/)
})

test('encodeHeader folds long ASCII and encodes non-ASCII words', () => {
  assert.equal(encodeHeader('short'), 'short')
  assert.match(encodeHeader('x'.repeat(100)), /\r\n /)
  assert.equal(decodeEncodedWords(encodeHeader('你好')), '你好')
  assert.equal(encodeHeader('plain', 70), 'plain')
})

test('the client sends EHLO, AUTH LOGIN, MAIL, RCPT and a dot-stuffed DATA', async () => {
  const server = fakeSmtp()
  const client = new SmtpClient({
    host: 'smtp.test',
    port: 465,
    account: 'me@gmail.com',
    credential: PASS,
    connect: server.connect,
    displayName: 'Gmail',
  })
  const result = await client.send({
    from: 'me@gmail.com',
    to: ['a@b.com', 'c@d.com'],
    data: `From: me@gmail.com${CRLF}Subject: hi${CRLF}${CRLF}.leading dot${CRLF}second line`,
  })
  assert.deepEqual(result.accepted, ['a@b.com', 'c@d.com'])
  assert.deepEqual(result.refused, [])
  assert.deepEqual(server.state.commands.slice(0, 7), [
    'EHLO localhost',
    'AUTH LOGIN',
    Buffer.from('me@gmail.com').toString('base64'),
    Buffer.from(PASS).toString('base64'),
    'MAIL FROM:<me@gmail.com>',
    'RCPT TO:<a@b.com>',
    'RCPT TO:<c@d.com>',
  ])
  assert.equal(server.state.user, 'me@gmail.com')
  assert.equal(server.state.password, PASS)
  assert.equal(server.state.mailFrom, '<me@gmail.com>')
  // The client stuffed the leading dot and the server put the original line back.
  assert.match(server.state.data, /^\.leading dot$/m)
  assert.match(client.constructor.name, /SmtpClient/)
  client.close()
})

test('a refused app password is one plain sentence without the password', async () => {
  const server = fakeSmtp({ rejectAuth: true })
  const client = new SmtpClient({ host: 'smtp.test', account: 'me@gmail.com', credential: PASS, connect: server.connect, displayName: 'Gmail' })
  await assert.rejects(client.send({ from: 'me@gmail.com', to: ['a@b.com'], data: 'x' }), (error) => {
    assert.match(error.message, /did not accept this address and app password/)
    assert.ok(!error.message.includes(PASS))
    return true
  })
  assert.equal(server.state.connections, 1)
  client.close()
})

test('a From that is not the connected account is refused before connecting', async () => {
  const server = fakeSmtp()
  const client = new SmtpClient({ host: 'smtp.test', account: 'me@gmail.com', credential: PASS, connect: server.connect, displayName: 'Gmail' })
  await assert.rejects(client.send({ from: 'other@gmail.com', to: ['a@b.com'], data: 'x' }), /must be the connected account/)
  assert.equal(server.state.connections, 0)
})

test('one refused recipient is reported while the others get the message', async () => {
  const server = fakeSmtp({ refuse: ['c@d.com'] })
  const client = new SmtpClient({ host: 'smtp.test', account: 'me@gmail.com', credential: PASS, connect: server.connect, displayName: 'Gmail' })
  const result = await client.send({ from: 'me@gmail.com', to: ['a@b.com', 'c@d.com'], data: 'x' })
  assert.deepEqual(result.accepted, ['a@b.com'])
  assert.equal(result.refused.length, 1)
  assert.equal(result.refused[0].recipient, 'c@d.com')
  client.close()
})

test('an approval that says no opens no connection at all', async () => {
  const server = fakeSmtp()
  const tools = createSmtpTools({
    id: 'gmail',
    displayName: 'Gmail',
    credential: PASS,
    account: { mailbox: 'me@gmail.com' },
    smtp: { host: 'smtp.test' },
    approve: async () => { throw new Error('The user denied this action.') },
    connect: server.connect,
  })
  await assert.rejects(tools[0].execute({ to: ['a@b.com'], subject: 'Hi', text: 'body' }), /denied/)
  assert.equal(server.state.connections, 0)
})

test('the approval line names recipients, subject, preview and attachments', async () => {
  const server = fakeSmtp()
  let seen
  const tools = createSmtpTools({
    id: 'gmail',
    displayName: 'Gmail',
    credential: PASS,
    account: { mailbox: 'me@gmail.com' },
    smtp: { host: 'smtp.test' },
    approve: async (request) => { seen = request },
    connect: server.connect,
  })
  const text = await tools[0].execute({
    to: ['a@b.com'],
    cc: ['c@d.com'],
    subject: 'Q3 report',
    text: 'Here is the report.',
    attachments: [{ filename: 'report.pdf', contentBase64: Buffer.from('pdf').toString('base64') }],
  })
  assert.match(seen.line, /Send to a@b\.com, c@d\.com/)
  assert.match(seen.line, /Subject: Q3 report/)
  assert.match(seen.line, /19 chars: "Here is the report\."/)
  assert.match(seen.line, /1 attachment \(report\.pdf\)/)
  assert.equal(seen.danger, true)
  assert.match(text, /Sent to a@b\.com, c@d\.com from me@gmail\.com/)
  assert.match(server.state.data, /Subject: Q3 report/)
})

test('reply and forward tools carry their own headers and attachments', async () => {
  const server = fakeSmtp()
  const requests = []
  const tools = createSmtpTools({
    id: 'gmail',
    displayName: 'Gmail',
    credential: PASS,
    account: 'me@gmail.com',
    smtp: { host: 'smtp.test' },
    approve: async (request) => { requests.push(request) },
    connect: server.connect,
  })
  const reply = await tools[1].execute({
    to: ['a@b.com'],
    subject: 'Re: hello',
    text: 'thanks',
    inReplyTo: '<original@example.com>',
    references: ['<original@example.com>'],
  })
  assert.match(reply, /^Sent to a@b\.com/)
  assert.match(server.state.data, /In-Reply-To: <original@example\.com>/)
  const forward = await tools[2].execute({
    to: ['f@b.com'],
    subject: 'Fwd: hello',
    text: 'forwarded',
    attachments: [{ filename: 'orig.txt', contentBase64: Buffer.from('original').toString('base64') }],
  })
  assert.match(forward, /^Sent to f@b\.com/)
  assert.match(requests[0].line, /^Reply to a@b\.com/)
  assert.match(requests[1].line, /^Forward to f@b\.com/)
  assert.match(server.state.data, /filename="orig\.txt"/)
})

test('the approval receives the running Session, so the card can address its chat', async () => {
  const server = fakeSmtp()
  let seen
  const tools = createSmtpTools({
    id: 'gmail',
    displayName: 'Gmail',
    credential: PASS,
    account: 'me@gmail.com',
    smtp: { host: 'smtp.test' },
    approve: async (request) => { seen = request },
    connect: server.connect,
  })
  await tools[0].execute({ to: ['a@b.com'], subject: 'Hi', text: 'body' }, { agent: { id: 'm1' } })
  assert.equal(seen.exec.agent.id, 'm1')
  assert.equal(seen.tool, 'send_email')
  assert.equal(seen.danger, true)
})

test('the tools expose exactly three send tools and caps their arguments', async () => {
  const server = fakeSmtp()
  const tools = createSmtpTools({
    id: 'gmail',
    displayName: 'Gmail',
    credential: PASS,
    account: 'me@gmail.com',
    smtp: { host: 'smtp.test' },
    approve: async () => {},
    connect: server.connect,
  })
  assert.deepEqual(tools.map(tool => tool.name), ['gmail_send_email', 'gmail_reply_email', 'gmail_forward_email'])
  await assert.rejects(tools[0].execute({ to: Array.from({ length: MAX_RECIPIENTS + 1 }, (_item, index) => `a${index}@b.com`), subject: 'x', text: 'y' }), /at most 20 recipients/)
  await assert.rejects(tools[0].execute({ to: ['a@b.com'], subject: 'Hi\r\nBcc: x@y.com', text: 'y' }), /line break/)
  await assert.rejects(tools[0].execute({ to: ['not-an-address'], subject: 'x', text: 'y' }), /plain email address/)
  assert.equal(server.state.connections, 0)
})

test('a message the server rejects is one plain sentence without the password', async () => {
  const server = fakeSmtp({ refuse: ['a@b.com', 'c@d.com'] })
  const tools = createSmtpTools({
    id: 'gmail',
    displayName: 'Gmail',
    credential: PASS,
    account: 'me@gmail.com',
    smtp: { host: 'smtp.test' },
    approve: async () => {},
    connect: server.connect,
  })
  await assert.rejects(tools[0].execute({ to: ['a@b.com', 'c@d.com'], subject: 'x', text: 'y' }), (error) => {
    assert.match(error.message, /refused every recipient/)
    assert.ok(!error.message.includes(PASS))
    return true
  })
})

test('a silent server fails in time instead of hanging', async () => {
  const server = fakeSmtp({ mute: true })
  const client = new SmtpClient({ host: 'smtp.test', account: 'me@gmail.com', credential: PASS, connect: server.connect, connectTimeoutMs: 50, commandTimeoutMs: 50, displayName: 'Gmail' })
  await assert.rejects(client.open(), /did not answer in time/)
})
