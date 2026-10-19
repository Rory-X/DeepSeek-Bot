// -------------------------------------------------------------------------
// The runtime facts a phone's browser and an installed app differ in.

// An app installed to the home screen runs without browser chrome. Safari reports it
// through the display-mode media query; its older `navigator.standalone` says the same.
export const STANDALONE = '(display-mode: standalone)'

// Reads the test now and on every change: a page can enter or leave standalone while it
// is open, when the app is installed from it.
export function watchStandalone(onChange) {
  const query = window.matchMedia(STANDALONE)
  const read = () => query.matches || window.navigator.standalone === true
  const update = () => onChange(read())
  query.addEventListener('change', update)
  return { read, dispose: () => query.removeEventListener('change', update) }
}

// The one fact CSS cannot ask for: `viewport-fit=cover` is what makes the safe areas real
// to env(). The shell's own meta is widened rather than replaced, so its scale and
// user-scalable choices stay the shell's; Safari only honours a viewport change made
// before load in some versions, so nothing here is load-bearing and the styles have to
// work without it. The theme colour follows the theme, and the browser's dark marker.
export function installViewport() {
  const meta = document.querySelector('meta[name="viewport"]')
  if (meta !== null) {
    const content = meta.getAttribute('content') ?? ''
    if (!/viewport-fit/.test(content)) meta.setAttribute('content', content === '' ? 'viewport-fit=cover' : `${content},viewport-fit=cover`)
  }
  let theme = document.querySelector('meta[name="theme-color"]')
  if (theme === null) {
    theme = document.createElement('meta')
    theme.setAttribute('name', 'theme-color')
    document.head.appendChild(theme)
  }
  let colors = { light: '', dark: '' }
  const apply = () => {
    const content = document.body?.hasAttribute('data-ds-dark-theme') ? colors.dark : colors.light
    if (content !== '') theme.setAttribute('content', content)
  }
  const observer = new MutationObserver(apply)
  if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  apply()
  return {
    theme: next => { colors = next; apply() },
    dispose: () => observer.disconnect(),
  }
}
