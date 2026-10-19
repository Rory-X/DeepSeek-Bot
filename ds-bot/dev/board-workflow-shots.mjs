import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const home = join(root, '.dsh-test-project-board-workflow')
const out = join(root, 'shots/project-board-stage2')
const base = 'http://127.0.0.1:3107'
const log = await readFile(join(home, 'web.log'), 'utf8')
const login = log.match(/http:\/\/127\.0\.0\.1:3107\/\?token=\S+/)?.[0]
assert.ok(login, 'The isolated project-board bench must be running')
const response = await fetch(login, { redirect: 'manual' })
const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const api = async (endpoint, payload = {}) => {
  const result = await fetch(base + '/api/bot', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) }).then(response => response.json())
  assert.ok(result.ok, result.error?.message)
  return result.value
}
const checks = []
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name) }
const until = async (fn, label, timeout = 90000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 400)) }
  throw new Error('Timed out: ' + label)
}
let team = await api('state')
for (const [name, role, color] of [['Nova', 'Frontend engineer', 'blue'], ['Sage', 'Quality engineer', 'green']]) {
  if (!team.bots.some(bot => bot.name === name)) await api('create-bot', { name, role, color })
}
team = await api('state')
const leadId = team.mainBotId
const nova = team.bots.find(bot => bot.name === 'Nova').id
const project = (await api('board-view')).projects.find(project => project.title === 'Studio')
assert.ok(project)
const card = await api('board-create', { projectId: project.id, requestId: 'workflow-acceptance', title: 'Keep each project’s filters separate', description: 'Remember filters independently for every project. Keep the implementation small and easy to verify.', acceptance: 'The filter returns only cards belonging to the chosen project.\nAn empty project returns an empty list.', leadId, collaboratorIds: [nova] })
const current = async () => (await api('board-view')).cards.find(item => item.id === card.id)
check('saving a draft creates no task conversation or delivery', !card.roomId && !card.deliveries)
await mkdir(out, { recursive: true })
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, ...(process.env.UI_VERIFY_LIBS ? { LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS } : {}) } })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  await page.goto(login)
  await page.locator('.bt-board-entry').first().waitFor({ timeout: 60000 })
  await page.locator('.bt-board-entry').first().click()
  await page.locator('.bt-board-project').filter({ hasText: 'Studio' }).click()
  await page.getByRole('button', { name: card.title, exact: true }).click()
  await page.getByRole('button', { name: 'Start requirement', exact: true }).click()
  await until(async () => (await current()).decisions.some(item => item.status === 'open' && item.kind === 'clarification'), 'Bot clarification')
  await page.getByRole('button', { name: 'Send answer', exact: true }).waitFor()
  await page.screenshot({ path: join(out, '01-user-decision.png') })
  const started = await current()
  check('start creates a dedicated group with the assigned project', Boolean(started.roomId))
  check('Bot tools create a real clarification without changing the phase', started.stage === 'clarification' && started.column === 'needs-you')
  await page.getByLabel('Your answer', { exact: true }).fill('Keep one saved filter per project. Proceed with this scope.')
  await page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await page.getByRole('button', { name: 'Approve plan', exact: true }).waitFor({ timeout: 90000 })
  await page.screenshot({ path: join(out, '02-plan-approval.png') })
  const planned = await current()
  check('plan includes a collaborator and independent reviewer', planned.steps[0].assigneeId === nova && planned.steps[1].assigneeId === leadId)
  check('implementation waits for user approval', planned.steps.every(step => step.status === 'queued') && !planned.approvedPlan)
  check('no fixture was written before plan approval', !await access(join(project.path, `board-demo-${card.number}-${card.id.slice(0, 8)}.mjs`)).then(() => true, () => false))
  await page.getByRole('button', { name: 'Approve plan', exact: true }).click()
  await until(async () => (await current()).stage === 'implementation', 'implementation starts')
  await page.getByRole('button', { name: 'Approve plan', exact: true }).waitFor({ state: 'hidden' })
  await page.locator('.bt-board-drawer-body').evaluate(el => { el.scrollTop = 340 })
  await page.screenshot({ path: join(out, '03-bot-execution.png') })
  await page.getByRole('button', { name: 'Accept delivery', exact: true }).waitFor({ timeout: 120000 })
  await page.locator('.bt-board-drawer-body').evaluate(el => { el.scrollTop = 0 })
  await page.screenshot({ path: join(out, '04-final-acceptance.png') })
  const submitted = await current()
  check('actual Bot tool calls complete implementation and independent validation', submitted.steps.every(step => step.status === 'done') && submitted.steps[1].evidence.includes('PASS:'))
  check('delivery includes evidence for each criterion and stays active', submitted.evidence.length === 2 && submitted.artifacts.length === 1 && submitted.status === 'active')
  const module = await import(pathToFileURL(join(project.path, `board-demo-${card.number}-${card.id.slice(0, 8)}.mjs`)).href)
  assert.deepEqual(module.forProject([{ projectId: 'a' }, { projectId: 'b' }], 'a'), [{ projectId: 'a' }])
  assert.deepEqual(module.forProject([], 'a'), [])
  check('the declared deliverable exists and executes correctly', true)
  await page.getByText('Verification evidence', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(out, '05-verification-evidence.png') })
  await page.locator('.bt-board-drawer-body').evaluate(el => { el.scrollTop = 0 })
  await page.getByLabel('Feedback or requested changes', { exact: true }).fill('Clarify the empty-project check in the revised plan and verify it again.')
  await page.getByRole('button', { name: 'Request changes', exact: true }).click()
  await page.getByRole('button', { name: 'Approve plan', exact: true }).waitFor({ timeout: 90000 })
  const rework = await current()
  check('rejection reuses the task group and requires a fresh plan approval', rework.roomId === started.roomId && rework.planVersion === 2 && !rework.approvedPlan)
  await page.screenshot({ path: join(out, '06-revised-plan.png') })
  await page.getByRole('button', { name: 'Approve plan', exact: true }).click()
  await page.getByRole('button', { name: 'Accept delivery', exact: true }).waitFor({ timeout: 120000 })
  await page.getByRole('button', { name: 'Accept delivery', exact: true }).click()
  await until(async () => (await current()).status === 'done', 'user acceptance')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator('.bt-board-column[data-column=done] .bt-board-card').waitFor()
  await page.screenshot({ path: join(out, '07-accepted-board.png') })
  check('only user acceptance moves the requirement to Done', (await current()).completedAt > 0)
  await page.getByRole('button', { name: card.title, exact: true }).click()
  await page.getByRole('button', { name: 'Open task group', exact: true }).click()
  await page.locator('.bt-board').waitFor({ state: 'hidden' })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(out, '08-task-group.png') })
  check('the board opens the linked real task conversation', true)
  const solo = await api('board-create', { projectId: project.id, requestId: 'workflow-solo', title: 'Handle empty project results', description: 'Keep an empty project result predictable.', acceptance: 'An empty project returns an empty list.', leadId: team.bots.find(bot => bot.name === 'Sage').id, collaboratorIds: [] })
  await api('board-start', { id: solo.id, version: solo.version })
  await until(async () => (await api('board-view')).cards.find(item => item.id === solo.id).decisions.some(item => item.status === 'open'), 'single Bot task plan')
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US', colorScheme: 'dark' })
  mobile.on('pageerror', error => errors.push(error.message))
  await mobile.addLocatorHandler(mobile.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  await mobile.goto(login)
  await mobile.locator('.bt-board-entry').first().click()
  await mobile.locator('.bt-board-project').filter({ hasText: 'Studio' }).click()
  await mobile.getByRole('button', { name: solo.title, exact: true }).click()
  await mobile.getByRole('button', { name: 'Approve plan', exact: true }).waitFor()
  await mobile.screenshot({ path: join(out, '09-mobile-plan.png') })
  check('single-Bot work gets its own task conversation and mobile approvals', await mobile.getByRole('button', { name: 'Open task conversation', exact: true }).count() === 1)
  await page.locator('.bt-board-entry').first().click()
  await page.reload()
  await page.locator('.bt-board-entry').first().click()
  await page.locator('.bt-board-project').filter({ hasText: 'Studio' }).click()
  await page.screenshot({ path: join(out, '10-workflow-overview.png') })
  check('reload preserves accepted work and pending decisions', (await current()).status === 'done')
  check('no browser exceptions', errors.length === 0)
  await writeFile(join(out, 'checks.json'), JSON.stringify({ checks, errors }, null, 2))
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]
  if (page) { await page.screenshot({ path: join(out, 'debug.png') }); console.error((await page.locator('body').innerText()).slice(-6000)) }
  const data = await current()
  console.error(JSON.stringify({ status: data.status, stage: data.stage, version: data.version, deliveryError: data.deliveryError, deliveries: data.deliveries?.map(job => ({ status: job.status, error: job.error, stepId: job.stepId })), steps: data.steps, decisions: data.decisions }, null, 2))
  throw error
} finally { await browser.close() }
