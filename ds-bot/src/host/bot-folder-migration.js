import { isFolderColor } from '../shared/bot-folders.js'

const sameName = (a, b) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase()

// Retire the upstream sidebar taxonomy once. Existing fork membership wins;
// legacy metadata stays archived so removing an entry point loses no history.
export function migrateSidebarSections(state) {
  const sections = Array.isArray(state.sections) ? state.sections.filter(section => section && typeof section.id === 'string') : []
  const entries = ['bots', 'rooms', 'agents'].flatMap(kind => Object.values(state[kind] ?? {}))
  if (!sections.length && !entries.some(entry => entry.sectionId !== undefined)) return false
  state.botFolders ??= {}
  const folders = Object.values(state.botFolders).filter(folder => folder && typeof folder.id === 'string' && typeof folder.name === 'string')
  const owners = new Map()
  for (const folder of folders) {
    for (const id of Array.isArray(folder.botIds) ? folder.botIds : []) {
      if (Object.hasOwn(state.bots, id) && !owners.has(id)) owners.set(id, folder)
    }
  }
  const bump = folder => { folder.version = (Number.isSafeInteger(folder.version) ? folder.version : 0) + 1 }
  const archive = Array.isArray(state.legacySidebarSections) ? state.legacySidebarSections : []
  for (const section of sections) {
    const grouped = kind => Object.values(state[kind] ?? {}).filter(entry => entry.sectionId === section.id).map(entry => entry.id)
    const botIds = grouped('bots').filter(id => id !== state.mainBotIds[0])
    if (!archive.some(saved => saved.id === section.id)) archive.push({ ...section, botIds, roomIds: grouped('rooms'), agentIds: grouped('agents') })
    const unassigned = botIds.filter(id => !owners.has(id))
    const name = typeof section.name === 'string' && section.name.trim() ? section.name.trim().slice(0, 48) : 'Imported Bots'
    if (unassigned.length) {
      let folder = folders.find(item => sameName(item.name, name))
      if (!folder) {
        const stem = `legacy-${section.id}`
        let id = stem, suffix = 2
        while (Object.hasOwn(state.botFolders, id)) id = `${stem}-${suffix++}`
        folder = { id, name, botIds: [], version: 0, ...(section.collapsed === true ? { collapsed: true } : {}) }
        state.botFolders[id] = folder
        folders.push(folder)
      }
      folder.botIds = [...new Set([...(Array.isArray(folder.botIds) ? folder.botIds : []), ...unassigned])]
      bump(folder)
      for (const id of unassigned) owners.set(id, folder)
    }
    if (isFolderColor(section.color)) {
      for (const folder of new Set(botIds.map(id => owners.get(id)).filter(Boolean))) {
        if (!isFolderColor(folder.color)) {
          folder.color = section.color
          bump(folder)
        }
      }
    }
  }
  state.legacySidebarSections = archive
  state.sections = []
  for (const entry of entries) delete entry.sectionId
  return true
}
