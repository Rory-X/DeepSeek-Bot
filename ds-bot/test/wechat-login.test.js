import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOGIN_STATES, consentGate, connectBlocked, loginActions, loginDetail, loginOf, loginStateOf, loginText, qrSourceOf, shouldPoll } from '../src/client/wechat-login.js'

const at = (state, extra = {}) => ({ state, ...extra })
// Every state has its own words and its own buttons: nothing falls into one shared error.
test('each of the ten states has its own words', () => {
  assert.equal(LOGIN_STATES.length, 10)
  const seen = new Set()
  for (const state of LOGIN_STATES) {
    const text = loginText(at(state, { account: 'ilxk…9f', error: 'host words' }))
    assert.equal(typeof text, 'string')
    assert.notEqual(text, '', `state ${state} has no words`)
    seen.add(text)
  }
  assert.equal(seen.size, 10)
})

test('a state the client does not know falls back to protocol-error', () => {
  assert.equal(loginStateOf(at('brand-new-state')), 'protocol-error')
  assert.equal(loginStateOf(null), null)
  assert.equal(loginStateOf(at('qr')), 'qr')
})

test('a channel without a login object has no sign-in state', () => {
  assert.equal(loginOf({ transport: 'webhook' }), null)
  assert.equal(loginOf({ login: { state: 'qr' } })?.state, 'qr')
  assert.equal(loginOf({ login: 'nope' }), null)
})

test('only a PNG data URL or an https URL is drawn as the QR picture', () => {
  const qr = value => qrSourceOf(at('qr', { qr: value }))
  assert.equal(qr('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA')
  assert.equal(qr('https://example.test/qr.png'), 'https://example.test/qr.png')
  assert.equal(qr('http://example.test/qr.png'), null)
  assert.equal(qr('javascript:alert(1)'), null)
  assert.equal(qr('WECHAT_LOGIN_TOKEN_ABCDEF'), null)
  assert.equal(qr(undefined), null)
  assert.equal(qrSourceOf(at('logged-in', { qr: 'data:image/png;base64,AAAA' })), null)
})

test('a QR the host could not draw says so instead of a picture', () => {
  const detail = loginDetail(at('qr', { qr: 'raw-token-string' }))
  assert.match(detail, /QR code unavailable/)
  assert.equal(loginDetail(at('qr', { qr: 'data:image/png;base64,AAAA' })), null)
})

test('every state offers the retry its contract names', () => {
  const actions = state => loginActions(at(state)).map(item => item.command)
  assert.deepEqual(actions('logged-out'), ['login-start'])
  assert.deepEqual(actions('qr'), ['login-refresh', 'login-cancel'])
  assert.deepEqual(actions('verified-needed'), ['login-refresh', 'login-cancel'])
  assert.deepEqual(actions('blocked'), ['login-refresh', 'login-cancel'])
  assert.deepEqual(actions('expired'), ['login-refresh', 'login-cancel'])
  assert.deepEqual(actions('cancelled'), ['login-start'])
  assert.deepEqual(actions('confirm-failed'), ['login-start', 'login-poll'])
  assert.deepEqual(actions('protocol-error'), ['login-poll'])
  assert.deepEqual(actions('logged-in'), [])
  assert.deepEqual(actions('login-expired'), ['login-start'])
  assert.deepEqual(loginActions(at('weird')).map(item => item.command), ['login-poll'])
})

test('polling runs only while the phone is being watched', () => {
  assert.equal(shouldPoll(at('qr')), true)
  assert.equal(shouldPoll(at('verified-needed')), true)
  for (const state of ['logged-out', 'blocked', 'expired', 'cancelled', 'confirm-failed', 'protocol-error', 'logged-in', 'login-expired']) {
    assert.equal(shouldPoll(at(state)), false, state)
  }
})

test('the risk note is asked once before any QR is requested', () => {
  assert.equal(consentGate(at('logged-out', { consentRequired: true }), false), true)
  assert.equal(consentGate(at('logged-out', { consentRequired: true }), true), false)
  assert.equal(consentGate(at('logged-out', { consentRequired: false }), false), false)
  assert.equal(consentGate(at('qr', { consentRequired: true }), false), false)
})

test('a clawbot channel connects only after the sign-in finished', () => {
  const connect = (transport, login) => connectBlocked(transport, login) === false
  assert.equal(connect('webhook', null), true)
  assert.equal(connect('clawbot', at('logged-in')), true)
  assert.equal(connect('clawbot', at('qr')), false)
  assert.equal(connect('clawbot', null), false)
})
