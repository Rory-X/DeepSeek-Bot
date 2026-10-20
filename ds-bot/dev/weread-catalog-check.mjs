// WeRead gateway catalog watchdog — run by hand or once a month, never per request.
//
// The Agent Gateway exposes its own interface catalog at `/_list`: every api_name, its
// parameters, and whether it needs the reader's identity. The connector registers a fixed
// white-list of those endpoints, so a change in the catalog is exactly the moment to re-read
// it: a renamed parameter breaks a tool quietly, and a NEW endpoint — above all a write —
// must be reviewed before anything is registered behind the approval card.
//
//   node dev/weread-catalog-check.mjs             compare against docs/evidence/weread/catalog.json
//   node dev/weread-catalog-check.mjs --update    rewrite the snapshot (a reviewed change)
//   node dev/weread-catalog-check.mjs --snapshot other.json
//
// It also notices `upgrade_info` in the answer and compares the skill version in the file with
// the version upstream Tencent/WeChatReading publishes. Exit codes: 0 unchanged, 1 changed
// (or an upgrade notice), 2 the check itself could not run.
//
// The key comes from WEREAD_API_KEY (or DSH_SECRET_WEREAD_API_KEY in a DS Bot shell); it is
// never printed, and only the interface catalog is read — no shelf, note or reading data.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_VERSION } from '../src/host/connectors/weread.js'

const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway'
const UPSTREAM = 'https://raw.githubusercontent.com/Tencent/WeChatReading/main/skills/SKILL.md'
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const DEFAULT_SNAPSHOT = join(ROOT, 'docs/evidence/weread/catalog.json')

const args = process.argv.slice(2)
const update = args.includes('--update')
const snapshotArg = args.indexOf('--snapshot')
const snapshotPath = snapshotArg === -1 ? DEFAULT_SNAPSHOT : args[snapshotArg + 1]
const token = process.env.WEREAD_API_KEY ?? process.env.DSH_SECRET_WEREAD_API_KEY
if (!token) {
  console.error('No key: set WEREAD_API_KEY (or DSH_SECRET_WEREAD_API_KEY).')
  process.exit(2)
}

const catalog = async () => {
  const response = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ api_name: '/_list', skill_version: SKILL_VERSION }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined)
  if (response === undefined) throw new Error('Could not reach WeRead')
  if (response.status === 401) throw new Error('WeRead did not accept this key')
  const body = await response.json().catch(() => undefined)
  if (body === undefined) throw new Error(`WeRead answered ${response.status} without JSON`)
  if (body.errcode !== undefined && body.errcode !== 0) throw new Error(`WeRead answered code ${body.errcode}: ${body.errmsg ?? ''}`)
  if (!Array.isArray(body.apis)) throw new Error('The answer carried no interface list')
  return body
}

// Only what a change would matter for: the endpoint, whether it needs the reader, and the
// parameter names with required ones starred. Descriptions are prose and change freely.
const normalize = body => {
  const endpoints = {}
  for (const api of body.apis) {
    if (typeof api?.api_name !== 'string') continue
    const params = Array.isArray(api.params)
      ? api.params.map(param => `${param?.name ?? '?'}${param?.required === true ? '*' : ''}`).sort()
      : []
    endpoints[api.api_name] = { needLogin: api.need_login === true, params }
  }
  return { skillVersion: SKILL_VERSION, endpoints: Object.fromEntries(Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b))) }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const diff = (before, after) => {
  const lines = []
  const beforeKeys = Object.keys(before.endpoints)
  const afterKeys = Object.keys(after.endpoints)
  for (const key of afterKeys) if (!beforeKeys.includes(key)) lines.push(`NEW endpoint ${key}`)
  for (const key of beforeKeys) if (!afterKeys.includes(key)) lines.push(`GONE endpoint ${key}`)
  for (const key of afterKeys.filter(name => beforeKeys.includes(name))) {
    const old = before.endpoints[key]
    const now = after.endpoints[key]
    if (old.needLogin !== now.needLogin) lines.push(`CHANGED ${key}: needLogin ${old.needLogin} -> ${now.needLogin}`)
    if (!same(old.params, now.params)) lines.push(`CHANGED ${key}: params [${old.params.join(',')}] -> [${now.params.join(',')}]`)
  }
  return lines
}

const localVersion = SKILL_VERSION
let body
try {
  body = await catalog()
} catch (error) {
  console.error(`Check failed: ${error?.message ?? error}`)
  process.exit(2)
}

const now = normalize(body)
let before
try {
  before = JSON.parse(readFileSync(snapshotPath, 'utf8'))
} catch {
  before = undefined
}

let failed = false
// The answer may ask for a skill-pack upgrade; that is the strongest signal to re-read the docs.
if (body.upgrade_info !== undefined) {
  failed = true
  console.error(`UPGRADE required: ${JSON.stringify(body.upgrade_info).slice(0, 300)}`)
}

if (before === undefined) {
  console.log(`No snapshot at ${snapshotPath}; writing the first one with ${Object.keys(now.endpoints).length} endpoints.`)
  mkdirSync(dirname(snapshotPath), { recursive: true })
  writeFileSync(snapshotPath, `${JSON.stringify({ ...now, checkedAt: new Date().toISOString() }, null, 2)}\n`)
} else {
  const changes = diff(before, now)
  if (changes.length === 0) console.log(`Catalog unchanged: ${Object.keys(now.endpoints).length} endpoints, skill ${localVersion}.`)
  else {
    console.log(`Catalog changed (${changes.length}):`)
    for (const line of changes) console.log(`  ${line}`)
    if (update) {
      // A reviewed change: registering or ignoring the new endpoints is a code decision, and
      // this snapshot only records that the catalog was read.
      writeFileSync(snapshotPath, `${JSON.stringify({ ...now, checkedAt: new Date().toISOString() }, null, 2)}\n`)
      console.log(`Snapshot updated at ${snapshotPath}.`)
    } else {
      failed = true
      console.log('Re-read the new endpoints, register only reviewed read ones (writes need the approval card), then run --update.')
    }
  }
}

// The skill pack's own version, from upstream. A failure here is a warning: the catalog check
// is the gate, and a network blip must not make it look like a change.
try {
  const upstream = await fetch(UPSTREAM, { signal: AbortSignal.timeout(20_000) }).then(response => (response.ok ? response.text() : undefined)).catch(() => undefined)
  const version = upstream?.match(/^version:\s*(\S+)/m)?.[1]
  if (version !== undefined && version !== localVersion) {
    failed = true
    console.log(`Upstream skill version ${version} differs from the connector's ${localVersion}; re-read Tencent/WeChatReading and bump the constant.`)
  } else if (version !== undefined) {
    console.log(`Upstream skill version ${version} matches.`)
  } else {
    console.warn('Could not read the upstream SKILL.md version (network?); catalog result above still stands.')
  }
} catch {
  console.warn('Could not read the upstream SKILL.md version (network?); catalog result above still stands.')
}

process.exit(failed ? 1 : 0)
