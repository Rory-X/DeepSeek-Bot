import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardExcerpt, splitBackgroundJobs } from '../src/client/board-detail-model.js'

test('background tasks hide only proven terminal states, retaining failed and unfamiliar states', () => {
  const jobs = ['running', 'stopping', 'failed', 'unknown', 'future-status', 'completed', 'killed', 'confirmed-stopped'].map((status, index) => ({ id: index, status }))
  const { current, history } = splitBackgroundJobs(jobs)
  assert.deepEqual(current.map(job => job.status), ['running', 'stopping', 'failed', 'unknown', 'future-status'])
  assert.deepEqual(history.map(job => job.status), ['completed', 'killed', 'confirmed-stopped'])
  assert.equal(current.length + history.length, jobs.length)
  assert.equal(history[2], jobs[7])
  assert.deepEqual(splitBackgroundJobs(), { current: [], history: [] })
})

test('long excerpts are literal and do not split emoji or invent a result', () => {
  assert.equal(boardExcerpt('Short result.'), null)
  assert.equal(boardExcerpt(''), null)
  const source = '验证未执行。\n  环境受限 🧪' + '证据'.repeat(120)
  const preview = boardExcerpt(source, 15)
  assert.equal(preview, Array.from(source).slice(0, 15).join('') + '…')
  assert.ok(preview.startsWith('验证未执行。'))
  assert.equal(boardExcerpt('a'.repeat(99) + '🧪END'), 'a'.repeat(99) + '🧪…')
  assert.equal(boardExcerpt('验证未执行。\n\n```json\n' + 'x'.repeat(120)), '验证未执行。…')
})
