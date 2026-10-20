import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../..'), home = join(root, '.dsh-test-board-stages')
const out = join(root, 'shots/board-stages'), port = 3118
const login = (await readFile(join(home, 'web.log'), 'utf8')).match(/http:\/\/127\.0\.0\.1:3118\/\?token=\S+/)?.[0]
assert.ok(login)
const auth = await fetch(login, { redirect: 'manual' }); assert.equal(auth.status, 303)
const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const api = async (endpoint, payload = {}) => {
  const data = await fetch(`http://127.0.0.1:${port}/api/bot`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) }).then(r => r.json())
  assert.ok(data.ok, data.error?.message); return data.value
}
const until = async (fn, label) => {
  for (let i = 0; i < 180; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 500)) }
  throw new Error('Timed out: ' + label)
}
await mkdir(out, { recursive: true })
const projectPath = join(root, '.board-test-projects/board-stages')
const content = '{"status":"ok","source":"bench"}\n'
const phase = process.argv[2] ?? 'prepare'
if (phase === 'prepare') {
  await mkdir(projectPath, { recursive: true })
  await writeFile(join(projectPath, 'stage-fixture.json'), content)
  const project = await api('board-project-add', { path: projectPath, title: '阶段跳过 · Bench' })
  const state = await api('state')
  const card = await api('board-create', { projectId: project.id, requestId: 'stages-' + Date.now(), title: '检查已有交付文件 · Bench', description: '[stage skip bench] Read the existing stage-fixture.json only. No code changes or additional design are needed.', acceptance: 'The existing artifact has status ok.', leadId: state.mainBotId })
  await api('board-start', { id: card.id, version: card.version })
  const proposed = await until(async () => { const next = (await api('board-view')).cards.find(item => item.id === card.id); return next.decisions.some(item => item.status === 'open' && item.kind === 'design') && next }, 'plan')
  assert.equal(proposed.steps.length, 1)
  assert.equal(proposed.steps[0].phase, 'validation')
  assert.equal(proposed.deliveries.filter(job => job.stepId).length, 0)
  assert.deepEqual(proposed.stageProgress.map(item => item.status), ['completed', 'skipped', 'skipped', 'skipped', 'pending'])
  await writeFile(join(out, 'before-restart.json'), JSON.stringify({ cardId: card.id, projectId: project.id, outcomes: proposed.stageOutcomes }, null, 2))
  console.log('PASS Bot recorded skip reasons through plan_requirement; no worker dispatched before approval')
  process.exit(0)
}
const saved = JSON.parse(await readFile(join(out, 'before-restart.json'), 'utf8'))
let card = (await api('board-view')).cards.find(item => item.id === saved.cardId)
assert.deepEqual(card.stageOutcomes, saved.outcomes)
assert.equal(card.steps[0].status, 'queued')
console.log('PASS stage outcomes and queued work survived a real bench restart')
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS } })
const checks = [], errors = []
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); console.log('PASS ' + name) }
const open = async width => {
  const page = await browser.newPage({ viewport: { width, height: 950 }, isMobile: width < 900, hasTouch: width < 900, locale: 'zh-CN', colorScheme: width < 900 ? 'light' : 'dark' })
  page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message))
  await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /^(Continue|继续)$/ }), locator => locator.click())
  await page.goto(login)
  const back = page.locator('[data-bt-nav-back]:visible').first(); if (width < 900 && await back.count()) await back.click()
  await page.locator('.bt-board-entry:visible').first().click()
  await page.locator('.bt-board-project').filter({ hasText: '阶段跳过' }).click()
  await page.locator('.bt-board-card').filter({ hasText: new RegExp('#' + card.number + '\\b') }).click()
  return page
}
const shot = async (page, name) => {
  await page.locator('.bt-board-stage-tracker').evaluate(el => el.scrollIntoView({ block: 'start' }))
  const box = await page.locator('.bt-board-drawer-body').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }))
  check(name + ' fits horizontally', box.scroll <= box.client + 1)
  await page.screenshot({ path: join(out, name + '.png') })
}
try {
  const mobile = await open(390)
  check('skipped stages use a dash and text rather than completion checks', await mobile.locator('.bt-board-stages [data-status=skipped]').count() === 3 && await mobile.locator('.bt-board-stages [data-status=skipped] svg').count() === 0)
  check('unexecuted validation remains pending before approval', await mobile.locator('.bt-board-stages li').last().getAttribute('data-status') === 'pending')
  await mobile.getByRole('button', { name: '代码实现 · 已跳过', exact: true }).click()
  check('a mobile tap exposes the persisted skip reason', (await mobile.locator('.bt-board-stage-explanation').innerText()).includes(saved.outcomes.implementation.reason))
  await shot(mobile, '01-mobile-skipped')
  const decision = card.decisions.find(item => item.status === 'open')
  await api('board-decide', { id: card.id, decisionId: decision.id, decisionVersion: decision.version, choice: 'approve' })
  card = await until(async () => { const next = (await api('board-view')).cards.find(item => item.id === saved.cardId); return next.decisions.some(item => item.status === 'open' && item.kind === 'acceptance') && next }, 'real read and final acceptance')
  check('only validation was dispatched and it produced real file evidence', card.deliveries.filter(job => job.stepId).length === 1 && card.steps[0].status === 'done' && card.steps[0].evidence.includes('DSH read'))
  check('existing fixture was not changed by the Bot', await readFile(join(projectPath, 'stage-fixture.json'), 'utf8') === content)
  const acceptance = card.decisions.find(item => item.status === 'open')
  await api('board-decide', { id: card.id, decisionId: acceptance.id, decisionVersion: acceptance.version, choice: 'approve' })
  await until(async () => (await api('board-view')).cards.find(item => item.id === saved.cardId)?.status === 'done', 'acceptance')
  const desktop = await open(1440)
  check('accepted card retains three skipped stages and only two completed stages', await desktop.locator('.bt-board-stages [data-status=skipped]').count() === 3 && await desktop.locator('.bt-board-stages [data-status=completed]').count() === 2)
  await desktop.getByRole('button', { name: '方案设计 · 已跳过', exact: true }).click()
  await shot(desktop, '02-desktop-accepted')
  await mobile.locator('.bt-board-stages li[data-status=completed]').nth(1).waitFor()
  await shot(mobile, '03-mobile-accepted')
  await desktop.close(); await mobile.close()
  assert.deepEqual(errors, [])
  await writeFile(join(out, 'checks.json'), JSON.stringify({ checks, errors, realTools: true, restartVerified: true }, null, 2))
} catch (error) { throw new Error(String(error.stack).replace(/token=[^\s)]+/g, 'token=REDACTED')) } finally { await browser.close() }
