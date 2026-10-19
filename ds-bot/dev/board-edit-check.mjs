// A second writer changes a draft while the first window's form remains open.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../..')
const [name = 'project-board', port = '3107'] = process.argv.slice(2)
assert.ok(['project-board', 'board-smoke'].includes(name))
assert.ok(/^\d+$/.test(port))
const log = await readFile(join(root, '.dsh-test-' + name, 'web.log'), 'utf8')
const login = log.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\?token=[^\\s]+'))?.[0]
assert.ok(login)
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, ...(process.env.UI_VERIFY_LIBS ? { LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS } : {}) } })
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  await page.goto(login)
  await page.locator('.bt-board-entry').first().waitFor({ timeout: 60000 })
  const api = (endpoint, payload = {}) => page.evaluate(async ([endpoint, payload]) => {
    const response = await fetch('api/bot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) })
    const data = await response.json()
    if (!data.ok) throw new Error(data.error.message)
    return data.value
  }, [endpoint, payload])
  const team = await api('state')
  const board = await api('board-view')
  const card = await api('board-create', {
    requestId: crypto.randomUUID(), title: 'Concurrent edit check', projectId: board.projects.find(p => p.title === 'DS Bot').id,
    leadId: team.mainBotId, collaboratorIds: [], description: 'Synthetic conflict scenario',
  })
  await page.locator('.bt-board-entry').first().click()
  await page.locator('.bt-board-project').filter({ hasText: 'DS Bot' }).click()
  await page.getByRole('button', { name: card.title, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Edit draft', exact: true }).click()
  await page.getByRole('dialog').getByLabel('Requirement title', { exact: true }).fill('An outdated edit')
  await api('board-edit', { ...card, title: 'Saved by another window' })
  // Let the live board receive the newer version while the older form is still open.
  await page.waitForTimeout(2000)
  await page.getByRole('dialog').getByRole('button', { name: 'Save draft', exact: true }).click()
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'another window' }).waitFor()
  const saved = (await api('board-view')).cards.find(c => c.id === card.id)
  assert.equal(saved.title, 'Saved by another window')
  assert.equal(saved.version, 2)
  console.log('PASS: live polling does not let an old form overwrite a newer draft')
} catch (error) {
  console.error(String(error).replace(/token=[^\s]+/g, 'token=[redacted]'))
  process.exitCode = 1
} finally { await browser.close() }
