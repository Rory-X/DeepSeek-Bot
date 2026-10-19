// -------------------------------------------------------------------------
// The device questions the styles and the React state must answer the same way.

// A touch device: no pointer that can hover, and a coarse one.
export const TOUCH = '(hover:none) and (pointer:coarse)'
// Narrow enough that the sidebar and the conversation cannot both have room.
export const NARROW = '(max-width:640px)'
// The Bot surface gives a phone a two-level navigation: a list page, then the
// conversation. The desktop app is excluded by an attribute the shell sets from its
// Electron preload; a media query cannot test an attribute, so the styles put that test
// in their selectors (`NOT_DESKTOP`). Both sides read the one string above.
export const MOBILE_NAV = `${TOUCH} and ${NARROW}`
export const NOT_DESKTOP = 'html:not([data-platform])'

// Reads the test now and on every change: a rotation, a resize, or a trackpad attached to
// a tablet, where the pointer goes from coarse to fine.
export function watchMobileNav(onChange) {
  const query = window.matchMedia(MOBILE_NAV)
  const read = () => query.matches && document.documentElement.dataset.platform === undefined
  const update = () => onChange(read())
  query.addEventListener('change', update)
  return { read, dispose: () => query.removeEventListener('change', update) }
}
