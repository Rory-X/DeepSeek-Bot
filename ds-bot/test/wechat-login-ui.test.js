import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The channel row is rendered with a recording createElement and the tree is walked, so what
// the reader sees for each sign-in state is checked without a browser.
const bundle = await build({
  stdin: {
    contents: "export { WeChatChannel } from './src/client/wechat-card.js'",
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
  // The row takes its open state from the prop, so state starts where the component puts it.
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
  window: { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) },
  document: { addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null },
  navigator: { clipboard: { writeText: async () => {} }, language: 'en' },
  localStorage: { getItem: () => null, setItem: () => {} },
})
const { WeChatChannel } = module.exports

const calls = []
const actions = new Proxy({}, { get: (_target, name) => (...args) => { calls.push({ name, args }); return Promise.resolve({ connectors: [] }) } })
const fields = (values = {}) => [
  { name: 'label', label: 'Name', value: values.label ?? 'WeChat' },
  { name: 'transport', kind: 'segmented', label: 'Transport', value: values.transport ?? 'clawbot', options: [{ value: 'webhook', label: 'Webhook' }, { value: 'clawbot', label: 'ClawBot' }] },
  { name: 'botId', kind: 'bot', label: 'Bot', required: true, value: 'chief' },
]
const row = (login, extra = {}) => ({
  id: 'wechat', name: 'WeChat', instance: { base: 'wechat', id: 'wechat', label: 'WeChat', max: 8 },
  state: 'off', level: 'write', levels: ['write'], transport: 'clawbot', canTest: false,
  fields: fields(), card: { glyph: 'wechat', levelChoice: false, about: 'A WeChat channel bound to one Bot.' },
  login, ...extra,
})

function flat(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return []
  if (Array.isArray(node)) return node.flatMap(child => flat(child, depth))
  if (depth > 24) return []
  if (typeof node.type === 'function') return flat(node.type(node.props), depth + 1)
  return [node, ...node.children.flatMap(child => flat(child, depth + 1))]
}
const render = (login, extra) => flat(WeChatChannel({ row: row(login, extra), actions, bots: [{ id: 'chief', name: 'Chief' }], expanded: true, onToggle: () => {}, lastOne: false }))
const texts = nodes => nodes.flatMap(node => node.children).filter(child => typeof child === 'string')
const buttons = nodes => nodes.filter(node => node.type === 'button').map(node => texts([node]).join('')).filter(Boolean)
const byState = nodes => nodes.find(node => node.props?.['data-login-state'] !== undefined)?.props['data-login-state']

test('the sign-in block names the state and keeps one Beta line and the owner line', () => {
  const nodes = render({ state: 'logged-out', consentRequired: false })
  assert.equal(byState(nodes), 'logged-out')
  const all = texts(nodes).join(' | ')
  assert.match(all, /Beta/)
  assert.match(all, /has not been tested on a real device/)
  assert.match(all, /only answer you/)
})

test('the risk note comes before any QR code, and its button is the only way on', () => {
  const nodes = render({ state: 'logged-out', consentRequired: true })
  const all = texts(nodes).join(' | ')
  assert.match(all, /Sign-in risks/)
  assert.match(all, /personal account/)
  assert.match(all, /official documentation/)
  assert.deepEqual(buttons(nodes).filter(label => /Start login/.test(label)), [])
  assert.deepEqual(buttons(nodes).filter(label => /I understand, continue/.test(label)).length, 1)
  assert.equal(nodes.filter(node => node.type === 'img').length, 0)
})

test('each state draws its own words and the buttons the contract names', () => {
  const expectations = [
    ['qr', /Scan the QR code with WeChat/, ['Refresh', 'Cancel']],
    ['verified-needed', /Enter the code shown in WeChat/, ['Refresh', 'Cancel']],
    ['blocked', /Too many wrong codes/, ['Refresh', 'Cancel']],
    ['expired', /QR code expired/, ['Refresh', 'Cancel']],
    ['cancelled', /Login cancelled/, ['Start login']],
    ['confirm-failed', /did not confirm the login/, ['Start login', 'Retry']],
    ['protocol-error', /login service is unavailable/, ['Retry']],
    ['logged-in', /Logged in as ilxk…9f/, []],
    ['login-expired', /Login expired; scan again/, ['Start login']],
  ]
  for (const [state, words, expected] of expectations) {
    const nodes = render({ state, account: 'ilxk…9f', error: 'host words' })
    assert.equal(byState(nodes), state)
    assert.match(texts(nodes).join(' | '), words, state)
    const labels = buttons(nodes)
    for (const label of expected) assert.ok(labels.includes(label), `${state} is missing ${label}: ${labels.join(',')}`)
  }
})

test('only a drawable QR reaches the page, and a raw string never does', () => {
  const picture = render({ state: 'qr', qr: 'data:image/png;base64,AAAA' }).filter(node => node.type === 'img')
  assert.equal(picture.length, 1)
  assert.equal(picture[0].props.src, 'data:image/png;base64,AAAA')
  const raw = 'WECHAT_LOGIN_TOKEN_DO_NOT_RENDER'
  const failed = render({ state: 'qr', qr: raw })
  assert.equal(failed.filter(node => node.type === 'img').length, 0)
  assert.match(texts(failed).join(' | '), /QR code unavailable/)
  assert.equal(JSON.stringify(failed).includes(raw), false)
})

test('a scanned code says so, and the login-expired state shows the host words', () => {
  assert.match(texts(render({ state: 'qr', scanned: true, qr: 'https://example.test/qr.png' })).join(' | '), /Scanned — confirm on your phone/)
  const expired = render({ state: 'login-expired', error: 'Login failed. Webhook channels are not affected; scan the QR code again.' }, { state: 'error', error: 'Login failed. Webhook channels are not affected; scan the QR code again.' })
  assert.match(texts(expired).join(' | '), /Webhook channels are not affected/)
})

test('a signed-in ClawBot channel offers one test message, and no earlier', () => {
  const loggedIn = render({ state: 'logged-in', account: 'ilxk…9f' }, { canTest: true })
  assert.ok(buttons(loggedIn).includes('Test message'), buttons(loggedIn).join(','))
  assert.equal(texts(loggedIn).join(' | ').includes('Sign in first'), false)

  const signedOut = render({ state: 'logged-out', consentRequired: false }, { canTest: false })
  assert.equal(buttons(signedOut).includes('Test message'), false)
  assert.match(texts(signedOut).join(' | '), /Sign in first to send a test message/)

  const quiet = render({ state: 'logged-in', account: 'ilxk…9f' }, { canTest: false })
  assert.equal(buttons(quiet).includes('Test message'), false)
})

test('a failed test shows the host words on the card', () => {
  const failed = render({ state: 'logged-in', account: 'ilxk…9f' }, { canTest: true, state: 'ready', error: 'Could not reach the WeChat service.' })
  assert.match(texts(failed).join(' | '), /Could not reach the WeChat service/)
})

test('a webhook channel keeps its own test rule', () => {
  const webhook = (extra) => flat(WeChatChannel({
    row: { ...row(null), transport: 'webhook', fields: fields({ transport: 'webhook' }), card: { glyph: 'wechat', levelChoice: false, about: 'A WeChat channel bound to one Bot.' }, ...extra },
    actions, bots: [], expanded: true, onToggle: () => {}, lastOne: false,
  }))
  const ready = buttons(webhook({ state: 'ready', canTest: true }))
  assert.ok(ready.includes('Test message'), ready.join(','))
  const off = buttons(webhook({ state: 'off', canTest: true }))
  assert.equal(off.includes('Test message'), false)
  assert.equal(texts(webhook({ state: 'ready', canTest: true })).join(' | ').includes('Sign in first'), false)
})

test('a webhook channel draws no sign-in block at all', () => {
  const webhook = flat(WeChatChannel({ row: { ...row(null), transport: 'webhook', fields: fields({ transport: 'webhook' }), card: { glyph: 'wechat', levelChoice: false, about: 'A WeChat channel bound to one Bot.' } }, actions, bots: [], expanded: true, onToggle: () => {}, lastOne: false }))
  assert.equal(byState(webhook), undefined)
  assert.equal(texts(webhook).join(' | ').includes('Beta'), false)
})
