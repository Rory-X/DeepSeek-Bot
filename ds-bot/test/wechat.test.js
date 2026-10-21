// WeChat connector tests. The P1/P2 cases are listed as todos so the checklist below runs
// as a plan (`node --test test/wechat.test.js` shows them) until the module exists; the
// fakes themselves are tested for real so a broken double fails before any module work.
//
// Checklist: docs/plans/2026-10-21-wechat-test-checklist.md
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { postInbound, signWechat, startWebhookReceiver, wechatHeaders } from './wechat-fakes.js'

test('the webhook receiver records a signed request and its signature verifies', async (t) => {
  const receiver = await startWebhookReceiver({ secret: 'test-secret' })
  t.after(() => receiver.close())
  const body = JSON.stringify({ text: 'a notice' })
  await fetch(receiver.url, { method: 'POST', headers: wechatHeaders({ secret: 'test-secret', body }), body })
  assert.equal(receiver.requests.length, 1)
  assert.equal(receiver.requests[0].signatureOk, true)
  assert.deepEqual(receiver.requests[0].json, { text: 'a notice' })
})

test('the receiver answers what the test scripts, so failures can be staged', async (t) => {
  const receiver = await startWebhookReceiver({ reply: () => ({ status: 429, body: '{"retry_after":9}' }) })
  t.after(() => receiver.close())
  const response = await fetch(receiver.url, { method: 'POST', body: '{}' })
  assert.equal(response.status, 429)
  assert.deepEqual(await response.json(), { retry_after: 9 })
  receiver.setReply(() => ({ status: 200 }))
  assert.equal((await fetch(receiver.url, { method: 'POST', body: '{}' })).status, 200)
})

test('the inbound signer builds one signature both directions can check', async () => {
  const timestamp = 1_700_000_000
  const nonce = 'fixed-nonce'
  const body = '{"msgId":"m1"}'
  const expected = signWechat({ secret: 's', timestamp, nonce, body })
  assert.match(expected, /^sha256=[0-9a-f]{64}$/)
  const receiver = await startWebhookReceiver({ secret: 's' })
  try {
    const answer = await postInbound({ url: receiver.url, secret: 's', msgId: 'm1', timestamp, nonce })
    assert.equal(answer.status, 200)
    assert.equal(receiver.requests[0].signatureOk, true)
  } finally {
    await receiver.close()
  }
})

// ---- P1: outbound notification and the channel card ----
test.todo('P1-01 a channel is one instance: create adds wechat-2, delete removes it, the ninth is refused with the host text')
test.todo('P1-02 the card carries kind/bot/segmented fields; webhookSecret reports saved but never a value')
test.todo('P1-03 readiness: no botId, a deleted Bot, no webhookUrl and no secret each give a levelNotes sentence and no Connect')
test.todo('P1-04 connector-connect on a webhook channel turns it ready and reports inbound.url + inbound.token')
test.todo('P1-05 wechat_notify exists only at write level; the card names the channel and the webhook host, never the full URL')
test.todo('P1-06 allow runs the POST once; deny, dismiss, timeout and cancel each leave the receiver with 0 requests')
test.todo('P1-07 outbound errors map 401/403/404/429/other to the fixed sentences and never echo the URL or secret')
test.todo('P1-08 generic text is capped at 4000 and wecom at 2048; a longer text fails before any request')
test.todo('P1-09 changing transport while ready is refused with the fixed sentence; after connector-disconnect it saves')
test.todo('P1-10 connector-test posts the fixed test notice and returns the whole view; a failure keeps state ready and shows error')
test.todo('P1-11 deleting an instance stops its listener, clears its secret and leaves the other channel ready')
test.todo('P1-12 the connector turned off in the profile has no row and opens no port')

// ---- P2: inbound listener, binding and replies ----
test.todo('P2-01 the listener binds 127.0.0.1 only: address is asserted, and no configuration can make it 0.0.0.0')
test.todo('P2-02 a taken port leaves only that channel error with port and fix; the plugin boots and other connectors are ready')
test.todo('P2-03 dispose closes the listener and unregisters every route: the port refuses connections, nothing stays in the route table')
test.todo('P2-04 a missing or wrong HMAC signature answers 401 bad-signature and starts 0 Bot turns')
test.todo('P2-05 a timestamp outside ±300s answers 401 stale-timestamp and starts 0 turns')
test.todo('P2-06 a replayed nonce answers 401 replayed-nonce and starts 0 turns')
test.todo('P2-07 a replayed msgId answers 200 duplicate and starts 0 turns; after a plugin restart it is still swallowed')
test.todo('P2-08 the same text under a new msgId starts a turn (no content-hash swallowing)')
test.todo('P2-09 over the per-channel rate limit answers 429 with retry_after and starts 0 turns')
test.todo('P2-10 a sender outside the allowlist answers 403 sender-not-allowed and starts 0 turns')
test.todo('P2-11 a deleted or failing Bot answers 502 bot-unavailable with the fallback sentence and no retry loop')
test.todo('P2-12 two inbound messages are serialized: each reply answers its own msgId, correlated to that turn end')
test.todo('P2-13 no reply within 120s answers 504 timeout and is not re-delivered')
test.todo('P2-14 rebinding A->B archives the A session with {botId:A, reason:rebind}, creates a new session for B, and answers in-flight requests 503 channel-rebound')
test.todo('P2-15 an inbound turn that needs approval gets the WeChat notice only: the card stays unanswered and the tool runs 0 times')
test.todo('P2-16 logs, diagnostics and state.json carry no sender text, no message body and no secret; sender appears as hash/length only')
test.todo('P2-17 the read level still answers inbound while wechat_notify stays unregistered')
