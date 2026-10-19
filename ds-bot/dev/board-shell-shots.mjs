import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../..'), plugin = join(root, 'ds-bot')
const home = join(root, '.dsh-test-project-board-shell'), out = join(root, 'shots/project-board-shell')
const base = 'http://127.0.0.1:3112'
assert.equal(process.platform, 'linux')
assert.equal(process.env.MOCK_BOARD_SHELL, '1')
let cookie, login
const authenticate = async () => {
  login = (await readFile(join(home, 'web.log'), 'utf8')).match(/http:\/\/127\.0\.0\.1:3112\/\?token=\S+/)?.[0]
  assert.ok(login)
  const response = await fetch(login, { redirect: 'manual' }); assert.equal(response.status, 303)
  cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
}
const api = async (endpoint, payload = {}) => {
  const data = await fetch(base + '/api/bot', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) }).then(r => r.json())
  assert.ok(data.ok, data.error?.message); return data.value
}
const audit = sessionId => fetch(base + '/api/board-bench', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }).then(r => r.json())
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (fn, label, timeout = 120000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(300) }
  throw new Error('Timed out: ' + label)
}
const checks = [], cards = [], errors = []
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name) }
const get = async card => (await api('board-view')).cards.find(item => item.id === card.id)
const file = (card, suffix) => join(card.projectPath, 'shell-bench-' + card.id + '.' + suffix)
const value = (card, suffix) => readFile(file(card, suffix), 'utf8').catch(() => '')
const status = (card, expected) => until(async () => (await get(card)).status === expected, expected)
const decide = async (card, kind) => {
  const ready = await until(async () => { const c = await get(card); return c.decisions.some(d => d.kind === kind && d.status === 'open') && c }, kind)
  const d = ready.decisions.find(d => d.kind === kind && d.status === 'open')
  return api('board-decide', { id: card.id, decisionId: d.id, decisionVersion: d.version, choice: 'approve' })
}
// Test-only OS observation. Match this synthetic worker's exact argv and bench
// environment, never a process name, shared port or workspace-wide kill pattern.
const workerPids = async card => {
  const found = []
  for (const entry of await readdir('/proc')) if (/^\d+$/.test(entry)) {
    try {
      const argv = (await readFile('/proc/' + entry + '/cmdline', 'utf8')).split('\0')
      if (!argv[0].endsWith('node') || argv[1] !== '-e' || !argv[2]?.includes("const id='" + card.id + "'")) continue
      const env = (await readFile('/proc/' + entry + '/environ', 'utf8')).split('\0')
      if (env.includes('DSH_HOME=' + home)) found.push(Number(entry))
    } catch {}
  }
  return found
}
const bench = action => execFileSync('sh', ['dev/bench.sh', 'project-board-shell', '3112', '8812', action], { cwd: plugin, env: process.env, stdio: 'pipe', timeout: 180000 })
await mkdir(out, { recursive: true }); await authenticate()
let team = await api('state')
if (!team.bots.some(b => b.name === 'Nova')) await api('create-bot', { name: 'Nova', role: 'Shell implementation', color: 'blue' })
team = await api('state')
const nova = team.bots.find(b => b.name === 'Nova').id
const projects = (await api('board-view')).projects, studio = projects.find(p => p.title === 'Studio')
const create = async title => {
  const card = await api('board-create', { projectId: studio.id, requestId: crypto.randomUUID(), title: 'Shell bench: ' + title,
    description: 'Isolated shell lifecycle verification using a real DSH-managed background worker.', acceptance: 'Retain one original launch record.\nVerify recovered output with a shell assertion.', leadId: team.mainBotId, collaboratorIds: [nova] })
  cards.push(card); await api('board-start', { id: card.id, version: card.version }); await decide(card, 'design')
  await until(async () => Number(await value(card, 'ticks')) >= 3, 'real shell heartbeat')
  const live = await until(async () => { const c = await get(card); return c.backgroundJobs?.some(j => j.kind === 'bash' && j.status === 'running') && c }, 'registered background task')
  const job = live.deliveries.find(j => j.stepId === 'build')
  await until(async () => (await audit(job.sessionId)).agentStatus === 'idle', 'Agent idle with background shell running')
  return card
}
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS } })
let page
try {
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message))
  await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), locator => locator.click())
  const board = async () => { await page.goto(login); await page.locator('.bt-board-entry').first().waitFor({ timeout: 60000 }); await page.locator('.bt-board-entry').first().click() }
  const open = async card => {
    const close = page.locator('.bt-board-drawer-header').getByRole('button', { name: 'Close', exact: true }); if (await close.count()) await close.click()
    await page.locator('.bt-board-project').filter({ hasText: 'Studio' }).click()
    if ((await get(card)).status === 'cancelled') await page.getByLabel('Show cancelled', { exact: true }).check()
    await page.getByRole('button', { name: card.title, exact: true }).click()
  }
  const shot = async name => { await page.waitForTimeout(400); await page.screenshot({ path: join(out, name) }) }
  const a = await create('pause a running worker')
  check('real shell remains alive after the Agent becomes idle', (await workerPids(a)).length === 1)
  await board(); await open(a); await page.getByText('Background tasks', { exact: true }).waitFor(); await shot('01-background-running.png')
  await page.getByRole('button', { name: 'Pause requirement', exact: true }).click(); await status(a, 'paused')
  const savedTicks = await value(a, 'ticks'); await delay(1200)
  check('pause stops the actual process and heartbeat while retaining files', !(await workerPids(a)).length && savedTicks === await value(a, 'ticks') && (await value(a, 'starts')).trim().split('\n').length === 1)
  check('pause is acknowledged only after DSH reports the job killed', (await get(a)).backgroundJobs.some(j => j.status === 'killed'))
  await page.getByText('Stopped', { exact: true }).waitFor(); await shot('02-shell-paused.png')
  bench('stop'); bench('start'); await authenticate()
  check('paused shell and saved output remain stopped across a graceful restart', (await get(a)).status === 'paused' && !(await workerPids(a)).length && savedTicks === await value(a, 'ticks'))
  await board(); await open(a); await page.getByRole('button', { name: 'Resume requirement', exact: true }).click()
  await until(async () => (await get(a)).decisions.some(d => d.kind === 'acceptance' && d.status === 'open'), 'recovered shell delivery')
  const resumed = await get(a)
  check('resumption reconciles saved progress without repeating the original shell launch', resumed.deliveries.some(j => j.reconciled) && (await value(a, 'starts')).trim().split('\n').length === 1 && (await value(a, 'done')).includes('finished'))
  const review = resumed.deliveries.find(j => j.stepId === 'verify')
  check('a separate Bot verifies output using a real foreground shell assertion', (await audit(review.sessionId)).tools.some(t => t.name === 'bash' && (typeof t.arguments === 'string' ? JSON.parse(t.arguments) : t.arguments).command.includes('assert/strict')) && resumed.steps[1].status === 'done')
  await open(a); await page.getByText('Recovery checks', { exact: true }).scrollIntoViewIfNeeded(); await shot('03-shell-recovered.png')
  await decide(a, 'acceptance')
  const b = await create('cancel a timeout-promoted worker')
  await open(b); await page.getByRole('button', { name: 'Cancel requirement', exact: true }).click(); await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click(); await status(b, 'cancelled')
  const cancelledTicks = await value(b, 'ticks'); await delay(1200)
  check('cancel stops the actual process, keeps output and never marks Done', !(await workerPids(b)).length && cancelledTicks === await value(b, 'ticks') && (await get(b)).status === 'cancelled')
  await page.getByText('Stopped', { exact: true }).waitFor(); await shot('04-shell-cancelled.png')
  const c = await create('check uncertain work after a crash')
  const original = (await get(c)).deliveries.find(j => j.stepId === 'build')
  const pid = Number((await readFile(join(home, 'web.pid'), 'utf8')).trim())
  assert.ok((await readFile('/proc/' + pid + '/environ', 'utf8')).split('\0').includes('DSH_HOME=' + home))
  assert.equal(Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()), pid)
  process.kill(-pid, 'SIGKILL'); await unlink(join(home, 'web.pid')); await delay(500)
  bench('start'); await authenticate()
  await until(async () => (await get(c)).backgroundJobs?.some(j => j.status === 'unknown'), 'lost job registry detected')
  await delay(1800)
  const crashed = await get(c), history = await audit(original.sessionId)
  check('hard restart preserves uncertainty and blocks automatic shell replay', crashed.deliveryError.includes('Automatic replay is blocked') && !crashed.deliveries.some(j => j.parentId === original.id) && (await value(c, 'starts')).trim().split('\n').length === 1)
  check('the original board message is not resent after a hard restart', history.messages.filter(m => m.id === original.id).length === 1)
  check('paused/cancelled state and completed delivery survive the hard restart', (await get(b)).status === 'cancelled' && (await get(a)).status === 'done')
  await board(); await open(c); await page.getByText('Needs verification after restart', { exact: true }).waitFor(); await shot('05-hard-restart-needs-verification.png')
  await page.setViewportSize({ width: 390, height: 844 }); await shot('06-mobile-restart-state.png')
  const survivors = await workerPids(c)
  for (const pid of survivors) process.kill(pid, 'SIGKILL')
  await until(async () => !(await workerPids(c)).length, 'old worker stopped')
  const crashTicks = await value(c, 'ticks'); await delay(1200)
  assert.equal(await value(c, 'ticks'), crashTicks)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.getByLabel('Shutdown verification evidence', { exact: true }).fill('Bench operator checked the exact worker argv and isolated DSH_HOME: no original worker remains. The heartbeat is stable and the original launch record contains one entry. Preserve these effects.')
  await page.getByRole('button', { name: 'Confirm stopped and continue', exact: true }).click()
  await until(async () => (await get(c)).decisions.some(d => d.kind === 'acceptance' && d.status === 'open'), 'recovery after verified shutdown')
  check('verified shutdown unlocks recovery with retained evidence and no repeated launch', (await get(c)).backgroundJobs.some(j => j.status === 'confirmed-stopped' && j.resolution.actor === 'user') && (await value(c, 'starts')).trim().split('\n').length === 1 && (await value(c, 'done')).includes('finished'))
  await open(c); await page.getByText('Shutdown verified by user', { exact: true }).scrollIntoViewIfNeeded(); await shot('07-hard-restart-recovered.png')
  await decide(c, 'acceptance')
  check('bench page has no JavaScript errors', errors.length === 0)
  await writeFile(join(out, 'checks.json'), JSON.stringify({ checks, errors, hardRestart: { originalMessages: history.messages.filter(m => m.id === original.id).length, shellStarts: (await value(c, 'starts')).trim().split('\n').length, survivingWorkersBeforeVerification: survivors.length, behavior: 'unknown state holds leases until explicit shutdown verification; recovery then preserves the original launch' } }, null, 2))
} catch (error) {
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
  throw new Error(String(error.message).replace(/token=[^\s)]+/g, 'token=REDACTED'))
} finally {
  await browser.close()
  for (const card of cards) for (const pid of await workerPids(card)) { try { process.kill(pid, 'SIGKILL') } catch {} }
}
