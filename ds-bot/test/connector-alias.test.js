import assert from 'node:assert/strict'
import { test } from 'node:test'
import { READ_ALIASES, WRITE_ALIASES, isReadAlias, isWriteAlias, legacyLevelOf, readAliases, writeAliases } from '../src/host/connectors-alias.js'
import { ACTION_TOOLS, READ_TOOLS } from '../src/host/connectors/github.js'
import { NEON_READ_TOOLS, NEON_WRITE_TOOLS } from '../src/host/connectors/neon.js'

test('the GitHub read aliases keep every old read name and its upstream tool', () => {
  assert.equal(READ_ALIASES.github.length, READ_TOOLS.length)
  for (const name of READ_TOOLS) {
    assert.equal(isReadAlias('github', `github_${name}`), true)
    assert.equal(isWriteAlias('github', `github_${name}`), false)
  }
  assert.deepEqual(readAliases('github')[0], { old: `github_${READ_TOOLS[0]}`, connector: 'github', tool: READ_TOOLS[0], kind: 'mcp' })
  assert.ok(readAliases('vercel').length > 0)
  assert.ok(readAliases('cloudflare').length > 0)
  assert.ok(readAliases('neon').length > 0)
  assert.ok(readAliases('gmail').every(alias => alias.kind === 'mail-shim'))
  assert.ok(readAliases('qqmail').every(alias => alias.kind === 'mail-shim'))
  assert.ok(writeAliases('gmail').some(alias => alias.old === 'gmail_send_email' && alias.write === true))
  assert.ok(writeAliases('qqmail').some(alias => alias.old === 'qqmail_delete_messages' && alias.write === true))
})

test('the GitHub write aliases keep every old action name', () => {
  assert.equal(WRITE_ALIASES.github.length, ACTION_TOOLS.length)
  for (const name of ACTION_TOOLS) {
    assert.equal(isWriteAlias('github', `github_${name}`), true)
    assert.deepEqual(writeAliases('github').find(alias => alias.old === `github_${name}`), { old: `github_${name}`, connector: 'github', tool: name, kind: 'mcp', write: true })
  }
})

test('Neon aliases keep the instance prefix on every tool name', () => {
  assert.equal(readAliases('neon-2').length, NEON_READ_TOOLS.length)
  assert.ok(readAliases('neon-2').every(alias => alias.old.startsWith('neon-2_')))
  assert.deepEqual(writeAliases('neon-3').map(alias => alias.old), NEON_WRITE_TOOLS.map(name => `neon-3_${name}`))
  assert.equal(writeAliases('neon').length, NEON_WRITE_TOOLS.length)
})

test('the legacy level follows the upstream switch, then the old level fields', () => {
  assert.equal(legacyLevelOf({ connectors: { github: { level: 'write', legacy: { level: 'read' } } } }, 'github'), 'write')
  assert.equal(legacyLevelOf({ connectors: { github: { legacy: { level: 'read' } } } }, 'github'), 'read')
  assert.equal(legacyLevelOf({ connectors: { github: { level: 'write' } } }, 'github'), 'write')
  assert.equal(legacyLevelOf({ connectors: { github: { readOnly: true } } }, 'github'), 'read')
  assert.equal(legacyLevelOf({ connectors: { github: { readOnly: false } } }, 'github'), 'write')
  assert.equal(legacyLevelOf({ connectors: { github: { level: 'read', readOnly: false } } }, 'github'), 'write')
  assert.equal(legacyLevelOf({ connectors: {} }, 'github'), 'read')
})
