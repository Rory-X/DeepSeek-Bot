// Gmail/QQ Mail compatibility shim for the bridge migration. The upstream mail connector
// covers search/read/draft/send only; the fork's old Gmail/QQ connectors also expose
// folders, attachments, labels, archive, move and delete. Until mail gains those, a migrated
// account gets the same old tools from the shared IMAP core, marked `compat: 'mail-shim'`.
import gmail, { GMAIL_ADDRESS_SECRET, GMAIL_APP_PASSWORD_SECRET, GMAIL_TOOLS } from './connectors/gmail.js'
import qqmail, { QQMAIL_ADDRESS_SECRET, QQMAIL_SECRET, QQMAIL_TOOLS } from './connectors/qqmail.js'

export const MAIL_SHIM_PROVIDERS = ['gmail', 'qqmail']

const MODULES = { gmail, qqmail }

// `secrets` is the old two-credential form both modules mount from. The older P2 call shape
// (`credential` + `account`) is kept for callers that only need the read tools.
export function createMailShim({ provider, secrets, credential, account, redact, level = 'read', approve, connect, timeoutMs, connectTimeoutMs } = {}) {
  const module = MODULES[provider]
  if (module === undefined) throw new Error(`Unknown mail shim provider: ${provider}`)
  const fields = secrets ?? (provider === 'gmail'
    ? { [GMAIL_ADDRESS_SECRET]: account?.mailbox, [GMAIL_APP_PASSWORD_SECRET]: credential }
    : { [QQMAIL_ADDRESS_SECRET]: account?.mailbox, [QQMAIL_SECRET]: credential })
  const mounted = module.mount({
    secrets: fields,
    redact,
    level,
    ...(approve === undefined ? {} : { approve }),
    ...(connect === undefined ? {} : { connect }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
  })
  return { compat: 'mail-shim', mailbox: mounted.mailbox, tools: mounted.tools, close: mounted.close }
}

export const MAIL_SHIM_TOOLS = { gmail: GMAIL_TOOLS, qqmail: QQMAIL_TOOLS }
