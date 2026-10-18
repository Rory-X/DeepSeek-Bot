// Mobile style verification service: render the plugin's real UI at phone viewports and
// report what breaks, so a mobile change can be re-checked with one command.
//
//   dev/ui-verify/run.sh [--viewports 360x800,390x844] [--out <dir>] [--stop]
//
// It uses the plugin's own CSS as the source of truth: the static pass reads
// src/client/styles.js (no build, no browser) and the live pass loads the plugin from this
// checkout in a bench (dev/bench.sh layout: mock model + dsh web in .dsh-test-uiverify) and
// measures the rendered page in headless Chromium at each viewport.
//
// The live pass needs a DeepSeek Harness install: DSH_HARNESS (bench.sh's rule: a
// ../deepseek-harness checkout, else the same place in the main worktree). With no harness
// and no bench running, it prints the static pass alone and says so.
//
// Exit code 1 when a FAIL was found, 0 otherwise; --no-fail always exits 0.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}
const has = name => argv.includes(`--${name}`)
// --plugin renders another checkout (a `git archive` of an older revision, say) and --home
// gives it its own bench, so an issue can show the state before a fix and the PR after it.
const PLUGIN = resolve(flag('plugin', resolve(HERE, '..', '..')))
const ROOT = resolve(PLUGIN, '..')
const NAME = flag('bench', 'uiverify')
const HOME_DIR = resolve(flag('home', join(ROOT, `.dsh-test-${NAME}`)))
const CLIENT = join(PLUGIN, 'src', 'client')
const STYLES = join(CLIENT, 'styles.js')
const viewports = flag('viewports', '360x800,390x844,430x932').split(',').map(text => {
  const [w, h] = text.split('x').map(Number)
  if (!w || !h) throw new Error(`bad viewport ${text}`)
  return { width: w, height: h }
})
const outDir = resolve(flag('out', join(ROOT, 'shots', 'ui-verify')))
const webPort = Number(flag('port', 3097))
const mockPort = Number(flag('mock-port', 8797))
const noFail = has('no-fail')
// touch: the default, a phone. both: also run each viewport with a mouse, to check that
// the mobile navigation follows the pointer and not the width alone.
const pointer = flag('pointer', 'touch')

// The playwright that dev/ui-verify/package.json installs; playwright-core alone cannot
// download a browser.
let playwright
try {
  playwright = await import('playwright')
} catch {
  console.error('playwright is not installed: cd ds-bot/dev/ui-verify && npm install')
  process.exit(2)
}
const { chromium } = playwright

// Chromium needs libnss3, libatk and friends, which a bare CentOS/RHEL has not. setup.sh
// unpacks them without root; point the browser at whichever copy is already on the
// machine — UI_VERIFY_LIBS, the repository's own, or a shared one under ~/.local. A bench
// of another checkout (--home) still uses the ones already there. LD_LIBRARY_PATH is
// inherited by the browser process only, and anything the caller set stays in front.
const REPO = resolve(HERE, '..', '..', '..')
const libs = [
  process.env.UI_VERIFY_LIBS,
  join(HOME_DIR, 'libs', 'usr', 'lib64'),
  join(REPO, '.dsh-test-uiverify', 'libs', 'usr', 'lib64'),
  join(REPO, `.dsh-test-${NAME}`, 'libs', 'usr', 'lib64'),
  join(homedir(), '.local', 'chromium-libs', 'usr', 'lib64'),
].filter(Boolean).find(existsSync)
const browserEnv = libs
  ? { ...process.env, LD_LIBRARY_PATH: [process.env.LD_LIBRARY_PATH, libs].filter(Boolean).join(':') }
  : process.env

const failures = []
const warnings = []
const check = (ok, message, soft) => {
  const line = `${ok ? 'ok  ' : soft ? 'WARN' : 'FAIL'} ${message}`
  console.log(line)
  if (!ok) (soft ? warnings : failures).push(message)
}

// ---------------------------------------------------------------- static pass (styles.js)
// The plugin builds its CSS in styles.js, so the file itself is the source of truth; every
// rule there is one line, which keeps the line numbers exact.
const staticPass = () => {
  const source = readFileSync(STYLES, 'utf8').split('\n')
  const at = (pattern, filter = () => true) => {
    const hits = []
    source.forEach((line, index) => { if (pattern.test(line) && filter(line)) hits.push(index + 1) })
    return hits
  }
  const css = at(/^[.#@a-zA-Z[]/)
  console.log(`\n== styles.js (${css.length} rule lines) ==`)
  const report = {}
  const note = (key, hits, message) => {
    report[key] = hits
    console.log(`${hits.length ? 'WARN' : 'ok  '} ${message}: ${hits.length}${hits.length ? ` (lines ${hits.slice(0, 12).join(', ')}${hits.length > 12 ? ', …' : ''})` : ''}`)
    if (hits.length) warnings.push(`${key}: ${hits.length}`)
  }
  // A phone viewport is 360–430 CSS px wide; a wider fixed box cannot fit.
  const over360 = (pattern, group) => at(pattern, line => [...line.matchAll(new RegExp(`${group}`, 'g'))].some(match => Number(match[1]) > 360))
  note('fixedWidthOver360', over360(/[^-]width:\s*(\d+)px/, '[^-]width:\\s*(\\d+)px'), 'fixed widths over 360px')
  note('minWidthOver360', over360(/min-width:\s*(\d+)px/, 'min-width:\\s*(\\d+)px'), 'min-width over 360px')
  // 100vh is fine when the file also upgrades it on browsers that have dvh.
  const dvh = at(/@supports[^{]*dvh|height:\s*100dvh/)
  const vh = at(/100vh/)
  if (dvh.length) {
    console.log(`ok   100vh: ${vh.length} use(s), upgraded to dvh at line(s) ${dvh.join(', ')}`)
  } else {
    note('vhNotDvh', vh, '100vh (a phone toolbar overlaps it; dvh does not)')
  }
  note('vwUnit', at(/\d+vw/), 'vw units (no scrollbar allowance, ignores the notch)')
  // Unlike the rest, more is better here: a phone needs the notch and home-bar insets.
  const safeArea = at(/env\(safe-area-inset/)
  console.log(`${safeArea.length ? 'ok  ' : 'WARN'} safe-area-inset uses (under the notch and the home bar): ${safeArea.length}${safeArea.length ? ` (lines ${safeArea.join(', ')})` : ''}`)
  if (!safeArea.length) warnings.push('no env(safe-area-inset-*)')
  report.safeArea = safeArea
  const hoverOnly = at(/:hover/, line => !/hover:hover|hover:none/.test(line))
  note('hoverRules', hoverOnly, ':hover rules')
  const touchFallback = at(/hover:none/)
  console.log(`${touchFallback.length ? 'ok  ' : 'WARN'} @media (hover:none) touch fallbacks: ${touchFallback.length}${touchFallback.length ? ` (lines ${touchFallback.join(', ')})` : ''}`)
  if (!touchFallback.length) warnings.push('no @media (hover:none) fallback')
  const breakpoints = [...new Set(at(/max-width:\s*\d+px/).map(line => source[line - 1].match(/max-width:\s*(\d+)px/)[1]))].sort((a, b) => a - b)
  console.log(`info phone-range breakpoints in @media rules: ${breakpoints.join(', ') || 'none'}`)
  report.breakpoints = breakpoints
  report.touchFallbacks = touchFallback
  // Layout widths also live in the client's own constants: browser-pane.js keeps a panel
  // at least MIN_WIDTH wide and leaves MIN_CHAT for the conversation beside it, which a
  // 360–430px viewport cannot do both of.
  const constants = []
  for (const file of readdirSync(CLIENT).filter(name => name.endsWith('.js') && name !== 'styles.js')) {
    readFileSync(join(CLIENT, file), 'utf8').split('\n').forEach((line, index) => {
      const match = line.match(/^const ([A-Z_]+)\s*=\s*(\d+)\s*$/)
      if (match && /WIDTH|HEIGHT|MIN_|MAX_/.test(match[1]) && Number(match[2]) > 360) constants.push(`${file}:${index + 1} ${match[1]}=${match[2]}`)
    })
  }
  report.layoutConstants = constants
  // Info only: a constant over 360px is not a bug by itself — browser-pane.js compares it
  // with the viewport and covers the chat instead of squeezing it. The live pass sees that.
  console.log(`info layout constants over 360px: ${constants.length}${constants.length ? ` (${constants.join(', ')})` : ''}`)
  return report
}

// ------------------------------------------------------------------ bench (mock + dsh web)
const alive = name => {
  const file = join(HOME_DIR, `${name}.pid`)
  if (!existsSync(file)) return false
  try { process.kill(-Number(readFileSync(file, 'utf8').trim()), 0); return true } catch { return false }
}

const stopOne = name => {
  const file = join(HOME_DIR, `${name}.pid`)
  if (!existsSync(file)) return
  const pid = Number(readFileSync(file, 'utf8').trim())
  try { process.kill(-pid, 'SIGTERM') } catch {}
  rmSync(file, { force: true })
}

const stopBench = () => {
  stopOne('web')
  stopOne('mock')
  console.log('bench stopped')
}

const ensureProfile = () => {
  const profile = join(HOME_DIR, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'ds-bot': `link:${PLUGIN}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'] } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  // The link itself has to be installed, or dsh skips the bundle and the page comes up
  // without the plugin.
  if (existsSync(join(profile, 'node_modules', 'ds-bot'))) return
  const install = spawnSync('pnpm', ['install'], { cwd: profile, env: { ...process.env, DSH_HOME: HOME_DIR }, stdio: 'ignore' })
  if (install.status !== 0) console.log(`profile install failed in ${profile}; the plugin will not load`)
}

const spawnDetached = (command, args, options, log) => {
  const fd = log ? openSync(log, 'a') : 'ignore'
  const child = spawn(command, args, { detached: true, stdio: log ? ['ignore', fd, fd] : 'ignore', ...options })
  child.unref()
  return child.pid
}

const loginUrl = () => {
  const log = join(HOME_DIR, 'web.log')
  if (!existsSync(log)) return undefined
  return readFileSync(log, 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${webPort}/\\?token=[^\\s]+`))?.[0]
}

const harness = () => process.env.DSH_HARNESS || join(ROOT, 'deepseek-harness')

// Anything answering on the port means a dsh web is already there — possibly one started
// outside this service, whose pid file we do not own — so the port decides, not the pid.
const portAnswers = async () => {
  try {
    await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch { return false }
}

const benchLogin = async () => (loginUrl() && (await portAnswers()) ? loginUrl() : undefined)

const startBench = async () => {
  const repo = harness()
  if (!existsSync(join(repo, 'node_modules'))) {
    console.log(`no harness at ${repo}; set DSH_HARNESS to a DeepSeek Harness install to run the live pass`)
    return undefined
  }
  mkdirSync(HOME_DIR, { recursive: true })
  ensureProfile()
  writeFileSync(join(HOME_DIR, 'bench.patch.yml'), '[]\n')
  if (!alive('mock')) {
    const pid = spawnDetached('node', ['dev/mock-llm.mjs', HOME_DIR], {
      cwd: PLUGIN,
      env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_DELAY_MS: '300', MOCK_LOG: join(HOME_DIR, 'mock.jsonl') },
    }, join(HOME_DIR, 'mock.out'))
    writeFileSync(join(HOME_DIR, 'mock.pid'), String(pid))
  }
  if (!alive('web') && !(await portAnswers())) {
    const log = join(HOME_DIR, 'web.log')
    rmSync(log, { force: true })
    const pid = spawnDetached('pnpm', ['-s', 'dsh', '--profile', 'web', '--patch', join(HOME_DIR, 'bench.patch.yml'), '--no-open', '--port', String(webPort)], {
      cwd: repo,
      env: { ...process.env, DSH_HOME: HOME_DIR, DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, DEEPSEEK_API_KEY: 'mock-key' },
    }, log)
    writeFileSync(join(HOME_DIR, 'web.pid'), String(pid))
    for (let i = 0; i < 120; i += 1) {
      if (loginUrl()) break
      if (!alive('web')) break
      await new Promise(done => setTimeout(done, 1000))
    }
  }
  if (!loginUrl()) {
    console.log(`dsh web did not come up; see ${join(HOME_DIR, 'web.log')}`)
    return undefined
  }
  return loginUrl()
}

// ------------------------------------------------------------------- live pass (browser)
// Everything measured in the page: what a phone viewport cannot hold, and what a finger
// cannot hit. Sizes come from getBoundingClientRect, so a fixed box or a stray row shows up.
const collect = () => {
  const vw = innerWidth
  const vh = innerHeight
  const visible = el => {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    return true
  }
  const name = el => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].filter(c => !c.includes('_')).slice(0, 2).map(c => `.${c}`).join('')}`
  const label = el => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
  const all = [...document.querySelectorAll('*')].filter(visible)
  const overflowing = []
  const scrollReachable = []
  const smallTargets = []
  const clipped = []
  const outside = []
  const interactive = 'button, a[href], input, textarea, select, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [contenteditable="true"], .bt-row, .bt-tile, .bt-pill'
  // A row inside a scroller the user can drag is reachable, however far it sits; only what
  // no ancestor can bring into view is really cut off.
  const scrollableAncestor = el => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (/auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return name(node)
    }
    return undefined
  }
  for (const el of all) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    if (rect.right > vw + 1 || rect.left < -1) {
      const row = { el: name(el), left: Math.round(rect.left), right: Math.round(rect.right), label: label(el) }
      const scroller = scrollableAncestor(el)
      if (scroller) scrollReachable.push({ ...row, scroller })
      else if (rect.right > vw + 1) overflowing.push(row)
      else outside.push(row)
    }
    const style = getComputedStyle(el)
    if ((style.position === 'fixed' || style.position === 'absolute') && rect.width > vw + 1) {
      outside.push({ el: name(el), left: Math.round(rect.left), right: Math.round(rect.right), label: `wider than the viewport (${Math.round(rect.width)}px)` })
    }
    if (el.matches(interactive)) {
      if (rect.width < 24 || rect.height < 24) smallTargets.push({ el: name(el), w: Math.round(rect.width), h: Math.round(rect.height), label: label(el) })
    }
    // clientWidth 0 means the box has no width at all (a collapsed column, or a
    // content-visibility:hidden panel), which is a layout finding of its own, not clipped text.
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && style.overflowX !== 'visible' && el.children.length === 0 && (el.textContent || '').trim()) {
      clipped.push({ el: name(el), text: label(el), w: Math.round(rect.width), scroll: el.scrollWidth })
    }
  }
  const fixed = [...document.querySelectorAll('*')].filter(el => getComputedStyle(el).position === 'fixed' && visible(el)).map(el => {
    const rect = el.getBoundingClientRect()
    return { el: name(el), top: Math.round(rect.top), bottom: Math.round(vh - rect.bottom), width: Math.round(rect.width), paddingBottom: getComputedStyle(el).paddingBottom }
  })
  // A touch screen has no hover, so anything the CSS hides until :hover — and a
  // visibility:hidden element cannot even take focus, so :focus-within does not save it —
  // is simply unreachable. Closed menus and dialogs are display:none, which leaves them
  // with no box, so what is left here is laid out and hidden on purpose.
  const hoverOnly = []
  for (const el of document.querySelectorAll(interactive)) {
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    if ((rect.width === 0 && rect.height === 0) || el.closest('[aria-hidden="true"]')) continue
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) {
      hoverOnly.push({ el: name(el), w: Math.round(rect.width), h: Math.round(rect.height), visibility: style.visibility, opacity: style.opacity, label: label(el) })
    }
  }
  // The message box is the shell's own input; what matters on a phone is how close it sits
  // to the bottom edge, where the home indicator and the browser toolbar are.
  const composer = [...document.querySelectorAll('[contenteditable="true"]')].at(-1)
  const composerBox = composer?.getBoundingClientRect()
  // The navigation shape: the Bot list (sidebar) beside the chat, or a list page of its
  // own. The two-level navigation marks its roots with data-bt-nav; until those hooks are
  // in, .bt-side is the plugin's sidebar and bt-rail is its collapsed form.
  const side = document.querySelector('.bt-side')
  const listRoot = document.querySelector('[data-bt-nav="list"]')
  const chatRoot = document.querySelector('[data-bt-nav="chat"]')
  const nav = {
    hooks: Boolean(listRoot || chatRoot),
    listRoot: Boolean(listRoot),
    chatRoot: Boolean(chatRoot),
    // A list page of its own is what the mobile navigation looks like.
    mobile: Boolean(listRoot),
    sidebar: side ? { width: Math.round(side.getBoundingClientRect().width), rail: side.classList.contains('bt-rail') } : null,
    list: [...document.querySelectorAll('.bt-row, .bt-tile')].filter(visible).length,
    composer: Boolean(composerBox),
  }
  return {
    vw,
    vh,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    overflowing: overflowing.slice(0, 25),
    scrollReachable: scrollReachable.slice(0, 25),
    outside: outside.slice(0, 25),
    smallTargets: smallTargets.slice(0, 40),
    clipped: clipped.slice(0, 25),
    fixed: fixed.slice(0, 25),
    nav,
    hoverOnly: hoverOnly.slice(0, 40),
    // The message toolbar in the state a touch screen really has: no hover to reveal it.
    toolbars: [...document.querySelectorAll('.bt-tools')].map(el => {
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return { w: Math.round(rect.width), h: Math.round(rect.height), visibility: style.visibility, opacity: style.opacity, buttons: el.querySelectorAll('button').length }
    }),
    pointer: {
      hoverNone: matchMedia('(hover:none)').matches,
      hoverHover: matchMedia('(hover:hover)').matches,
      pointerCoarse: matchMedia('(pointer:coarse)').matches,
    },
    composer: composerBox ? { bottom: Math.round(vh - composerBox.bottom), height: Math.round(composerBox.height) } : undefined,
  }
}

const livePass = async (login) => {
  const browser = await chromium.launch({ env: browserEnv })
  const reports = []
  try {
    for (const viewport of viewports) {
      const tag = `${viewport.width}x${viewport.height}`
      const page = await browser.newPage({ viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
      const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue' })
      // The shell shows a preview notice once per profile. Its button goes disabled while
      // the notice animates out, so a click that waits for the dialog to hide times out:
      // dismiss it without waiting and carry on.
      const dismiss = async () => {
        if (!(await notice.isVisible().catch(() => false))) return
        await notice.click({ timeout: 3000, force: true }).catch(() => {})
        await page.waitForTimeout(500)
      }
      await page.addLocatorHandler(notice, dismiss, { noWaitAfter: true })
      const shot = async name => {
        await dismiss()
        const path = join(outDir, `${tag}-${name}.png`)
        await page.screenshot({ path })
        console.log(`  shot ${path}`)
        return path
      }
      await page.goto(login)
      await page.locator('.bt-tile, .bt-row').first().waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1500)
      console.log(`\n== ${tag} ==`)
      // 1. The list, before anything is opened.
      await shot('nav-1-list')
      let result = await page.evaluate(collect)
      check(result.scrollWidth <= viewport.width + 1, `${tag} the page does not scroll sideways (scrollWidth ${result.scrollWidth} <= ${viewport.width})`)
      check(result.overflowing.length === 0, `${tag} nothing is wider than the viewport`, true)
      // Every screen is recorded and printed the same way, so a finding names the screen.
      const record = screen => {
        reports.push({ tag, screen, ...result })
        for (const row of result.overflowing.slice(0, 8)) console.log(`     overflow ${row.el} ${row.left}..${row.right} ${row.label}`)
        for (const row of result.outside.slice(0, 8)) console.log(`     outside  ${row.el} ${row.left}..${row.right} ${row.label}`)
        for (const row of result.scrollReachable.slice(0, 4)) console.log(`     scroll   ${row.el} ${row.left}..${row.right} in ${row.scroller} ${row.label}`)
        for (const row of result.smallTargets.slice(0, 8)) console.log(`     small    ${row.el} ${row.w}x${row.h} ${row.label}`)
        for (const row of result.hoverOnly.slice(0, 8)) console.log(`     hover    ${row.el} ${row.w}x${row.h} ${row.visibility}/${row.opacity} ${row.label}`)
        for (const row of result.clipped.slice(0, 8)) console.log(`     clipped  ${row.el} ${row.scroll}>${row.w} ${row.text}`)
        console.log(`  ${screen}: scrollWidth ${result.scrollWidth}, fixed boxes ${result.fixed.map(box => `${box.el} w${box.width} top${box.top} bottom${box.bottom} pad-bottom ${box.paddingBottom}`).join(' | ') || 'none'}`)
        if (result.composer) console.log(`  ${screen}: composer height ${result.composer.height}, bottom gap ${result.composer.bottom}`)
        if (result.toolbars?.length) {
          const state = result.toolbars.map(box => `${box.buttons} button(s) ${box.w}x${box.h} ${box.visibility}/${box.opacity}`).join(' | ')
          console.log(`  ${screen}: message toolbar ${state}; pointer hover:none=${result.pointer.hoverNone} coarse=${result.pointer.pointerCoarse}`)
        }
      }
      // The navigation shape at each step, so a change from sidebar to list page (or back)
      // shows up in the report without a screenshot.
      const shape = screen => {
        const { hooks, listRoot, chatRoot, mobile, sidebar, list, composer } = result.nav
        const marks = hooks ? `, hooks list=${listRoot} chat=${chatRoot} mobile=${mobile}` : ', no nav hooks yet'
        console.log(`  ${screen}: sidebar ${sidebar ? `${sidebar.width}px${sidebar.rail ? ' (rail)' : ''}` : 'none'}, list rows ${list}, composer ${composer}${marks}`)
      }
      // Kept for the pointer comparison below.
      let navList = null
      let navChat = null
      let touchPointer = null
      // A Main Bot with no model yet shows the model dock in the chat; it wraps its chips
      // in a fixed max width, so measure it before picking one and moving on.
      const chip = page.locator('.bt-model-choice-chips button').first()
      if (await chip.isVisible({ timeout: 5000 }).catch(() => false)) {
        await shot('model-dock')
        result = await page.evaluate(collect)
        check(result.scrollWidth <= viewport.width + 1, `${tag} the model dock does not scroll sideways (scrollWidth ${result.scrollWidth})`)
        reports.push({ tag, screen: 'model-dock', ...result })
        await chip.click()
        await page.waitForTimeout(2500)
      }
      check(result.smallTargets.length === 0, `${tag} every tap target is at least 24x24`, true)
      check(result.clipped.length === 0, `${tag} no text is clipped inside a fixed-width box`, true)
      check(result.hoverOnly.length === 0, `${tag} no control is hidden until hover`, true)
      record('nav-list')
      shape('nav-list')
      navList = result.nav
      touchPointer = result.pointer

      // 2. Into a conversation. The list is either a sidebar beside the chat or a page of
      // its own, so the shape is measured rather than assumed.
      const row = page.locator('.bt-tile, .bt-row').first()
      await row.click()
      await page.waitForTimeout(1200)
      // One message in the chat, so a message toolbar exists to measure: the mock model
      // answers it. Without a message there is nothing for the hover rule to hide.
      const box = page.locator('[contenteditable="true"]').last()
      if (await box.isVisible().catch(() => false)) {
        await box.click()
        await page.keyboard.type('mobile check')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(4000)
      }
      await shot('nav-2-chat')
      result = await page.evaluate(collect)
      check(result.scrollWidth <= viewport.width + 1, `${tag} chat does not scroll sideways (scrollWidth ${result.scrollWidth})`)
      check(result.hoverOnly.length === 0, `${tag} the chat leaves no control hidden until hover`, true)
      // On a touch pointer the message toolbar has to be visible outright: there is no
      // hover, and a visibility:hidden child cannot take focus either.
      if (result.toolbars.length) {
        check(result.toolbars.every(toolbar => toolbar.visibility === 'visible'),
          `${tag} the message toolbar is reachable with hover:none (${result.toolbars.length} toolbar(s))`)
      }
      record('nav-chat')
      shape('nav-chat')
      navChat = result.nav
      // A desktop window keeps the list and the chat side by side: a two-level navigation
      // for narrow screens must not take the sidebar away from it.
      if (viewport.width >= 1024) {
        check(Boolean(result.nav.sidebar) && !result.nav.sidebar.rail && result.nav.composer,
          `${tag} the desktop keeps the Bot list beside the chat (sidebar ${result.nav.sidebar ? `${result.nav.sidebar.width}px${result.nav.sidebar.rail ? ' rail' : ''}` : 'missing'}, composer ${result.nav.composer})`)
      }

      // 3. Back to the list, when this navigation has a back control. Without one the flow
      // stops here: the shape of nav-2 says why.
      const back = await page.evaluate(() => {
        // The navigation hook first (the design note pins it), the accessible name after.
        const candidates = [...document.querySelectorAll('[data-bt-nav="back"], [data-bt-back], button, [role="button"]')]
        const found = candidates.find(el => {
          const hook = el.matches('[data-bt-nav="back"], [data-bt-back]')
          const label = (el.getAttribute('aria-label') || el.textContent || '').trim()
          return (hook || (/^back\b/i.test(label) && !/details|bottom/i.test(label))) && el.checkVisibility?.() !== false
        })
        if (!found) return null
        found.dataset.btVerifyBack = '1'
        return `${found.matches('[data-bt-nav="back"], [data-bt-back]') ? 'hook' : 'label'}: ${(found.getAttribute('aria-label') || found.textContent || '').trim().slice(0, 30)}`
      })
      if (back) {
        await page.locator('[data-bt-verify-back="1"]').click()
        await page.waitForTimeout(1000)
        await shot('nav-3-back')
        result = await page.evaluate(collect)
        check(result.nav.list > 0, `${tag} going back shows the Bot list again (${result.nav.list} row(s))`)
        record('nav-back')
        shape('nav-back')
      } else {
        console.log(`  ${tag}: no back control in the conversation (two-level navigation is not in yet)`)
      }

      const details = page.getByRole('button', { name: 'View conversation details' }).first()
      if (await details.isVisible().catch(() => false)) {
        await details.click()
        await page.waitForTimeout(900)
        await shot('details')
        result = await page.evaluate(collect)
        check(result.scrollWidth <= viewport.width + 1, `${tag} the details drawer does not scroll sideways (scrollWidth ${result.scrollWidth})`)
        check(result.hoverOnly.length === 0, `${tag} the details drawer leaves no control hidden until hover`, true)
        record('details')

        // The memory dialog is the one overlay with its own phone rule (styles.js:783).
        const memoryRow = page.locator('.bt-panel .bt-mem-row').first()
        if (await memoryRow.isVisible().catch(() => false)) {
          await memoryRow.click()
          const memory = page.locator('.bt-mem')
          if (await memory.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
            await page.waitForTimeout(1200)
            await shot('memory')
            result = await page.evaluate(collect)
            const box = await memory.boundingBox()
            check(Boolean(box) && box.width <= viewport.width + 1 && box.height <= viewport.height + 1,
              `${tag} the memory dialog fits the viewport (${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '?'} <= ${viewport.width}x${viewport.height})`)
            check(result.hoverOnly.length === 0, `${tag} the memory dialog leaves no control hidden until hover`, true)
            record('memory')
            await memory.getByRole('button', { name: 'Close memory' }).click({ timeout: 5000 }).catch(() => {})
            await page.waitForTimeout(400)
          }
        }
        const close = page.getByRole('button', { name: 'Close details' }).first()
        if (await close.isVisible().catch(() => false)) await close.click()
        await page.waitForTimeout(400)
      }

      // The settings overlay is the largest fixed dialog the plugin draws.
      await page.locator('.bt-row').first().click({ button: 'right' })
      const edit = page.getByRole('menuitem', { name: 'Edit Bot' })
      if (await edit.isVisible({ timeout: 5000 }).catch(() => false)) {
        await edit.click()
        await page.locator('.bt-settings').waitFor({ timeout: 15_000 })
        await page.waitForTimeout(800)
        await shot('bot-settings')
        result = await page.evaluate(collect)
        const dialog = await page.locator('.bt-settings').boundingBox({ timeout: 8000 }).catch(() => null)
        check(Boolean(dialog) && dialog.width <= viewport.width + 1, `${tag} Bot settings fit the viewport (${dialog ? Math.round(dialog.width) : '?'} <= ${viewport.width})`)
        check(result.hoverOnly.length === 0, `${tag} Bot settings leave no control hidden until hover`, true)
        record('bot-settings')
        // The settings overlay's own pages: each one lays out differently.
        for (const [title, screen] of [['Bots', 'settings-bots'], ['Group chats', 'settings-groups'], ['Usage', 'settings-usage']]) {
          const item = page.locator('.bt-settings-nav .bt-settings-item', { hasText: new RegExp(`^${title}$`) }).first()
          if (!(await item.isVisible().catch(() => false))) continue
          await item.click()
          await page.waitForTimeout(1200)
          await shot(screen)
          result = await page.evaluate(collect)
          check(result.scrollWidth <= viewport.width + 1, `${tag} the ${title} settings page does not scroll sideways (scrollWidth ${result.scrollWidth})`)
          check(result.outside.length === 0, `${tag} the ${title} settings page keeps its content inside the dialog`, true)
          record(screen)
        }
      } else {
        console.log(`  (no Edit Bot menu at ${tag}; skipped Bot settings)`)
      }
      await page.close()

      // The same viewport with a mouse instead of a finger: the mobile navigation is meant
      // to follow the pointer type, not the width alone, so the two must disagree.
      if (pointer === 'both') {
        const fine = await browser.newPage({ viewport, deviceScaleFactor: 2 })
        await fine.goto(login)
        await fine.locator('.bt-tile, .bt-row').first().waitFor({ timeout: 60_000 })
        await fine.waitForTimeout(1500)
        const fineListAll = await fine.evaluate(collect)
        const fineList = fineListAll.nav
        await fine.screenshot({ path: join(outDir, `${tag}-pointer-fine-list.png`) })
        await fine.locator('.bt-tile, .bt-row').first().click()
        await fine.waitForTimeout(1200)
        const fineChat = (await fine.evaluate(collect)).nav
        await fine.screenshot({ path: join(outDir, `${tag}-pointer-fine-chat.png`) })
        await fine.close()
        console.log(`  ${tag}: fine pointer list ${fineList.mobile ? 'list page' : 'sidebar'}, chat ${fineChat.mobile ? 'list page' : 'sidebar'}`)
        if (navList?.hooks || fineList.hooks) {
          check(navList.mobile !== fineList.mobile,
            `${tag} the mobile navigation follows the pointer type (touch ${navList.mobile ? 'list page' : 'sidebar'} vs mouse ${fineList.mobile ? 'list page' : 'sidebar'})`)
        } else {
          console.log(`  ${tag}: no navigation hooks yet; touch and mouse shapes recorded as the baseline`)
        }
        reports.push({
          tag,
          screen: 'pointer-compare',
          touch: { list: navList, chat: navChat, pointer: touchPointer },
          mouse: { list: fineList, chat: fineChat, pointer: fineListAll.pointer },
        })
      }
    }
  } finally {
    await browser.close()
  }
  return reports
}

// ---------------------------------------------------------------------------------- main
mkdirSync(outDir, { recursive: true })
console.log(`ds-bot mobile style verification\nplugin ${PLUGIN}\nout ${outDir}`)
if (has('stop')) {
  stopBench()
  process.exit(0)
}

const staticReport = staticPass()
let live = []
let liveError
if (has('static')) {
  console.log('\n--static: skipping the live pass')
} else {
  const login = (await benchLogin()) ?? (await startBench())
  if (login) {
    try {
      live = await livePass(login)
    } catch (error) {
      liveError = error.message
      console.log(`live pass failed: ${error.message}`)
    }
  } else {
    liveError = 'no bench'
  }
}

writeFileSync(join(outDir, 'report.json'), `${JSON.stringify({ viewports, static: staticReport, live, failures, warnings, liveError }, null, 2)}\n`)
const lines = [
  '# Mobile style verification',
  '',
  `Viewports: ${viewports.map(viewport => `${viewport.width}x${viewport.height}`).join(', ')}`,
  '',
  `FAIL ${failures.length}, WARN ${warnings.length}${liveError ? `, live pass: ${liveError}` : ''}`,
  '',
]
for (const row of live) {
  if (row.screen === 'pointer-compare') {
    const side = nav => (nav.listRoot ? 'list page' : nav.sidebar ? `sidebar ${nav.sidebar.width}px${nav.sidebar.rail ? ' (rail)' : ''}` : 'none')
    lines.push(`## ${row.tag} — pointer-compare`, '', `- touch (hover:none ${row.touch.pointer?.hoverNone}, coarse ${row.touch.pointer?.pointerCoarse}): ${side(row.touch.list)}`, `- mouse (hover:none ${row.mouse.pointer?.hoverNone}, coarse ${row.mouse.pointer?.pointerCoarse}): ${side(row.mouse.list)}`, '')
    continue
  }
  lines.push(`## ${row.tag} — ${row.screen}`, '', `- page scrollWidth ${row.scrollWidth} (viewport ${row.vw})`, `- elements past the viewport edge: ${row.overflowing.length + row.outside.length}`, `- tap targets under 24x24: ${row.smallTargets.length}`, `- clipped text: ${row.clipped.length}`, '')
}
if (failures.length) lines.push('## FAIL', '', ...failures.map(line => `- ${line}`), '')
if (warnings.length) lines.push('## WARN', '', ...warnings.map(line => `- ${line}`), '')
writeFileSync(join(outDir, 'report.md'), `${lines.join('\n')}\n`)
console.log(`\nFAIL ${failures.length}  WARN ${warnings.length}  report ${join(outDir, 'report.md')}`)
process.exitCode = failures.length && !noFail ? 1 : 0
