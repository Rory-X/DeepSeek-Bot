// Dumps the Gmail connector's mounted tool surface as JSON, generated from the real module
// rather than written by hand: the acceptance pass diffs it against the spec and against
// its own mount. Run from the repository root:
//
//   node docs/acceptance/dump-gmail-tools.mjs > docs/acceptance/gmail-tools-registry.json
//
// The mount is given stub credentials and a stub approval hook so the tool definitions can
// be built without a mailbox; nothing connects.
import gmail from '../../ds-bot/src/host/connectors/gmail.js'

const secrets = { GMAIL_ADDRESS: 'you@gmail.com', GMAIL_APP_PASSWORD: 'app-password' }
const approve = async () => {}
const mountAt = (level) => {
  const mounted = gmail.mount({ secrets, redact: String, level, approve })
  return mounted.tools.map(tool => ({ name: tool.name, description: tool.description }))
}

const read = mountAt('read')
const write = mountAt('write')

process.stdout.write(`${JSON.stringify({
  levels: { default: gmail.defaultLevel, available: gmail.levels },
  tiers: { read, write },
  unregistered: [
    // Saving an attachment to disk waits for a path policy.
    'gmail_save_attachment',
    // Never this connector: permanent delete, batch delete, draft sending, settings.
    'gmail_delete_permanent',
    'gmail_empty_trash',
    'gmail_delete_many',
    'gmail_batch_delete',
    'gmail_send_draft',
    'gmail_settings',
    'gmail_set_auto_forward',
    'gmail_create_filter',
    'gmail_set_signature',
  ],
}, null, 2)}\n`)
