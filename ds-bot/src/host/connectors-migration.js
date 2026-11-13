// P2 migration from the fork connector state to the upstream catalog/gateway namespaces.
//
// The migration is additive: old `state.connectors[id]` entries and old secrets stay
// untouched. Every write is guarded by the target key already existing, so running it
// again (or switching legacy -> bridge -> legacy) changes nothing. A connector whose old
// credential cannot be checked is marked `needs-reconnect` instead of being dropped.
import { tokenSecretOf, refreshSecretOf } from './connectors/catalog.js'
import { mailSecretName, presetOf } from './connectors/mail/presets.js'

const grantKey = id => `ds-bot/connector-${id}`

export const CONNECTOR_MIGRATION_VERSION = 1
const RECORD = 'connectorMigrations'
const OAUTH_IDS = id => /^(cloudflare|neon)(-\d+)?$/.test(id)

const now = () => Date.now()
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const accountOf = state => {
  state.connectors ??= {}
  state.connectors.mail ??= {}
  state.connectors.mail.accounts ??= {}
  return state.connectors.mail.accounts
}

function recordOf(state) {
  if (!isObject(state[RECORD])) state[RECORD] = { version: CONNECTOR_MIGRATION_VERSION, connectors: {} }
  if (!isObject(state[RECORD].connectors)) state[RECORD].connectors = {}
  return state[RECORD].connectors
}

async function readGrant(rt, id) {
  const credentials = rt.ctx?.get?.('credentials')
  if (credentials === undefined || credentials === null) return undefined
  try {
    const record = await credentials.readRecord(`ds-bot/connector-${id}`)
    if (record?.kind !== 'grant' || record.payload?.version !== 1 || typeof record.payload?.tokens?.access !== 'string') return undefined
    return record.payload
  } catch {
    return undefined
  }
}
export async function migrateConnectors(rt, { validateMail, checkGrant = readGrant } = {}) {
  const state = rt.state
  const records = recordOf(state)
  const changes = []
  const skipped = []
  await rt.loadSecrets?.()

  const writeSecret = async (name, value, purpose) => {
    if (typeof value !== 'string' || value === '') return false
    if (rt.secretValue?.(name) !== undefined) return false
    await rt.secretEndpoint?.('secret-set', { name, value, purpose, scope: 'all' })
    return true
  }
  const legacyOf = (id, extra = {}) => {
    const old = isObject(state.connectors?.[id]) ? state.connectors[id] : {}
    state.connectors[id] = { ...old, ...(old.legacy === undefined ? { legacy: { ...old, ...extra } } : {}) }
  }
  const finish = (id, status, detail = {}) => {
    records[id] = { status, at: now(), ...detail }
  }
  const fail = (id, error) => {
    finish(id, 'failed', { error: String(error?.message ?? error).slice(0, 300) })
    skipped.push(id)
  }

  // GitHub keeps its old secret name; only the level/state shape needs a copy.
  try {
    if (records.github?.status === 'migrated') {
      // already migrated; keep the old state and skip a second report entry
    } else {
    const old = state.connectors?.github
    if (old !== undefined || rt.secretValue?.('GITHUB_TOKEN') !== undefined) {
      legacyOf('github')
      if (typeof old?.level === 'string') state.connectors.github.readOnly ??= old.level === 'read'
      finish('github', 'migrated', { source: 'state+token' })
      changes.push('github')
    }
    }
  } catch (error) { fail('github', error) }

  // Vercel: copy the old saved token to the upstream token name.
  try {
    if (records.vercel?.status === 'migrated') {
      // already migrated
    } else {
    const old = state.connectors?.vercel
    const token = rt.secretValue?.('VERCEL_TOKEN')
    if (old !== undefined || token !== undefined) {
      legacyOf('vercel', { tokenSecret: 'VERCEL_TOKEN' })
      if (token !== undefined) await writeSecret(tokenSecretOf('vercel'), token, 'Vercel connector')
      if (typeof old?.level === 'string') state.connectors.vercel.readOnly ??= old.level === 'read'
      finish('vercel', 'migrated', { source: token === undefined ? 'state' : 'token' })
      changes.push('vercel')
    }
    }
  } catch (error) { fail('vercel', error) }

  // Cloudflare and each Neon instance: copy the old DSH grant's access/refresh tokens to
  // the upstream secret names, keep the project/role metadata on the legacy snapshot.
  for (const id of Object.keys(state.connectors ?? {}).filter(id => OAUTH_IDS(id))) {
    try {
      if (records[id]?.status === 'migrated') continue
      const old = state.connectors[id]
      const grant = await checkGrant(rt, id)
      legacyOf(id, { grantKey: grantKey(id), projectId: old?.projectId, projectName: old?.projectName, role: old?.role })
      if (typeof old?.level === 'string') state.connectors[id].readOnly ??= old.level === 'read'
      if (grant === undefined) {
        state.connectors[id].legacy = { ...state.connectors[id].legacy, needsReconnect: true }
        finish(id, 'needs-reconnect', { reason: 'grant-missing' })
        skipped.push(id)
        continue
      }
      const copied = await writeSecret(tokenSecretOf(id), grant.tokens.access, `${id} connector`)
      if (typeof grant.tokens.refresh === 'string') await writeSecret(refreshSecretOf(id), grant.tokens.refresh, `${id} connector`)
      state.connectors[id].oauth = {
        ...(state.connectors[id].oauth ?? {}),
        ...(grant.authorizationServerUrl === undefined ? {} : { authorizationServerUrl: grant.authorizationServerUrl }),
        ...(grant.resource === undefined ? {} : { resource: grant.resource }),
        ...(grant.scope === undefined ? {} : { scope: grant.scope }),
      }
      finish(id, 'migrated', { source: copied ? 'grant' : 'existing' })
      changes.push(id)
    } catch (error) { fail(id, error) }
  }

  // Gmail and QQ Mail: one upstream mail account each, keeping the old level on the
  // account and the old secrets untouched. The password is copied to the mail secret
  // name the upstream mail connector reads.
  const mailSources = [
    { id: 'gmail', provider: 'gmail', address: 'GMAIL_ADDRESS', password: 'GMAIL_APP_PASSWORD' },
    { id: 'qqmail', provider: 'qqmail', address: 'QQMAIL_ADDRESS', password: 'QQMAIL_AUTH_CODE' },
  ]
  const accounts = accountOf(state)
  for (const source of mailSources) {
    try {
      if (records[source.id]?.status === 'migrated') continue
      const old = state.connectors?.[source.id]
      const address = rt.secretValue?.(source.address)
      const password = rt.secretValue?.(source.password)
      if (old === undefined && address === undefined) continue
      legacyOf(source.id)
      if (typeof old?.level === 'string') state.connectors[source.id].legacy.level = old.level
      const account = {
        id: source.id,
        address: address ?? old?.account ?? old?.mailbox,
        provider: source.provider,
        auth: 'password',
        legacyLevel: old?.level ?? 'read',
        compat: 'mail-shim',
        status: 'ready',
        createdAt: now(),
      }
      const preset = presetOf(account.address)
      if (preset !== undefined) { account.imap = preset.imap; account.smtp = preset.smtp }
      if (typeof account.address !== 'string' || account.address === '') account.status = 'needs-reconnect'
      else if (typeof password !== 'string' || password === '') account.status = 'needs-reconnect'
      else if (typeof validateMail === 'function') {
        try { await validateMail(account, { password }) } catch { account.status = 'needs-reconnect' }
      }
      if (account.status === 'ready') await writeSecret(mailSecretName(account.address, 'PASSWORD'), password, `Mailbox ${account.address}`)
      if (accounts[source.id] === undefined) accounts[source.id] = account
      else if (accounts[source.id].status !== 'ready' && account.status === 'ready') accounts[source.id] = account
      else account.status === 'needs-reconnect' && (accounts[source.id].status ??= 'needs-reconnect')
      finish(source.id, account.status === 'ready' ? 'migrated' : 'needs-reconnect', { account: source.id })
      if (account.status === 'ready') changes.push(source.id)
      else skipped.push(source.id)
    } catch (error) { fail(source.id, error) }
  }

  // A stable, small report; no secret values or account addresses in it.
  return { changed: changes.length > 0, changes, skipped, records }
}
