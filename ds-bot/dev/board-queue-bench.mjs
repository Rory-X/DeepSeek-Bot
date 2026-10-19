// Read-only Session audit for the isolated fault-injection bench, through public DSH APIs.
import { basename } from 'node:path'
import { apply as registerProjects } from './board-bench.mjs'
export const name = 'project-board-queue-fixture'
export const inject = ['workspaceRegistry', 'sessionController', 'connection', 'jobs']
export function apply(ctx) {
  if (!['.dsh-test-project-board-queue', '.dsh-test-project-board-shell'].includes(basename(process.env.DSH_HOME ?? '')) || process.env.DSH_BOARD_DEMO !== '1') throw new Error('Queue audit requires its isolated bench')
  registerProjects(ctx)
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/board-bench', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const { sessionId } = await request.json()
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if (resolved.error) return Response.json({ error: resolved.error.message }, { status: 400 })
      const throughSeq = Number(resolved.agent.session.seq) - 1
      const messages = [], tools = [], lifecycle = []
      let beforeSeq
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await ctx.sessionController.page({ address: { kind: 'session', sessionId }, throughSeq, maxMessages: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, request.signal)
        for (const { event } of page.records) {
          if (event.type === 'user/message' && event.data?.source?.role === 'board') messages.push({ id: event.data.source.exchangeId, turn: event.data.turn })
          if (event.type === 'tool/call') tools.push({ name: event.data.name, arguments: event.data.arguments })
          if (event.type === 'turn/start' || event.type === 'turn/end') lifecycle.push({ type: event.type, seq: event.seq, turn: event.data?.turn, reason: event.data?.reason })
        }
        if (!page.hasMore || !page.records.length) break
        beforeSeq = page.records[0].event.seq
      }
      return Response.json({ messages, tools, lifecycle, agentStatus: resolved.agent.status, jobs: ctx.jobs.list(sessionId).filter(job => job.owner === sessionId).map(({ id, kind, status }) => ({ id, kind, status })) })
    },
  }), 'board bench: Session audit')
}
