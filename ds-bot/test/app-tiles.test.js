import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// The app tiles (the two-column rows of services a settings page lists) came with
// upstream's connectors page, which this fork does not ship. The IM page is built from
// those classes, so the base styles live in app-tiles.js and must reach every panel.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const loadCss = async () => {
  const { outputFiles } = await build({
    stdin: { contents: "export { APP_TILE_CSS } from './src/client/app-tiles.js'", resolveDir: PLUGIN },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  new Function('module', 'exports', 'require', outputFiles[0].text)(module, module.exports, () => ({}))
  return module.exports.APP_TILE_CSS
}

// Every class a JSX className literal asks for, template holes removed.
const classNamesOf = (source) => {
  const names = new Set()
  for (const match of source.matchAll(/className\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g)) {
    const text = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, ' ')
    for (const name of text.match(/\bbt-[a-z0-9-]+\b/g) ?? []) names.add(name)
  }
  return names
}

const APP_TILE_CSS = await loadCss()

test('the app-tile base styles define every class the IM page builds its cards from', () => {
  const imPage = readFileSync(join(PLUGIN, 'src/client/im-page.js'), 'utf8')
  const tiles = [...classNamesOf(imPage)].filter(name => name.startsWith('bt-app'))
  assert.ok(tiles.length >= 8, `expected the IM page to use the tile classes, saw ${tiles.length}`)
  for (const name of tiles) {
    assert.ok(APP_TILE_CSS.includes(`.${name}`), `.${name} has no rule in APP_TILE_CSS`)
  }
})

test('the tile base carries the layout, button and icon rules, not just the names', () => {
  // Two columns when the tiles have room, one when the panel is narrow.
  assert.match(APP_TILE_CSS, /\.bt-apps\{display:flex;flex-direction:column;gap:14px;container-type:inline-size\}/)
  assert.match(APP_TILE_CSS, /\.bt-app-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
  assert.match(APP_TILE_CSS, /@container \(max-width:520px\)\{\.bt-app-grid\{grid-template-columns:minmax\(0,1fr\)\}\}/)
  // The row itself: icon beside the text, and the action button that sat out of place.
  assert.match(APP_TILE_CSS, /\.bt-app\{position:relative;display:flex;align-items:center;gap:10px;min-height:60px/)
  assert.match(APP_TILE_CSS, /\.bt-app-icon\{[^}]*flex:none/)
  assert.match(APP_TILE_CSS, /\.bt-app-text\{min-width:0;display:flex;flex-direction:column/)
  assert.match(APP_TILE_CSS, /\.bt-app-btn\{[^}]*flex:none;[^}]*min-width:72px;height:28px/)
  // The arrival animation's keyframes travel with the rules that name them.
  for (const name of ['bt-app-pop', 'bt-app-shine', 'bt-app-done']) {
    assert.match(APP_TILE_CSS, new RegExp(`@keyframes ${name}\\b`), `${name} keyframes are missing`)
  }
})

test('the shell installs the tile base, so a panel opened first is still styled', () => {
  const index = readFileSync(join(PLUGIN, 'src/client/index.js'), 'utf8')
  assert.match(index, /import \{ APP_TILE_CSS \} from '\.\/app-tiles\.js'/)
  assert.match(index, /\[SHELL_CSS \+ APP_TILE_CSS, 'shell'\]/)
})

test('the built client.js carries the tile rules', () => {
  const client = readFileSync(join(PLUGIN, 'client.js'), 'utf8')
  for (const rule of ['.bt-apps{', '.bt-app-grid{display:grid', '.bt-app-btn{', '.bt-app-icon{', '@keyframes bt-app-pop', '@keyframes bt-app-shine']) {
    assert.ok(client.includes(rule), `client.js is missing ${rule}`)
  }
})
