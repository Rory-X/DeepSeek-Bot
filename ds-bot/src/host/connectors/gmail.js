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
import { createImapTools, createImapWriteTools, signInImap } from './_imap.js'
import { createSmtpTools } from './_smtp.js'

export const GMAIL_ID = 'gmail'
export const GMAIL_HOST = 'imap.gmail.com'
export const GMAIL_ADDRESS_SECRET = 'GMAIL_ADDRESS'
export const GMAIL_APP_PASSWORD_SECRET = 'GMAIL_APP_PASSWORD'
// The four tools the shared core builds for `<id>`. Kept here so the card, the tests and
// the declaration for QA name the same list.
export const GMAIL_TOOLS = [
  'gmail_list_folders',
  'gmail_search',
  'gmail_list_messages',
  'gmail_get_message',
  'gmail_list_attachments',
  'gmail_read_attachment',
]
// What the write level adds: the shared IMAP write session's mailbox tools and the shared
// SMTP helper's send tools. Labels and archive wait for the shared core's label extension;
// sending a draft is not part of this round.
export const GMAIL_WRITE_TOOLS = [
  'gmail_mark_read',
  'gmail_mark_unread',
  'gmail_move_messages',
  'gmail_delete_messages',
  'gmail_save_draft',
  'gmail_add_labels',
  'gmail_remove_labels',
  'gmail_archive',
]
export const GMAIL_SEND_TOOLS = ['gmail_send_email', 'gmail_reply_email', 'gmail_forward_email']
export const GMAIL_SMTP = { host: 'smtp.gmail.com', port: 465 }
// What the card shows beside the line for each write: what changes and whether it can be
// undone. The framework writes these onto the approval question; a send is the one that
// cannot be undone. Tools not listed get the line and danger only.
const GMAIL_APPROVAL_PREVIEW = {
  mark_read: { change: 'Changes the read flag only', reversible: true },
  mark_unread: { change: 'Changes the read flag only', reversible: true },
  add_labels: { change: 'Only the named labels are added', reversible: true },
  remove_labels: { change: 'Only the named labels are removed', reversible: true },
  archive: { change: 'Removes the inbox label and keeps the message', reversible: true },
  move_messages: { change: 'Moves messages between folders', reversible: true },
  delete_messages: { change: 'Deletes messages; the default path keeps them restorable', reversible: true },
  save_draft: { change: 'Creates a draft, sends nothing', reversible: true },
  send_email: { change: 'Sends a message from your account', reversible: false },
  reply_email: { change: 'Sends a reply from your account', reversible: false },
  forward_email: { change: 'Sends a message from your account', reversible: false },
}

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
    // Attachment list and text read are read-only tools and need no approval.
    attachments: true,
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
    { key: 'read_attachments', title: 'Read attachments', description: 'List the attachments of a message and read the text of one, up to 20000 characters; binary attachments are named by type and size only.', risk: 'read' },
    { key: 'mark_read', title: 'Mark mail read or unread', description: 'Change the read flag of up to 10 messages per call.', risk: 'write', preview: { change: 'Changes the read flag only', reversible: true } },
    { key: 'label_mail', title: 'Add or remove labels', description: 'Apply existing labels to up to 10 messages per call; labels are never created.', risk: 'write', preview: { change: 'Only the named labels change', reversible: true } },
    { key: 'archive_mail', title: 'Archive mail', description: 'Remove up to 10 messages from the inbox and keep them in All Mail.', risk: 'write', preview: { change: 'Removes the inbox label', reversible: true } },
    { key: 'save_draft', title: 'Save drafts', description: 'Store a draft in Gmail without sending it.', risk: 'write', preview: { change: 'Creates a draft, sends nothing', reversible: true } },
    { key: 'move_mail', title: 'Move mail', description: 'Move up to 10 messages to another folder.', risk: 'write', preview: { change: 'Moves messages between folders', reversible: true } },
    { key: 'delete_mail', title: 'Delete mail', description: 'Delete up to 10 messages per call, or permanently when the call asks for it.', risk: 'destructive', preview: { change: 'Deletes messages', reversible: true } },
    { key: 'send_mail', title: 'Send, reply and forward', description: 'Send mail as you, to at most 20 recipients per message; a send cannot be undone.', risk: 'destructive', preview: { change: 'Sends a message from your account', reversible: false } },
  ],
  permissions: { summary: 'Reads your mail and attachments. With full capabilities it can mark, label, archive, move and trash mail, save drafts, and send from your address.' },
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
    const credential = secrets[GMAIL_APP_PASSWORD_SECRET]
    const account = { mailbox: secrets[GMAIL_ADDRESS_SECRET] }
    const read = createGmailTools({ credential, account, redact })
    if (levelNow !== 'write' || typeof approve !== 'function') return read
    // The helpers know their line and danger; this module supplies the preview fields the
    // card needs (what changes, and whether the call can be undone).
    const approveWrite = (request) => {
      const key = String(request?.tool ?? '').replace(/^gmail_/, '')
      const preview = GMAIL_APPROVAL_PREVIEW[key] ?? {}
      const permanent = key === 'delete_messages' && request?.danger === true
      return approve({ ...request, ...preview, ...(permanent ? { change: 'Deletes messages for good', reversible: false } : {}) })
    }
    const mailbox = createImapWriteTools({
      id: GMAIL_ID,
      displayName: 'Gmail',
      credential,
      account,
      host: GMAIL_HOST,
      port: 993,
      redact,
      gmailLabels: true,
      approve: approveWrite,
      ...(connect === undefined ? {} : { connect }),
    })
    const send = createSmtpTools({
      id: GMAIL_ID,
      displayName: 'Gmail',
      credential,
      account,
      smtp: GMAIL_SMTP,
      redact,
      approve: approveWrite,
      ...(connect === undefined ? {} : { connect }),
    })
    return { tools: [...read.tools, ...mailbox, ...send], close: read.close }
  },
}
