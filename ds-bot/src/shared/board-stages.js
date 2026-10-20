export const BOARD_STAGES = ['confirmation', 'clarification', 'design', 'implementation', 'validation']
export const EXECUTION_STAGES = ['implementation', 'validation']

export const stageSkipped = (card, stage) => card.stageOutcomes?.[stage]?.status === 'skipped'

// A later stage or an accepted card is not evidence that an earlier stage ran.
// Old cards without outcomes stay pending unless their own work records prove completion.
export function stageProgress(card) {
  return BOARD_STAGES.map(stage => {
    const outcome = card.stageOutcomes?.[stage]
    if (outcome && ['completed', 'skipped'].includes(outcome.status)) return { stage, ...outcome }
    const authorized = card.planVersion !== undefined && card.approvedPlan === card.planVersion
    if (EXECUTION_STAGES.includes(stage) && authorized) {
      const steps = (card.steps ?? []).filter(step => step.phase === stage)
      if (steps.length && steps.every(step => step.status === 'done' && step.evidence?.trim())) return { stage, status: 'completed', reason: 'All steps in this stage have completion evidence.' }
    }
    if (stage === 'design' && card.plan && authorized) return { stage, status: 'completed', reason: 'The implementation plan was submitted and approved.' }
    const current = card.stage === stage && !['backlog', 'done', 'cancelled'].includes(card.status)
    return { stage, status: current ? card.status === 'paused' ? 'paused' : 'active' : 'pending' }
  })
}

export function executionComplete(card) {
  return EXECUTION_STAGES.every(phase => {
    const steps = (card.steps ?? []).filter(step => step.phase === phase)
    return stageSkipped(card, phase) ? steps.length === 0 : steps.length > 0 && steps.every(step => step.status === 'done')
  })
}
