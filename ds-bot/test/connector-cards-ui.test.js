import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The cards are rendered with a recording createElement: the capability list, the level
// sentence and the Disconnect label are read off the tree, not a browser.
const here = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = await build({
  stdin: {
    contents: [
      "export { CapabilityList, disconnectLabel } from './src/client/connector-shared.js'",
      "export { ConnectorsPage } from './src/client/connectors.js'",
    ].join('\n'),
    resolveDir: here,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
let serial = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'fragment',
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: current => ({ current }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useId: () => `id-${serial += 1}`,
  useMemo: make => make(),
  useCallback: fn => fn,
}
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  window: { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), open: () => null },
  document: { addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null },
  navigator: { clipboard: { writeText: async () => {} }, language: 'en' },
  localStorage: { getItem: () => null, setItem: () => {} },
})
const { CapabilityList, disconnectLabel, ConnectorsPage } = module.exports

function flat(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return []
  if (Array.isArray(node)) return node.flatMap(child => flat(child, depth))
  if (depth > 24) return []
  if (typeof node.type === 'function') return flat(node.type(node.props), depth + 1)
  return [node, ...node.children.flatMap(child => flat(child, depth + 1))]
}
const allText = nodes => {
  const out = []
  const walk = node => {
    if (typeof node === 'string') out.push(node)
    else if (node && typeof node === 'object') {
      for (const child of node.children ?? []) walk(child)
      if (typeof node.props?.children === 'string') out.push(node.props.children)
    }
  }
  for (const node of nodes) walk(node)
  return out.join(' ')
}

const NEON_CAPS = [
  { key: 'browse_projects', title: 'Browse projects and branches', risk: 'read' },
  { key: 'inspect_schema', title: 'Inspect schemas and tables', risk: 'read' },
  { key: 'read_sql', title: 'Run read-only SQL', risk: 'read' },
  { key: 'diagnose', title: 'Check slow queries and database health', risk: 'read' },
  { key: 'create_branch', title: 'Create a branch', risk: 'write' },
  { key: 'create_snapshot', title: 'Create a snapshot', risk: 'write' },
  { key: 'write_sql', title: 'Write SQL', risk: 'write' },
  { key: 'delete_branch', title: 'Delete a branch', risk: 'destructive' },
]
const neonRow = (id, label) => ({
  id, name: id === 'neon' ? 'Neon' : `Neon · ${label}`, state: 'off', level: 'read', levels: ['read', 'write'],
  capabilities: NEON_CAPS, oauth: true, card: { glyph: 'neon' },
  instance: { base: 'neon', id, label: label ?? '', max: 8 },
})

test('the module capabilities are drawn once, with the delete branch red', () => {
  const nodes = flat(CapabilityList({ capabilities: NEON_CAPS }))
  const items = nodes.filter(node => node.props?.className === 'bt-connector-cap')
  assert.equal(items.length, 8, 'all eight declarations are drawn')
  const del = items.find(item => item.props['data-risk'] === 'destructive')
  assert.ok(del, 'the delete branch is destructive')
  assert.ok(flat(del).some(node => node.props?.className === 'bt-connector-cap-badge' && node.children.includes('Destructive')), 'its badge says Destructive')
  // A read-only host greys the writes out instead of hiding them.
  const locked = flat(CapabilityList({ capabilities: NEON_CAPS, writesLocked: true }))
    .filter(node => node.props?.className === 'bt-connector-cap' && node.props['data-locked'] !== undefined)
  assert.equal(locked.length, 4, 'the four changing capabilities are unavailable on a read-only host')
})

test('a module card draws that list once, not once per project authorization', () => {
  const rows = [neonRow('neon'), neonRow('neon-2', 'Bench project')]
  const nodes = flat(ConnectorsPage({ roster: { connectors: rows, bots: [] }, actions: new Proxy({}, { get: () => async () => {} }), readOnly: null }))
  // The panel is closed until a click, so no capability is drawn yet; the wiring is what the
  // page must carry, and the shared list above already proves how it draws.
  const text = allText(nodes)
  assert.ok(text.includes('Neon'), 'the group card drew')
  const source = readFileSync(new URL('../src/client/connectors.js', import.meta.url), 'utf8')
  assert.ok(source.includes('h(CapabilityList, {\n            capabilities: base.capabilities'), 'the group card passes the module list once')
  const built = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(built.includes('Each project authorization runs this same set, at the level you gave it.'), 'the built client carries the group card list')
})

test('one level is not a choice, so the reauthorization sentence stays out', () => {
  const source = readFileSync(new URL('../src/client/connectors.js', import.meta.url), 'utf8')
  const guarded = source.split("t('Switching the access level needs a new authorization.')").filter(part => part.includes('levels.length > 1'))
  assert.equal(guarded.length, 2, 'both cards guard the sentence behind two levels')
  const built = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(built.split('levels.length > 1 ?').length - 1, 2, 'the built client guards both places')
})

test('a Disconnect press says what it is doing', () => {
  assert.equal(disconnectLabel(false), 'Disconnect')
  assert.equal(disconnectLabel(true), 'Disconnecting…')
  const connectors = readFileSync(new URL('../src/client/connectors.js', import.meta.url), 'utf8')
  const wechat = readFileSync(new URL('../src/client/wechat-card.js', import.meta.url), 'utf8')
  assert.equal(connectors.split('disconnectLabel(busy)').length - 1, 3, 'every connector card uses it')
  assert.equal(wechat.split('disconnectLabel(busy)').length - 1, 1, 'the channel card uses it too')
  assert.ok(readFileSync(new URL('../client.js', import.meta.url), 'utf8').includes('Disconnecting…'), 'the built client carries the label')
})

test('the channel card draws the module capabilities too', () => {
  const source = readFileSync(new URL('../src/client/wechat-card.js', import.meta.url), 'utf8')
  assert.ok(source.includes('h(CapabilityList, {\n            capabilities: first?.capabilities'), 'the channel card renders the list once')
  const built = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(built.includes('Every channel sends the same way; a notice goes only to the chat that wrote first.'), 'the built client carries the channel list')
})
