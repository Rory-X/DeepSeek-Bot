import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { migrateSidebarSections } from '../src/host/bot-folder-migration.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { ContextMenu } from './src/client/context-menu.js'\nexport { TeamSidebar } from './src/client/sidebar.js'\nexport { BotFolderSection, FolderColorPicker, folderStatus } from './src/client/bot-folders.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useEffect() {},
  useLayoutEffect() {},
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(),
  useRef: current => ({ current }),
  useId: () => 'id',
}
const mod = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module: mod,
  exports: mod.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
  document: { body: {}, documentElement: { hasAttribute: () => false }, addEventListener() {}, removeEventListener() {} },
})
const { ContextMenu, BotFolderSection, FolderColorPicker, folderStatus } = mod.exports

function start(saved) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-sections-'))
  if (saved !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const ctx = fakeContext()
  let sessions = 0
  Object.assign(ctx, {
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = name => rt.teamTools.find(entry => entry.name === name)
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, tool, stop, home }
}

const baseTeam = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Copy', instructions: '', createdAt: 2 },
    editor: { id: 'editor', sessionId: 'editor', name: 'Editor', role: 'Video', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: { id: 'r1', sessionId: 'r1', name: 'Video Room', named: true, members: ['chief', 'writer', 'editor'], admin: 'chief', mode: 'admin', notice: '', createdAt: 4 },
  },
})


test('legacy sections migrate Bots and colors into one folder system and survive a restart', async t => {
  const saved = baseTeam()
  saved.sections = [{ id: 'old', name: 'Writing', color: 'orange', collapsed: true }, { id: 'empty', name: 'New section 2' }]
  saved.bots.writer.sectionId = 'old'
  saved.rooms.r1.sectionId = 'old'
  const first = start(saved)
  t.after(first.stop)
  const state = (await first.call('state', { fast: true })).value
  assert.deepEqual(state.sections, [])
  assert.equal(state.botFolders.length, 1)
  assert.deepEqual(state.botFolders[0].botIds, ['writer'])
  assert.equal(state.botFolders[0].color, 'orange')
  assert.equal(state.botFolders[0].collapsed, true)
  const disk = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8'))
  assert.equal(disk.rooms.r1.name, saved.rooms.r1.name)
  assert.deepEqual(disk.legacySidebarSections.find(s => s.id === 'old').roomIds, ['r1'])
  assert.equal(disk.bots.writer.sectionId, undefined)
  const second = start(disk)
  t.after(second.stop)
  assert.deepEqual((await second.call('state', { fast: true })).value.botFolders, state.botFolders)
})

test('existing fork membership and chosen colors win over legacy sections without duplicate Bots', () => {
  const state = baseTeam()
  state.botFolders = { ours: { id: 'ours', name: 'Team', botIds: ['writer'], color: 'blue', version: 4 } }
  state.sections = [{ id: 'old', name: 'Writing', color: 'orange' }]
  state.bots.writer.sectionId = 'old'
  state.bots.editor.sectionId = 'old'
  assert.equal(migrateSidebarSections(state), true)
  assert.equal(state.botFolders.ours.color, 'blue')
  assert.deepEqual(state.botFolders.ours.botIds, ['writer'])
  const imported = Object.values(state.botFolders).find(f => f.id !== 'ours')
  assert.deepEqual(imported.botIds, ['editor'])
  assert.equal(imported.color, 'orange')
  const before = structuredClone(state)
  assert.equal(migrateSidebarSections(state), false)
  assert.deepEqual(state, before)
})

test('a legacy color enriches an existing fork folder and empty sections create no empty folders', () => {
  const state = baseTeam()
  state.botFolders = { ours: { id: 'ours', name: 'Team', botIds: ['writer'], version: 2 } }
  state.sections = [{ id: 'old', name: 'Old', color: 'green' }, { id: 'empty', name: 'Empty' }]
  state.bots.writer.sectionId = 'old'
  state.bots.chief.sectionId = 'old'
  migrateSidebarSections(state)
  assert.equal(Object.keys(state.botFolders).length, 1)
  assert.equal(state.botFolders.ours.color, 'green')
  assert.equal(state.botFolders.ours.version, 3)
  assert.deepEqual(state.botFolders.ours.botIds, ['writer'])
  assert.equal(state.bots.chief.sectionId, undefined)
})

test('retired mutation routes cannot create invisible sections or alter the Bot roster', async t => {
  const app = start(baseTeam())
  t.after(app.stop)
  const before = (await app.call('state', { fast: true })).value
  for (const endpoint of ['section-save', 'section-order', 'section-delete']) {
    const response = await app.call(endpoint, { name: 'Invisible', items: ['writer'] })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'bot/retired')
  }
  const after = (await app.call('state', { fast: true })).value
  assert.deepEqual(after.sections, [])
  assert.deepEqual(after.bots.map(b => b.id), before.bots.map(b => b.id))
})

const nodes = (tree, predicate, out = []) => {
  if (Array.isArray(tree)) { for (const node of tree) nodes(node, predicate, out); return out }
  if (!tree || typeof tree !== 'object') return out
  if (tree.type === FolderColorPicker) return nodes(FolderColorPicker(tree.props), predicate, out)
  if (predicate(tree)) out.push(tree)
  nodes(tree.props?.children, predicate, out)
  return out
}

test('folded fork folders show the color, three Bot avatars, overflow and aggregated working status', () => {
  const bots = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, sessionId: id }))
  const roster = { byId: Object.fromEntries(bots.map(b => [b.id, b])), bots, questions: {}, workspaceId: 'test' }
  const tree = BotFolderSection({ folder: { id: 'folder', name: 'Team', botIds: bots.map(b => b.id), collapsed: true, color: 'orange', entries: bots.map(b => ({ kind: 'bot', item: b })) },
    roster, actions: {}, renderRow: row => ({ type: 'div', props: { 'data-member': row.item.id } }),
    rowProps: { wide: true, useSessions: pick => pick({ byId: {} }), useSessionStatus: pick => pick(new Map([['a', { running: true }]])), useWork: pick => pick({}) } })
  assert.equal(nodes(tree, n => n.props?.className === 'bt-bot-folder-color').length, 1)
  assert.equal(nodes(tree, n => n.props?.bot && n.props?.size === 18).length, 3)
  assert.equal(nodes(tree, n => n.props?.className === 'bt-bot-folder-more')[0].props.children[0], '+1')
  assert.equal(nodes(tree, n => n.props?.['data-kind'] === 'working').length, 1)
  assert.equal(nodes(tree, n => n.props?.className === 'bt-bot-folder-rows')[0].props.hidden, true)
  assert.equal(nodes(tree, n => n.props?.['data-member']).length, 4, 'rows stay mounted for live state')
})

test('folder status prioritizes questions and approvals, then working, then unread outside the active chat', () => {
  const base = { statuses: [['a', false, true]], activeSession: 'a' }
  assert.equal(folderStatus(base), null)
  assert.equal(folderStatus({ ...base, activeSession: '' }), 'unread')
  assert.equal(folderStatus({ ...base, hasRoomWork: true }), 'working')
  assert.equal(folderStatus({ ...base, hasRoomWork: true, hasQuestion: true }), 'alert')
  assert.equal(folderStatus({ ...base, hasApproval: true }), 'alert')
})

test('the folder palette supports choosing and clearing color, and disables edits for read-only teams', () => {
  const picked = []
  const tree = FolderColorPicker({ color: 'blue', onChange: color => picked.push(color) })
  const buttons = nodes(tree, n => n.type === 'button')
  assert.equal(buttons.length, 6)
  assert.equal(buttons[1].props['aria-pressed'], true)
  buttons[2].props.onClick()
  buttons[0].props.onClick()
  assert.deepEqual(picked, ['orange', null])
  assert.ok(nodes(FolderColorPicker({ color: null, onChange() {}, disabled: true }), n => n.type === 'button').every(n => n.props.disabled))
})

test('legacy section menus are absent after retirement', () => {
  const roster = { byId: {}, roomsById: {}, agentsById: {} }
  for (const kind of ['section', 'section-add']) assert.equal(ContextMenu({ menu: { kind, id: 'retired', x: 10, y: 10 }, roster, actions: { closeMenu() {} } }), null)
})

test('one Bot in the narrow folder preview has no synthetic group-chat guest', () => {
  const writer = baseTeam().bots.writer
  const tree = BotFolderSection({ folder: { id: 'one', name: 'One', botIds: ['writer'], entries: [], collapsed: true },
    roster: { byId: { writer }, questions: {} }, actions: {}, renderRow: () => null, rowProps: { wide: false } })
  assert.equal(nodes(tree, node => node.props?.bot?.id === 'writer' && node.props?.size === 36).length, 1)
  assert.equal(nodes(tree, node => node.props?.room?.members).length, 0)
})

test('migration tolerates corrupt old folder records and preserves the first valid owner', () => {
  const state = baseTeam()
  state.botFolders = { broken: null, invalid: { id: 'invalid', name: null }, one: { id: 'one', name: 'One', botIds: ['writer'] }, duplicate: { id: 'duplicate', name: 'Duplicate', botIds: ['writer'] } }
  state.sections = [{ id: 'old', name: 'Old', color: 'orange' }]
  state.bots.writer.sectionId = 'old'
  migrateSidebarSections(state)
  assert.equal(state.botFolders.one.color, 'orange')
  assert.equal(state.botFolders.one.version, 1)
  assert.equal(state.botFolders.duplicate.color, undefined)
})
