// A connector's authorization grant: one opaque record in DSH's own credential store
// (ctx.credentials), addressed as `ds-bot/connector-<id>`. The seam never reads a grant's
// payload, so the access and refresh tokens stay out of the team file, the Secrets page
// and every Bot's shell; only this module parses it. Writes go through modifyRecord, the
// seam's serialized read-modify-write, which is what makes a token refresh safe.
import { OAuthError } from './client.js'

export const GRANT_VERSION = 1
const REFRESH_SKEW_MS = 60_000

// The credential-key grammar is `<scope>/<id>`, both lowercase-hyphenated segments; the
// owning plugin is `ds-bot`.
export const grantKey = id => `ds-bot/connector-${id}`

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// A record this module can use, or undefined. Anything else (another version, a half
// written record, an api-key record) reads as "no authorization" and asks for a reconnect.
export function parseGrant(record) {
  if (record?.kind !== 'grant' || !isObject(record.payload)) return undefined
  const payload = record.payload
  if (payload.version !== GRANT_VERSION) return undefined
  if (!isObject(payload.client) || typeof payload.client.id !== 'string' || payload.client.id === '') return undefined
  if (typeof payload.resource !== 'string' || payload.resource === '') return undefined
  if (!isObject(payload.tokens) || typeof payload.tokens.access !== 'string' || payload.tokens.access === '') return undefined
  return payload
}

export function isExpiring(grant, { now = Date.now(), skewMs = REFRESH_SKEW_MS } = {}) {
  const expiresAt = grant?.tokens?.expiresAt
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt - skewMs <= now
}

export function createGrantStore({ credentials }) {
  if (credentials === undefined) throw new OAuthError('This DSH has no credential store to keep a connector authorization', 'store')
  return {
    keyOf: grantKey,
    async read(id) {
      return parseGrant(await credentials.readRecord(grantKey(id)))
    },
    async save(id, grant) {
      await credentials.modifyRecord(grantKey(id), async () => ({ kind: 'grant', payload: { ...grant, version: GRANT_VERSION } }))
    },
    async clear(id) {
      await credentials.deleteRecord(grantKey(id))
    },
    // Replaces the grant only while it is still the one `access` names: a token another
    // turn (or another process) already refreshed is left alone and returned as it is.
    // `produce` runs under the record lock, as a refresh must (the refresh token rotates).
    async rotate(id, access, produce) {
      const record = await credentials.modifyRecord(grantKey(id), async (current) => {
        const grant = parseGrant(current)
        if (grant === undefined) return undefined
        if (grant.tokens.access !== access) return undefined
        const next = await produce(grant)
        return { kind: 'grant', payload: { ...next, version: GRANT_VERSION } }
      })
      return parseGrant(record)
    },
  }
}
