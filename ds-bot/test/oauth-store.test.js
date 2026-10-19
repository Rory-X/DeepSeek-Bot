import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGrantStore, GRANT_VERSION, grantKey, isExpiring, parseGrant } from '../src/host/oauth/store.js'
import { fakeCredentials } from './oauth-fakes.js'

const grant = (overrides = {}) => ({
  version: GRANT_VERSION,
  issuer: 'https://mcp.test',
  resource: 'https://mcp.test/mcp',
  client: { id: 'client-1', tokenAuth: 'none', redirectUri: 'https://dsh.test/oauth/ds-bot/notion' },
  tokens: { access: 'access-1', refresh: 'refresh-1', expiresAt: 10_000, tokenType: 'Bearer' },
  scopes: ['read'],
  authorizedAt: 1000,
  ...overrides,
})

const stored = (payload, kind = 'grant') => ({ kind, payload })

test('the grant lives in one credential record named after the connector', async () => {
  const credentials = fakeCredentials()
  const store = createGrantStore({ credentials })
  assert.equal(grantKey('notion'), 'ds-bot/connector-notion')
  assert.equal(store.keyOf('cloudflare'), 'ds-bot/connector-cloudflare')

  assert.equal(await store.read('notion'), undefined)
  await store.save('notion', grant())
  const record = credentials.records.get('ds-bot/connector-notion')
  assert.equal(record.kind, 'grant')
  assert.equal(record.payload.version, GRANT_VERSION)
  assert.equal((await store.read('notion')).tokens.access, 'access-1')

  await store.clear('notion')
  assert.equal(await store.read('notion'), undefined)
  // Clearing a grant that is already gone is not an error.
  await store.clear('notion')
})

test('a record this module cannot read counts as no authorization', () => {
  assert.equal(parseGrant(undefined), undefined)
  assert.equal(parseGrant(stored(undefined, 'api-key')), undefined)
  assert.equal(parseGrant(stored({ ...grant(), version: 2 })), undefined)
  assert.equal(parseGrant(stored(grant({ client: {} }))), undefined)
  assert.equal(parseGrant(stored(grant({ tokens: {} }))), undefined)
  assert.equal(parseGrant(stored(grant({ resource: undefined }))), undefined)
  assert.equal(parseGrant(stored(grant({ tokens: { access: '' } }))), undefined)
  assert.equal(parseGrant(stored(grant())).tokens.access, 'access-1')
})

test('a token is expiring inside the refresh window', () => {
  const now = 10_000
  assert.equal(isExpiring(grant(), { now }), true)
  assert.equal(isExpiring(grant({ tokens: { access: 'a', expiresAt: now + 60_000 } }), { now }), true)
  assert.equal(isExpiring(grant({ tokens: { access: 'a', expiresAt: now + 61_000 } }), { now }), false)
  // A provider that states no lifetime is not refreshed ahead of a 401.
  assert.equal(isExpiring(grant({ tokens: { access: 'a' } }), { now }), false)
})

test('rotate replaces the grant only while it is the one named', async () => {
  const credentials = fakeCredentials()
  const store = createGrantStore({ credentials })
  await store.save('notion', grant())

  let produced = 0
  const rotated = await store.rotate('notion', 'access-1', async (current) => {
    produced += 1
    return { ...current, tokens: { ...current.tokens, access: 'access-2', refresh: 'refresh-2' } }
  })
  assert.equal(produced, 1)
  assert.equal(rotated.tokens.access, 'access-2')
  assert.equal(rotated.tokens.refresh, 'refresh-2')
  assert.equal((await store.read('notion')).tokens.access, 'access-2')

  // Someone else refreshed first: the stale access token no longer matches, so the grant
  // is handed back unchanged and the produce step never runs.
  const stale = await store.rotate('notion', 'access-1', async () => {
    produced += 1
    return grant()
  })
  assert.equal(produced, 1)
  assert.equal(stale.tokens.access, 'access-2')

  // A cleared grant declines too.
  await store.clear('notion')
  assert.equal(await store.rotate('notion', 'access-2', async () => grant()), undefined)
})

test('a store without DSH credentials refuses with a readable reason', () => {
  assert.throws(() => createGrantStore({ credentials: undefined }), (error) => {
    assert.equal(error.code, 'oauth/store')
    assert.match(error.message, /credential store/)
    return true
  })
})
