// Synthetic visual scenarios, mounted only by the isolated project-board bench.
// Production packages do not export dev/ and cannot enable this fixture.
import { mkdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createDraft, emptyBoard } from '../src/host/board.js'

export const inject = ['workspaceRegistry']
export const name = 'project-board-fixture'

export function apply(ctx) {
  const home = process.env.DSH_HOME
  if (process.env.DSH_BOARD_DEMO !== '1' || !home || !['.dsh-test-project-board', '.dsh-test-project-board-workflow', '.dsh-test-project-board-queue', '.dsh-test-project-board-shell'].includes(basename(home))) throw new Error('This fixture requires the isolated project-board bench')
  ctx.effect(() => {
    let disposed = false
    const seed = async () => {
      for (const title of ['Studio', 'Companion']) {
        if (disposed) return
        const path = join(resolve(home), '..', '.board-test-projects', basename(home), title.toLowerCase())
        await mkdir(path, { recursive: true })
        if (!await ctx.workspaceRegistry.resolveByPath(path)) await ctx.workspaceRegistry.create(path, title)
      }
    }
    void seed().catch(error => ctx.logger.error('project-board fixture failed: %s', error.message))
    return () => { disposed = true }
  })
}

// Called by board-seed.mjs only after its own bench has stopped.
export async function seedBenchCards(rt) {
      if (rt.state.board) return
      const ctx = rt.ctx
      const home = process.env.DSH_HOME
      const projects = []
      for (const title of ['Studio', 'Companion']) {
        const path = join(resolve(home), '..', '.board-test-projects', basename(home), title.toLowerCase())
        await mkdir(path, { recursive: true })
        const workspace = await ctx.workspaceRegistry.resolveByPath(path) ?? await ctx.workspaceRegistry.create(path, title)
        projects.push({ id: workspace.id, title, path })
      }
      const members = []
      for (const [name, role, color, shape] of [['Atlas', 'Product & architecture', 'purple', 'cat'], ['Nova', 'Frontend engineer', 'blue', 'drop'], ['Sage', 'Quality engineer', 'green', 'leaf']]) {
        const existing = Object.values(rt.state.bots).find(bot => bot.name === name)
        const bot = existing ?? await rt.createBot({ name, role, color, avatar: { shape }, pickModel: true })
        members.push(bot)
      }
      const leadId = rt.state.mainBotIds[0]
      const now = Date.now()
      let board = emptyBoard()
      const specs = [
        ['Design a clearer project switcher', 'backlog', 'confirmation', leadId, [members[0].id], 'Keep each project one click away.', 0],
        ['Remember each project’s filters', 'backlog', 'confirmation', members[1].id, [], 'Restore the view when you return.', 0],
        ['Keep board changes in sync', 'active', 'implementation', members[1].id, [members[2].id], 'Two browser windows, one reliable board.', 3],
        ['Make the board comfortable on mobile', 'active', 'design', members[0].id, [members[1].id], 'Readable cards and a full-screen detail view.', 1],
        ['Add a focused requirement detail panel', 'active', 'design', leadId, [members[0].id, members[1].id], 'A place for the brief, decisions and evidence.', 2, 'design'],
        ['Protect drafts from conflicting edits', 'active', 'validation', members[1].id, [members[2].id], 'Ready for your final acceptance.', 4, 'acceptance'],
        ['Keep project scopes separate', 'done', 'validation', members[2].id, [], 'Project switching preserves the current conversation.', 4],
      ]
      for (let i = 0; i < specs.length; i++) {
        const [title, status, stage, owner, collaborators, summary, completed, decision] = specs[i]
        const result = createDraft(board, {
          projectId: projects[0].id, requestId: 'fixture-' + i, title, leadId: owner, collaboratorIds: collaborators,
          description: summary + '\n\nUsers should be able to understand the next step without searching through chat history. Keep the experience consistent with the existing DS Bot interface.',
          acceptance: 'The requirement stays attached to its DSH project.\nKeyboard and touch interactions remain accessible.\nRefreshing the page preserves the saved state.',
        }, { projects, bots: rt.state.bots, now: now - (i + 1) * 12 * 60000, id: 'demo-card-' + i })
        board = result.board
        const card = result.card
        Object.assign(card, { status, stage, summary })
        if (status !== 'backlog') card.steps = ['Clarify the expected behavior', 'Review the interaction proposal', 'Build with existing components', 'Verify the result and collect evidence'].map((title, n) => ({
          id: card.id + '-step-' + n, title, assigneeId: n === 3 ? members[2].id : owner, status: n < completed ? 'done' : n === completed ? 'running' : 'queued',
        }))
        if (decision) card.decisions = [{
          id: card.id + '-decision', kind: decision, status: 'open',
          question: decision === 'design' ? 'Use a side panel on desktop and a full-screen detail on mobile?' : 'Accept the verified draft conflict protection?',
          recommendation: decision === 'design' ? 'Recommended: keep the board in view while reading a requirement. Use the full screen when space is limited.' : 'The checks cover stale edits, retrying a request and saving across refreshes.',
          impact: decision === 'design' ? 'After confirmation, the lead can continue with implementation.' : 'Acceptance completes this requirement. You can also request changes.',
        }]
        if (completed >= 2) card.artifacts = [{ id: card.id + '-brief', title: 'Interaction proposal', summary: 'Synthetic bench artifact · scope, states and acceptance checklist' }]
        if (completed === 4) card.artifacts.push({ id: card.id + '-checks', title: 'Verification evidence', summary: 'Synthetic bench artifact · test outcomes and review notes' })
        if (status !== 'backlog') card.activity.push({ id: card.id + '-event', at: card.updatedAt, actor: owner, text: status === 'done' ? 'Accepted by user' : decision === 'design' ? 'Plan ready for confirmation' : decision === 'acceptance' ? 'Verification evidence submitted' : 'Implementation started' })
      }
      const second = createDraft(board, {
        projectId: projects[1].id, requestId: 'fixture-second', title: 'Improve first-run guidance', leadId, collaboratorIds: [members[0].id],
        description: 'Help a new user understand their Bot team.', acceptance: 'The next action is visible after setup.',
      }, { projects, bots: rt.state.bots, now, id: 'demo-second-project' })
      rt.state.board = second.board
      await rt.save()
}
