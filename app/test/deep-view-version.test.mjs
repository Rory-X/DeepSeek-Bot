import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The app declares deep-view for its own runtime; ds-bot vendors its copy under
// vendor/deep-view. The app's version must track the vendored copy.
test('the app carries the vendored deep-view version', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const vendored = JSON.parse(readFileSync(join(root, '..', 'ds-bot', 'vendor', 'deep-view', 'package.json'), 'utf8'))
  assert.equal(app.dependencies['deep-view'], vendored.version)
})
