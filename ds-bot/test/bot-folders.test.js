import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { install } from '../src/host/bot-folders.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function fixture() {
  const bots = Object.fromEntries(['chief', 'auth', 'gmail', 'slack', 'drive', 'calendar', 'design'].map(id => [id, { id, name: id, role: id === 'design' ? 'Design' : 'Connectors' }]))
  const ctx = fakeContext()
  const rt = { ctx, state: { bots, mainBotIds: ['chief'], botFolders: {} }, load: async () => {}, refresh: async () => {}, save: async () => {}, readOnly: () => undefined,
    isMain: id => id === 'chief', selfOf: id => id === 'chief-part' ? 'chief' : id,
    findBot: name => Object.values(bots).find(bot => bot.name === name || bot.id === name) }
  install(rt)
  return rt
}
const five = ['auth', 'gmail', 'slack', 'drive', 'calendar']

test('one assignment creates a folder for five Bots, reuses names and moves without duplicates', async () => {
  const rt = fixture()
  const folder = await rt.botFolderMutate('assign', { name: ' connector ', botIds: five })
  assert.deepEqual(folder.botIds, five)
  await rt.botFolderMutate('assign', { name: 'CONNECTOR', botIds: ['auth', 'auth'] })
  assert.equal(rt.botFoldersView().length, 1)
  assert.deepEqual(rt.botFoldersView()[0].botIds, five)
  await rt.botFolderMutate('assign', { name: 'platform', botIds: ['auth'] })
  assert.deepEqual(rt.botFoldersView()[0].botIds, five.slice(1))
  await rt.botFolderMutate('assign', { name: '', botIds: ['gmail'] })
  assert.ok(rt.botFoldersView().every(item => !item.botIds.includes('gmail')))
  assert.equal(Object.keys(rt.state.bots).length, 7)
})

test('invalid batches do not move any member or create a folder', async () => {
  const rt = fixture()
  for (const botIds of [['auth', 'missing'], ['chief'], ['__proto__'], ['constructor'], null]) {
    await assert.rejects(rt.botFolderMutate('assign', { name: 'connector', botIds }))
    assert.deepEqual(rt.botFoldersView(), [])
  }
  for (const name of ['', ' ', '\nconnector', 'a'.repeat(49)]) {
    if (name === '') continue
    await assert.rejects(rt.botFolderMutate('assign', { name, botIds: ['auth'] }))
  }
})

test('UI saves replace membership, release unchecked Bots and protect concurrent edits', async () => {
  const rt = fixture()
  const folder = await rt.botFolderMutate('save', { name: 'connector', botIds: five })
  const current = await rt.botFolderMutate('save', { id: folder.id, version: folder.version, name: 'integration', botIds: ['auth'] })
  assert.deepEqual(current.botIds, ['auth'])
  await assert.rejects(rt.botFolderMutate('save', { id: folder.id, version: folder.version, name: 'stale', botIds: five }), /changed/)
  await assert.rejects(rt.botFolderMutate('delete', { id: folder.id }), /Move the Bots out/)
  await rt.botFolderMutate('save', { id: current.id, version: current.version, name: current.name, botIds: [] })
  await rt.botFolderMutate('delete', { id: current.id })
  assert.deepEqual(rt.botFoldersView(), [])
  assert.equal(Object.keys(rt.state.bots).length, 7)
})

test('source folder versions change when another folder takes their members', async () => {
  const rt = fixture()
  const source = await rt.botFolderMutate('assign', { name: 'connector', botIds: five })
  await rt.botFolderMutate('assign', { name: 'platform', botIds: ['auth'] })
  await assert.rejects(rt.botFolderMutate('save', { ...source, name: 'stale' }), /changed/)
  await assert.rejects(rt.botFolderMutate('rename', { id: source.id, name: 'PLATFORM' }), /already exists/)
})

test('concurrent same-name assignments serialize into one folder', async () => {
  const rt = fixture()
  rt.save = () => new Promise(resolve => setTimeout(resolve, 5))
  await Promise.all(five.map(id => rt.botFolderMutate('assign', { name: 'connector', botIds: [id] })))
  assert.equal(rt.botFoldersView().length, 1)
  assert.deepEqual(rt.botFoldersView()[0].botIds, five)
})

test('failed persistence and read-only teams leave no phantom changes', async () => {
  const rt = fixture()
  await rt.botFolderMutate('assign', { name: 'connector', botIds: five })
  const before = structuredClone(rt.state.botFolders)
  rt.save = async () => { throw new Error('disk full') }
  await assert.rejects(rt.botFolderMutate('assign', { name: 'other', botIds: ['auth'] }), /disk full/)
  assert.deepEqual(rt.state.botFolders, before)
  rt.readOnly = () => 'read-only team'
  await assert.rejects(rt.botFolderMutate('assign', { name: 'other', botIds: ['auth'] }), /read-only/)
  assert.deepEqual(rt.state.botFolders, before)
})

test('Main Bot tools accept name batches and reject ordinary Bots before any changes', async () => {
  const rt = fixture()
  const tool = rt.ctx.registeredTools.get('organize_bots')
  const args = { action: 'assign', folder: 'connector', bots: five }
  for (const id of ['auth', 'unknown', undefined]) await assert.rejects(tool.execute(args, { agent: { id } }), /Only a Main Bot/)
  assert.deepEqual(rt.botFoldersView(), [])
  await assert.rejects(tool.execute({ ...args, bots: ['auth', 'unknown'] }, { agent: { id: 'chief' } }), /No Bot named/)
  await tool.execute(args, { agent: { id: 'chief-part' } })
  const read = JSON.parse(await rt.ctx.registeredTools.get('list_bot_folders').execute({}, {}))
  assert.deepEqual(read[0].bots, five)
  await tool.execute({ action: 'rename', folder: 'connector', new_name: 'integrations' }, { agent: { id: 'chief' } })
  assert.equal(rt.botFoldersView()[0].name, 'integrations')
})

test('deleted Bots and a promoted primary Bot leave no ghost folder members', async () => {
  const rt = fixture()
  await rt.botFolderMutate('assign', { name: 'connector', botIds: ['auth', 'gmail'] })
  delete rt.state.bots.auth
  rt.state.mainBotIds = ['gmail', 'chief']
  assert.deepEqual(rt.botFoldersView()[0].botIds, [])
  await rt.botFolderMutate('delete', { id: rt.botFoldersView()[0].id })
})

test('folder names and membership survive a real store restart', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-folder-test-'))
  let ctx = fakeContext()
  let rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  await rt.load()
  rt.state.bots = fixture().state.bots
  rt.state.mainBotIds = ['chief']
  await rt.botFolderMutate('assign', { name: 'connector', botIds: five })
  const folder = rt.botFoldersView()[0]
  await rt.botFolderMutate('pin', { id: folder.id, version: folder.version, pinned: true })
  const before = rt.botFoldersView()
  await ctx.dispose()
  ctx = fakeContext()
  rt = createRuntime(ctx, { home })
  await rt.load()
  assert.deepEqual(rt.botFoldersView(), before)
  assert.equal(rt.botFoldersView()[0].pinned, true)
})

test('pinning survives membership edits and rejects invalid or stale requests', async () => {
  const rt = fixture()
  const folder = await rt.botFolderMutate('assign', { name: 'connector', botIds: five })
  await assert.rejects(rt.botFolderMutate('pin', { id: folder.id, pinned: 'yes' }), /whether/)
  const pinned = await rt.botFolderMutate('pin', { id: folder.id, version: folder.version, pinned: true })
  await assert.rejects(rt.botFolderMutate('pin', { id: folder.id, version: folder.version, pinned: false }), /changed/)
  const edited = await rt.botFolderMutate('save', { id: folder.id, version: pinned.version, name: 'integrations', botIds: ['auth'] })
  assert.equal(edited.pinned, true)
  assert.equal((await rt.botFolderMutate('pin', { id: folder.id, version: edited.version, pinned: false })).pinned, false)
})

test('dissolving a populated folder retains every Bot and other folders', async () => {
  const rt = fixture()
  rt.state.bots.auth.pinned = true
  const bots = structuredClone(rt.state.bots)
  const folder = await rt.botFolderMutate('assign', { name: 'connector', botIds: five })
  const other = await rt.botFolderMutate('assign', { name: 'design', botIds: ['design'] })
  await assert.rejects(rt.botFolderMutate('dissolve', { id: folder.id, version: 999 }), /changed/)
  await rt.botFolderMutate('dissolve', { id: folder.id, version: folder.version })
  assert.deepEqual(rt.state.bots, bots)
  assert.deepEqual(rt.botFoldersView(), [other])
})
