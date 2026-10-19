import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CONNECTOR_ID, CONNECTOR_MODES, externalConnectors, loadConnectorModules } from '../src/host/connectors/registry.js'

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
  assert.deepEqual(CONNECTOR_MODES, ['mcp-client', 'read-tools', 'oauth-mcp', 'notify', 'rest-tools'])
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
