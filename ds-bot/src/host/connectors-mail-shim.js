// Gmail/QQ Mail compatibility shim for the bridge migration. The upstream mail connector
// covers search/read/draft/send only; the fork's old Gmail/QQ connectors also expose
// folders, attachments, labels, archive, move and delete. Until mail gains those, a migrated
// account gets the same old tools from the shared IMAP core, marked `compat: 'mail-shim'`.
import { createGmailTools } from './connectors/gmail.js'
import { createQQMailTools } from './connectors/qqmail.js'

export const MAIL_SHIM_PROVIDERS = ['gmail', 'qqmail']

export function createMailShim({ provider, credential, account, redact, connect, timeoutMs, connectTimeoutMs } = {}) {
  if (!MAIL_SHIM_PROVIDERS.includes(provider)) throw new Error(`Unknown mail shim provider: ${provider}`)
  const mounted = provider === 'gmail'
    ? createGmailTools({ credential, account, redact, connect, timeoutMs, connectTimeoutMs })
    : createQQMailTools({ credential, account, redact, connect, timeoutMs, connectTimeoutMs })
  return { compat: 'mail-shim', mailbox: mounted.mailbox, tools: mounted.tools, close: mounted.close }
}
