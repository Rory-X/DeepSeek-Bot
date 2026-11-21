import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['b1'],
  revision: 1,
  bots: { b1: { id: 'b1', sessionId: 'b1', name: 'Writer', role: 'Writer', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('tool schemas are cached across save refreshes and unrelated tools/change churn', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-schema-cache-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const restricted = []
  const agent = {
    id: 'b1',
    session: { id: 'b1' },
    ctx: {
      tools: {
        register: () => () => {},
        restrict: filter => { restricted.push(filter); return () => {} },
      },
      on: () => () => {},
      effect: () => {},
    },
  }
  const services = { agents: { list: () => [] } }
  const ctx = fakeContext({ services })
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  services.agents.list = () => [agent]
  rt.connectorOffFor = () => ['mcp__notion__']
  let reads = 0
  // ToolsService.schemas() is a method that reads this.definitions(), and Cordis
  // returns a fresh shadow method on every ctx.tools.schemas read. Model both: a
  // stable arrow fake would miss an unbound call and a reader-identity cache.
  const definitions = [
    { name: 'bash' },
    { name: 'ask_user_question' },
    { name: 'mcp__notion__search' },
    { name: 'cua' },
  ]
  ctx.tools.definitions = () => definitions
  Object.defineProperty(ctx.tools, 'schemas', {
    configurable: true,
    get() {
      return function schemas() {
        reads += 1
        return this.definitions().map(definition => ({ ...definition }))
      }
    },
  })
  assert.notStrictEqual(ctx.tools.schemas, ctx.tools.schemas)

  // hideBotUnusedTools reads once; maskConnectorTools in the same epoch reuses it.
  rt.hideBotUnusedTools(agent)
  assert.equal(reads, 1)
  assert.equal(rt.toolSchemasFor(agent), rt.toolSchemasFor(agent))
  rt.reapplyToolMasks()
  assert.equal(reads, 1)

  // computer.denyNames uses the same cached array.
  rt.refreshComputer()
  assert.equal(reads, 1)

  // Save-time refreshes do not change the tools, so they reuse the cache.
  await rt.save()
  await rt.save()
  await rt.save()
  assert.equal(reads, 1)

  // tools/change fires for every scoped registration and restriction; an event
  // from elsewhere does not change this agent's definitions, so it keeps the cache.
  const before = rt.toolSchemasFor(agent)
  for (let i = 0; i < 100; i += 1) ctx.emit('tools/change')
  assert.equal(reads, 1)
  rt.reapplyToolMasks()
  rt.refreshComputer()
  assert.equal(reads, 1)
  assert.equal(rt.toolSchemasFor(agent), before)

  // A real tool change invalidates the entry and projects once more.
  definitions.push({ name: 'extra_tool' })
  ctx.emit('tools/change')
  assert.equal(reads, 2)
  const after = rt.toolSchemasFor(agent)
  assert.notEqual(after, before)
  assert.equal(rt.toolSchemasFor(agent), after)

  // A later unrelated tools/change does not recompute the new entry.
  ctx.emit('tools/change')
  assert.equal(reads, 2)
  assert.ok(restricted.length > 0)
})
