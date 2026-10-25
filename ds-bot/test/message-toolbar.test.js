import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { placeToolbar, TOOLBAR_GAP, VIEW_INSET } from '../src/client/message-toolbar.js'

// The browser bundle holds every style sheet ds-bot installs; the toolbar's show and
// hide rules live there, so the bundle is the contract under test.
const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height })
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const inside = (spot, toolbar, viewport) => spot.left >= VIEW_INSET
  && spot.top >= VIEW_INSET
  && spot.left + toolbar.width <= viewport.width - VIEW_INSET
  && spot.top + toolbar.height <= viewport.height - VIEW_INSET

const strip = (width = 76, height = 24) => ({ width, height })

test('a bubble with room keeps the strip beside it, on the viewport side away from the screen edge', () => {
  const viewport = { width: 1280, height: 800 }
  const bubble = box(12, 100, 400, 100)
  const toolbar = strip()
  const spot = placeToolbar({ bubble, toolbar, viewport })
  assert.equal(spot.side, 'right')
  assert.ok(spot.left >= bubble.right + TOOLBAR_GAP, 'the strip starts after the bubble')
  assert.ok(!overlaps({ ...spot, right: spot.left + toolbar.width, bottom: spot.top + toolbar.height }, bubble))
  assert.ok(inside(spot, toolbar, viewport))
})

test('a received bubble near the phone edge keeps its strip outside the words', () => {
  const viewport = { width: 390, height: 800 }
  const bubble = box(12, 100, 296, 200)
  const toolbar = strip(140, 44)
  const spot = placeToolbar({ bubble, toolbar, viewport })
  const placed = { ...spot, right: spot.left + toolbar.width, bottom: spot.top + toolbar.height }
  assert.ok(!overlaps(placed, bubble), 'the strip never covers the bubble')
  assert.ok(inside(spot, toolbar, viewport), 'the strip stays inside a 390px viewport')
  assert.ok(spot.side === 'below' || spot.side === 'above')
})

test('an own message puts the strip on its left, where the right-aligned bubble leaves room', () => {
  const viewport = { width: 390, height: 800 }
  const bubble = box(300, 100, 82, 80)
  const toolbar = strip(44, 44)
  const spot = placeToolbar({ bubble, toolbar, viewport, preferred: 'left' })
  assert.equal(spot.side, 'left')
  assert.ok(spot.left + toolbar.width <= bubble.left - TOOLBAR_GAP)
  assert.ok(!overlaps({ ...spot, right: spot.left + toolbar.width, bottom: spot.top + toolbar.height }, bubble))
})

test('a message taller than the viewport pins the strip to the edge, still on screen', () => {
  const viewport = { width: 390, height: 800 }
  const bubble = box(12, 0, 296, 900)
  const toolbar = strip(140, 44)
  const spot = placeToolbar({ bubble, toolbar, viewport })
  assert.ok(inside(spot, toolbar, viewport))
})

test('the toolbar shows on hover or focus, and on a touch screen only after a tap', () => {
  // Hover and keyboard focus reveal the strip on a pointer device.
  assert.ok(bundle.includes('.bt-msg:hover>.bt-msg-line>.bt-tools'))
  assert.ok(bundle.includes('.bt-msg:focus-within>.bt-msg-line>.bt-tools'))
  assert.ok(bundle.includes('.bt-umsg:hover .bt-utools'))
  assert.ok(bundle.includes('.bt-umsg:focus-within .bt-utools'))
  // A tap sets data-open; that is the only way it shows without a pointer.
  assert.ok(bundle.includes(".bt-tools[data-open]"))
  assert.ok(bundle.includes('.bt-utools[data-open]'))
  // The old touch rule parked the strip inside the bubble, over its text.
  assert.ok(!bundle.includes('.bt-tools{left:auto;right:4px'), 'no inside-the-bubble placement')
  // And a touch device no longer shows the strip everywhere all the time.
  assert.ok(!bundle.includes('@media (hover:none){.bt-tools{opacity:1;visibility:visible}'))
  assert.ok(!bundle.includes('@media (hover:none){.bt-utools{opacity:1;visibility:visible}'))
})
