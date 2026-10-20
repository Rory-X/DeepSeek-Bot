// A connector module may name tools it never offers (`blockedTools`). Two places use this:
// the mount keeps them out of every tool list, and a pre-execute gate denies a call that
// carries one of the names anyway. Matching lives here, away from the plugin wiring, so the
// rule is one function and its edge cases have their own test.
//
// A name matches either as written (`delete_repository`, what a module declares) or with
// the connector id prefix (`github_delete_repository`, how a mounted tool is called). A
// RegExp entry matches the call name as written; it is for defensive families whose exact
// names a service may add later.
export function blockedToolMatches(list, id, name) {
  if (!Array.isArray(list) || typeof name !== 'string' || name === '') return false
  // A mounted call carries the connector id; the module's patterns are written against the
  // service's own names, so they see the bare name too.
  const bare = typeof id === 'string' && id !== '' && name.startsWith(`${id}_`) ? name.slice(id.length + 1) : name
  for (const item of list) {
    if (item instanceof RegExp) {
      if (item.test(name) || item.test(bare)) return true
      continue
    }
    if (typeof item !== 'string' || item === '') continue
    if (name === item || name === `${id}_${item}`) return true
  }
  return false
}
