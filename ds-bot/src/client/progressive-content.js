import { createElement as h, useEffect, useRef, useState } from 'react'

// One shared observer and a small rendering queue avoid mounting every Markdown
// parser and attachment viewer in the loaded history during the first paint.
const waiting = new Map()
let observer
const jobs = new Set()
let scheduled = false
const schedule = () => {
  if (scheduled || jobs.size === 0) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    for (const job of [...jobs].slice(0, 2)) { jobs.delete(job); job() }
    schedule()
  })
}

export function observeContent(node, reveal) {
  const job = () => { waiting.delete(node); reveal() }
  observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const ready = waiting.get(entry.target)
      if (ready) { observer.unobserve(entry.target); jobs.add(ready) }
    }
    schedule()
  }, { rootMargin: '240px' })
  waiting.set(node, job)
  observer.observe(node)
  const watching = observer
  return () => {
    watching.unobserve(node)
    waiting.delete(node)
    jobs.delete(job)
    if (waiting.size === 0 && observer === watching) { observer.disconnect(); observer = undefined }
  }
}

export function deferContent(children, options) {
  if (typeof IntersectionObserver !== 'function' || typeof requestAnimationFrame !== 'function') return children
  return h(ProgressiveContent, options, children)
}

export function ProgressiveContent({ children, text = '', live = false }) {
  const supported = typeof IntersectionObserver === 'function' && typeof requestAnimationFrame === 'function'
  const [ready, setReady] = useState(!supported || live)
  const element = useRef(null)
  useEffect(() => {
    if (ready || live || !element.current) return undefined
    return observeContent(element.current, () => setReady(true))
  }, [ready, live])
  if (ready || live) return children
  return h('div', {
    ref: element,
    className: 'bt-progressive-content',
    style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minHeight: text ? undefined : '80px' },
    onFocus: () => setReady(true),
    onPointerDown: () => setReady(true),
  }, text)
}
