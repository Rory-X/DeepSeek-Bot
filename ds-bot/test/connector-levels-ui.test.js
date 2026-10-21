import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The cards are rendered with a recording `createElement`: the tree the components build is
// walked here, so a test can say what the reader would see without a browser.
const bundle = await build({
  stdin: {
    contents: "export { ConnectorsPage } from './src/client/connectors.js'\nexport { WeChatCard, WeChatChannel } from './src/client/wechat-card.js'\nexport { levelChoiceVisible } from './src/client/connector-shared.js'",
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
  // Panels start collapsed, so the test opens them: a boolean that starts false reads as true,
  // which lets the collapsed branch be checked for the blocks it would draw when open.
  useState: initial => {
    const value = typeof initial === 'function' ? initial() : initial
    return [value === false ? true : value, () => {}]
  },
  useRef: current => ({ current }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useId: () => `id-${serial += 1}`,
  useMemo: make => make(),
  useCallback: fn => fn,
}
const sandbox = {
  module, exports: module.exports,
  require: name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    return {}
  },
  window: { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), location: { href: '' } },
  document: { addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null },
  navigator: { clipboard: { writeText: async () => {} }, language: 'en' },
  localStorage: { getItem: () => null, setItem: () => {} },
}
runInNewContext(bundle.outputFiles[0].text, sandbox)
const { ConnectorsPage, WeChatCard, WeChatChannel, levelChoiceVisible } = module.exports

const actions = new Proxy({}, { get: () => async () => {} })
const fields = values => Object.entries(values ?? {}).map(([name, value]) => ({ name, label: name, value }))

const telegram = {
  id: 'telegram', name: 'Telegram', state: 'off', level: 'read', levels: ['read'],
  fields: fields({ botToken: 'saved' }), actions: false, toolbox: false, toolboxCall: 'telegram_call',
  card: { glyph: 'telegram', levelChoice: false, about: 'Send notifications through a Telegram bot of your own.' },
}
const cloudflare = {
  id: 'cloudflare', name: 'Cloudflare', state: 'off', level: 'read', levels: ['read', 'write'],
  fields: fields({}), actions: false, toolbox: false, toolboxCall: 'cloudflare_call',
  card: { glyph: 'cloudflare', about: "Zones, DNS records and Workers through Cloudflare's own MCP server." },
}
const wechatRow = (id, name) => ({
  id, name, instance: { base: 'wechat', id, label: name, max: 8 }, state: 'off', level: 'read',
  levels: ['read', 'write'], fields: fields({ label: name, transport: 'webhook', botId: '', webhookUrl: '' }),
  transport: 'webhook', canTest: false,
  card: { glyph: 'wechat', levelChoice: false, about: 'A WeChat channel bound to one Bot.' },
})

// Walk what the components return: function children are called with their props, so the
// whole card is checked the way it renders.
function flat(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return []
  if (Array.isArray(node)) return node.flatMap(child => flat(child, depth))
  if (depth > 24) return []
  if (typeof node.type === 'function') return flat(node.type(node.props), depth + 1)
  return [node, ...node.children.flatMap(child => flat(child, depth + 1))]
}
const page = connectors => flat(ConnectorsPage({ roster: { connectors, bots: [] }, actions, readOnly: null }))
const texts = nodes => nodes.flatMap(node => node.children).filter(child => typeof child === 'string')
const hasLevelTitle = nodes => texts(nodes).includes('Access level')
const hasRadioGroup = nodes => nodes.some(node => node.props?.className === 'bt-connector-levels' && node.props?.role === 'radiogroup')

test('a one-way channel card leaves the access level out entirely', () => {
  const tree = page([telegram])
  assert.equal(hasLevelTitle(tree), false, 'no "Access level" heading')
  assert.equal(hasRadioGroup(tree), false, 'no level radio group')
  const emptySettings = tree.filter(node => node.props?.className === 'bt-connector-setting' && node.children.filter(Boolean).length === 0)
  assert.deepEqual(emptySettings, [], 'no empty settings container is left behind')
})

test('a connector that keeps its two levels still shows them', () => {
  const tree = page([cloudflare])
  assert.equal(hasLevelTitle(tree), true)
  assert.equal(hasRadioGroup(tree), true)
})

test('the WeChat card leaves the access level out of every channel', () => {
  // A channel row draws its settings only when open, which is where the level block would be.
  const open = row => flat(WeChatChannel({ row, actions, bots: [], expanded: true, onToggle: () => {}, lastOne: false }))
  assert.equal(hasLevelTitle(open(wechatRow('wechat', 'WeChat'))), false)
  assert.equal(hasRadioGroup(open(wechatRow('wechat', 'WeChat'))), false)
  const module = flat(WeChatCard({ rows: [wechatRow('wechat', 'WeChat')], actions, bots: [] }))
  assert.equal(hasLevelTitle(module), false)
})

test('a WeChat channel that still lists its levels draws them when open', () => {
  const row = { ...wechatRow('wechat', 'WeChat'), card: { glyph: 'wechat', about: 'A WeChat channel bound to one Bot.' } }
  const tree = flat(WeChatChannel({ row, actions, bots: [], expanded: true, onToggle: () => {}, lastOne: false }))
  assert.equal(hasLevelTitle(tree), true)
  assert.equal(hasRadioGroup(tree), true)
})

test('a mixed page draws the level block only for the connector that has one', () => {
  const tree = page([telegram, cloudflare])
  assert.equal(texts(tree).filter(text => text === 'Access level').length, 1)
  assert.equal(tree.filter(node => node.props?.role === 'radiogroup').length, 1)
})

test('a card that declares no level choice keeps its levels, and an empty one draws nothing', () => {
  assert.equal(levelChoiceVisible(cloudflare), true)
  assert.equal(levelChoiceVisible(telegram), false)
  assert.equal(levelChoiceVisible({ levels: ['read'] }), true)
  assert.equal(levelChoiceVisible({ levels: [], card: { levelChoice: true } }), false)
  assert.equal(levelChoiceVisible({ levels: ['read'], card: { levelChoice: true } }), true)
  assert.equal(levelChoiceVisible({ card: { levelChoice: false } }), false)
})
