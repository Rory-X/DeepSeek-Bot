import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectValues, credentialFields } from '../src/host/connector-setup.js'

test('a connector card asks for its declared credentials, or its one token', () => {
  assert.deepEqual(credentialFields({ tokenSecret: 'TOKEN' }), [{ name: 'TOKEN' }])
  assert.deepEqual(credentialFields({
    credentials: [
      { name: 'IMA_OPENAPI_CLIENTID', label: 'Client ID' },
      { name: 'IMA_OPENAPI_APIKEY', label: 'API key' },
      { name: 'NOTE', label: 'Optional note', required: false },
      { label: 'no name' },
      null,
    ],
  }), [
    { name: 'IMA_OPENAPI_CLIENTID', label: 'Client ID' },
    { name: 'IMA_OPENAPI_APIKEY', label: 'API key' },
    { name: 'NOTE', label: 'Optional note', required: false },
  ])
  assert.deepEqual(credentialFields({ credentials: [] , tokenSecret: 'TOKEN' }), [{ name: 'TOKEN' }])
  assert.deepEqual(credentialFields({}), [])
  assert.deepEqual(credentialFields({ credentials: [{ name: '' }] }), [])
})

test('connect reads the declared fields and nothing else', () => {
  const imap = { credentials: [{ name: 'GMAIL_ADDRESS' }, { name: 'GMAIL_APP_PASSWORD' }] }
  assert.deepEqual(connectValues(imap, { values: { GMAIL_ADDRESS: ' me@example.com ', GMAIL_APP_PASSWORD: 'pass code', ADMIN: 'no' } }), {
    GMAIL_ADDRESS: 'me@example.com',
    GMAIL_APP_PASSWORD: 'pass code',
  })
  assert.throws(() => connectValues(imap, { values: { GMAIL_ADDRESS: 'me@example.com' } }), /Paste GMAIL_APP_PASSWORD first/)
  assert.throws(() => connectValues(imap, {}), /Paste GMAIL_ADDRESS first/)
  // The single-token card still posts `token`.
  assert.deepEqual(connectValues({ tokenSecret: 'WEREAD_API_KEY' }, { token: ' key ' }), { WEREAD_API_KEY: 'key' })
  assert.throws(() => connectValues({ tokenSecret: 'WEREAD_API_KEY' }, { token: '  ' }), /Paste WEREAD_API_KEY first/)
  // An optional field left empty is skipped, not refused.
  assert.deepEqual(connectValues({ credentials: [{ name: 'A' }, { name: 'B', required: false }] }, { values: { A: 'x', B: '' } }), { A: 'x' })
  // Every credential optional and none given: a channel that logs in later still connects.
  assert.deepEqual(connectValues({ credentials: [{ name: 'CHANNEL_TOKEN', required: false }] }, {}), {})
  assert.deepEqual(connectValues({ credentials: [{ name: 'CHANNEL_TOKEN', required: false }] }, { values: {} }), {})
})
