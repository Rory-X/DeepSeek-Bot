// Run only against the named synthetic bench, never a user's team.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../..')
const home = join(root, '.dsh-test-bot-folder-live'), out = join(root, 'shots/bot-folder-live')
const base = 'http://127.0.0.1:3132'
const log = await readFile(join(home, 'web.log'), 'utf8')
const login = log.match(/http:\/\/127\.0\.0\.1:3132\/\?token=\S+/)?.[0]
assert.ok(login, 'The isolated Bot folder bench must be running')
const auth = await fetch(login, { redirect: 'manual' })
const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const api = async (endpoint, payload = {}) => {
  const result = await fetch(base + '/api/bot', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) }).then(response => response.json())
  assert.ok(result.ok, result.error?.message)
  return result.value
}
const until = async (check, label) => {
  const end = Date.now() + 30000
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error('Timed out: ' + label)
}
const checks = [], errors = []
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name) }
await mkdir(out, { recursive: true })
let team = await api('state')
assert.equal(team.bots.length, 1, 'Use a fresh synthetic bench')
await api('update-bot', { id: team.mainBotId, model: team.models.find(model => !model.needsKey).ref })
for (const name of ['Auth', 'Gmail', 'Slack', 'Designer', 'Writer']) await api('create-bot', { name, role: name === 'Designer' ? 'Design' : 'Integration' })
team = await api('state')
const byName = Object.fromEntries(team.bots.map(bot => [bot.name, bot.id]))
await api('set-flags', { id: byName.Auth, pinned: true })
await api('set-flags', { id: byName.Designer, pinned: true })
await until(async () => Object.keys((await api('state')).work?.turns ?? {}).length === 0, 'initial greetings finish')
const { chromium } = await import(pathToFileURL(process.env.BOARD_PLAYWRIGHT).href)
const browser = await chromium.launch({ headless: true, env: { ...process.env, LD_LIBRARY_PATH: process.env.UI_VERIFY_LIBS ?? '' } })
const pages = []
let stage = 'open windows'
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'dark' })
  const a = await desktop.newPage(), b = await phone.newPage()
  pages.push(a, b)
  for (const page of [a, b]) {
    page.on('pageerror', error => errors.push(error.message))
    await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: /Continue|继续/ }), async locator => { await locator.click({ timeout: 3000 }).catch(() => {}) }, { noWaitAfter: true })
    const feed = page.waitForResponse(response => response.url().includes('api/bot/feed?scope=roster') && response.status() === 200)
    await page.goto(login)
    await page.locator('.bt-list').waitFor({ timeout: 60000 })
    await feed
    await page.locator('.bt-list [data-bot-id]').first().click()
    if (page === b) await page.locator('[data-bt-nav-back]').click()
  }
  let navigations = 0
  for (const page of [a, b]) page.on('domcontentloaded', () => { navigations++ })
  const ids = page => page.locator('.bt-list [data-bot-id]').evaluateAll(rows => rows.map(row => row.dataset.botId))
  const orderBefore = await ids(a)
  const group = (page, id) => page.locator(`[data-bot-folder-id="${id}"]`)
  const menu = async (page, id) => {
    await group(page, id).locator('.bt-bot-folder-edit').click()
    await page.getByRole('menu').waitFor()
    await page.getByRole('menu').evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)) })
  }
  const folderNames = page => page.locator('.bt-bot-folder-name').allTextContents()
  const firstFolder = async (page, id) => page.waitForFunction(id => document.querySelector('.bt-bot-folder')?.dataset.botFolderId === id, id)

  stage = 'Main Bot tool updates both windows'
  await api('send', { sessionId: team.mainBotId, text: '归组 connector: Auth, Gmail, Slack' })
  const connector = await until(async () => (await api('state')).botFolders.find(folder => folder.name === 'connector'), 'Main Bot grouping tool')
  const savedAt = Date.now()
  await Promise.all([a, b].map(page => group(page, connector.id).waitFor()))
  const updateDelayMs = Date.now() - savedAt
  const modelCalls = (await readFile(join(home, 'mock.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  check('real Main Bot organize_bots updates both open lists without reload', modelCalls.some(call => call.out?.some(block => block.type === 'tool_use' && block.name === 'organize_bots')) && navigations === 0)
  check('group title uses the smaller font', await group(a, connector.id).locator('.bt-bot-folder-name').evaluate(el => getComputedStyle(el).fontSize) === '13px')
  for (const page of [a, b]) check('pinned rows precede folders, then ordinary rows on ' + (page === a ? 'desktop' : 'phone'), await page.locator('.bt-list').evaluate((el, byName) => {
    const children = [...el.children]
    const index = children.findIndex(child => child.classList.contains('bt-bot-folder'))
    return children.findIndex(child => child.dataset.botId === byName.Designer) < index && index < children.findIndex(child => child.dataset.botId === byName.Writer)
  }, byName))
  for (const page of [a, b]) check('divider follows the last member on ' + (page === a ? 'desktop' : 'phone'), await group(page, connector.id).evaluate(el => {
    const last = [...el.querySelectorAll('[data-bot-id]')].at(-1)
    const divider = el.querySelector('.bt-bot-folder-divider')
    return divider && divider.getBoundingClientRect().top >= last.getBoundingClientRect().bottom && getComputedStyle(divider).borderTopWidth === '1px'
  }))
  const planning = await api('bot-folder-save', { name: 'planning', botIds: [byName.Writer] })
  stage = 'pin and unpin'
  await Promise.all([a, b].map(page => group(page, planning.id).waitFor()))
  await menu(a, planning.id)
  await a.getByRole('menuitem', { name: 'Pin folder', exact: true }).click()
  await Promise.all([a, b].map(page => firstFolder(page, planning.id)))
  check('pinning moves the folder first in both windows', (await api('state')).botFolders.find(folder => folder.id === planning.id).pinned === true)
  await menu(a, planning.id)
  await a.getByRole('menuitem', { name: 'Unpin folder', exact: true }).waitFor()
  await a.screenshot({ path: join(out, '01-desktop-folder-menu.png') })
  await a.getByRole('menuitem', { name: 'Unpin folder', exact: true }).click()
  await Promise.all([a, b].map(page => firstFolder(page, connector.id)))
  check('unpinning restores the normal folder order', true)

  stage = 'Main Bot pin and unpin tools'
  await api('send', { sessionId: team.mainBotId, text: '置顶分组 planning' })
  await Promise.all([a, b].map(page => firstFolder(page, planning.id)))
  for (const page of [a, b]) assert.ok(await page.locator('.bt-list').evaluate((el, id) => {
    const children = [...el.children]
    return children.findIndex(child => child.dataset.botId === id) < children.findIndex(child => child.classList.contains('bt-bot-folder'))
  }, byName.Designer))
  check('Main Bot pins the folder below pinned standalone Bots in both windows', true)
  await until(async () => Object.keys((await api('state')).work?.turns ?? {}).length === 0, 'pin tool finishes')
  await api('send', { sessionId: team.mainBotId, text: '取消置顶分组 planning' })
  await Promise.all([a, b].map(page => firstFolder(page, connector.id)))
  check('Main Bot unpins the folder in both windows', (await api('state')).botFolders.find(folder => folder.id === planning.id).pinned === false)
  await group(a, connector.id).locator('.bt-bot-folder-toggle').click()
  const current = (await api('state')).botFolders.find(folder => folder.id === connector.id)
  await api('bot-folder-save', { ...current, name: 'connectors' })
  await Promise.all([a, b].map(page => group(page, connector.id).getByRole('button', { name: 'connectors', exact: true }).waitFor()))
  check('live rename preserves the existing collapse preference', await group(a, connector.id).locator('.bt-bot-folder-toggle').getAttribute('aria-expanded') === 'false')
  check('collapsed groups hide their bottom divider', !await group(a, connector.id).locator('.bt-bot-folder-divider').isVisible())

  await phone.setOffline(true)
  stage = 'offline recovery'
  const oldPlanning = (await api('state')).botFolders.find(folder => folder.id === planning.id)
  await api('bot-folder-save', { ...oldPlanning, name: 'delivery', botIds: [byName.Writer, byName.Auth] })
  await group(a, planning.id).getByRole('button', { name: 'delivery', exact: true }).waitFor()
  await phone.setOffline(false)
  await group(b, planning.id).getByRole('button', { name: 'delivery', exact: true }).waitFor()
  await group(b, planning.id).locator(`[data-bot-id="${byName.Auth}"]`).waitFor()
  check('reconnection catches up with moves and renamed folders', (await folderNames(b)).includes('delivery'))
  await menu(b, planning.id)
  await b.getByRole('menuitem', { name: 'Pin folder', exact: true }).click()
  await firstFolder(b, planning.id)
  await menu(b, planning.id)
  await b.screenshot({ path: join(out, '02-mobile-folder-menu.png') })
  await b.getByRole('menuitem', { name: 'Manage folder', exact: true }).click()
  await b.locator('.bt-bot-folders-dialog').waitFor()
  await b.getByRole('button', { name: 'Close', exact: true }).click()
  check('the popup still opens folder management', true)

  stage = 'dissolve populated folders'
  await menu(a, planning.id)
  await a.getByRole('menuitem', { name: 'Dissolve folder', exact: true }).click()
  await Promise.all([a, b].map(page => group(page, planning.id).waitFor({ state: 'detached' })))
  check('dissolving a populated folder updates both windows and retains all Bots', (await api('state')).bots.length === team.bots.length)
  await api('send', { sessionId: team.mainBotId, text: '解散分组 connectors' })
  await Promise.all([a, b].map(page => group(page, connector.id).waitFor({ state: 'detached' })))
  const calls = (await readFile(join(home, 'mock.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const folderActions = calls.flatMap(call => call.out ?? []).filter(block => block.type === 'tool_use' && block.name === 'organize_bots').map(block => block.input?.action)
  check('real Main Bot tools pin, unpin and dissolve populated folders', ['pin', 'unpin', 'dissolve'].every(action => folderActions.includes(action)))
  assert.deepEqual(await ids(a), orderBefore)
  assert.deepEqual(await ids(b), orderBefore)
  check('former members return to normal pinned and recent-activity order', (await api('state')).bots.find(bot => bot.id === byName.Auth).pinned === true)
  check('all live changes occurred without page reload', navigations === 0)
  await b.screenshot({ path: join(out, '03-after-dissolving.png') })
  check('no client exceptions', errors.length === 0)
  await writeFile(join(out, 'checks.json'), JSON.stringify({ checks, errors, updateDelayMs }, null, 2))
} catch (error) {
  console.log('FAIL ' + stage + ': ' + String(error.message).replace(/token=[A-Za-z0-9_-]+/g, 'token=REDACTED'))
  for (const [index, page] of pages.entries()) await page.screenshot({ path: join(out, `debug-${index}.png`) }).catch(() => {})
  throw new Error(String(error.message).replace(/token=[A-Za-z0-9_-]+/g, 'token=REDACTED'))
} finally { await browser.close() }
