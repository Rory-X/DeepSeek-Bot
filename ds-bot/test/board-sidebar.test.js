import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/client/board-sidebar.js', import.meta.url))], bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react'] })
const module = { exports: {} }
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: () => ({}), requestAnimationFrame: fn => fn() })
const { openBoardPreview } = module.exports
const fixture = ({ mounted = 'current', browser = true } = {}) => {
  const calls = []
  const sidebar = { mounted: { getSnapshot: () => mounted }, openResource: (...args) => calls.push(['file', ...args]), openTab: (...args) => calls.push(['tab', ...args]) }
  const ctx = { get: key => key === 'sidebarRight' ? sidebar : { get: () => browser }, sessions: { refresh: async () => {} }, uiWorkspace: { openSession: id => { calls.push(['session', id]); mounted = id } } }
  return { ctx, calls }
}
test('preview preserves the current conversation while opening a task-authorized file', async () => {
  const { ctx, calls } = fixture()
  await openBoardPreview({ ctx, preview: { roomId: 'task-room' }, target: { kind: 'file', address: 'dsh-resource://file/session/task//project/report.md', line: 7 } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'file'); assert.equal(calls[0][2].params.line, 7)
})
test('a missing foreground session uses the requirement conversation without starting Agent work', async () => {
  const { ctx, calls } = fixture({ mounted: undefined })
  // Explicitly empty because fixture defaults apply to undefined.
  ctx.get('sidebarRight').mounted.getSnapshot = () => calls.some(call => call[0] === 'session') ? 'task-room' : undefined
  await openBoardPreview({ ctx, preview: { roomId: 'task-room' }, target: { kind: 'file', address: 'dsh-resource://file/session/task//project/report.md' } })
  assert.equal(calls[0][0], 'session'); assert.equal(calls[0][1], 'task-room'); assert.equal(calls[1][0], 'file')
})
test('disabled Browser and cancelled opens do not navigate or change the sidebar', async () => {
  const { ctx, calls } = fixture({ browser: false })
  await assert.rejects(openBoardPreview({ ctx, preview: {}, target: { kind: 'url', value: 'https://example.test/' } }), /not enabled/)
  await openBoardPreview({ ctx, preview: {}, target: { kind: 'file', address: 'ignored' }, signal: { aborted: true } })
  assert.equal(calls.length, 0)
})
