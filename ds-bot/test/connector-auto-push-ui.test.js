import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The notification card is rendered with a recording createElement, so the switch it draws
// can be checked against the host's own autoPush value without a browser.
const bundle = await build({
  stdin: {
    contents: "export { ConnectorsPage, AutoPushControl } from './src/client/connectors.js'",
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
const { ConnectorsPage, AutoPushControl } = module.exports
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

// The switch is a setting now: folded, the card shows only the connection.
test('a folded notification card keeps the automatic-send switch out of sight', () => {
  const tree = page([telegram()])
  assert.equal(switchNode(tree), undefined, 'no switch on the folded card')
  assert.equal(texts(tree).includes('Automatic sends'), false)
})

const autoPushActions = () => {
  const calls = []
  const actions = { connectorSetAutoPush: (id, value) => { calls.push([id, value]); return Promise.resolve() } }
  return { calls, actions }
}
const renderSwitch = ({ autoPush = true, busy = false, actions = new Proxy({}, { get: () => async () => {} }), run = () => {} } = {}) =>
  flat(AutoPushControl({ connector: telegram(), actions, autoPush, busy, run }))
const press = (nodes, choice) => {
  const button = nodes.find(n => n.props?.['data-auto-push-choice'] === choice)
  let stopped = false
  button.props.onClick({ stopPropagation: () => { stopped = true } })
  return stopped
}

test('the switch it draws reports the host value and flips it', () => {
  const on = renderSwitch({ autoPush: true })
  const block = switchNode(on)
  assert.equal(block.props['data-auto-push'], 'on')
  assert.ok(texts(on).includes('Automatic sends'))
  assert.equal(choices(on).find(c => c.props['data-auto-push-choice'] === 'off').props['aria-checked'], false)
  assert.equal(choices(on).find(c => c.props['data-auto-push-choice'] === 'on').props['aria-checked'], true)

  const off = renderSwitch({ autoPush: false })
  assert.equal(switchNode(off).props['data-auto-push'], 'off')
  assert.equal(choices(off).find(c => c.props['data-auto-push-choice'] === 'off').props['aria-checked'], true)
  assert.equal(choices(off).find(c => c.props['data-auto-push-choice'] === 'on').props['aria-checked'], false)
})

test('choosing On or Off asks the host, and only for a change', () => {
  const first = autoPushActions()
  let ran = 0
  const onNodes = flat(AutoPushControl({ connector: telegram(), actions: first.actions, autoPush: true, busy: false, run: () => { ran += 1 } }))
  assert.equal(press(onNodes, 'off'), true, 'the press does not reach the card')
  assert.deepEqual(first.calls, [['telegram', false]])
  assert.equal(ran, 1, 'the host action runs through the card')
  press(onNodes, 'on')
  assert.deepEqual(first.calls, [['telegram', false]], 'choosing the value it already has asks nothing')

  const second = autoPushActions()
  const offNodes = flat(AutoPushControl({ connector: telegram(), actions: second.actions, autoPush: false, busy: false, run: () => {} }))
  press(offNodes, 'on')
  assert.deepEqual(second.calls, [['telegram', true]])
})

// The panel is the only place the switch can appear, and a card without one keeps it outside.
test('the switch sits first inside the card panel, and stays on the card when there is no panel', () => {
  const source = readFileSync(new URL('../src/client/connectors.js', import.meta.url), 'utf8')
  const panelStart = source.indexOf("className: 'bt-connector-panel-inner'")
  const switchAt = source.indexOf('autoPushNode,', panelStart)
  const levelAt = source.indexOf('levelBlock,', panelStart)
  assert.ok(panelStart >= 0 && switchAt > panelStart && switchAt < levelAt, 'the panel draws it before the level choice')
  assert.match(source, /!hasOptions \? autoPushNode : null/, 'a card without a panel keeps it on the card')
  // A notification card that cannot open a panel still shows the switch.
  const noPanel = telegram({ levels: [], card: { glyph: 'telegram', levelChoice: false } })
  const tree = page([noPanel])
  assert.ok(switchNode(tree), 'the fallback keeps the control on the card')
  assert.equal(texts(tree).includes('Automatic sends'), true)
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

test('the chosen automatic-send radio is painted, so On and Off differ without a screen reader', () => {
  // The card draws role=radio buttons; the stylesheet is what makes the chosen one visible.
  const styles = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const chosen = /\.bt-connector-auto-push \[role=radio\]\[aria-checked=true\]\{[^}]*background:color-mix\([^}]*\)[^}]*box-shadow:inset[^}]*font-weight:600/
  const other = /\.bt-connector-auto-push \[role=radio\]\[aria-checked=false\]\{color:var\(--bt-ink-2\)\}/
  assert.match(styles, chosen, 'the chosen radio gets a fill, a ring and a heavier label')
  assert.match(styles, other, 'the other radio stays quiet')
  // The shipped bundle carries the same rules: this is what a reader actually loads.
  assert.ok(bundle.includes('.bt-connector-auto-push [role=radio][aria-checked=true]{'), 'the built client paints the chosen radio')
  assert.ok(bundle.includes('.bt-connector-auto-push [role=radio][aria-checked=false]{'), 'the built client quiets the other one')
  // A touch screen has no hover: the same two radios keep a 36px target there.
  assert.match(styles, /@media \(hover:none\)\{\.bt-connector-auto-push \[role=radio\]\{height:36px;padding:0 16px\}\}/, 'the phone keeps a 36px target')
  assert.ok(bundle.includes('.bt-connector-auto-push [role=radio]{height:36px'), 'the built client keeps the 36px target')
  // And the two states cannot look the same: only the checked rule sets a fill and a ring.
  const on = renderSwitch({ autoPush: true })
  assert.equal(choices(on).find(c => c.props['data-auto-push-choice'] === 'off').props['aria-checked'], false)
  assert.equal(choices(on).find(c => c.props['data-auto-push-choice'] === 'on').props['aria-checked'], true)
})
