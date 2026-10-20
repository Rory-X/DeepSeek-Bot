// Gmail, read-only, over IMAP. Gmail's own remote MCP server needs a Google Cloud OAuth
// client and the Workspace Developer Preview, so this connector takes the other road: the
// user turns on 2-Step Verification, creates an app password, and the card saves the
// mailbox address and that password as two named credentials. The password only reaches
// Gmail's IMAP server, through node:tls, from the host; it never enters a shell.
//
// The module names Gmail's server, its credentials and its card; the IMAP client and the
// four tool definitions come from the shared `_imap.js` beside it (the registry skips
// underscore files). `mode: 'imap'` is the framework's non-HTTP mail mode: the card asks
// for the address and the app password, `verify` checks them once when they are saved, and
// `mount` answers the tools.
//
// Read-only is a property of the shared core, not of this file: it opens a mailbox with
// EXAMINE, fetches with BODY.PEEK, and has no STORE, APPEND, COPY, MOVE or EXPUNGE.
import { createImapTools, signInImap } from './_imap.js'

export const GMAIL_ID = 'gmail'
export const GMAIL_HOST = 'imap.gmail.com'
export const GMAIL_ADDRESS_SECRET = 'GMAIL_ADDRESS'
export const GMAIL_APP_PASSWORD_SECRET = 'GMAIL_APP_PASSWORD'
// The four tools the shared core builds for `<id>`. Kept here so the card, the tests and
// the declaration for QA name the same list.
export const GMAIL_TOOLS = ['gmail_list_folders', 'gmail_search', 'gmail_list_messages', 'gmail_get_message']

// A connect-time check: the address and app password log in and INBOX opens read-only.
// The shared core accepts the older one-string `address:secret` form too, which is what
// the helper's own tests cover.
export function signInGmail(credential, options = {}) {
  return signInImap(credential, { host: GMAIL_HOST, ...options })
}

export function createGmailTools({ credential, account, redact, connect, timeoutMs, connectTimeoutMs } = {}) {
  return createImapTools({
    id: GMAIL_ID,
    displayName: 'Gmail',
    host: GMAIL_HOST,
    credential,
    account,
    redact,
    connect,
    timeoutMs,
    connectTimeoutMs,
    // Gmail understands its own search syntax through X-GM-RAW; the shared core offers the
    // `query` argument and the raw search key only when a connector asks for them.
    gmailQuery: true,
  })
}

export default {
  id: GMAIL_ID,
  displayName: 'Gmail',
  mode: 'imap',
  // Two named credentials, so the app password is saved on its own instead of inside one
  // pasted string: the address names the mailbox, the app password is the secret.
  credentials: [
    { name: GMAIL_ADDRESS_SECRET, label: 'Gmail address' },
    { name: GMAIL_APP_PASSWORD_SECRET, label: 'App password' },
  ],
  accountField: 'account',
  readOnly: true,
  // The client draws a connector's card from `card` only: the same fields at the module's
  // top level are carried to the view but no longer read, so the card would show a name and
  // a Connect button with no explanation.
  card: {
    glyph: 'gmail',
    about: 'Read your Gmail over IMAP: list folders, search, and read messages. Sending is not part of this connector.',
    readOnlyNote: 'Read-only: opens the mailbox with EXAMINE and fetches bodies with BODY.PEEK, so reading a mail here never marks it as read. It never sends, deletes or moves a message.',
    docsUrl: 'https://myaccount.google.com/apppasswords',
  },
  // Checked once, when the card saves the credentials: a login that opens INBOX read-only.
  // The framework hands the saved form over as `secrets`; `values` is accepted too so a
  // caller may pass either.
  verify: async ({ secrets, values }) => {
    const fields = secrets ?? values ?? {}
    const { mailbox } = await signInGmail(fields[GMAIL_APP_PASSWORD_SECRET], { account: { mailbox: fields[GMAIL_ADDRESS_SECRET] } })
    return { account: mailbox }
  },
  // The mount is lazy: the tools open (and reopen) the connection on their first call, so a
  // plugin start does not log in to the mailbox before it is used.
  mount: ({ secrets, redact }) => createGmailTools({
    credential: secrets[GMAIL_APP_PASSWORD_SECRET],
    account: { mailbox: secrets[GMAIL_ADDRESS_SECRET] },
    redact,
  }),
}
