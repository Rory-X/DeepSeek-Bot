// The ClawBot sign-in step, kept apart from the card so its states and copy can be checked
// without a browser: the view sends the state, this module says what the reader sees and
// which generic command each button sends.
import { t } from './i18n.js'

// The ten states the client draws. Any other value a host sends falls back to protocol-error,
// the state that offers a Retry and never marks the channel as failed.
export const LOGIN_STATES = ['logged-out', 'qr', 'verified-needed', 'blocked', 'expired', 'cancelled', 'confirm-failed', 'protocol-error', 'logged-in', 'login-expired']
const KNOWN = new Set(LOGIN_STATES)

// The iLink status call is a long poll: one answer can take half a minute. The card keeps
// exactly one request in flight and waits a moment after each answer, so a slow host never
// builds a queue; the whole wait is still bounded.
export const POLL_GAP_MS = 500
export const POLL_LIMIT_MS = 5 * 60 * 1000

// One serialized wait: poll, wait out the gap, poll again, until cancelled or the limit
// passes. `sleep`, `now` and `cancelled` are given by the caller so this can be tested.
export const pollLoginSerially = async ({
  poll,
  cancelled = () => false,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  startedAt = now(),
  gapMs = POLL_GAP_MS,
  limitMs = POLL_LIMIT_MS,
} = {}) => {
  let calls = 0
  while (!cancelled() && now() - startedAt < limitMs) {
    calls += 1
    try {
      await poll()
    } catch {
      // One failed status call leaves the card as it is; the next round asks again.
    }
    if (cancelled()) break
    await sleep(gapMs)
  }
  return calls
}

// A channel whose transport is clawbot carries its sign-in state under `login`; webhook
// channels carry none, so nothing of this is drawn for them.
export const loginOf = row => (row?.login !== null && typeof row?.login === 'object' && typeof row.login.state === 'string' ? row.login : null)

export const loginStateOf = (login) => {
  if (login === null) return null
  return KNOWN.has(login.state) ? login.state : 'protocol-error'
}

// Only a picture the browser can load is drawn: a PNG data URL or an https URL. A raw string
// is a login token in disguise, so it never reaches the DOM.
export const qrSourceOf = (login) => {
  if (login === null || loginStateOf(login) !== 'qr') return null
  const qr = login.qr
  if (typeof qr !== 'string') return null
  if (qr.startsWith('data:image/png;base64,')) return qr
  if (/^https:\/\/\S+$/i.test(qr)) return qr
  return null
}

const state = login => loginStateOf(login)

export const loginText = (login) => {
  switch (state(login)) {
    case 'logged-out': return t('Not logged in — this channel cannot send or receive yet.')
    case 'qr': return login.scanned === true ? t('Scanned — confirm on your phone.') : t('Scan the QR code with WeChat to link this channel.')
    case 'verified-needed': return t('Enter the code shown in WeChat.')
    case 'blocked': return t('Too many wrong codes; refresh the QR code.')
    case 'expired': return t('QR code expired; refresh to try again.')
    case 'cancelled': return t('Login cancelled.')
    case 'confirm-failed': return t('WeChat did not confirm the login.')
    case 'protocol-error': return t('WeChat login service is unavailable.')
    case 'logged-in': return typeof login.account === 'string' && login.account !== '' ? t('Logged in as {account}', { account: login.account }) : t('Logged in')
    case 'login-expired': return t('Login expired; scan again.')
    default: return null
  }
}

// A second line: the host's own words when it sends some, and the QR trouble when the picture
// could not be drawn at all.
export const loginDetail = (login) => {
  if (state(login) === 'protocol-error') return typeof login.error === 'string' && login.error !== '' ? login.error : t('Try again in a moment.')
  if (state(login) === 'login-expired' || state(login) === 'blocked') return typeof login.error === 'string' && login.error !== '' ? login.error : null
  if (state(login) === 'qr' && qrSourceOf(login) === null) return t('QR code unavailable. Refresh to try again.')
  return null
}

// The buttons of each state, as generic commands: no transport here sends anything else.
export const loginActions = (login) => {
  const action = (id, label, command, args) => ({ id, label, command, args })
  switch (state(login)) {
    case 'logged-out': return [action('start', t('Start login'), 'login-start')]
    case 'qr': return [action('refresh', t('Refresh'), 'login-refresh'), action('cancel', t('Cancel'), 'login-cancel')]
    case 'verified-needed': return [action('refresh', t('Refresh'), 'login-refresh'), action('cancel', t('Cancel'), 'login-cancel')]
    case 'blocked': return [action('refresh', t('Refresh'), 'login-refresh'), action('cancel', t('Cancel'), 'login-cancel')]
    case 'expired': return [action('refresh', t('Refresh'), 'login-refresh'), action('cancel', t('Cancel'), 'login-cancel')]
    case 'cancelled': return [action('start', t('Start login'), 'login-start')]
    case 'confirm-failed': return [action('start', t('Start login'), 'login-start'), action('retry', t('Retry'), 'login-poll')]
    case 'protocol-error': return [action('retry', t('Retry'), 'login-poll')]
    case 'login-expired': return [action('start', t('Start login'), 'login-start')]
    default: return []
  }
}

// The risk note needs the reader's yes before a QR is requested; the host remembers the yes
// by version, so this is only the first gate of this screen.
export const consentGate = (login, acknowledged) => state(login) === 'logged-out' && login?.consentRequired === true && acknowledged !== true

export const shouldPoll = login => state(login) === 'qr' || state(login) === 'verified-needed'

// A clawbot channel connects only after its sign-in succeeded.
export const connectBlocked = (transport, login) => transport === 'clawbot' && state(login) !== 'logged-in'

export const CONSENT_POINTS = [
  'Your WeChat account is a personal account and may be limited by WeChat.',
  'The protocol follows public official documentation and has no third-party support commitment.',
  'Scanning login is beta and has not been tested on a real device.',
]
