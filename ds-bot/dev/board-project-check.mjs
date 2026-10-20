// UI and workspace integration checks against the isolated board bench only.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../..'), home = join(root, '.dsh-test-project-board-workflow')
const out = join(root, 'shots/project-board-projects'), port = Number(process.env.BOARD_PORT ?? 3116)
assert.ok(Number.isInteger(port) && port >= 3100 && port < 3200)
const login = (await readFile(join(home, 'web.log'), 'utf8')).match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=\\S+`))?.[0]
assert.ok(login)
const auth = await fetch(login, { redirect: 'manual' })
assert.equal(auth.status, 303)
const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const api = async (endpoint, payload = {}) => {
  const result = await fetch(`http://127.0.0.1:${port}/api/bot`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) }).then(r => r.json())
  assert.ok(result.ok, result.error?.message); return result.value
}
await mkdir(out, { recursive: true })
if (process.argv[2] === 'restart') {
  const before = JSON.parse(await readFile(join(out, 'project.json'), 'utf8'))
  const after = (await api('board-view')).projects.find(project => project.id === before.id)
  assert.equal(after.path, before.path); assert.equal(after.title, before.title)
  const checks = JSON.parse(await readFile(join(out, 'checks.json'), 'utf8'))
  checks.checks.push('Added project remains registered after restarting the bench')
  await writeFile(join(out, 'checks.json'), JSON.stringify(checks, null, 2))
  console.log('PASS project registration survives restart')
  process.exit(0)
}
const checks = [], errors = []
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name) }
const projectPath = join(root, '.board-test-projects/project-board-workflow/added-project')
await mkdir(projectPath, { recursive: true })
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS } })
const open = async (mobile, colorScheme = 'dark') => {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, locale: 'en-US', colorScheme })
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000)
  await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  await page.goto(login)
  const back = page.locator('[data-bt-nav-back]:visible').first(); if (mobile && await back.count()) await back.click()
  await page.locator('.bt-board-entry:visible').first().click()
  return page
}
try {
  const before = await api('state')
  const page = await open(false)
  await page.locator('.bt-board-add-project').click()
  const dialog = page.getByRole('dialog', { name: 'Add project', exact: true })
  await dialog.getByLabel('Project name (optional)', { exact: true }).fill('Product studio')
  await dialog.getByLabel('Project folder', { exact: true }).fill(join(projectPath, 'missing'))
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  check('Invalid project folder displays a recoverable form error', await dialog.isVisible())
  await dialog.locator('.bt-model-trigger').click()
  await page.getByRole('menuitem', { name: 'Enter a path…', exact: true }).click()
  await page.getByRole('textbox', { name: 'Folder path', exact: true }).fill(projectPath)
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click()
  check('The shared folder picker supplies the selected project path', await dialog.getByLabel('Project folder', { exact: true }).inputValue() === projectPath)
  await page.screenshot({ path: join(out, '02-add-project.png') })
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const selected = page.locator('.bt-board-project[aria-pressed=true]')
  await selected.filter({ hasText: 'Product studio' }).waitFor()
  const project = (await api('board-view')).projects.find(item => item.path === projectPath)
  check('Add project registers a real DSH workspace and selects it', Boolean(project?.id) && project.title === 'Product studio')
  const duplicate = await api('board-project-add', { path: projectPath, title: 'Do not rename' })
  check('Adding an existing folder returns the same project without renaming it', duplicate.id === project.id && duplicate.title === project.title)
  const after = await api('state')
  check('Project registration does not change Bot or group working folders', JSON.stringify(after.bots.map(b => [b.id, b.workDir])) === JSON.stringify(before.bots.map(b => [b.id, b.workDir])) && JSON.stringify(after.rooms.map(r => [r.id, r.workDir])) === JSON.stringify(before.rooms.map(r => [r.id, r.workDir])))
  await api('board-create', { projectId: project.id, requestId: 'project-entry-draft', title: 'Improve project navigation', description: 'Use the shared controls to keep project switching clear and compact.', acceptance: 'Project changes stay scoped to their workspace.', leadId: after.mainBotId })
  await page.getByRole('button', { name: 'Improve project navigation', exact: true }).waitFor()
  await page.screenshot({ path: join(out, '01-desktop-board.png') })
  await page.locator('.bt-board-search input').fill('no matching card')
  check('Project search filters requirement cards', await page.locator('.bt-board-card').count() === 0)
  await page.locator('.bt-board-search input').fill('')
  for (const [mobile, scheme, filename] of [[true, 'dark', '03-mobile-board.png'], [false, 'light', '04-light-board.png']]) {
    const other = await open(mobile, scheme)
    await other.locator('.bt-board-project').filter({ hasText: 'Product studio' }).click()
    const geometry = await other.locator('.bt-board-toolbar').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }))
    check((mobile ? 'Mobile' : 'Light theme') + ' toolbar fits and keeps Add project visible', geometry.scroll <= geometry.width + 1 && await other.locator('.bt-board-add-project').isVisible())
    await other.screenshot({ path: join(out, filename) })
    if (mobile) {
      await other.getByRole('button', { name: 'New requirement', exact: true }).click()
      const selector = other.getByRole('button', { name: 'Coordinator Bot', exact: true })
      await selector.scrollIntoViewIfNeeded()
      check('The restyled requirement form retains only the coordinator picker', (await selector.boundingBox()).height <= 110 && await other.locator('#bt-board-draft input[type=checkbox],#bt-board-draft select').count() === 0)
      await other.screenshot({ path: join(out, '05-mobile-requirement.png') })
      await selector.click()
      const picker = other.getByRole('dialog', { name: 'Choose coordinator Bot', exact: true })
      await picker.getByRole('textbox', { name: 'Search Bots' }).fill('Frontend')
      await picker.getByRole('option', { name: /Nova/ }).waitFor()
      await picker.getByRole('textbox', { name: 'Search Bots' }).press('ArrowDown')
      await picker.getByRole('option').press('Enter')
      assert.ok((await selector.innerText()).includes('Nova'))
      await selector.click()
      await picker.getByRole('textbox', { name: 'Search Bots' }).press('Escape')
      check('Coordinator search and keyboard selection work without closing the requirement form', await other.locator('#bt-board-draft').count() === 1 && await selector.getAttribute('aria-expanded') === 'false')
    }
    await other.close()
  }
  assert.deepEqual(errors, [])
  await writeFile(join(out, 'project.json'), JSON.stringify(project, null, 2))
  await writeFile(join(out, 'checks.json'), JSON.stringify({ checks, errors }, null, 2))
} catch (error) { throw new Error(String(error.message).replace(/token=[^\s)]+/g, 'token=REDACTED')) } finally { await browser.close() }
