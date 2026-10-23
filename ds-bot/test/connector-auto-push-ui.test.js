import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The notification card is rendered with a recording createElement, so the switch it draws
// can be checked against the host's own autoPush value without a browser.
const bundle = await build({
  stdin: {
    contents: "export { ConnectorsPage } from './src/client/connectors.js'",
    resolveDir: dirname(dirname(fileURLToPath(import.meta.url))),
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
const { ConnectorsPage } = module.exports
const actions = new Proxy({}, { get: () => async () => {} })

function flat(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return []
  if (Array.isArray(node)) return node.flatMap(child => flat(child, depth))
  if (depth > 24) return []
  if (typeof node.type === 'function') return flat(node.type(node.props), depth + 1)
  return [node, ...node.children.flatMap(child => flat(child, depth + 1))]
}
const tokenField = { name: 'token', kind: 'secret', label: 'Bot token', saved: true }
const telegram = extra => ({
  id: 'telegram', name: 'Telegram', state: 'ready', level: 'read', levels: ['read'],
  actions: false, toolbox: false, canTest: true, mode: 'notify', chatId: '1234', autoPush: true,
  fields: [tokenField], card: { glyph: 'telegram', about: 'Send notifications through a Telegram bot of your own.' },
  ...extra,
})
const github = {
  id: 'github', name: 'GitHub', state: 'ready', level: 'read', levels: ['read'],
  fields: [], card: { glyph: 'github', about: 'Repositories, issues and pull requests' },
}
const page = connectors => flat(ConnectorsPage({ roster: { connectors, bots: [] }, actions, readOnly: null }))
const texts = nodes => nodes.flatMap(node => node.children).filter(child => typeof child === 'string')
const switchNode = nodes => nodes.find(node => node.props?.['data-auto-push'] !== undefined)
const choices = nodes => nodes.filter(node => node.props?.['data-auto-push-choice'] !== undefined)

test('a notification connector shows the automatic-send switch on when the host says so', () => {
  const tree = page([telegram()])
  const block = switchNode(tree)
  assert.ok(block, 'the switch is drawn')
  assert.equal(block.props['data-auto-push'], 'on')
  assert.ok(texts(tree).includes('Automatic sends'))
  const [off, on] = choices(tree)
  assert.equal(off.props['aria-checked'], false)
  assert.equal(on.props['aria-checked'], true)
})

test('an explicit autoPush:false draws the switch off', () => {
  const tree = page([telegram({ autoPush: false })])
  assert.equal(switchNode(tree).props['data-auto-push'], 'off')
  const [off, on] = choices(tree)
  assert.equal(off.props['aria-checked'], true)
  assert.equal(on.props['aria-checked'], false)
})

test('the switch belongs to notification connectors only', () => {
  const tree = page([github])
  assert.equal(switchNode(tree), undefined)
  assert.equal(texts(tree).includes('Automatic sends'), false)
})

test('a connector that is not connected yet has no switch to flip', () => {
  const tree = page([telegram({ state: 'off' })])
  assert.equal(switchNode(tree), undefined)
})
