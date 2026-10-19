import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness')
const requireHarness = createRequire(join(harness, 'package.json'))
const { JSDOM } = requireHarness('jsdom')

const { outputFiles } = await build({
  stdin: {
    contents: "export { installViewport } from './src/client/platform.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
})

// The module in a real document: the metas it reads and writes are the page's own.
const page = (html) => {
  const { window } = new JSDOM(html)
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    document: window.document, MutationObserver: window.MutationObserver, navigator: window.navigator,
  })
  return { window, installViewport: module.exports.installViewport }
}

test('the viewport meta gains viewport-fit without losing the shell\'s own settings', () => {
  const { window, installViewport } = page('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>')
  const viewport = installViewport()
  assert.equal(
    window.document.querySelector('meta[name="viewport"]').getAttribute('content'),
    'width=device-width, initial-scale=1,viewport-fit=cover')
  // A second install on the same page must not stack the flag.
  const again = installViewport()
  assert.equal(
    window.document.querySelector('meta[name="viewport"]').getAttribute('content'),
    'width=device-width, initial-scale=1,viewport-fit=cover')
  again.dispose()
  viewport.dispose()
})

test('a page with no viewport meta still gets a theme colour', () => {
  const { window, installViewport } = page('<!doctype html><html><head></head><body></body></html>')
  const viewport = installViewport()
  assert.equal(window.document.querySelector('meta[name="viewport"]'), null)
  const meta = window.document.querySelector('meta[name="theme-color"]')
  assert.ok(meta, 'the browser gets a colour to paint its chrome with')
  // The theme is what fills it in; until then it stays unset rather than guessing.
  assert.equal(meta.getAttribute('content'), null)
  viewport.theme({ light: '#faf9f5', dark: '#1f1e1b' })
  assert.equal(meta.getAttribute('content'), '#faf9f5')
  viewport.dispose()
})

test('the theme colour follows the theme and the browser\'s dark marker', async () => {
  const { window, installViewport } = page('<!doctype html><html><head></head><body></body></html>')
  const viewport = installViewport()
  const meta = window.document.querySelector('meta[name="theme-color"]')
  viewport.theme({ light: '#faf9f5', dark: '#1f1e1b' })
  assert.equal(meta.getAttribute('content'), '#faf9f5')
  window.document.body.setAttribute('data-ds-dark-theme', '')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(meta.getAttribute('content'), '#1f1e1b')
  window.document.body.removeAttribute('data-ds-dark-theme')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(meta.getAttribute('content'), '#faf9f5')
  viewport.dispose()
})
