export function splitBotFolders(order, folders = []) {
  const assigned = new Set(folders.flatMap(folder => folder.botIds))
  const unpinned = order.filter(entry => !entry.item.pinned)
  return {
    pinned: order.filter(entry => entry.item.pinned),
    loose: unpinned.filter(entry => entry.kind !== 'bot' || !assigned.has(entry.item.id)),
    folders: [...folders].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))).map(folder => ({
      ...folder,
      entries: unpinned.filter(entry => entry.kind === 'bot' && folder.botIds.includes(entry.item.id)),
    })),
  }
}
