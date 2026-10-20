// Keep references verbatim; only recognizable paths and links become preview actions.
export function artifactTargets(reference) {
  if (typeof reference !== 'string') return []
  const found = [], seen = new Set()
  const add = (value, label, explicit = false) => {
    value = value.trim().replace(/^<|>$/g, '')
    if (!value || /[\u0000-\u001f\u007f]/.test(value) || seen.has(value)) return
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value)
        if (url.username || url.password) return
        seen.add(value); found.push({ kind: 'url', value, label: label || url.hostname + url.pathname })
      } catch { /* Malformed URLs remain readable in the original reference. */ }
      return
    }
    const absolute = /^(\/|[a-z]:[\\/]|\\\\)/i.test(value)
    if (!explicit && /\s/.test(value) && !absolute) return
    const match = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(value)
    const path = match ? value.slice(0, match.index) : value
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return
    if (!absolute && !/[\\/]/.test(path) && !/^[\w. -]+\.[a-z\d]{1,12}$/i.test(path) && !/^(README|LICENSE|NOTICE|Makefile|Dockerfile)$/i.test(path)) return
    if (/[<>|*?]/.test(path) || /^(git |bash |sh |python|node |npm |pnpm |curl )/.test(path)) return
    const line = Number(match?.[1] ?? match?.[2])
    seen.add(value); found.push({ kind: 'file', value: path, label: label || path.split(/[\\/]/).at(-1), ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) })
  }
  for (const raw of reference.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[-*]\s+/, '').trim()
    const markdown = [...line.matchAll(/\[([^\]]+)\]\((<[^>]+>|[^\s)]+)\s*\)/g)]
    const quoted = [...line.matchAll(/`([^`]+)`/g)]
    if (markdown.length || quoted.length) {
      for (const match of markdown) add(match[2], match[1], true)
      for (const match of quoted) add(match[1], undefined, true)
    } else add(line)
  }
  return found.slice(0, 20)
}

// Public dsh-util-workspace-path grammar: encode segments while retaining literal colons.
export function artifactFileAddress(sessionId, path) {
  const encode = value => encodeURIComponent(value).replace(/%3A/gi, ':')
  return 'dsh-resource://file/session/' + encode(sessionId) + '/' + path.replace(/\\/g, '/').split('/').map(encode).join('/')
}
