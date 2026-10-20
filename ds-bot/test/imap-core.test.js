import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createImapTools, searchCriteria } from '../src/host/connectors/_imap.js'

const source = readFileSync(fileURLToPath(new URL('../src/host/connectors/_imap.js', import.meta.url)), 'utf8')
// Comments may name the commands they promise not to send; only code counts.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !line.trim().startsWith('//')).join('\n')

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

test('only the Gmail connector offers the raw query parameter', () => {
  const make = gmailQuery => createImapTools({
    id: 'mail', displayName: 'Mail', credential: 'name@example.com:code', account: { mailbox: 'name@example.com' }, gmailQuery,
  })
  assert.equal(make(true).tools.find(tool => tool.name === 'mail_search').parameters.properties.query.type, 'string')
  assert.equal(make(false).tools.find(tool => tool.name === 'mail_search').parameters.properties.query, undefined)
})

test('the shared IMAP core carries no write command', () => {
  for (const command of ['STORE', 'APPEND', 'COPY', 'MOVE', 'EXPUNGE', 'SELECT']) {
    assert.equal(new RegExp(`\\b${command}\\b`).test(code), false, command)
  }
})
