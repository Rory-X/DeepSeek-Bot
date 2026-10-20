// Scripted isolated bench: inspect an existing fixture without an implementation stage.
export function stageBoardReply({ messages, tools, textOf, tool, text }) {
  if (!tools.has('read_project_board')) return
  const opener = messages.findLastIndex(message => message.role === 'user' && textOf(message.content).includes('[Project requirement '))
  if (opener < 0) return
  const prompt = textOf(messages[opener].content)
  if (!prompt.includes('[stage skip bench]')) return
  const id = /\[Project requirement ([^\]]+)\]/.exec(prompt)?.[1]
  const later = messages.slice(opener + 1)
  if (later.some(message => message.role === 'user' && !message.content?.some?.(block => block.type === 'tool_result'))) return
  const blocks = later.flatMap(message => Array.isArray(message.content) ? message.content : [])
  const call = blocks.findLast(block => block.type === 'tool_use')
  const result = blocks.findLast(block => block.type === 'tool_result')
  const read = () => [tool('read_project_board', { id })]
  if (!call || !result || call.name === 'read') return read()
  let data
  try { data = JSON.parse(textOf(result.content)) } catch { return [text('Cannot read bench tool response.')] }
  if (data.error) return /changed/.test(data.error) ? read() : [text('Bench failed: ' + data.error)]
  if (call.name !== 'read_project_board') return [text('Recorded the applicable work on the board.')]
  const card = data.cards?.[0]
  if (!card) return [text('No assigned bench card.')]
  const args = { id, version: card.version }
  if (card.decisions.some(item => item.status === 'open')) return [text('Waiting for user authorization.')]
  if (['clarification', 'design'].includes(card.stage)) return [tool('plan_requirement', {
    ...args, summary: '只读检查已有文件。需求和字段约定已明确，无需额外澄清、方案设计或代码实现；保留验证步骤与用户验收。',
    stages: [
      { stage: 'confirmation', status: 'completed', reason: '用户已确认本次只读检查的范围和验收标准。' },
      { stage: 'clarification', status: 'skipped', reason: '文件和期望字段已给定，无需额外需求澄清。' },
      { stage: 'design', status: 'skipped', reason: '沿用现有文件格式，不涉及新方案或架构设计。' },
      { stage: 'implementation', status: 'skipped', reason: '只需核对已有文件，本需求不修改任何代码。' },
    ],
    steps: [{ id: 'verify', title: '只读验证已有文件', phase: 'validation', assigneeId: card.leadId, scope: 'Read stage-fixture.json and compare status with ok; do not modify it', dependsOn: [] }],
  })]
  const stepId = /Assigned step: ([^.]+)\./.exec(prompt)?.[1]
  if (stepId && card.steps.find(step => step.id === stepId)?.status === 'running') {
    const readCall = blocks.findLast(block => block.type === 'tool_use' && block.name === 'read')
    if (!readCall) return [tool('read', { file_path: 'stage-fixture.json' })]
    const fileResult = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === readCall.id)
    if (!fileResult || fileResult.is_error || !textOf(fileResult.content).includes('"status":"ok"')) return [text('Fixture does not match; do not report success.')]
    return [tool('update_requirement_step', { ...args, stepId, status: 'done', summary: '只读检查通过：status 字段为 ok。', evidence: 'DSH read 工具读回 stage-fixture.json，包含 "status":"ok"。未修改文件，也未运行 shell 测试。' })]
  }
  if (card.stage === 'validation' && card.steps.every(step => step.status === 'done')) return [tool('submit_requirement', {
    ...args, summary: '已有文件的只读检查已完成；澄清、设计和实现均因不适用而跳过。请确认验收。',
    evidence: [{ result: 'passed', detail: card.steps[0].evidence, reference: card.projectPath + '/stage-fixture.json' }],
    artifacts: [{ title: '已有文件检查记录', summary: '复用原文件，记录只读核对结果。', reference: card.projectPath + '/stage-fixture.json' }],
  })]
  return [text('Waiting for the next assigned phase.')]
}
