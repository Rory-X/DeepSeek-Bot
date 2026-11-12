import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/client/progressive-content.js', import.meta.url))], bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'] })
function fixture() {
  const frames = [], observed = new Set()
  let intersect
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: () => ({}),
    requestAnimationFrame: fn => frames.push(fn),
    IntersectionObserver: class {
      constructor(callback) { intersect = callback }
      observe(node) { observed.add(node) }
      unobserve(node) { observed.delete(node) }
      disconnect() { observed.clear() }
    },
  })
  return { ...module.exports, frames, observed, enter: nodes => intersect(nodes.map(target => ({ target, isIntersecting: true }))) }
}

test('offscreen history stays cheap; visible rich content mounts two rows per animation frame', () => {
  const f = fixture(), mounted = []
  const nodes = Array.from({ length: 100 }, (_, i) => ({ i }))
  const stop = nodes.map(node => f.observeContent(node, () => mounted.push(node.i)))
  assert.equal(mounted.length, 0)
  f.enter(nodes.slice(90))
  assert.equal(f.frames.length, 1)
  f.frames.shift()()
  assert.equal(mounted.length, 2)
  while (f.frames.length) f.frames.shift()()
  assert.deepEqual(mounted, nodes.slice(90).map(node => node.i))
  stop.forEach(dispose => dispose())
  assert.equal(f.observed.size, 0)
})

test('leaving a conversation cancels queued renders and observer cleanup is idempotent', () => {
  const f = fixture(), node = {}, mounted = []
  const stop = f.observeContent(node, () => mounted.push(true))
  f.enter([node])
  stop()
  stop()
  f.frames.shift()()
  assert.equal(mounted.length, 0)
  const other = {}, cleanup = f.observeContent(other, () => mounted.push(true))
  f.enter([other])
  f.frames.shift()()
  cleanup()
  assert.deepEqual(mounted, [true])
})
