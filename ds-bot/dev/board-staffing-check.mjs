// Isolated mock workflow: coordinator selection, staffing, approval and delivery.
// Run prepare, restart this bench, then run finish. Never use a production home.
import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const home = join(root, '.dsh-test-project-board-workflow')
const out = join(root, 'shots/project-board-staffing')
const port = Number(process.env.BOARD_PORT ?? 3116)
assert.ok(Number.isInteger(port) && port >= 3100 && port < 3200)
const login = (await readFile(join(home, 'web.log'), 'utf8')).match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=\\S+`))?.[0]
assert.ok(login, 'Start the isolated staffing bench first')
const response = await fetch(login, { redirect: 'manual' })
assert.equal(response.status, 303)
const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const api = async (endpoint, payload = {}) => {
  const result = await fetch(`http://127.0.0.1:${port}/api/bot`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) }).then(r => r.json())
  assert.ok(result.ok, result.error?.message)
  return result.value
}
const until = async (fn, label) => {
  for (let i = 0; i < 240; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 500)) }
  throw new Error('Timed out: ' + label)
}
const checks = [], errors = []
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name) }
await mkdir(out, { recursive: true })
const phase = process.argv[2] ?? 'prepare'
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS } })
const open = async mobile => {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, locale: 'en-US', colorScheme: 'dark' })
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000)
  await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  await page.goto(login)
  const back = page.locator('[data-bt-nav-back]:visible').first()
  if (mobile && await back.count()) await back.click()
  await page.locator('.bt-board-entry:visible').first().click()
  await page.locator('.bt-board-project').filter({ hasText: 'Studio' }).click()
  return page
}
try {
  if (phase === 'prepare') {
    const initial = await api('state')
    if (!initial.bots.some(bot => bot.name === 'Nova')) await api('create-bot', { name: 'Nova', role: 'Frontend engineer', color: 'blue' })
    const team = await api('state'), developer = team.bots.find(bot => bot.name === 'Nova')
    for (const mobile of [false, true]) {
      const page = await open(mobile)
      await page.getByRole('button', { name: 'New requirement', exact: true }).click()
      const form = page.locator('#bt-board-draft')
      await form.getByLabel('Requirement title', { exact: true }).fill('Keep project filters separate')
      await form.getByLabel('Requirement brief', { exact: true }).fill('Remember each project’s filter and restore it when switching projects.')
      await form.getByLabel('Acceptance criteria', { exact: true }).fill('Project filters stay independent.\nEmpty results are supported.')
      const selector = form.getByRole('button', { name: 'Coordinator Bot', exact: true })
      await selector.scrollIntoViewIfNeeded()
      const box = await selector.boundingBox()
      check((mobile ? 'Mobile' : 'Desktop') + ' form uses an animated Bot row with role and no select or collaborator fields', await form.locator('select').count() === 0 && await form.locator('input[type=checkbox]').count() === 0 && await selector.locator('.bt-mark[data-live]').count() === 1 && (await selector.innerText()).includes('Chief of Staff') && box.height >= 60 && box.height <= 110)
      await page.screenshot({ path: join(out, mobile ? '02-mobile-form.png' : '01-desktop-form.png') })
      await selector.click()
      const picker = page.getByRole('dialog', { name: 'Choose coordinator Bot', exact: true })
      await picker.getByRole('option', { name: /Nova/ }).waitFor()
      const bounds = await picker.boundingBox(), screen = page.viewportSize()
      check((mobile ? 'Mobile' : 'Desktop') + ' Bot picker stays in view and shows dynamic avatars', bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= screen.width + 1 && bounds.y + bounds.height <= screen.height + 1 && await picker.locator('.bt-mark[data-live]').count() === team.bots.length)
      await page.screenshot({ path: join(out, mobile ? '06-mobile-picker.png' : '05-desktop-picker.png') })
      await picker.getByRole('textbox', { name: 'Search Bots' }).fill('Frontend')
      assert.equal(await picker.getByRole('option').count(), 1)
      await picker.getByRole('textbox', { name: 'Search Bots' }).press('ArrowDown')
      await picker.getByRole('option').press('Enter')
      assert.ok((await selector.innerText()).includes('Nova'))
      await selector.click()
      await picker.getByRole('textbox', { name: 'Search Bots' }).fill('no-such-bot')
      await picker.getByText('No matching Bots', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      assert.equal(await selector.getAttribute('aria-expanded'), 'false')
      assert.equal(await form.count(), 1)
      check((mobile ? 'Mobile' : 'Desktop') + ' picker searches roles, selects by keyboard and closes without closing the form', true)
      await page.close()
    }
    const project = (await api('board-view')).projects.find(project => project.title === 'Studio')
    const card = await api('board-create', { projectId: project.id, requestId: 'staffing-acceptance', title: 'Coordinator assigns the project team', description: '[staffing bench] Keep project filters separate. The coordinator chooses an implementer and independently verifies the result.', acceptance: 'Only matching projects are returned.\nEmpty results are supported.', leadId: team.mainBotId })
    check('Saving with only a coordinator creates no collaborator, task room or delivery', !card.collaboratorIds.length && !card.roomId && !card.deliveries)
    const current = async () => (await api('board-view')).cards.find(item => item.id === card.id)
    await api('board-start', { id: card.id, version: card.version })
    const planned = await until(async () => { const value = await current(); return value.decisions.some(d => d.kind === 'design' && d.status === 'open') && value }, 'coordinator staffing and plan')
    check('Coordinator tool assigned the implementer and recorded responsibilities', planned.collaboratorIds[0] === developer.id && Boolean(planned.staffing?.summary))
    const room = (await api('state')).rooms.find(room => room.id === planned.roomId)
    check('Task group contains the coordinator and assigned collaborator', room.members.length === 2 && room.members.includes(developer.id) && room.members.includes(card.leadId))
    check('Only the coordinator was dispatched before approval', planned.deliveries.every(job => job.botId === card.leadId && !job.stepId) && !planned.approvedPlan)
    const file = join(project.path, `board-demo-${card.number}-${card.id.slice(0, 8)}.mjs`)
    check('No implementation file exists before user approval', !await access(file).then(() => true, () => false))
    const page = await open(false)
    await page.getByRole('button', { name: card.title, exact: true }).click()
    await page.getByText('Team assignment', { exact: true }).waitFor()
    await page.screenshot({ path: join(out, '03-assigned-team.png') })
    await writeFile(join(out, 'checkpoint.json'), JSON.stringify({ cardId: card.id, roomId: room.id, members: room.members, developerId: developer.id, file, checks }, null, 2))
  } else {
    assert.equal(phase, 'finish')
    const checkpoint = JSON.parse(await readFile(join(out, 'checkpoint.json'), 'utf8')); checks.push(...checkpoint.checks)
    const current = async () => (await api('board-view')).cards.find(item => item.id === checkpoint.cardId)
    let card = await current()
    const room = (await api('state')).rooms.find(room => room.id === card.roomId)
    check('Restart preserves task group membership and staffing with no extra dispatch', card.roomId === checkpoint.roomId && JSON.stringify(room.members) === JSON.stringify(checkpoint.members) && Boolean(card.staffing) && card.deliveries.length === 1)
    let decision = card.decisions.find(d => d.status === 'open')
    await api('board-decide', { id: card.id, decisionId: decision.id, decisionVersion: decision.version, choice: 'approve' })
    card = await until(async () => { const value = await current(); return value.decisions.some(d => d.kind === 'acceptance' && d.status === 'open') && value }, 'Bot delivery and verification')
    check('Assigned collaborator implements and coordinator independently reviews', card.steps.every(step => step.status === 'done') && card.steps[0].assigneeId === checkpoint.developerId && card.steps[1].assigneeId === card.leadId)
    const module = await import(pathToFileURL(checkpoint.file).href)
    assert.deepEqual(module.forProject([{ projectId: 'a' }, { projectId: 'b' }], 'a'), [{ projectId: 'a' }]); assert.deepEqual(module.forProject([], 'a'), [])
    check('Delivered fixture passes actual isolation and empty-array assertions', true)
    check('Bot submission waits for user acceptance with evidence for both criteria', card.status === 'active' && card.evidence.length === 2 && card.artifacts.length === 1)
    const page = await open(false)
    await page.getByRole('button', { name: card.title, exact: true }).click()
    await page.getByRole('button', { name: 'Accept delivery', exact: true }).waitFor()
    await page.screenshot({ path: join(out, '04-delivery.png') })
    decision = card.decisions.find(d => d.status === 'open')
    await api('board-decide', { id: card.id, decisionId: decision.id, decisionVersion: decision.version, choice: 'approve' })
    check('Only the user acceptance marks the requirement Done', (await current()).status === 'done')
  }
  assert.deepEqual(errors, [])
  await writeFile(join(out, phase + '-checks.json'), JSON.stringify({ checks, errors }, null, 2))
} catch (error) { throw new Error(String(error.message).replace(/token=[^\s)]+/g, 'token=REDACTED')) } finally { await browser.close() }
