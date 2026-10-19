// Real queue controls and a guarded SIGKILL of this bench's own web process group.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../..'), plugin = join(root, 'ds-bot')
const home = join(root, '.dsh-test-project-board-queue'), out = join(root, 'shots/project-board-stage3')
const base = 'http://127.0.0.1:3110'
assert.equal(process.platform, 'linux', 'Fault injection is only supported on the isolated Linux bench')
let cookie, login
const authenticate = async () => {
  const log = await readFile(join(home, 'web.log'), 'utf8')
  login = log.match(/http:\/\/127\.0\.0\.1:3110\/\?token=\S+/)?.[0]
  assert.ok(login)
  const response = await fetch(login, { redirect: 'manual' })
  assert.equal(response.status, 303)
  cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
}
const api = async (endpoint, payload = {}) => {
  const result = await fetch(base + '/api/bot', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) }).then(response => response.json())
  assert.ok(result.ok, result.error?.message)
  return result.value
}
const audit = sessionId => fetch(base + '/api/board-bench', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ sessionId }) }).then(response => response.json())
const until = async (fn, label, timeout = 120000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 300)) }
  throw new Error('Timed out: ' + label)
}
const checks = []
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name) }
const get = async card => (await api('board-view')).cards.find(item => item.id === card.id)
const status = (card, expected) => until(async () => (await get(card)).status === expected, expected)
const artifact = card => join(card.projectPath, `board-demo-${card.number}-${card.id.slice(0, 8)}.mjs`)
const exists = path => access(path).then(() => true, () => false)
const decide = async (card, kind, choice = 'approve') => {
  const ready = await until(async () => { const current = await get(card); return current.decisions.some(item => item.kind === kind && item.status === 'open') && current }, kind)
  const decision = ready.decisions.find(item => item.kind === kind && item.status === 'open')
  return api('board-decide', { id: card.id, decisionId: decision.id, decisionVersion: decision.version, choice })
}
const control = (card, command) => api(command, { id: card.id, requestId: crypto.randomUUID() })
await authenticate()
await mkdir(out, { recursive: true })
let team = await api('state')
for (const [name, role, color] of [['Nova', 'Implementation', 'blue'], ['Sage', 'Review & implementation', 'green']]) {
  if (!team.bots.some(bot => bot.name === name)) await api('create-bot', { name, role, color })
}
team = await api('state')
const nova = team.bots.find(bot => bot.name === 'Nova').id, sage = team.bots.find(bot => bot.name === 'Sage').id
const projects = (await api('board-view')).projects
const studio = projects.find(project => project.title === 'Studio'), companion = projects.find(project => project.title === 'Companion')
const create = async (title, project, worker) => {
  const card = await api('board-create', { projectId: project.id, requestId: crypto.randomUUID(), title, description: 'Build and review a small project filter module within this requirement.', acceptance: 'Only matching project cards are returned.\nAn empty input produces an empty result.', leadId: team.mainBotId, collaboratorIds: [worker] })
  await api('board-start', { id: card.id, version: card.version })
  await decide(card, 'design')
  return card
}
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS } })
let page
const errors = []
try {
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  const board = async () => {
    await page.goto(login)
    await page.locator('.bt-board-entry').first().waitFor({ timeout: 60000 })
    await page.locator('.bt-board-entry').first().click()
  }
  const close = async () => { const button = page.locator('.bt-board-drawer-header').getByRole('button', { name: 'Close', exact: true }); if (await button.count()) await button.click() }
  const open = async card => {
    await close()
    await page.locator('.bt-board-project').filter({ hasText: projects.find(project => project.id === card.projectId).title }).click()
    if ((await get(card)).status === 'cancelled') await page.getByLabel('Show cancelled', { exact: true }).check()
    await page.getByRole('button', { name: card.title, exact: true }).click()
  }
  const shot = async name => { await page.waitForTimeout(300); await page.screenshot({ path: join(out, name) }) }
  const cancel = async card => {
    await open(card)
    await page.getByRole('button', { name: 'Cancel requirement', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click()
    await status(card, 'cancelled')
    await page.getByText('Cancelled; deliverables and history retained', { exact: true }).waitFor()
  }
  const a = await create('Keep project filters isolated', studio, nova)
  await until(() => exists(artifact(a)), 'first output written')
  const b = await create('Queue another task for Nova', companion, nova)
  const c = await create('Wait for the Studio workspace', studio, sage)
  await until(async () => { const queue = (await api('board-view')).queue; return queue.some(job => job.cardId === b.id && job.blockedBy === 'bot') && queue.some(job => job.cardId === c.id && job.blockedBy === 'project') }, 'both queue reasons')
  check('same Bot waits across projects and same project waits across Bots', !await exists(artifact(b)) && !await exists(artifact(c)))
  await board()
  await page.getByRole('button', { name: /^Queue \d+$/ }).click()
  await page.getByText('Waiting for this Bot', { exact: true }).waitFor()
  await shot('01-global-queue.png')
  await cancel(b)
  await shot('02-cancelled-queued-task.png')
  check('cancelling queued work starts no implementation', !await exists(artifact(b)))
  await open(a)
  await page.getByRole('button', { name: 'Pause requirement', exact: true }).click()
  await status(a, 'paused')
  await page.getByRole('button', { name: 'Resume requirement', exact: true }).waitFor()
  await shot('03-paused-task.png')
  check('pause preserves the written file and the incomplete step', await exists(artifact(a)) && (await get(a)).steps[0].status === 'paused')
  await until(() => exists(artifact(c)), 'project reservation released after pause')
  await cancel(c)
  await shot('04-cancelled-running-task.png')
  check('cancelling running work retains files and never marks it Done', await exists(artifact(c)) && (await get(c)).status === 'cancelled')
  await open(a)
  await page.getByRole('button', { name: 'Resume requirement', exact: true }).click()
  await until(async () => (await get(a)).decisions.some(item => item.status === 'open' && item.kind === 'acceptance'), 'resumed delivery')
  await page.getByText('Recovery checks', { exact: true }).waitFor()
  await page.getByText('Recovery checks', { exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }))
  await shot('05-resume-reconciliation.png')
  const resumed = await get(a)
  const aSession = resumed.deliveries.find(job => job.stepId === 'build').sessionId
  const aAudit = await audit(aSession)
  check('resuming reconciles saved progress and does not repeat the completed write', aAudit.tools.filter(tool => tool.name === 'write').length === 1 && resumed.deliveries.some(job => job.reconciled))
  await decide(a, 'acceptance')

  // A paused decision and cancelled records must remain stopped across the crash.
  const paused = await api('board-create', { projectId: studio.id, requestId: crypto.randomUUID(), title: 'Keep this requirement paused', description: 'Plan a small follow-up.', acceptance: 'The saved plan remains available.', leadId: team.mainBotId, collaboratorIds: [sage] })
  await api('board-start', { id: paused.id, version: paused.version })
  await until(async () => (await get(paused)).decisions.some(item => item.status === 'open'), 'paused plan')
  await control(paused, 'board-pause'); await status(paused, 'paused')
  const d = await create('Recover an interrupted implementation', companion, nova)
  await until(() => exists(artifact(d)), 'output before hard crash')
  const e = await create('Continue the queue after recovery', studio, nova)
  const beforeCrash = await get(d)
  const original = beforeCrash.deliveries.find(job => job.stepId === 'build')
  check('crash occurs after a real write and before the step completion receipt', beforeCrash.steps[0].status === 'running')
  const pid = Number((await readFile(join(home, 'web.pid'), 'utf8')).trim())
  const environment = await readFile(`/proc/${pid}/environ`, 'utf8')
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
  assert.ok(environment.split('\0').includes('DSH_HOME=' + home), 'Only this isolated bench may be killed')
  assert.equal(Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]), pid, 'The saved PID must own its process group')
  process.kill(-pid, 'SIGKILL')
  await until(async () => !await fetch(base).then(() => true, () => false), 'web process stopped')
  await unlink(join(home, 'web.pid'))
  execFileSync('sh', ['dev/bench.sh', 'project-board-queue', '3110', '8810', 'start'], { cwd: plugin, env: process.env, windowsHide: true, stdio: 'pipe' })
  await authenticate()
  await until(async () => (await get(d)).decisions.some(item => item.status === 'open' && item.kind === 'acceptance'), 'hard restart recovery')
  const recovered = await get(d)
  const dAudit = await audit(original.sessionId)
  check('hard restart reuses the task conversation and creates a reconciled continuation', recovered.roomId === beforeCrash.roomId && recovered.deliveries.some(job => job.parentId === original.id && job.reconciled))
  check('the original message and file write occur exactly once across the hard restart', dAudit.messages.filter(message => message.id === original.id).length === 1 && dAudit.tools.filter(tool => tool.name === 'write').length === 1)
  check('paused and cancelled requirements stay stopped across restart', (await get(paused)).status === 'paused' && (await get(b)).status === 'cancelled' && (await get(c)).status === 'cancelled')
  await board(); await open(d)
  await page.getByText('Recovery checks', { exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }))
  await shot('06-hard-restart-recovery.png')
  await until(() => exists(artifact(e)), 'queue continues after recovered Bot finishes')
  await cancel(e)
  check('queued work proceeds after the recovered attempt releases its Bot', await exists(artifact(e)))
  await decide(d, 'acceptance')
  const module = await import(pathToFileURL(artifact(d)).href)
  assert.deepEqual(module.forProject([{ projectId: 'a' }, { projectId: 'b' }], 'a'), [{ projectId: 'a' }])
  check('the retained recovered artifact executes correctly', true)
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'en-US' })
  mobile.setDefaultTimeout(20000)
  await mobile.addLocatorHandler(mobile.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  await mobile.goto(login); await mobile.locator('.bt-board-entry').first().click()
  await mobile.locator('.bt-board-project').filter({ hasText: 'Studio' }).click()
  await mobile.getByRole('button', { name: paused.title, exact: true }).click()
  await mobile.getByRole('button', { name: 'Resume requirement', exact: true }).waitFor()
  await mobile.screenshot({ path: join(out, '07-mobile-paused.png') })
  check('mobile exposes paused progress and the resume control', await mobile.locator('.bt-board-drawer').evaluate(el => Math.abs(el.getBoundingClientRect().width - innerWidth) < 2))
  await close(); await page.locator('.bt-board-project').filter({ hasText: 'Studio' }).click(); await page.getByLabel('Show cancelled', { exact: true }).check()
  await shot('08-final-board.png')
  check('no browser exceptions', errors.length === 0)
  await writeFile(join(out, 'checks.json'), JSON.stringify({ checks, errors, originalMessageCount: dAudit.messages.filter(message => message.id === original.id).length, implementationWrites: dAudit.tools.filter(tool => tool.name === 'write').length }, null, 2))
} catch (error) {
  if (page) { await page.screenshot({ path: join(out, 'debug.png') }).catch(() => {}); console.error((await page.locator('body').innerText().catch(() => '')).slice(-3500)) }
  console.error(String(error.message).replace(/token=[^\s'"&]+/g, 'token=[hidden]'))
  console.error(JSON.stringify((await api('board-view').catch(() => ({ cards: [] }))).cards.map(card => ({ title: card.title, status: card.status, stage: card.stage, error: card.deliveryError, jobs: card.deliveries?.map(job => ({ state: job.status, step: job.stepId, outcome: job.outcome, error: job.error })) })), null, 2))
  process.exitCode = 1
} finally { await browser.close() }
