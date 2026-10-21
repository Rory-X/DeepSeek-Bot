// The iLink protocol client for the WeChat ClawBot transport. It speaks only the official
// documented contract (docs/protocol_zh_CN.md) with fetch and node:crypto: no new dependency,
// no real account in tests. The QR login is beta: the mock server is the only verification
// until a real account is explicitly allowed.
import { randomUUID } from 'node:crypto'

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com'
const DEFAULT_PAUSE_MS = 3_600_000
const DEFAULT_BACKOFF_MAX_MS = 60_000
const APP_ID = 'bot'

// `iLink-App-ClientVersion` is a uint32 packed as 0x00MMNNPP.
export const clientVersionOf = ({ major = 2, minor = 4, patch = 10 } = {}) =>
  ((0x00 << 24) | (major << 16) | (minor << 8) | patch) >>> 0

export const qrStateOf = (status) => {
  const state = typeof status === 'string' ? status : ''
  if (state === 'wait') return 'wait'
  if (state === 'scaned') return 'scanned'
  if (state === 'scaned_but_redirect') return 'scanned'
  if (state === 'confirmed') return 'confirmed'
  if (state === 'expired') return 'expired'
  if (state === 'need_verifycode') return 'verified-needed'
  if (state === 'verify_code_blocked') return 'blocked'
  if (state === 'binded_redirect') return 'bound'
  return 'unknown'
}

// Only an https image URL or a data: URL can reach the card; the raw content string never
// does (it could carry a login token into the DOM).
export const qrImageOf = (value) => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (/^https:\/\/\S+$/i.test(text)) return text
  if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/i.test(text)) return text
  return undefined
}

export const maskAccount = (value) => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return undefined
  if (text.length <= 6) return `${text.slice(0, 1)}…`
  return `${text.slice(0, 4)}…${text.slice(-2)}`
}

const jsonHeaders = (extra = {}) => ({ 'content-type': 'application/json', ...extra })

export function createIlinkClient({
  base = DEFAULT_BASE,
  fetch: request = fetch,
  version = {},
  uin = () => Math.floor(Math.random() * 0xffffffff) >>> 0,
  pauseMs = DEFAULT_PAUSE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  now = () => Date.now(),
} = {}) {
  const baseUrl = String(base).replace(/\/+$/, '')
  const clientVersion = String(clientVersionOf(version))
  const common = { 'iLink-App-Id': APP_ID, 'iLink-App-ClientVersion': clientVersion }
  const uinHeader = () => ({ 'X-WECHAT-UIN': Buffer.from(String(uin()), 'utf8').toString('base64') })
  let pausedUntil = 0
  let failures = 0

  const answer = async (response) => {
    let body
    try { body = await response.json() } catch { body = undefined }
    if (!response.ok) throw Object.assign(new Error(`iLink answered ${response.status}`), { status: response.status, body })
    if (body !== null && typeof body === 'object') {
      // `-14` is WeChat's "session timeout". What it means depends on the phase (a retryable
      // pause while signing in, a dead login afterwards), so the error carries a marker and
      // the caller names it instead of inheriting one phase's wording.
      const paused = Number(body.errcode) === -14 || Number(body.ret) === -14
      if (paused) throw Object.assign(new Error('WeChat paused this login for a while; try again later.'), { paused: true, body })
      if (body.ret !== undefined && Number(body.ret) !== 0) throw Object.assign(new Error(`iLink answered ret ${body.ret}`), { body })
      if (body.errcode !== undefined && Number(body.errcode) !== 0) throw Object.assign(new Error(`iLink answered errcode ${body.errcode}`), { body })
    }
    return body
  }

  const backoffMs = () => {
    const step = Math.min(backoffMaxMs, 1000 * 2 ** Math.min(failures, 10))
    failures = Math.min(failures + 1, 10)
    return step
  }

  const failPause = () => {
    if (failures >= 3) pausedUntil = now() + pauseMs
  }

  return {
    baseUrl,
    clientVersion,
    paused: () => now() < pausedUntil,
    pauseRemainingMs: () => Math.max(0, pausedUntil - now()),
    backoffMs,

    // The QR request: JSON + AuthorizationType + X-WECHAT-UIN, no Authorization/base_info.
    async getQrCode() {
      const response = await request(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`, {
        method: 'POST',
        headers: jsonHeaders({ ...common, AuthorizationType: 'ilink_bot_token', ...uinHeader() }),
        body: '{}',
      })
      return await answer(response)
    },

    // The status poll: only the app headers, optionally the route tag; no auth headers.
    async pollQrStatus(qrcode, { routeTag } = {}) {
      const query = new URLSearchParams({ qrcode: String(qrcode) })
      const response = await request(`${baseUrl}/ilink/bot/get_qrcode_status?${query}`, {
        method: 'GET',
        headers: { ...common, ...(routeTag === undefined ? {} : { SKRouteTag: String(routeTag) }) },
      })
      return await answer(response)
    },

    // Bot API: Bearer plus base_info, and the documented long-poll timeout is 35s.
    async getUpdates({ token, cursor, signal, channelVersion = 1 } = {}) {
      const response = await request(`${baseUrl}/ilink/bot/getupdates`, {
        method: 'POST',
        headers: jsonHeaders({ ...common, Authorization: `Bearer ${String(token ?? '')}` }),
        body: JSON.stringify({
          base_info: { channel_version: String(channelVersion), bot_agent: 'ds-bot' },
          ...(cursor === undefined ? {} : { get_updates_buf: String(cursor) }),
        }),
        signal,
      })
      return await answer(response)
    },

    // The bot's identity is the bearer token; the scanned account is the target. The official
    // client sends an empty `from_user_id`, and it is not a parameter here so no caller can
    // put an id there.
    async sendMessage({ token, toUserId, clientId = randomUUID(), contextToken, text, signal }) {
      const response = await request(`${baseUrl}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: jsonHeaders({ ...common, Authorization: `Bearer ${String(token ?? '')}` }),
        body: JSON.stringify({
          base_info: { channel_version: '1', bot_agent: 'ds-bot' },
          msg: {
            from_user_id: '',
            to_user_id: String(toUserId ?? ''),
            client_id: String(clientId ?? ''),
            message_type: 2,
            message_state: 2,
            ...(contextToken === undefined ? {} : { context_token: String(contextToken) }),
            item_list: [{ type: 1, text_item: { text: String(text ?? '') } }],
          },
        }),
        signal,
      })
      return await answer(response)
    },

    // `-14` is the login paused code: hold every call until the pause passes.
    noteError(code) {
      if (Number(code) === -14) pausedUntil = now() + pauseMs
      else failPause()
      return { paused: now() < pausedUntil, pauseMs: Math.max(0, pausedUntil - now()) }
    },
  }
}
