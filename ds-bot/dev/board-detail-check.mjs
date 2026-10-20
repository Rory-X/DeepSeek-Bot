// Real plugin rendering in an isolated mock bench. Only board-view is replaced
// with synthetic long text; this checks presentation, not Agent execution.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detailFixture } from './board-detail-fixture.mjs'

const root = resolve(import.meta.dirname, '../..'), home = join(root, '.dsh-test-board-detail')
const out = join(root, 'shots/board-detail'), port = 3117
const login = (await readFile(join(home, 'web.log'), 'utf8')).match(/http:\/\/127\.0\.0\.1:3117\/\?token=\S+/)?.[0]
assert.ok(login)
const auth = await fetch(login, { redirect: 'manual' }); assert.equal(auth.status, 303)
const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const api = async (endpoint, payload = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/bot`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) }).then(r => r.json())
  assert.ok(response.ok, response.error?.message); return response.value
}
await mkdir(out, { recursive: true })
const projectPath = join(root, '.board-test-projects/board-detail')
await mkdir(projectPath, { recursive: true })
const project = await api('board-project-add', { path: projectPath, title: '界面验收 · 合成演示' })
let state = await api('state')
for (const [name, role, color] of [['Atlas', 'Implementation', 'purple'], ['Sage', 'Independent verification', 'green']]) {
  if (!state.bots.some(bot => bot.name === name)) await api('create-bot', { name, role, color })
}
state = await api('state')
const leadId = state.bots.find(bot => bot.name === 'Atlas').id, reviewerId = state.bots.find(bot => bot.name === 'Sage').id
const draft = await api('board-create', { projectId: project.id, requestId: 'detail-ui-fixture', title: '交付验收与长文本 · 合成演示', leadId, description: 'Synthetic UI fixture; no Agent work is dispatched.', acceptance: 'Responsive detail and readable evidence.' })
const fixture = detailFixture(draft, leadId, reviewerId)
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS } })
const checks = [], errors = []
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); console.log('PASS ' + name) }
const geometry = async (page, name) => {
  const bad = await page.locator('.bt-board-drawer').evaluate(drawer => {
    const body = drawer.querySelector('.bt-board-drawer-body'), bounds = body.getBoundingClientRect()
    const nodes = [drawer, body, ...body.querySelectorAll('.bt-set-card,.bt-board-result,.bt-board-step-list,.bt-board-text,.bt-board-source,.bt-board-disclosure')]
    return nodes.filter(el => el.getClientRects().length && (el.scrollWidth > el.clientWidth + 2 || el.getBoundingClientRect().right > bounds.right + 1 || el.getBoundingClientRect().left < bounds.left - 1)).map(el => ({ className: el.className, client: el.clientWidth, scroll: el.scrollWidth }))
  })
  assert.deepEqual(bad, [], name)
  const footer = await page.locator('.bt-board-drawer-foot').boundingBox()
  check(name, footer.x >= 0 && footer.x + footer.width <= page.viewportSize().width + 1 && footer.y + footer.height <= page.viewportSize().height + 1)
}
try {
  for (const [width, scheme] of [[1440, 'dark'], [390, 'light'], [320, 'dark']]) {
    const page = await browser.newPage({ viewport: { width, height: width > 900 ? 1050 : 900 }, isMobile: width < 900, hasTouch: width < 900, locale: 'zh-CN', colorScheme: scheme })
    page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message))
    let current = structuredClone(fixture)
    await page.route('**/api/bot', async route => {
      const request = route.request().postDataJSON()
      if (request?.endpoint !== 'board-view') return route.continue()
      await route.fulfill({ json: { ok: true, value: { revision: 999, readOnly: 'Synthetic visual fixture', projects: [{ ...project, pending: 1 }], cards: [current], queue: [] } } })
    })
    await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /^(Continue|继续)$/ }), locator => locator.click())
    await page.goto(login)
    const back = page.locator('[data-bt-nav-back]:visible').first()
    if (width < 900 && await back.count()) await back.click()
    await page.locator('.bt-board-entry:visible').first().click()
    await page.locator('.bt-board-card').first().click()
    await page.locator('.bt-board-step-list').waitFor()
    check(`${width}: acceptance precedes runtime history`, await page.locator('.bt-board-decision').evaluate(el => el.getBoundingClientRect().top < document.querySelector('.bt-board-step-list').getBoundingClientRect().top))
    check(`${width}: finished jobs and recovery are hidden by default`, await page.locator('.bt-board-history').getAttribute('open') === null && await page.locator('.bt-board-jobs:visible').count() === 0)
    await geometry(page, `${width} ${scheme}: collapsed detail fits horizontally`)
    await page.screenshot({ path: join(out, `${width}-overview.png`) })
    await page.locator('.bt-board-step-list').scrollIntoViewIfNeeded()
    await page.locator('.bt-board-step-list').evaluate(el => el.closest('.bt-set-section').scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: join(out, `${width}-steps.png`) })
    // Disclosures and long text must survive periodic board polling.
    await page.locator('.bt-board-step-list .bt-board-disclosure summary').first().click()
    await page.waitForResponse(response => response.url().endsWith('/api/bot') && response.request().postDataJSON()?.endpoint === 'board-view')
    check(`${width}: disclosure survives polling`, await page.locator('.bt-board-step-list .bt-board-disclosure').first().getAttribute('open') !== null)
    await geometry(page, `${width}: expanded raw evidence fits horizontally`)
    await page.locator('.bt-board-step-list .bt-board-disclosure-body').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(out, `${width}-evidence.png`) })
    await page.locator('.bt-board-step-list .bt-board-disclosure summary').first().click()
    const fullText = page.locator('.bt-board-step-list .bt-more').first()
    await fullText.click()
    check(`${width}: full step result is retained`, (await page.locator('.bt-board-step-list .bt-board-text').first().innerText()).includes(fixture.steps[0].summary))
    await geometry(page, `${width}: full result fits horizontally`)
    await fullText.click()
    const results = page.locator('.bt-set-section').filter({ has: page.locator('.bt-board-deliverable') })
    await results.scrollIntoViewIfNeeded()
    await page.locator('.bt-board-deliverable summary').click()
    await geometry(page, `${width}: expanded long artifact path fits horizontally`)
    await page.screenshot({ path: join(out, `${width}-delivery.png`) })
    await page.locator('.bt-board-history>summary').click()
    await page.locator('.bt-board-history>.bt-board-disclosure-body>.bt-board-disclosure').first().locator('summary').click()
    check(`${width}: all 18 completed tasks remain accessible`, await page.locator('.bt-board-jobs:visible li').count() === 18)
    const jobHeight = await page.locator('.bt-board-jobs:visible li').first().boundingBox()
    check(`${width}: completed task rows stay compact`, jobHeight.height < 80)
    await geometry(page, `${width}: expanded history fits horizontally`)
    await page.locator('.bt-board-history>summary').click()
    // Unknown/failed tasks are never placed behind the history disclosure.
    current = { ...current, status: 'paused', decisions: [], evidence: fixture.evidence.map((item, index) => ({ ...item, result: index ? 'not-run' : 'failed' })), backgroundJobs: [...fixture.backgroundJobs,
      { id: 'still-running', kind: 'bash', status: 'running' }, { id: 'stop-failed', kind: 'bash', status: 'failed' }, { id: 'lost-on-restart', kind: 'bash', status: 'unknown' }] }
    await page.locator('.bt-board-jobs:visible').filter({ hasText: 'lost-on-restart' }).waitFor()
    check(`${width}: running, failed and unknown jobs stay visible`, await page.locator('.bt-board-jobs:visible li').count() === 3)
    check(`${width}: shutdown verification stays available`, await page.locator('.bt-board-decision textarea').count() === 1)
    check(`${width}: failed and unrun evidence have explicit statuses`, await page.locator('.bt-board-result .bt-board-status[data-state=failed]').count() === 1 && await page.locator('.bt-board-result .bt-board-status[data-state=not-run]').count() === 1)
    await geometry(page, `${width}: recovery state fits horizontally`)
    if (width === 390) { await page.locator('.bt-board-decision').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(out, '390-recovery.png') }) }
    // Keyboard summaries belong to the drawer focus loop.
    await page.locator('.bt-board-history>summary').focus()
    await page.keyboard.press('Enter')
    check(`${width}: history can be expanded with keyboard`, await page.locator('.bt-board-history').getAttribute('open') !== null)
    await page.keyboard.press('Escape')
    check(`${width}: Escape closes the detail`, await page.locator('.bt-board-drawer').count() === 0)
    await page.close()
  }
  assert.deepEqual(errors, [])
  await writeFile(join(out, 'checks.json'), JSON.stringify({ synthetic: true, checks, errors }, null, 2))
} catch (error) { throw new Error(String(error.stack).replace(/token=[^\s)]+/g, 'token=REDACTED')) } finally { await browser.close() }
