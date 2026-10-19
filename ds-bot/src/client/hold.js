// A phone has no right button: holding a list row opens the same menu the right click opens
// on a desktop. The hold is a pointer gesture, so the browser's own scroll still wins when
// the finger moves, and the click that follows a hold is swallowed instead of opening the chat.
import { useEffect, useRef } from 'react'

export const HOLD_MS = 500
const SLOP = 10

// `open(point)` places the menu at the touch. The returned props go on the row element.
export function useRowMenu(open) {
  const state = useRef(null)
  const timer = useRef(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const cancel = () => {
    clearTimeout(timer.current)
    timer.current = undefined
    state.current = null
  }
  const swallow = (event) => {
    if (state.current?.fired !== true) return false
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  return {
    onPointerDown: (event) => {
      // A mouse keeps its right click, and a secondary button never starts a hold.
      if (event.pointerType === 'mouse' || event.button !== 0) return
      cancel()
      const point = { x: event.clientX, y: event.clientY }
      state.current = { point, fired: false }
      timer.current = setTimeout(() => {
        timer.current = undefined
        if (state.current === null) return
        state.current = { point, fired: true }
        navigator.vibrate?.(8)
        open(point)
      }, HOLD_MS)
    },
    onPointerMove: (event) => {
      const current = state.current
      if (current === null || current.fired) return
      if (Math.abs(event.clientX - current.point.x) > SLOP || Math.abs(event.clientY - current.point.y) > SLOP) cancel()
    },
    onPointerUp: () => {
      // A fired hold keeps its flag so the click it comes with is swallowed below; the flag
      // goes on its own if no click follows, so a later right click is not taken for one.
      if (state.current?.fired !== true) { cancel(); return }
      setTimeout(() => { if (state.current?.fired === true) state.current = null }, 350)
    },
    onPointerCancel: cancel,
    onPointerLeave: () => {
      if (state.current?.fired !== true) cancel()
    },
    onContextMenu: (event) => {
      // Android Chrome reports the same hold as a context menu as well; the menu is open.
      const duplicate = state.current?.fired === true || event.sourceCapabilities?.firesTouchEvents === true
      event.preventDefault()
      event.stopPropagation()
      if (duplicate) { state.current = null; return }
      open({ x: event.clientX, y: event.clientY })
    },
    onClickCapture: (event) => {
      if (!swallow(event)) return
      state.current = null
    },
  }
}
