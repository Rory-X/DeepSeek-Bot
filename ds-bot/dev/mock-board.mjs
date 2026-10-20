// Scripted test Bot: every board change runs through the normal registered tool.
// Its tiny fixture uses DSH's scoped file tools; the bench runner also executes it.
import { shellBoardReply } from './mock-board-shell.mjs'
import { stageBoardReply } from './mock-board-stages.mjs'
export function boardReply({ messages, tools, textOf, tool, text }) {
  const stages = stageBoardReply({ messages, tools, textOf, tool, text })
  if (stages) return stages
  const shell = shellBoardReply({ messages, tools, textOf, tool, text })
  if (shell) return shell
  if (!tools.has('read_project_board')) return
  const opener = messages.findLastIndex(message => message.role === 'user' && textOf(message.content).includes('[Project requirement '))
  if (opener < 0) return
  const prompt = textOf(messages[opener].content)
  const id = /\[Project requirement ([^\]]+)\]/.exec(prompt)?.[1]
  const later = messages.slice(opener + 1)
  // A new ordinary message must not replay an old board job.
  if (later.some(message => message.role === 'user' && !message.content?.some?.(block => block.type === 'tool_result'))) return
  const result = messages.at(-1)?.content?.find?.(block => block.type === 'tool_result')
  const call = [...later].reverse().flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'tool_use')
  const read = () => [tool('read_project_board', { id })]
  // DSH may combine an aborted attempt's last tool result with the new prompt.
  if (!result || !call) return read()
  const rendered = textOf(result.content)
  const filename = number => `board-demo-${number}-${id.slice(0, 8)}.mjs`
  const previousCard = later.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result').map(block => { try { return JSON.parse(textOf(block.content)).cards?.[0] } catch { return undefined } }).filter(Boolean).at(-1)
  if (call?.name === 'list_bots' && previousCard?.description.includes('[staffing bench]')) {
    const roster = later.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'tool_result').map(block => { try { return JSON.parse(textOf(block.content)).bots } catch { return undefined } }).filter(Boolean).at(-1)
    const developer = roster?.find(bot => bot.role === 'Frontend engineer' && bot.id !== previousCard.leadId)
    if (!developer) return [text('No fixture developer exists; cannot assign this test requirement.')]
    return [tool('assign_requirement_bots', { id, version: previousCard.version, collaboratorIds: [developer.id], summary: `${developer.name} implements the project filter. The coordinator independently reviews project isolation and empty results.` })]
  }
  if (call?.name === 'assign_requirement_bots') return read()
  if (call?.name === 'write') return Object.assign([tool('read', { file_path: filename(previousCard.number) })], { delay: Number(process.env.MOCK_BOARD_HOLD_MS ?? 0) || undefined })
  if (call?.name === 'read') return read()
  let data
  try { data = JSON.parse(rendered) } catch { return [text('Bench tool response: ' + rendered.slice(0, 300))] }
  if (data.error) return /changed/.test(data.error) ? read() : [text('Bench board error: ' + data.error)]
  if (call?.name === 'reconcile_requirement_work') return read()
  if (call?.name !== 'read_project_board') return [text('Board updated with the recorded result.')]
  const card = data.cards?.[0]
  if (!card) return [text('Requirement is not assigned to this Bot.')]
  const args = { id, version: card.version }
  const jobId = /Execution attempt: ([^.]+)\./.exec(prompt)?.[1]
  const job = card.deliveries?.find(item => item.id === jobId)
  if (job?.recovery && !job.reconciled) {
    const calls = later.flatMap(message => Array.isArray(message.content) ? message.content : [])
    const readCall = calls.findLast(block => block.type === 'tool_use' && block.name === 'read')
    if (!readCall) return [tool('read', { file_path: filename(card.number) })]
    const saved = calls.find(block => block.type === 'tool_result' && block.tool_use_id === readCall.id)
    const content = textOf(saved?.content)
    if (saved?.is_error && !/not exist|not found|ENOENT/i.test(content)) return [text('Cannot establish existing effects; manual review is needed.')]
    return [tool('reconcile_requirement_work', {
      observations: content.includes('cards.filter(card => card.projectId === project)') ? 'The previous attempt already wrote the project filter. I read and verified the existing file; I will report this result without writing it again.' : 'The file is absent. No completed output can be reused; continue the assigned step.',
      references: [card.projectPath + '/' + filename(card.number), 'Previous execution attempt ' + job.parentId],
    })]
  }
  if (card.stage === 'clarification' && card.description.includes('[staffing bench]') && !card.staffing) return [tool('list_bots', {})]
  if (card.stage === 'clarification' && card.description.includes('Remember filters') && !card.decisions.length) return [tool('ask_requirement_user', {
    ...args, question: 'Should filters be remembered separately for each project?', recommendation: 'Keep one saved filter per project so switching projects restores the previous view.', impact: 'The implementation plan waits for this product choice. Read-only investigation can continue.',
  })]
  if (['clarification', 'design'].includes(card.stage) && !card.decisions.some(item => item.status === 'open')) return [tool('plan_requirement', {
    ...args, summary: 'Add a small project filter module, keep the saved view scoped to its project, and verify project isolation' + (card.collaboratorIds.length ? ' with an independent reviewer.' : ' with a self-review; no independent reviewer is assigned.') + ' This bench uses a tiny executable fixture to exercise the real workflow.',
    steps: [
      { id: 'build', title: 'Implement the project filter', assigneeId: card.collaboratorIds[0] ?? card.leadId, phase: 'implementation', scope: filename(card.number), dependsOn: [] },
      { id: 'verify', title: card.collaboratorIds.length ? 'Verify project isolation independently' : 'Self-review project isolation', assigneeId: card.leadId, phase: 'validation', scope: `Review ${filename(card.number)} for isolation and empty-array behavior; do not modify it`, dependsOn: ['build'] },
    ],
  })]
  const stepId = /Assigned step: ([^.]+)\./.exec(prompt)?.[1]
  const step = card.steps.find(item => item.id === stepId)
  if (step?.status === 'running') {
    const calls = later.flatMap(message => Array.isArray(message.content) ? message.content : [])
    const reviewed = calls.findLast(block => block.type === 'tool_use' && block.name === 'read')
    const file = filename(card.number)
    if (!reviewed) {
      const source = 'export const forProject = (cards, project) => cards.filter(card => card.projectId === project);\n'
      return step.phase === 'implementation' ? [tool('write', { file_path: file, content: source })] : [tool('read', { file_path: file })]
    }
    const fileResult = calls.find(block => block.type === 'tool_result' && block.tool_use_id === reviewed.id)
    const content = textOf(fileResult?.content)
    if (job?.reconciled && step.phase === 'implementation' && fileResult?.is_error && /not exist|not found|ENOENT/i.test(content)) return [tool('write', { file_path: file, content: 'export const forProject = (cards, project) => cards.filter(card => card.projectId === project);\n' })]
    if (fileResult?.is_error || !content.includes('cards.filter(card => card.projectId === project)')) return [text('Fixture could not be verified; no success will be recorded. ' + content.slice(0, 300))]
    return [tool('update_requirement_step', { ...args, stepId, status: 'done', summary: step.phase === 'implementation' ? 'Project filter module written and read back in the assigned workspace.' : (card.collaboratorIds.length ? 'Independent static review' : 'Self-review') + ' confirms the project predicate and empty-array behavior.', evidence: `PASS: ${file}, read through the DSH file tool. The predicate only keeps matching project ids; filtering an empty array returns []. This is a static review, not a shell test run.` })]
  }
  if (card.stage === 'validation' && card.steps.every(step => step.status === 'done') && !card.decisions.some(item => item.status === 'open')) return [tool('submit_requirement', {
    ...args, summary: 'The project filter is implemented and ' + (card.collaboratorIds.length ? 'independently checked.' : 'self-reviewed by the same Bot.') + ' Please review the deliverable and evidence.',
    evidence: card.acceptance.split('\n').filter(Boolean).map(() => ({ result: 'passed', detail: card.steps.find(step => step.phase === 'validation').evidence, reference: `DSH task conversation · verify · ${filename(card.number)}` })),
    artifacts: [{ title: 'Project filter module', summary: card.collaboratorIds.length ? 'Executable bench fixture, reviewed by the lead Bot after the collaborator implemented it.' : 'Executable bench fixture, implemented and self-reviewed by one Bot.', reference: `${card.projectPath}/${filename(card.number)}` }],
  })]
  return [text('Waiting for the next board decision or assigned step.')]
}
