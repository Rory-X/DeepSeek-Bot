// WeRead connector card evidence: the Connectors page and the key form at a phone width
// (390×844) and a desktop width (1280×800), plus the form's error state after a key the
// gateway refuses. Nothing here touches the reader's data: the form is filled with an
// invalid probe key, so no real call is made and no shelf or note is ever shown.
//
//   node dev/shots-weread.mjs <dsh-repo> <out-dir> <bench-name> <web-port>
//
// The bench must already be running (dev/bench.sh web ...); the login URL comes from its
// web.log, as in dev/ui-shots.mjs. Screenshots are written as
// `<out-dir>/390-01-connectors.png` and so on, and their md5s are printed.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwright, waitTeam } from './desktop-linux/lib.mjs'

const [repo, outDir, bench, webPort] = process.argv.slice(2)
if (!repo || !outDir || !bench || !webPort) {
  console.error('usage: node dev/shots-weread.mjs <dsh-repo> <out-dir> <bench-name> <web-port>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

const findChrome = () => {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() } catch {}
  }
  return undefined
}
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const log = readFileSync(join(root, `.dsh-test-${bench}`, 'web.log'), 'utf8')
const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${webPort}/\\?token=[^\\s]+`))?.[0]
if (!login) throw new Error(`no login URL in .dsh-test-${bench}/web.log`)

const { chromium } = playwright(repo)
const browser = await chromium.launch({ executablePath: findChrome(), headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue' })
await page.addLocatorHandler(notice, () => notice.click())
const settle = () => page.waitForTimeout(500)

const shot = async (name) => {
  await settle()
  const path = join(outDir, name)
  await page.screenshot({ path, fullPage: false })
  console.log(path)
}

// The Connectors page lives behind the account menu (desktop footer avatar, or the phone
// list page's brand button). Both paths are tried, then the plain text as a last resort.
const openConnectors = async () => {
  if (await notice.isVisible().catch(() => false)) await notice.click()
  const direct = page.getByRole('button', { name: /^(Connectors|连接器)$/ })
  if (await direct.first().isVisible().catch(() => false)) {
    await direct.first().click()
  } else {
    const trigger = page.locator('button.bt-account, .bt-brand.bt-nav-account').first()
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click()
      await page.waitForTimeout(300)
    }
    const item = page.getByRole('menuitem', { name: /Connectors|连接器/ }).first()
    if (await item.isVisible().catch(() => false)) await item.click()
    else await page.getByText(/Connectors|连接器/, { exact: true }).first().click()
  }
  await page.getByText('WeRead', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 })
  await settle()
}

const wereadRow = () => page.locator('.bt-connector', { hasText: 'WeRead' }).first()
const connectButton = () => wereadRow().getByRole('button', { name: /^(Connect|连接)$/ }).first()

// Opens the row's key form and shoots it; returns nothing so the caller can reuse the page.
const showForm = async (prefix) => {
  await wereadRow().scrollIntoViewIfNeeded()
  await connectButton().click()
  await wereadRow().locator('input').first().waitFor({ state: 'visible', timeout: 10_000 })
  await shot(`${prefix}-02-form.png`)
}

const showError = async (prefix) => {
  const input = wereadRow().locator('input').first()
  await input.fill('wrk-invalid-probe')
  await connectButton().click()
  await wereadRow().getByText(/did not accept|Could not connect|无法连接|鉴权失败/).first().waitFor({ state: 'visible', timeout: 20_000 })
  await shot(`${prefix}-03-error.png`)
}

try {
  await page.goto(login)
  await waitTeam(page)
  await page.waitForTimeout(1500)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await waitTeam(page)
  await openConnectors()
  await shot('390-01-connectors.png')
  await showForm('390')
  await showError('390')

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.reload()
  await waitTeam(page)
  await openConnectors()
  await shot('1280-01-connectors.png')
  await showForm('1280')

  for (const name of readdirSync(outDir).filter(file => /^\d{3}-\d{2}-.*\.png$/.test(file)).sort()) {
    const digest = createHash('md5').update(readFileSync(join(outDir, name))).digest('hex')
    console.log(`${digest}  ${name}`)
  }
} finally {
  await browser.close()
}
