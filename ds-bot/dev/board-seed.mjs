import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { seedBenchCards } from './board-bench.mjs'

const root = resolve(import.meta.dirname, '../..')
const home = join(root, '.dsh-test-project-board')
const port = 3107
process.env.DSH_HOME = home
const log = await readFile(join(home, 'web.log'), 'utf8')
const login = log.match(/http:\/\/127\.0\.0\.1:3107\/\?token=\S+/)?.[0]
assert.ok(login)
const response = await fetch(login, { redirect: 'manual' })
const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
assert.equal(response.status, 303)
const api = async (endpoint, payload = {}) => {
  const result = await fetch('http://127.0.0.1:' + port + '/api/bot', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
  }).then(r => r.json())
  assert.ok(result.ok, result.error?.message)
  return result.value
}
let team = await api('state')
for (const [name, role, color] of [['Atlas', 'Product & architecture', 'purple'], ['Nova', 'Frontend engineer', 'blue'], ['Sage', 'Quality engineer', 'green']]) {
  if (!team.bots.some(bot => bot.name === name)) await api('create-bot', { name, role, color })
}
team = await api('state')
assert.equal(team.bots.length, 4)
const view = await api('board-view')
assert.ok(view.projects.some(project => project.title === 'Studio'))
const stop = spawnSync('sh', ['dev/bench.sh', 'project-board', '3107', '8807', 'stop'], { cwd: join(root, 'ds-bot'), stdio: 'inherit', windowsHide: true })
assert.equal(stop.status, 0)
const statePath = join(home, 'bot/state.json')
const state = JSON.parse(await readFile(statePath, 'utf8'))
await seedBenchCards({
  state,
  ctx: { workspaceRegistry: { resolveByPath: async path => view.projects.find(project => project.path === path) } },
  save: async () => { state.revision++; await writeFile(statePath, JSON.stringify(state)) },
})
console.log('Synthetic board fixture saved while the bench is stopped')
