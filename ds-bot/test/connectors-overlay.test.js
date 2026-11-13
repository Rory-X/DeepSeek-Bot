import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogWithOverlay } from '../src/host/connectors/index.js'

test('a catalog overlay replaces a matching service and appends new instance ids', () => {
  const catalog = [
    { id: 'github', name: 'GitHub' },
    { id: 'neon', name: 'Neon', remote: { url: 'https://mcp.neon.tech/mcp' } },
  ]
  const rows = catalogWithOverlay([
    { id: 'neon', name: 'Neon P1', remote: { url: 'https://mcp.neon.tech/mcp?projectId=p1' } },
    { id: 'neon-2', name: 'Neon P2' },
  ], catalog)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(row => row.name), ['GitHub', 'Neon P1', 'Neon P2'])
  assert.equal(rows[1].remote.url, 'https://mcp.neon.tech/mcp?projectId=p1')
})

test('a malformed or duplicate overlay entry cannot double a catalog row', () => {
  const catalog = [{ id: 'neon', name: 'Neon' }]
  const rows = catalogWithOverlay([
    null,
    { name: 'no id' },
    { id: 'neon-2', name: 'Neon P2' },
    { id: 'neon-2', name: 'Neon P2 again' },
    { id: 'neon', name: 'Neon replaced' },
  ], catalog)
  assert.deepEqual(rows.map(row => row.id), ['neon', 'neon-2'])
  assert.equal(rows[0].name, 'Neon replaced')
})
