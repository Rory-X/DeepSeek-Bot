// Finish the single-Bot scenario and capture readable evidence after the main workflow run.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../..')
const out = join(root, 'shots/project-board-stage2')
const log = await readFile(join(root, '.dsh-test-project-board-workflow/web.log'), 'utf8')
const login = log.match(/http:\/\/127\.0\.0\.1:3107\/\?token=\S+/)?.[0]
assert.ok(login)
const response = await fetch(login, { redirect: 'manual' })
const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const api = async (endpoint, payload = {}) => {
  const result = await fetch('http://127.0.0.1:3107/api/bot', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) }).then(response => response.json())
  assert.ok(result.ok, result.error?.message)
  return result.value
}
const view = await api('board-view')
const solo = view.cards.find(card => card.requestId === 'workflow-solo')
const done = view.cards.find(card => card.requestId === 'workflow-acceptance')
assert.equal(done.status, 'done')
const decision = solo.decisions.find(item => item.status === 'open')
await api('board-decide', { id: solo.id, decisionId: decision.id, decisionVersion: decision.version, choice: 'reject', answer: 'State explicitly that this single-Bot requirement is self-reviewed.' })
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS } })
const checks = JSON.parse(await readFile(join(out, 'checks.json'), 'utf8'))
try {
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US', colorScheme: 'dark' })
  mobile.setDefaultTimeout(20000)
  await mobile.addLocatorHandler(mobile.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  await mobile.goto(login)
  await mobile.locator('.bt-board-entry').first().click()
  await mobile.locator('.bt-board-project').filter({ hasText: 'Studio' }).click()
  await mobile.getByRole('button', { name: solo.title, exact: true }).click()
  await mobile.getByRole('button', { name: 'Approve plan', exact: true }).waitFor({ timeout: 90000 })
  await mobile.screenshot({ path: join(out, '09-mobile-plan.png') })
  await mobile.getByRole('button', { name: 'Approve plan', exact: true }).click()
  await mobile.getByRole('button', { name: 'Accept delivery', exact: true }).waitFor({ timeout: 120000 })
  assert.ok(await mobile.getByText('Single-Bot delivery: no independent reviewer.', { exact: true }).count())
  await mobile.screenshot({ path: join(out, '11-mobile-acceptance.png') })
  const after = (await api('board-view')).cards.find(card => card.id === solo.id)
  assert.ok(after.steps.every(step => step.status === 'done' && step.assigneeId === solo.leadId))
  assert.equal(after.roomId, solo.roomId)
  checks.checks.push('single-Bot implementation and self-review complete in the same task conversation, with a clear self-review label')
  await api('board-create', { projectId: done.projectId, requestId: 'workflow-next-draft', title: 'Polish the board’s empty state', description: 'Make the empty project board easier to understand.', acceptance: 'An empty board explains how to create the first requirement.', leadId: done.leadId, collaboratorIds: [] })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  page.setDefaultTimeout(20000)
  await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  await page.goto(login)
  await page.locator('.bt-board-entry').first().click()
  await page.locator('.bt-board-project').filter({ hasText: 'Studio' }).click()
  await page.getByRole('button', { name: done.title, exact: true }).waitFor()
  await page.screenshot({ path: join(out, '10-workflow-overview.png') })
  await page.getByRole('button', { name: done.title, exact: true }).click()
  await page.locator('.bt-board-evidence').first().evaluate(element => {
    const body = element.closest('.bt-board-drawer-body')
    body.scrollTop += element.getBoundingClientRect().top - body.getBoundingClientRect().top - 45
  })
  await page.screenshot({ path: join(out, '05-verification-evidence.png') })
  checks.checks.push('board state and linked task conversations survive a bench restart')
  checks.checks = [...new Set(checks.checks)]
  await writeFile(join(out, 'checks.json'), JSON.stringify(checks, null, 2))
  console.log('PASS single-Bot workflow, mobile acceptance and restart persistence')
} finally { await browser.close() }
