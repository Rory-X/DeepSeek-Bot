import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CONNECTOR_ID, CONNECTOR_MODES, INSTANCE_LIMIT, externalConnectors, loadConnectorModules } from '../src/host/connectors/registry.js'

// Each case writes its own directory: a module URL is cached for the process, so a reused
// path would hand back the first module even after the file changed.
const withModules = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-connector-registry-'))
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) }
}

const VALID = `export default { id: 'demo', displayName: 'Demo', mode: 'read-tools', api: 'https://demo.test' }\n`

test('connector modules are keyed by id and sorted by file name', async () => {
  const { dir, cleanup } = withModules({
    'zeta.js': `export default { id: 'alpha', displayName: 'Alpha', mode: 'mcp-client' }\n`,
    'alpha.js': `export default { id: 'zeta', displayName: 'Zeta', mode: 'rest-tools', api: 'https://z.test' }\n`,
    'middle.js': `export const connector = { id: 'middle', displayName: 'Middle', mode: 'notify' }\n`,
  })
  try {
    const loaded = await loadConnectorModules(dir)
    assert.deepEqual(Object.keys(loaded), ['zeta', 'middle', 'alpha'])
    assert.deepEqual(loaded.zeta, { displayName: 'Zeta', mode: 'rest-tools', api: 'https://z.test' })
    assert.equal(loaded.middle.displayName, 'Middle')
  } finally {
    cleanup()
  }
})

test('this plugin ships no external connector modules yet', () => {
  assert.equal(typeof externalConnectors, 'object')
  assert.equal(Array.isArray(externalConnectors), false)
  assert.ok(CONNECTOR_ID instanceof RegExp)
  assert.deepEqual(CONNECTOR_MODES, ['mcp-client', 'read-tools', 'oauth-mcp', 'notify', 'rest-tools', 'imap', 'imap-read', 'custom'])
})

test('display-only capability descriptions are kept for the view', async () => {
  const { dir, cleanup } = withModules({
    'shiny.js': `export default { id: 'shiny', displayName: 'Shiny', mode: 'custom', capabilities: [{ key: 'deploy', title: 'Deploy', description: 'Ship a build', risk: 'write', preview: { target: 'project', change: 'a deployment', reversible: true } }], permissions: { summary: 'Read a project and ship a build.', scopes: ['read', 'write'] } }\n`,
  })
  try {
    const loaded = await loadConnectorModules(dir)
    assert.equal(loaded.shiny.capabilities[0].risk, 'write')
    assert.deepEqual(loaded.shiny.permissions.scopes, ['read', 'write'])
  } finally {
    cleanup()
  }
})

test('helpers and tests beside a connector are not loaded', async () => {
  const { dir, cleanup } = withModules({
    '_helper.js': `export default { id: 'hidden', displayName: 'Hidden', mode: 'notify' }\n`,
    'demo.test.js': `export default { id: 'alsohidden', displayName: 'Hidden', mode: 'notify' }\n`,
    'registry.js': `export default { id: 'registry', displayName: 'Registry', mode: 'notify' }\n`,
    'demo.js': VALID,
  })
  try {
    assert.deepEqual(Object.keys(await loadConnectorModules(dir)), ['demo'])
  } finally {
    cleanup()
  }
})

test('a broken connector module fails at load with the file name', async () => {
  const cases = [
    [`export default { id: 'bad id', displayName: 'Bad', mode: 'notify' }\n`, /needs an id matching/],
    [`export default { id: 'nodisplay', mode: 'notify' }\n`, /needs a displayName/],
    [`export default { id: 'nomode', displayName: 'No mode' }\n`, /needs a mode/],
    [`export default { id: 'unknown', displayName: 'Unknown', mode: 'proxy' }\n`, /needs a mode/],
    [`export default { id: 'notlevels', displayName: 'L', mode: 'rest-tools', levels: 'read' }\n`, /levels must be a non-empty list/],
    [`export default { id: 'badlevel', displayName: 'L', mode: 'rest-tools', levels: ['admin'] }\n`, /levels must be a non-empty list/],
    [`export default { id: 'dupelevel', displayName: 'L', mode: 'rest-tools', levels: ['read', 'read'] }\n`, /levels must be a non-empty list/],
    [`export default { id: 'baddefault', displayName: 'L', mode: 'rest-tools', levels: ['read'], defaultLevel: 'write' }\n`, /defaultLevel/],
    [`export default { id: 'badhook', displayName: 'L', mode: 'rest-tools', authorize: 'nope' }\n`, /needs authorize to be a function/],
    [`export default { id: 'badsettings', displayName: 'L', mode: 'rest-tools', settings: [{ label: 'x' }] }\n`, /settings must list fields with a name/],
    [`export default { id: 'badcaps', displayName: 'C', mode: 'rest-tools', capabilities: 'all' }\n`, /capabilities must be a list/],
    [`export default { id: 'badrisk', displayName: 'C', mode: 'rest-tools', capabilities: [{ key: 'k', title: 'T', risk: 'maybe' }] }\n`, /risk of read, write, destructive/],
    [`export default { id: 'badperm', displayName: 'C', mode: 'rest-tools', permissions: { summary: '' } }\n`, /permissions need a summary/],
    [`export default 42\n`, /must export a connector object/],
    [`export default { id: 'boom', displayName: 'Boom', mode: 'notify', api: foo }\n`, /did not load/],
  ]
  for (const [source, pattern] of cases) {
    const { dir, cleanup } = withModules({ 'broken.js': source })
    try {
      await assert.rejects(loadConnectorModules(dir), pattern, source)
    } finally {
      cleanup()
    }
  }
})

test('two modules may not claim the same id', async () => {
  const { dir, cleanup } = withModules({
    'one.js': `export default { id: 'same', displayName: 'One', mode: 'notify' }\n`,
    'two.js': `export default { id: 'same', displayName: 'Two', mode: 'notify' }\n`,
  })
  try {
    await assert.rejects(loadConnectorModules(dir), /repeats the id "same"/)
  } finally {
    cleanup()
  }
})

test('a multi-instance declaration is kept and defaulted', async () => {
  const { dir, cleanup } = withModules({
    'neon.js': `export default { id: 'neon', displayName: 'Neon', mode: 'oauth-mcp', instances: { prefix: 'neon', min: 1, max: 8 }, mcpUrl: 'https://neon.test/mcp', oauth: { scopes: ['read'] } }\n`,
    'bare.js': `export default { id: 'bare', displayName: 'Bare', mode: 'oauth-mcp', instances: {}, mcpUrl: 'https://bare.test/mcp', oauth: { scopes: ['read'] } }\n`,
    'plain.js': `export default { id: 'plain', displayName: 'Plain', mode: 'oauth-mcp', mcpUrl: 'https://plain.test/mcp', oauth: { scopes: ['read'] } }\n`,
  })
  try {
    const loaded = await loadConnectorModules(dir)
    assert.deepEqual(loaded.neon.instances, { prefix: 'neon', min: 1, max: 8 })
    assert.deepEqual(loaded.bare.instances, { prefix: 'bare', min: 1, max: 8 })
    // A module without the declaration is one instance, and keeps no instances field.
    assert.equal('instances' in loaded.plain, false)
  } finally {
    cleanup()
  }
})

test('a broken multi-instance declaration fails at load with the file name', async () => {
  const cases = [
    [`instances: 'all'`, /instances must be an object/],
    [`instances: { prefix: 'other' }`, /prefix must be the module id/],
    [`instances: { prefix: 'Bad Prefix' }`, /prefix matching/],
    [`instances: { min: 0 }`, /min of at least 1/],
    [`instances: { min: 3, max: 2 }`, /max from 3 to/],
    [`instances: { max: ${INSTANCE_LIMIT + 1} }`, /max from 1 to/],
    [`instances: { max: 2.5 }`, /max from 1 to/],
    [`id: 'a'.repeat(39), instances: {}`, /short enough for a "-2" instance/],
  ]
  for (const [fragment, pattern] of cases) {
    const source = fragment.startsWith('instances:')
      ? `export default { id: 'demo', displayName: 'Demo', mode: 'oauth-mcp', mcpUrl: 'https://demo.test/mcp', oauth: { scopes: ['read'] }, ${fragment} }\n`
      : `export default { displayName: 'Demo', mode: 'oauth-mcp', mcpUrl: 'https://demo.test/mcp', oauth: { scopes: ['read'] }, ${fragment} }\n`
    const { dir, cleanup } = withModules({ 'broken.js': source })
    try {
      await assert.rejects(loadConnectorModules(dir), pattern, source)
    } finally {
      cleanup()
    }
  }
})

test('only OAuth connectors can be instances', async () => {
  const { dir, cleanup } = withModules({
    'demo.js': `export default { id: 'demo', displayName: 'Demo', mode: 'rest-tools', api: 'https://demo.test', instances: {} }\n`,
  })
  try {
    await assert.rejects(loadConnectorModules(dir), /per-instance credentials: oauth-mcp/)
  } finally {
    cleanup()
  }
})

test('a module id may not take the id another module reserves for an instance', async () => {
  const { dir, cleanup } = withModules({
    'neon.js': `export default { id: 'neon', displayName: 'Neon', mode: 'oauth-mcp', instances: { prefix: 'neon', min: 1, max: 8 }, mcpUrl: 'https://neon.test/mcp', oauth: { scopes: ['read'] } }\n`,
    'second.js': `export default { id: 'neon-2', displayName: 'Second', mode: 'oauth-mcp', mcpUrl: 'https://second.test/mcp', oauth: { scopes: ['read'] } }\n`,
  })
  try {
    await assert.rejects(loadConnectorModules(dir), /"neon-2" is reserved for instances of "neon"/)
  } finally {
    cleanup()
  }
})
