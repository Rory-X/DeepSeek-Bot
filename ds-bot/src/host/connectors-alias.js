// Read-tool aliases for the bridge. During P2 the old six connectors still run on the
// fork host; the alias table is the contract P3 mounts on the upstream gateway: every old
// `github_*` read name maps to its upstream MCP tool, and Gmail/QQ reads stay on the
// `_imap` shim (they have no upstream mail equivalent for folders/attachments).
import { READ_TOOLS } from './connectors/github.js'
import { GMAIL_TOOLS } from './connectors/gmail.js'
import { NEON_READ_TOOLS } from './connectors/neon.js'
import { QQMAIL_TOOLS } from './connectors/qqmail.js'
import { CLOUDFLARE_READ_TOOLS, VERCEL_READ_TOOLS } from './connectors.js'

export const READ_ALIASES = Object.freeze({
  github: READ_TOOLS.map(name => ({ old: `github_${name}`, connector: 'github', tool: name, kind: 'mcp' })),
  vercel: VERCEL_READ_TOOLS.map(name => ({ old: `vercel_${name}`, connector: 'vercel', tool: name, kind: 'mcp' })),
  cloudflare: CLOUDFLARE_READ_TOOLS.map(name => ({ old: `cloudflare_${name}`, connector: 'cloudflare', tool: name, kind: 'mcp' })),
  neon: NEON_READ_TOOLS.map(name => ({ old: `neon_${name}`, connector: 'neon', tool: name, kind: 'mcp' })),
  gmail: GMAIL_TOOLS.map(name => ({ old: name, connector: 'gmail', tool: name, kind: 'mail-shim' })),
  qqmail: QQMAIL_TOOLS.map(name => ({ old: name, connector: 'qqmail', tool: name, kind: 'mail-shim' })),
})

export function readAliases(id) {
  return READ_ALIASES[id] ?? []
}

export function isReadAlias(id, name) {
  return readAliases(id).some(alias => alias.old === name)
}
