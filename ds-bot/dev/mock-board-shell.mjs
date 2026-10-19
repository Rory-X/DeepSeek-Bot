// Deterministic model only; all processes and files are created by real DSH tools.
export function shellBoardReply({ messages, tools, textOf, tool, text }) {
  if (process.env.MOCK_BOARD_SHELL !== '1' || !tools.has('read_project_board')) return
  const opener = messages.findLastIndex(message => message.role === 'user' && textOf(message.content).includes('[Project requirement '))
  if (opener < 0) return
  const prompt = textOf(messages[opener].content)
  if (!prompt.includes('Shell bench:')) return
  const id = /\[Project requirement ([^\]]+)\]/.exec(prompt)[1]
  const later = messages.slice(opener + 1)
  const blocks = later.flatMap(message => Array.isArray(message.content) ? message.content : [])
  const call = blocks.findLast(block => block.type === 'tool_use')
  const result = messages.at(-1)?.content?.find?.(block => block.type === 'tool_result')
  const read = () => [tool('read_project_board', { id })]
  if (!call || !result) return read()
  const rendered = textOf(result.content)
  const lastCard = blocks.filter(block => block.type === 'tool_result').map(block => { try { return JSON.parse(textOf(block.content)).cards?.[0] } catch { return undefined } }).filter(Boolean).at(-1)
  const file = 'shell-bench-' + id
  if (call.name === 'bash') {
    if (result.is_error || /sandbox.*unavailable|no sandbox backend|Error:|exit code: [1-9]/i.test(rendered)) return [text('Shell bench failed: ' + rendered.slice(0, 600))]
    if (call.input?.run_in_background || /run_in_background/.test(JSON.stringify(call.input)) || (!prompt.includes('Recovery checkpoint') && prompt.includes('Assigned step: build'))) return [text('The DSH background shell is running. The board must retain its execution lease while this Agent is idle.')]
    return read()
  }
  if (call.name === 'read') return [tool('reconcile_requirement_work', { observations: 'Read the saved heartbeat from the stopped shell. Preserve its single start record and finish the remaining output; do not launch the original worker again.', references: [lastCard.projectPath + '/' + file + '.ticks', lastCard.projectPath + '/' + file + '.starts'] })]
  if (call.name === 'reconcile_requirement_work') return read()
  if (call.name !== 'read_project_board') return [text('Recorded the shell verification result on the board.')]
  let data
  try { data = JSON.parse(rendered) } catch { return [text('Unreadable board response')] }
  const card = data.cards?.[0]
  if (!card) return [text('No assigned requirement')]
  const args = { id, version: card.version }, job = card.deliveries.find(job => job.id === /Execution attempt: ([^.]+)\./.exec(prompt)?.[1])
  if (job?.recovery && !job.reconciled) return [tool('read', { file_path: file + '.ticks' })]
  if (['clarification', 'design'].includes(card.stage) && !card.decisions.some(d => d.status === 'open')) return [tool('plan_requirement', {
    ...args, summary: 'Run a DSH-managed shell that records one start and writes a heartbeat. Verify process shutdown, retained output and recovery without repeating the initial launch.',
    steps: [
      { id: 'build', title: 'Run the background shell worker', assigneeId: card.collaboratorIds[0], phase: 'implementation', scope: file + '.* within this isolated workspace', dependsOn: [] },
      { id: 'verify', title: 'Verify the saved shell result', assigneeId: card.leadId, phase: 'validation', scope: 'Read-only shell assertions on ' + file + '.*', dependsOn: ['build'] },
    ],
  })]
  const stepId = /Assigned step: ([^.]+)\./.exec(prompt)?.[1], step = card.steps.find(step => step.id === stepId)
  if (step?.status === 'running') {
    const bashCall = blocks.findLast(block => block.type === 'tool_use' && block.name === 'bash')
    if (!bashCall) {
      const script = step.phase === 'validation'
        ? `const f=require('fs'),a=require('assert/strict');a.equal(f.readFileSync('${file}.starts','utf8').trim().split('\\n').length,1);a.ok(f.readFileSync('${file}.done','utf8').includes('finished'));console.log('PASS single launch and retained output')`
        : job?.recovery ? `require('fs').writeFileSync('${file}.done','finished after reconciliation\\n');console.log('PASS recovered without relaunch')`
          : `const f=require('fs');const id='${id}';f.appendFileSync('${file}.starts',id+'\\n');let n=0;const t=setInterval(()=>f.writeFileSync('${file}.ticks',String(++n)),200);setTimeout(()=>{clearInterval(t);f.writeFileSync('${file}.done','finished\\n')},300000)`
      const command = 'node -e ' + "'" + script.replaceAll("'", "'\\''") + "'"
      return [tool('bash', { command, description: step.phase === 'validation' ? 'Verify shell start count and saved result' : 'Run isolated shell lifecycle verification worker', ...(step.phase === 'implementation' && !job?.recovery ? card.title.includes('timeout-promoted') ? { timeoutMs: 100 } : { run_in_background: true } : {}) })]
    }
    return [tool('update_requirement_step', { ...args, stepId, status: 'done', summary: step.phase === 'validation' ? 'Shell assertions passed: one original start and saved output.' : 'Reconciled the stopped shell and finished without repeating its original launch.', evidence: 'PASS: DSH bash command completed with exit code 0; see task conversation and ' + file + '.starts / .done' })]
  }
  if (card.stage === 'validation' && card.steps.every(s => s.status === 'done') && !card.decisions.some(d => d.status === 'open')) return [tool('submit_requirement', {
    ...args, summary: 'Background worker stopped, saved progress reconciled, remaining output completed. Independent shell assertions confirm one original launch.',
    evidence: card.acceptance.split('\n').filter(Boolean).map(() => ({ result: 'passed', detail: card.steps[1].evidence, reference: card.projectPath + '/' + file + '.starts' })),
    artifacts: [{ title: 'Shell lifecycle output', summary: 'Original launch record, retained heartbeat and recovered output.', reference: card.projectPath + '/' + file + '.done' }],
  })]
  return [text('Waiting for the next assigned step.')]
}
