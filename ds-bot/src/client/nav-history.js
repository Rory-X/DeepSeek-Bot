// -------------------------------------------------------------------------
// The phone's two levels are states, not pages, so the browser has no entry of its own to go
// back to: without one, the system's back gesture leaves the app instead of returning to the
// list. Each arrival at a conversation adds one entry, marked as ours, and the list entry is
// marked in place, so a pop can tell which entry it landed on. Entries that are not ours — a
// document preview's own page history, another site — are left alone.

// The key our entries carry. Anything without it belongs to somebody else.
export const NAV_LEVEL_KEY = 'btNav'

/**
 * Put the phone's levels on the browser's history, so the system's back gesture returns to
 * the list instead of leaving the app.
 * @param options - `mobileNav` gates the rule to a phone, `navLevel` is the current level,
 *   `onLeave` runs the return when a pop lands on the list, `onEnter` runs the arrival when
 *   a pop lands on a conversation (the browser's own forward).
 * @returns the installer's handle: `entered` for one entry per arrival, `returned` to keep
 *   the stack in step with a return, and `dispose` for teardown.
 */
export function installNavHistory({ mobileNav, navLevel, onLeave, onEnter }) {
  const landedLevel = () => {
    try { return window.history.state?.[NAV_LEVEL_KEY] } catch { return undefined }
  }
  const write = (level, replace) => {
    try {
      const state = { ...window.history.state, [NAV_LEVEL_KEY]: level }
      if (replace) window.history.replaceState(state, '')
      else window.history.pushState(state, '')
    } catch {
      // A frame that refuses history keeps working; only the system's back gesture is lost.
    }
  }
  const onPop = (event) => {
    const landed = event.state?.[NAV_LEVEL_KEY]
    // The entry names where the reader is now. Only a move away from a conversation that is
    // still open is ours to animate; a landing on a conversation the shell still holds only
    // needs the level back.
    if (landed === 'list' && navLevel.getSnapshot() === 'chat') onLeave()
    else if (landed === 'chat' && navLevel.getSnapshot() !== 'chat') onEnter()
  }
  window.addEventListener('popstate', onPop)
  // The entry the app started on is the list: it is marked in place, so a return can land on
  // it and a back gesture past it leaves the app, as it should.
  const mark = () => { if (mobileNav.getSnapshot() && navLevel.getSnapshot() === 'list') write('list', true) }
  mark()
  const off = mobileNav.subscribe(mark)
  return {
    /** One entry per arrival at a conversation, from the list. */
    entered: () => { if (mobileNav.getSnapshot()) write('chat', false) },
    /**
     * Keep the stack in step with a return that is already under way: the pop lands on the
     * list entry, where the level has already arrived, so nothing returns twice.
     */
    returned: () => {
      if (!mobileNav.getSnapshot()) return
      if (landedLevel() === 'chat') {
        try { window.history.back() } catch { /* the entry stays; only the stack is stale */ }
      }
    },
    dispose: () => { off(); window.removeEventListener('popstate', onPop) },
  }
}
