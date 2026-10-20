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
// The read tools are read-only by construction: the shared core opens a mailbox with
// EXAMINE, fetches with BODY.PEEK, and has no STORE, APPEND, COPY, MOVE or EXPUNGE. The
// send tools come from the shared SMTP helper and exist only at the write level, where the
// framework's approval hook is available; every send asks before a connection is opened.
import { createImapTools, signInImap } from './_imap.js'
import { createSmtpTools } from './_smtp.js'

export const GMAIL_ID = 'gmail'
export const GMAIL_HOST = 'imap.gmail.com'
export const GMAIL_ADDRESS_SECRET = 'GMAIL_ADDRESS'
export const GMAIL_APP_PASSWORD_SECRET = 'GMAIL_APP_PASSWORD'
// The four tools the shared core builds for `<id>`. Kept here so the card, the tests and
// the declaration for QA name the same list.
export const GMAIL_TOOLS = ['gmail_list_folders', 'gmail_search', 'gmail_list_messages', 'gmail_get_message']
// The tools the write level adds from the shared SMTP helper. The IMAP write tools
// (mark, move, trash, save draft) arrive with the shared IMAP write session.
export const GMAIL_SEND_TOOLS = ['gmail_send_email', 'gmail_reply_email', 'gmail_forward_email']
export const GMAIL_SMTP = { host: 'smtp.gmail.com', port: 465 }

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
  // Read is the default; the user opts into write on the card, and every write or send is
  // still gated by the per-call approval card.
  levels: ['read', 'write'],
  defaultLevel: 'read',
  readOnly: true,
  // The client draws a connector's card from `card` only: the same fields at the module's
  // top level are carried to the view but no longer read, so the card would show a name and
  // a Connect button with no explanation.
  card: {
    glyph: 'gmail',
    about: 'Read, search and manage your Gmail over IMAP. Write and send tools need full capabilities, and each call asks for approval first.',
    readOnlyNote: 'At the default read level nothing changes: mail is opened read-only and fetched with BODY.PEEK. Full capabilities adds write and send tools; every one asks first, and sending cannot be undone.',
    docsUrl: 'https://myaccount.google.com/apppasswords',
  },
  // Display only: the client draws this operation list by risk. The real boundary is the
  // mounted tool list, which the framework keeps empty at the read level.
  capabilities: [
    { key: 'read_mail', title: 'Read and search mail', description: 'List folders, search messages and read them without changing anything.', risk: 'read' },
    { key: 'send_mail', title: 'Send, reply and forward', description: 'Send mail as you, to at most 20 recipients per message; a send cannot be undone.', risk: 'destructive', preview: { change: 'Sends a message from your account', reversible: false } },
  ],
  permissions: { summary: 'Reads your mail. With full capabilities it can mark, label, archive, draft, move and trash mail, and send from your address.' },
  // The framework mounts the shared IMAP write tools and the shared SMTP tools at the
  // write level when a module opts in; the read tools stay in this module's mount.
  imap: { host: GMAIL_HOST, port: 993, mailbox: 'INBOX', gmail: true, write: true },
  smtp: { host: 'smtp.gmail.com', port: 465 },
  // Checked once, when the card saves the credentials: a login that opens INBOX read-only.
  // The framework hands the saved form over as `secrets`; `values` is accepted too so a
  // caller may pass either.
  verify: async ({ secrets, values }) => {
    const fields = secrets ?? values ?? {}
    const { mailbox } = await signInGmail(fields[GMAIL_APP_PASSWORD_SECRET], { account: { mailbox: fields[GMAIL_ADDRESS_SECRET] } })
    return { account: mailbox }
  },
  // The mount is lazy: the tools open (and reopen) the connection on their first call, so a
  // plugin start does not log in to the mailbox before it is used. The framework passes the
  // access level and the approval hook; the send tools exist only at the write level and
  // only when the hook is there, because a send without it could not ask first.
  mount: ({ secrets, redact, level, approve, state, connect } = {}) => {
    const levelNow = level ?? state?.level ?? 'read'
    const read = createGmailTools({
      credential: secrets[GMAIL_APP_PASSWORD_SECRET],
      account: { mailbox: secrets[GMAIL_ADDRESS_SECRET] },
      redact,
    })
    if (levelNow !== 'write' || typeof approve !== 'function') return read
    const send = createSmtpTools({
      id: GMAIL_ID,
      displayName: 'Gmail',
      credential: secrets[GMAIL_APP_PASSWORD_SECRET],
      account: { mailbox: secrets[GMAIL_ADDRESS_SECRET] },
      smtp: GMAIL_SMTP,
      redact,
      approve,
      ...(connect === undefined ? {} : { connect }),
    })
    return { tools: [...read.tools, ...send], close: read.close }
  },
}
