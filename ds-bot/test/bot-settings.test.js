import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/bot-settings.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn,
  useRef: current => ({ current }), useId: () => 'id', Fragment: Symbol('Fragment'),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { BotSettingsForm } = module.exports

function walk(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}
function settings(bot, { main = false, rooms = [] } = {}) {
  const roster = { mainBotIds: main ? [bot.id] : [], mainBotId: main ? bot.id : null, rooms, models: [], memory: false }
  return walk(BotSettingsForm({ bot, roster, actions: {}, run: fn => fn }))
}
const bot = { id: 'b', name: 'Writer', role: 'Writer', instructions: '', capabilities: [] }

test('the Private switch is enabled only for a state the host accepts', () => {
  const noFolder = settings(bot).find(node => node.props?.label === 'Private')
  assert.equal(noFolder.props.disabled, true)
  assert.equal(noFolder.props.hint, 'Choose a working folder of its own first.')

  const grouped = settings({ ...bot, workDir: '/work' }, { rooms: [{ id: 'r', members: ['b'] }] }).find(node => node.props?.label === 'Private')
  assert.equal(grouped.props.disabled, true)
  assert.equal(grouped.props.hint, 'Leave its group chats before making it private.')

  const main = settings({ ...bot, workDir: '/work' }, { main: true }).find(node => node.props?.label === 'Private')
  assert.equal(main.props.disabled, true)
  assert.equal(main.props.hint, 'A Main Bot cannot be private.')

  const allowed = settings({ ...bot, workDir: '/work' }).find(node => node.props?.label === 'Private')
  assert.equal(allowed.props.disabled, false)
  assert.equal(allowed.props.on, false)
})

test('a private Bot can always turn privacy off, and cannot become Main or be duplicated', () => {
  const tree = settings({ ...bot, workDir: '/work', private: true })
  const privacy = tree.find(node => node.props?.label === 'Private')
  assert.equal(privacy.props.on, true)
  assert.equal(privacy.props.disabled, false)
  assert.equal(tree.find(node => node.props?.label === 'Main Bot').props.disabled, true)
  assert.equal(tree.some(node => node.props?.onClick && node.props.className === 'bt-set-row bt-bs-row' && JSON.stringify(node).includes('Duplicate')), false)
})

test('BOT_SETTINGS_CSS keeps a settings row on one line and shares a narrow panel', async () => {
  const { BOT_SETTINGS_CSS } = module.exports
  const phone = BOT_SETTINGS_CSS.slice(BOT_SETTINGS_CSS.lastIndexOf('@media (max-width:640px)'))
  // The direction is pinned for a phone; the panel query only changes shares.
  assert.match(phone, /\.bt-bs-row\{flex-direction:row;align-items:center/)
  assert.match(phone, /\.bt-bs-row\.bt-bs-stack\{flex-direction:column/)
  const panel = BOT_SETTINGS_CSS.slice(BOT_SETTINGS_CSS.indexOf('@container (max-width:520px)'), BOT_SETTINGS_CSS.lastIndexOf('@media (max-width:640px)'))
  assert.doesNotMatch(panel, /flex-direction/, 'a narrow panel never stacks the row')
  assert.match(panel, /\.bt-bs-input\{flex:1 1 auto;width:auto;max-width:56%/)
  assert.match(panel, /\.bt-bs-row \.bt-model-trigger\{flex:0 0 auto;max-width:68%/)
  assert.match(panel, /\.bt-bs-area\{[^}]*min-height:140px/)
  // Same specificity means source order decides: the shares must come after the base rule.
  assert.ok(BOT_SETTINGS_CSS.indexOf('.bt-bs-input{flex:0 1 220px') < BOT_SETTINGS_CSS.indexOf('@container (max-width:520px)'))
})

test('the phone makes the avatar editor a full-width bottom sheet', () => {
  const { BOT_SETTINGS_CSS } = module.exports
  const phone = BOT_SETTINGS_CSS.slice(BOT_SETTINGS_CSS.lastIndexOf('@media (max-width:640px)'))
  assert.match(phone, /\.bt-bs \.bt-avedit\{position:fixed;left:12px;right:12px;bottom:/)
  assert.match(phone, /width:auto/)
  assert.match(phone, /overflow-y:auto/)
  assert.match(phone, /transform:none/)
  assert.match(phone, /background:var\(--bt-main\)/)
})
