// QQ Mail connector: QQ offers no API and no MCP server, so its tools speak IMAP with the
// authorization code a user makes in QQ Mail's settings. The connection is read-only: the
// mailbox is opened with EXAMINE, bodies are fetched with BODY.PEEK, and no tool sends or
// changes a message. Sending would need SMTP and an approval, and is not part of this
// connector.
//
// The module names QQ's server, its credentials and its card; the IMAP client and the four
// tool definitions come from `_imap.js` beside it (the registry skips underscore files).
// `mode: 'imap'` is the framework's non-HTTP mail mode: the card asks for the address and
// the code, `verify` checks them once when they are saved, and `mount` answers the tools.
import { createImapTools, signInImap } from './_imap.js'

export const QQMAIL_ID = 'qqmail'
export const QQMAIL_HOST = 'imap.qq.com'
export const QQMAIL_ADDRESS_SECRET = 'QQMAIL_ADDRESS'
export const QQMAIL_SECRET = 'QQMAIL_AUTH_CODE'
export const QQMAIL_TOOLS = ['qqmail_list_folders', 'qqmail_search', 'qqmail_list_messages', 'qqmail_get_message']

// `signInQQMail` accepts both shapes: one `address:code` string (the card's older form) or
// a stored code beside the stored address (what the two credential fields keep). The code
// itself never leaves the DSH credential store; the team file keeps only the address.
export function signInQQMail(credential, options = {}) {
  return signInImap(credential, { host: QQMAIL_HOST, ...options })
}

export function createQQMailTools({ credential, account, redact, connect, timeoutMs, connectTimeoutMs } = {}) {
  return createImapTools({
    id: QQMAIL_ID,
    displayName: 'QQ Mail',
    host: QQMAIL_HOST,
    credential,
    account,
    redact,
    connect,
    timeoutMs,
    connectTimeoutMs,
  })
}

export default {
  id: QQMAIL_ID,
  displayName: 'QQ Mail',
  mode: 'imap',
  // Two named credentials, so the code is saved on its own instead of inside one pasted
  // string: the address names the mailbox, the code is the secret.
  credentials: [
    { name: QQMAIL_ADDRESS_SECRET, label: 'QQ Mail address' },
    { name: QQMAIL_SECRET, label: 'Authorization code' },
  ],
  accountField: 'account',
  readOnly: true,
  glyph: 'qqmail',
  about: 'Read your QQ Mail inbox over IMAP: list folders, search, and read messages. Sending is not part of this connector.',
  readOnlyNote: 'Read-only: opens the mailbox with EXAMINE and fetches bodies with BODY.PEEK, so reading a mail here never marks it as read. It never sends, deletes or moves a message.',
  docsUrl: 'https://service.mail.qq.com/',
  // Checked once, when the card saves the credentials: a login that opens INBOX read-only.
  // The address comes from the first field; only the code is a secret. The framework hands
  // the saved form over as `secrets`; `values` is accepted too so a caller may pass either.
  verify: async ({ secrets, values }) => {
    const fields = secrets ?? values ?? {}
    const { mailbox } = await signInQQMail(fields[QQMAIL_SECRET], { account: { mailbox: fields[QQMAIL_ADDRESS_SECRET] } })
    return { account: mailbox }
  },
  // The mount is lazy: the tools open (and reopen) the connection on their first call, so a
  // plugin start does not log in to every mailbox before it is used.
  mount: ({ secrets, redact }) => createQQMailTools({
    credential: secrets[QQMAIL_SECRET],
    account: { mailbox: secrets[QQMAIL_ADDRESS_SECRET] },
    redact,
  }),
}
