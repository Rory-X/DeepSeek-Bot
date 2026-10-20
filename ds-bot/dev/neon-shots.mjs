// Evidence shots for the Neon connector card: Settings → Connectors at a phone width and a
// desktop width, in the states the connector goes through (off, waiting for the browser,
// connected). It drives a running test bench (dev/bench.sh) with the mock model, and the card
// is asked for one real authorization against the local Neon-shaped OAuth server
// (dev/neon-mock.mjs): no Neon account and no key is touched.
//
//   node dev/neon-shots.mjs <bench-name> <web-port> <out-dir>
//
// The bench's profile must point the connector at the mock, for example a --patch file with
//   - id: bot
//     config:
//       neon:
//         url: https://127.0.0.1:8912/mcp?readonly=true
// and the dsh process needs NODE_TLS_REJECT_UNAUTHORIZED=0 for the mock's self-signed
// certificate. playwright-core is not a dependency of this plugin: point
// DS_BOT_PLAYWRIGHT_DIR at a directory whose node_modules has it (default /tmp/pwtools), and
// CHROME_BIN at a Chromium or let playwright find its own.
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [bench, webPort, outDir] = process.argv.slice(2)
if (!bench || !webPort || !outDir) {
  console.error('usage: node dev/neon-shots.mjs <bench-name> <web-port> <out-dir>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const log = readFileSync(join(root, `.dsh-test-${bench}`, 'web.log'), 'utf8')
const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${webPort}/\\?token=[^\\s]+`))?.[0]
if (login === undefined) throw new Error(`no login URL in .dsh-test-${bench}/web.log`)

const requirePlaywright = createRequire(join(process.env.DS_BOT_PLAYWRIGHT_DIR ?? '/tmp/pwtools', 'noop.js'))
const { chromium } = requirePlaywright('playwright-core')
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN === undefined ? {} : { executablePath: process.env.CHROME_BIN }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })
const page = await context.newPage()
const popups = []
context.on('page', other => { if (other !== page) popups.push(other) })

// The preview notice masks the page until it is dismissed once per profile; the handler
// clears it before any click.
const previewNotice = page.getByRole('dialog').filter({ hasText: 'Preview Notice' }).getByRole('button', { name: 'Continue' })
await page.addLocatorHandler(previewNotice, () => previewNotice.click())

const failures = []
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
  if (!ok) failures.push(message)
}
const shot = async (name) => {
  await dismissDialogs()
  await page.waitForTimeout(400)
  const path = join(outDir, `neon-${name}.png`)
  await page.screenshot({ path })
  console.log(path)
}

// DSH opens notices in a modal that masks the page; clear whatever is open before a click.
// Only the preview notice is dismissed: the settings modal is a dialog too, and closing it
// would leave the shot on the chat instead of the Connectors page.
const dismissDialogs = async () => {
  for (let at = 0; at < 4; at += 1) {
    const dialog = page.getByRole('dialog').filter({ hasText: 'Preview Notice' })
    if (await dialog.count() === 0) return
    const button = dialog.getByRole('button', { name: /Continue|Got it|Close|OK/i })
    if (await button.count() > 0) {
      await button.first().click().catch(() => {})
    } else {
      await page.keyboard.press('Escape').catch(() => {})
    }
    await page.waitForTimeout(600)
  }
}
await page.goto(login, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(2000)
await dismissDialogs()
const firstBot = page.locator('.bt-tile, .bt-row').first()
await firstBot.waitFor({ timeout: 60_000 })
// The team is built after the first paint; the tile appears a moment after the sidebar.
for (let at = 0; at < 20; at += 1) {
  if (await page.locator('button[aria-label="Settings"]').count() > 0) break
  await page.waitForTimeout(1000)
}
// Settings opens from a Bot's context menu; the team pages live behind the modal's nav.
await firstBot.click({ button: 'right' })
const editBot = page.getByRole('menuitem', { name: 'Edit Bot' })
if (await editBot.count() > 0) {
  await editBot.click()
} else {
  await page.keyboard.press('Escape')
  await firstBot.click()
  await page.waitForTimeout(1500)
  await page.locator('button[aria-label="Settings"]').first().click()
}
await page.locator('.bt-settings').waitFor({ timeout: 20_000 })
await page.locator('.bt-settings-nav .bt-settings-item', { hasText: /^Connectors$/ }).click()
const neon = page.locator('.bt-connector', { hasText: 'Neon' })
await neon.waitFor({ timeout: 20_000 })
await neon.scrollIntoViewIfNeeded()

const status = () => neon.locator('.bt-connector-status').innerText()
const button = name => neon.getByRole('button', { name })
const settle = async (pattern) => {
  const wanted = new RegExp(pattern)
  for (let at = 0; at < 40; at += 1) {
    if (wanted.test(await status())) return true
    await page.waitForTimeout(500)
  }
  return false
}
const connect = async () => {
  await dismissDialogs()
  await button('Connect').or(button('Connect again')).first().click()
}
const disconnect = async () => {
  if (await button('Disconnect').count() === 0) return
  await button('Disconnect').click()
  await settle('^Not connected$')
}

check(/^Not connected$/.test(await status()), 'Neon starts off')
check((await neon.locator('.bt-connector-name').innerText()) === 'Neon', 'the row is the Neon connector')
check((await page.getByText('Full capabilities').count()) === 0 || (await neon.getByText('Full capabilities').count()) === 0, 'the card offers no write panel')

for (const [label, width, height] of [['phone', 390, 844], ['desktop', 1280, 900]]) {
  await page.setViewportSize({ width, height })
  await disconnect()
  await neon.scrollIntoViewIfNeeded()
  await shot(`off-${label}`)
  await connect()
  check(await settle('Waiting for the browser'), `the card waits for the browser (${label})`)
  await shot(`connecting-${label}`)
  check(await settle('^Connected'), `the card reaches connected (${label})`)
  await shot(`ready-${label}`)
  for (const popup of popups.splice(0)) await popup.close().catch(() => {})
}

await browser.close()
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nall checks passed; shots in ${outDir}`)
