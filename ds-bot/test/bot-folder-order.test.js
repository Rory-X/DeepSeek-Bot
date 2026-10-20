import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitBotFolders } from '../src/client/bot-folder-order.js'

const row = (id, pinned = false, kind = 'bot') => ({ kind, item: { id, pinned } })
const ids = rows => rows.map(entry => entry.item.id)

test('pinned folder members join pinned chats above folders without duplicate rows or changed membership', () => {
  const order = [row('auth', true), row('designer', true), row('room', true, 'room'), row('gmail'), row('writer'), row('agent', false, 'agent')]
  const folders = [{ id: 'connectors', botIds: ['auth', 'gmail'] }, { id: 'design', botIds: ['designer'], pinned: true }]
  const before = structuredClone({ order, folders })
  const view = splitBotFolders(order, folders)
  assert.deepEqual(ids(view.pinned), ['auth', 'designer', 'room'])
  assert.deepEqual(view.folders.map(folder => folder.id), ['design', 'connectors'])
  assert.deepEqual(ids(view.folders[0].entries), [])
  assert.deepEqual(ids(view.folders[1].entries), ['gmail'])
  assert.deepEqual(ids(view.loose), ['writer', 'agent'])
  const visible = ids([...view.pinned, ...view.folders.flatMap(folder => folder.entries), ...view.loose])
  assert.equal(new Set(visible).size, order.length)
  assert.equal(visible.length, order.length)
  assert.deepEqual({ order, folders }, before)
})

test('unpinning returns a Bot to its retained folder in the current list order', () => {
  const folders = [{ id: 'connectors', botIds: ['auth', 'gmail'], pinned: true }]
  const pinned = splitBotFolders([row('auth', true), row('gmail')], folders)
  assert.deepEqual(ids(pinned.pinned), ['auth'])
  const unpinned = splitBotFolders([row('gmail'), row('auth')], folders)
  assert.deepEqual(unpinned.pinned, [])
  assert.deepEqual(unpinned.loose, [])
  assert.deepEqual(ids(unpinned.folders[0].entries), ['gmail', 'auth'])
  assert.deepEqual(unpinned.folders[0].botIds, ['auth', 'gmail'])
})

test('folders retain every member when all are pinned, and dissolving releases membership only', () => {
  const order = [row('auth', true), row('gmail', true)]
  const folders = [{ id: 'connectors', botIds: ['auth', 'gmail'] }]
  const grouped = splitBotFolders(order, folders)
  assert.deepEqual(grouped.folders[0].botIds, ['auth', 'gmail'])
  assert.deepEqual(grouped.folders[0].entries, [])
  assert.deepEqual(ids(grouped.pinned), ['auth', 'gmail'])
  const dissolved = splitBotFolders(order, [])
  assert.deepEqual(ids(dissolved.pinned), ['auth', 'gmail'])
  assert.deepEqual(dissolved.folders, [])
  const unpinned = splitBotFolders([row('gmail', true), row('auth')], [])
  assert.deepEqual(ids(unpinned.loose), ['auth'])
})
