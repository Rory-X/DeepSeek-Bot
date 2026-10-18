import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/header.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    const platform = {
      react: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }), useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, Fragment: 'fragment' },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { HeaderPill } = module.exports

const roster = { byId: { a: { id: 'a', name: 'Chief', sessionId: 'a' } }, roomsById: {}, bots: [], exchangeTurns: {}, questions: {} }
const hook = value => select => select(value)
const header = actions => HeaderPill({
  sessionId: 'a',
  useRoster: hook(roster),
  useSessions: hook({ byId: {} }),
  useSessionStatus: hook(new Map()),
  useSession: hook({}),
  useActivity: hook({}),
  useMemoryNews: hook({}),
  useTurnClock: hook({}),
  useUi: hook({}),
  useLive: hook({}),
  useMobileNav: hook(false),
  useNavLevel: hook('list'),
  actions,
})
const sideButton = (node) => {
  if (node === null || typeof node !== 'object') return null
  if (node.props?.['data-bt-right-sidebar'] !== undefined) return node
  for (const child of node.children ?? []) {
    const found = sideButton(child)
    if (found) return found
  }
  return null
}

// 公开#172: the Bot header replaces DSH's session header, and with it the corner seat
// where DSH puts the button that opens its right sidebar; only the shortcut was left.
test('the Bot header has the right sidebar toggle that DSH keeps in the header it replaces', () => {
  let toggled = 0
  const button = sideButton(header({ hasRightSidebar: () => true, toggleRightSidebar: () => { toggled += 1 } }))
  assert.ok(button)
  assert.equal(button.props['aria-label'], 'Show or hide the right sidebar')
  button.props.onClick()
  assert.equal(toggled, 1)
})

test('without DSH\'s right sidebar the Bot header shows no toggle', () => {
  assert.equal(sideButton(header({ hasRightSidebar: () => false, toggleRightSidebar: () => {} })), null)
})

// The phone's header gives way on a real scroll down and returns on a real scroll up: the
// thresholds keep it from flickering at every nudge, and a scroll that does not move leaves
// it as it was.
test('the phone header collapses on a scroll down and returns on a scroll up', () => {
  const { headCollapse, HEAD_COLLAPSE_AT } = module.exports
  assert.equal(headCollapse(HEAD_COLLAPSE_AT, HEAD_COLLAPSE_AT - 40, true), false, 'at the top it comes back')
  assert.equal(headCollapse(HEAD_COLLAPSE_AT + 40, 0, false), true, 'past the threshold, down')
  assert.equal(headCollapse(400, 500, true), false, 'up brings it back')
  assert.equal(headCollapse(400, 400, true), true, 'no movement keeps the state')
  assert.equal(headCollapse(400, 400, false), false, 'no movement keeps the state')
  // A jump has no direction to read, so where it lands decides.
  assert.equal(headCollapse(900, 2600, false, 'jump'), true, 'a jump down the transcript collapses')
  assert.equal(headCollapse(10, 900, true, 'jump'), false, 'a jump back to the top returns it')
})
