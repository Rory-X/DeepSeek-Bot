import assert from 'node:assert/strict'
import { test } from 'node:test'
import { READ_ALIASES, isReadAlias, readAliases } from '../src/host/connectors-alias.js'
import { READ_TOOLS } from '../src/host/connectors/github.js'

test('the GitHub read aliases keep every old read name and its upstream tool', () => {
  assert.equal(READ_ALIASES.github.length, READ_TOOLS.length)
  for (const name of READ_TOOLS) assert.equal(isReadAlias('github', `github_${name}`), true)
  assert.deepEqual(readAliases('github')[0], { old: `github_${READ_TOOLS[0]}`, connector: 'github', tool: READ_TOOLS[0], kind: 'mcp' })
  assert.ok(readAliases('vercel').length > 0)
  assert.ok(readAliases('cloudflare').length > 0)
  assert.ok(readAliases('neon').length > 0)
  assert.ok(readAliases('gmail').every(alias => alias.kind === 'mail-shim'))
  assert.ok(readAliases('qqmail').every(alias => alias.kind === 'mail-shim'))
})
