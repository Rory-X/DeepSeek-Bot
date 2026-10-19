import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardReply } from '../dev/mock-board.mjs'

test('a resumed mock attempt reads fresh state when DSH combines it with an old tool result', () => {
  const result = boardReply({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-write', content: 'Created file' }, { type: 'text', text: '[Project requirement card] Resume\nExecution attempt: new-job.' }] }],
    tools: new Set(['read_project_board']),
    textOf: content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    tool: (name, input) => ({ name, input }), text: text => ({ text }),
  })
  assert.deepEqual(result, [{ name: 'read_project_board', input: { id: 'card' } }])
})
