import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { artifactTargets, artifactFileAddress } from '../src/shared/board-artifacts.js'
import { boardArtifactPreview } from '../src/host/board-artifacts.js'

test('artifact references recognize explicit paths, markdown links, multiple files and line numbers', () => {
  assert.deepEqual(artifactTargets('[报告](<reports/验收 report.md>)\n`reports/screen.png`\nreport.json:12\nhttps://example.test/result'), [
    { kind: 'file', value: 'reports/验收 report.md', label: '报告' },
    { kind: 'file', value: 'reports/screen.png', label: 'screen.png' },
    { kind: 'file', value: 'report.json', label: 'report.json', line: 12 },
    { kind: 'url', value: 'https://example.test/result', label: 'example.test/result' },
  ])
  assert.deepEqual(artifactTargets('commit abc123\ngit show abc123:path.md\njavascript:alert(1)\nhttps://user:secret@example.test/x\nfile:///tmp/x\n'), [])
  assert.equal(artifactTargets('report.md\nreport.md').length, 1)
})

test('file resource addresses preserve absolute paths and reserved Unicode path characters', () => {
  assert.equal(artifactFileAddress('task 1', '/project/报告 #%.md'), 'dsh-resource://file/session/task%201//project/%E6%8A%A5%E5%91%8A%20%23%25.md')
  assert.equal(artifactFileAddress('s', 'C:\\work\\test.md'), 'dsh-resource://file/session/s/C:/work/test.md')
})

test('preview uses the card task identity and project, never caller-supplied file or session fields', () => {
  const card = { id: 'card', leadId: 'lead', roomId: 'room', projectPath: '/projects/one', artifacts: [{ id: 'a', title: 'Report', reference: 'reports/result.md' }] }
  const rt = { state: { board: { cards: { card } } }, roomOf: () => ({ boardCardId: 'card', sessions: { lead: 'task-one' } }) }
  const preview = boardArtifactPreview(rt, { id: 'card', artifactId: 'a', path: '/wrong', sessionId: 'wrong' })
  assert.equal(preview.targets[0].address, artifactFileAddress('task-one', resolve(card.projectPath, 'reports/result.md')))
  assert.throws(() => boardArtifactPreview(rt, { id: '__proto__', artifactId: 'a' }), /no longer exists/)
  assert.throws(() => boardArtifactPreview(rt, { id: 'card', artifactId: 'missing' }), /no longer exists/)
  const snapshot = structuredClone(rt.state)
  rt.roomOf = () => ({ boardCardId: 'other', sessions: { lead: 'task-other' } })
  assert.match(boardArtifactPreview(rt, { id: 'card', artifactId: 'a' }).targets[0].unavailable, /unavailable/)
  assert.deepEqual(rt.state, snapshot)
})
