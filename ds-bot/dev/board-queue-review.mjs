import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../..'), home = join(root, '.dsh-test-project-board-queue'), out = join(root, 'shots/project-board-stage3')
const log = await readFile(join(home, 'web.log'), 'utf8')
const login = log.match(/http:\/\/127\.0\.0\.1:3110\/\?token=\S+/)?.[0]
assert.ok(login)
const auth = await fetch(login, { redirect: 'manual' })
const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const api = async (endpoint, payload = {}) => {
  const data = await fetch('http://127.0.0.1:3110/api/bot', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) }).then(response => response.json())
  assert.ok(data.ok, data.error?.message); return data.value
}
const until = async fn => { for (let i = 0; i < 240; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 300)) } throw new Error('Paused-view verification timed out') }
const team = await api('state'), project = (await api('board-view')).projects.find(project => project.title === 'Studio')
const get = async card => (await api('board-view')).cards.find(item => item.id === card.id)
const start = async (title, name) => {
  const card = await api('board-create', { projectId: project.id, requestId: crypto.randomUUID(), title, description: 'Build a small filter within the assigned file scope.', acceptance: 'Only the selected project is returned.', leadId: team.mainBotId, collaboratorIds: [team.bots.find(bot => bot.name === name).id] })
  await api('board-start', { id: card.id, version: card.version })
  const planned = await until(async () => { const next = await get(card); return next.decisions.some(item => item.status === 'open') && next })
  const decision = planned.decisions.find(item => item.status === 'open')
  await api('board-decide', { id: card.id, decisionId: decision.id, decisionVersion: decision.version, choice: 'approve' })
  return card
}
const card = await start('Pause without losing saved work', 'Nova')
await until(() => access(join(card.projectPath, `board-demo-${card.number}-${card.id.slice(0, 8)}.mjs`)).then(() => true, () => false))
const peer = await start('Next Studio requirement', 'Sage')
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS } })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  page.setDefaultTimeout(20000)
  await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  await page.goto(login)
  await page.locator('.bt-board-entry').first().click()
  await page.locator('.bt-board-project').filter({ hasText: 'Studio' }).click()
  await page.getByRole('button', { name: card.title, exact: true }).click()
  await page.getByRole('button', { name: 'Pause requirement', exact: true }).click()
  await until(async () => (await get(card)).status === 'paused')
  await page.locator('.bt-board-queue').getByText('Paused', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Resume requirement', exact: true }).waitFor()
  const queue = (await api('board-view')).queue.find(item => item.cardId === card.id)
  assert.equal(queue.blockedBy, undefined)
  await page.screenshot({ path: join(out, '03-paused-task.png') })
  await api('board-cancel', { id: peer.id, requestId: crypto.randomUUID() })
  await until(async () => (await get(peer)).status === 'cancelled')
  const checks = JSON.parse(await readFile(join(out, 'checks.json'), 'utf8'))
  checks.checks = [...new Set([...checks.checks, 'paused work stays labelled Paused while another requirement owns the project'])]
  await writeFile(join(out, 'checks.json'), JSON.stringify(checks, null, 2))
  console.log('PASS paused queue label and preserved progress')
} finally { await browser.close() }
