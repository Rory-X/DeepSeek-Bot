import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom and the real client module system come from the harness, as the dsh packages do.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness')
const requireHarness = createRequire(join(harness, 'package.json'))
const { JSDOM } = requireHarness('jsdom')

// The style helpers and the CSS they ship, bundled once with a minimal React for
// motion.js; they run in each test's jsdom document through the vm context.
const { outputFiles } = await build({
  stdin: {
    contents: "export { installStyles, installCompiledStyles } from './src/client/styles.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}

const tick = () => new Promise(resolve => setImmediate(resolve))
// DS Bot's style tags in a document, all of them or those of one group.
const tagged = (document, tag) => [...document.head.querySelectorAll('style')]
  .filter(style => style.dataset.dshBot !== undefined && (tag === undefined || style.dataset.dshBot === tag))

// The client-modules bundle registers itself through the page's __ModuleLoader__
// facade when it loads; capture that registration once to reach its exports.
const clientModules = (() => {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  let registration
  const previousWindow = globalThis.window
  globalThis.window = window
  window.__ModuleLoader__ = { load: (record) => { registration = record } }
  try {
    requireHarness('@deepseek-ai/dsh-client-modules/client')
  } finally {
    globalThis.window = previousWindow
  }
  return registration.factory((spec) => { throw new Error(`no seed module ${spec}`) })
})()
const { createClientModuleSystem, parseBootManifest } = clientModules

// A fresh jsdom document, the bundled style helpers bound to it, and a real
// ClientModuleSystem that materializes the pretend modules named in `rows`.
const bench = (rows) => {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    document: window.document,
    MutationObserver: window.MutationObserver,
    HTMLLinkElement: window.HTMLLinkElement,
    setTimeout, clearTimeout,
    require: name => (name === 'react' ? react : {}),
  })
  // The client module system reads the page's globals when it claims and removes.
  const previousGlobals = { window: globalThis.window, document: globalThis.document }
  const inside = (fn) => {
    globalThis.window = window
    globalThis.document = window.document
    try { return fn() } finally { globalThis.window = previousGlobals.window; globalThis.document = previousGlobals.document }
  }
  const boot = (rev) => ({
    rev,
    entries: rows.map(id => ({ id, url: `/modules/${id}.js?rev=${rev}`, rev })),
    batches: rows.length ? [{ phase: 'application', url: `/boot.js?rev=${rev}`, rev, entries: [...rows] }] : [],
  })
  // A bench with no modules never builds the system; the helpers stay undefined.
  const system = rows.length === 0 ? undefined : inside(() => {
    window.__ModuleLoader__ = { mode: 'queue', pendingQueue: [], load() {} }
    return createClientModuleSystem(window.__ModuleLoader__, { id: 'shell', exports: {} }, {
      boot: boot('r1'),
      staticModules: {},
    })
  })
  const materialize = id => inside(() => system.materialize(id))
  const update = (rev, managed = new Map()) => inside(() => system.updateManifest(parseBootManifest(boot(rev)), managed))
  const register = (id, factory) => inside(() => window.__ModuleLoader__.load({ id, factory }))
  return { window, module, materialize, register, update }
}

// #228: our style tags carry the client module id, so another module's materialization
// cannot claim them and its teardown cannot delete them.
test('every DS Bot style is owned by the ds-bot client module', async () => {
  const { window, module, register, materialize, update } = bench(['other'])
  const { installStyles, installCompiledStyles } = module.exports
  const { document } = window
  register('other', () => ({}))

  const plain = installStyles('a{color:red}', 'mentions')
  installCompiledStyles('.b{position:fixed}', 'shell')
  const [compiled] = tagged(document, 'shell')
  const stray = document.createElement('style')
  stray.textContent = 'stray{}'
  document.head.appendChild(stray)
  for (const style of [plain, compiled]) {
    assert.equal(style.dataset.dshBot !== undefined, true)
    assert.equal(style.dataset.plugin, 'ds-bot')
    assert.equal(style.matches('style:not([data-plugin])'), false)
  }

  // Another module materializing claims untagged styles (DSH 0.2.0-rc.2 does; other
  // versions may not); ours keep their owner either way.
  materialize('other')
  const claimed = stray.dataset.plugin === 'other'
  assert.equal(plain.dataset.plugin, 'ds-bot')
  assert.equal(compiled.dataset.plugin, 'ds-bot')

  // A newer revision of that module replaces it: what it claimed goes, ours stay.
  update('r2')
  await tick()
  if (claimed) assert.equal(stray.isConnected, false)
  assert.equal(plain.isConnected, true)
  assert.equal(compiled.isConnected, true)
})

test('a compiled style removed from outside comes back, until its cleanup runs', async () => {
  const { window, module } = bench([])
  const { installCompiledStyles } = module.exports
  const { document } = window
  const dispose = installCompiledStyles('.b{position:fixed}', 'shell')
  const [style] = tagged(document, 'shell')
  assert.ok(style.isConnected)

  style.remove()
  await tick()
  assert.equal(style.isConnected, true, 'the observer puts a removed node back')

  dispose()
  await tick()
  assert.equal(style.isConnected, false)
  // Later page changes cannot resurrect it.
  const late = document.createElement('style')
  document.head.appendChild(late)
  await tick()
  assert.equal(style.isConnected, false)
})

test('mounting and unmounting compiled styles twice leaves no extra nodes', async () => {
  const { window, module } = bench([])
  const { installCompiledStyles } = module.exports
  const { document } = window
  for (let round = 0; round < 2; round += 1) {
    const dispose = installCompiledStyles('.b{position:fixed}', 'shell')
    await tick()
    dispose()
  }
  await tick()
  assert.equal(tagged(document).length, 0)
})

test('the chat-room rule is installed through installStyles, so it is owned too', () => {
  const pane = readFileSync(new URL('../src/client/browser-pane.js', import.meta.url), 'utf8')
  assert.match(pane, /installStyles\(.*'chat-room'/)
  assert.equal(pane.includes("dataset.dshBot = 'chat-room'"), false)
})

// The phone's settings strip scrolls sideways, so room for the close button has to sit
// outside its box: padding-right leaves the items running under the button at scroll 0,
// where they take the taps meant for it.
test('the phone settings strip leaves the close button room outside its scroll box', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  const strip = css.split('\n').find(line => line.includes('.bt-settings-nav{') && line.includes('overflow-x:auto'))
  assert.ok(strip, 'the phone settings strip rule is there')
  assert.match(strip, /margin-right:calc\(12px \+ 32px\)/)
  assert.equal(/padding:[^;]*48px/.test(strip), false)
})

// A phone must not move the page itself. The shell's frame is the viewport, so a drag that
// reaches the page would rubber-band, refresh, or zoom the whole interface.
test('the phone pins the page against bounce, refresh and zoom', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  const root = css.split('\n').find(line => line.includes('overscroll-behavior:none'))
  assert.ok(root, 'the root carries the overscroll rule')
  assert.match(root, /touch-action:pan-x pan-y/)
  const field = css.split('\n').find(line => line.includes('max(16px,1em)'))
  assert.ok(field, 'a field under 16px would zoom the page when it takes focus')
  assert.match(field, /select/, 'a select zooms it too')
})

// The Main Bot's card, once it has scrolled away on a phone, is a small centred pill
// under the top row: a full-width bar would be a different design, and a pill that is not
// centred is not what the phone asks for.
test('the phone stands in for the Main Bot card with a centred pill', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  const pill = css.split('\n').find(line => line.includes('.bt-chief-bar{'))
  assert.ok(pill, 'the pill is there')
  assert.match(pill, /left:50%;transform:translateX\(-50%\)/)
  assert.match(pill, /border-radius:999px/)
  assert.equal(/left:0;right:0/.test(pill), false, 'not a full-width bar')
  const arrow = css.split('\n').find(line => line.includes('.bt-chief-go{'))
  assert.match(arrow, /width:44px;height:44px/)
})

// The shell's right panel goes fullscreen below 768px, and its column is the box it
// positions itself against: hiding that column is what left the header's button doing
// nothing. It comes back, out of the grid, while the panel is fullscreen.
test('the phone lets the shell\'s fullscreen right panel through', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  const shown = css.split('\n').find(line => line.includes('data-rightbar-fullscreen] [data-rightbar-col]'))
  assert.ok(shown, 'the fullscreen rule is there')
  assert.match(shown, /display:block!important/)
  assert.match(shown, /position:fixed!important/)
  const hidden = css.split('\n').find(line => line.includes('body[data-bt-nav] [data-rightbar-col]'))
  assert.match(hidden, /display:none!important/, 'it stays hidden while collapsed')
  // A strip of the conversation stays visible, and the scrim over it is the way out.
  // Fullscreen: the panel is the whole screen, so nothing is left beside it to tap.
  assert.match(shown, /inset:0/)
  assert.match(shown, /width:100%!important/)
  assert.equal(css.includes('bt-right-scrim'), false, 'no strip means no scrim')
})
