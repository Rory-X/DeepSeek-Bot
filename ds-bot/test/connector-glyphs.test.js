import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const connectorDir = new URL('../src/host/connectors/', import.meta.url)
const clientDir = new URL('../src/client/', import.meta.url)
const read = (base, file) => readFileSync(new URL(file, base), 'utf8')

// A glyph the host names but the client does not draw falls back to the plug, so the card
// shows "some service" instead of the module's own mark.
test('every glyph a connector declares has a mark in the client', () => {
  const glyphs = new Set()
  const sources = [read(connectorDir, '../connectors.js'), ...readdirSync(connectorDir)
    .filter(file => file.endsWith('.js'))
    .map(file => read(connectorDir, file))]
  for (const source of sources) {
    for (const match of source.matchAll(/glyph: '([a-z0-9-]+)'/g)) glyphs.add(match[1])
  }
  assert.ok(glyphs.size > 0, 'no connector declares a glyph')
  const glyphMap = read(clientDir, 'connectors.js')
  for (const glyph of glyphs) {
    assert.match(glyphMap, new RegExp(`\\b${glyph}: [A-Z][A-Za-z]*Mark\\b`), `the client draws no mark for glyph "${glyph}"`)
  }
})

// The WeChat card draws its own mark and the glyph map points at that same mark, so one
// icon never has two drawings.
test('the WeChat mark has one drawing and the glyph map reuses it', () => {
  const card = read(clientDir, 'wechat-card.js')
  const map = read(clientDir, 'connectors.js')
  assert.match(card, /export const WeChatMark = /)
  assert.match(map, /import \{[^}]*\bWeChatMark\b[^}]*\} from '\.\/wechat-card\.js'/)
  assert.match(map, /\bwechat: WeChatMark\b/)
  assert.doesNotMatch(map, /export const WeChatMark /)
})
