// Sidebar folders are independent of group chats and of the Bots' work.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { own } from './store.js'

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const keyOf = name => name.normalize('NFKC').toLowerCase()
function cleanName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 48 || /[\p{Cc}\p{Cf}]/u.test(name)) throw invalid('Use a folder name of 1–48 characters without control characters.')
  return name.trim()
}

export function folderView(state) {
  const used = new Set()
  return Object.values(state.botFolders ?? {}).filter(folder => folder && typeof folder.id === 'string' && typeof folder.name === 'string').map(folder => ({
    ...folder,
    botIds: (Array.isArray(folder.botIds) ? folder.botIds : []).filter(id => {
      if (!own(state.bots, id) || id === state.mainBotIds[0] || used.has(id)) return false
      used.add(id)
      return true
    }),
  }))
}

export function install(rt) {
  let writing = Promise.resolve()
  const mutate = (kind, body, actor) => {
    const operation = writing.then(async () => {
      await rt.refresh()
      const reason = rt.readOnly()
      if (reason !== undefined) throw Object.assign(new Error(reason), { code: 'bot/read-only' })
      if (actor !== undefined && !rt.isMain(rt.selfOf(actor))) throw invalid('Only a Main Bot can organize Bot folders. Ask a Main Bot instead.')
      const before = rt.state.botFolders
      const folders = Object.fromEntries(folderView(rt.state).map(folder => [folder.id, { ...folder, botIds: [...folder.botIds] }]))
      let folder = body.id ? own(folders, body.id) : undefined
      if (body.id && !folder) throw invalid('This Bot folder no longer exists.')
      if (body.version !== undefined && folder?.version !== body.version) throw invalid('This folder changed. Reopen it to review the latest members.')
      const members = value => {
        if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !own(rt.state.bots, id))) throw invalid('Choose existing Bots for the folder.')
        if (value.includes(rt.state.mainBotIds[0])) throw invalid('The primary Main Bot stays at the top of the list.')
        return [...new Set(value)]
      }
      const nameAvailable = (name, id) => {
        if (Object.values(folders).some(item => item.id !== id && keyOf(item.name) === keyOf(name))) throw invalid('A Bot folder with this name already exists.')
      }
      if (kind === 'save' || kind === 'assign') {
        const ids = members(body.botIds)
        if (kind === 'assign' && body.name === '') {
          folder = undefined
        } else {
          const name = cleanName(body.name)
          if (kind === 'assign') folder = Object.values(folders).find(item => keyOf(item.name) === keyOf(name))
          nameAvailable(name, folder?.id)
          if (!folder) {
            folder = { id: randomUUID(), name, botIds: [], version: 0 }
            folders[folder.id] = folder
          }
          folder.name = name
          folder.botIds = kind === 'save' ? ids : [...new Set([...folder.botIds, ...ids])]
          folder.version += 1
        }
        for (const other of Object.values(folders)) {
          if (other === folder) continue
          const keep = other.botIds.filter(id => !ids.includes(id))
          if (keep.length !== other.botIds.length) { other.botIds = keep; other.version += 1 }
        }
      } else if (kind === 'pin') {
        if (!folder) throw invalid('Choose a Bot folder.')
        if (typeof body.pinned !== 'boolean') throw invalid('Choose whether the folder is pinned.')
        folder.pinned = body.pinned
        folder.version += 1
      } else if (kind === 'rename') {
        if (!folder) throw invalid('Choose a Bot folder.')
        const name = cleanName(body.name)
        nameAvailable(name, folder.id)
        folder.name = name
        folder.version += 1
      } else if (kind === 'delete' || kind === 'dissolve') {
        if (!folder) throw invalid('Choose a Bot folder.')
        if (kind === 'delete' && folder.botIds.length) throw invalid('Move the Bots out before deleting this folder.')
        delete folders[folder.id]
      } else throw invalid('Unknown Bot folder action.')
      rt.state.botFolders = folders
      try { await rt.save() } catch (error) {
        if (rt.state.botFolders === folders) rt.state.botFolders = before
        throw error
      }
      return kind === 'delete' || kind === 'dissolve' ? null : folder ?? null
    })
    writing = operation.catch(() => {})
    return operation
  }
  rt.botFoldersView = () => folderView(rt.state)
  rt.botFolderMutate = mutate
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
  rt.ctx.tools.register(defineTool({
    name: 'list_bot_folders',
    description: 'Read sidebar Bot folders, their pinned status and members. These organize the Bot list; they are separate from group chats and projects. Use list_bots for each Bot’s role and work before deciding how to group them.',
    parameters: {}, output,
    async execute() {
      await rt.load()
      return JSON.stringify(rt.botFoldersView().map(folder => ({ ...folder, pinned: Boolean(folder.pinned), bots: folder.botIds.map(id => rt.state.bots[id].name) })))
    },
  }))
  rt.ctx.tools.register(defineTool({
    name: 'organize_bots',
    description: 'Main Bot only. Organize existing Bots in sidebar folders based on their roles and work. assign creates or reuses a named folder and moves all specified Bots into it atomically; folder "" moves them out. A Bot belongs to at most one folder. rename changes a folder name; pin and unpin change its priority among folders; dissolve removes a folder even when populated, returning its Bots to normal list order; delete removes only an empty folder. These actions retain Bots, chats and their work. This never starts, stops, deletes, or messages a Bot and never creates a group chat.',
    parameters: {
      action: { type: 'string', required: true, enum: ['assign', 'rename', 'pin', 'unpin', 'dissolve', 'delete'] },
      folder: { type: 'string', required: true, description: 'Folder name. For assign, an empty string removes the Bots from their folders.' },
      bots: { type: 'array', items: { type: 'string' }, description: 'Exact Bot names or IDs from list_bots. Required for assign; [] creates an empty folder.' },
      new_name: { type: 'string', description: 'New folder name for rename.' },
    }, output,
    async execute(args, exec) {
      await rt.load()
      if (!rt.isMain(rt.selfOf(exec.agent?.id))) throw invalid('Only a Main Bot can organize Bot folders. Ask a Main Bot instead.')
      const folderName = args.folder === '' ? '' : cleanName(args.folder)
      const folder = rt.botFoldersView().find(item => keyOf(item.name) === keyOf(folderName))
      if (args.action !== 'assign' && !folder) throw invalid('No Bot folder with this name. Read list_bot_folders first.')
      let botIds
      if (args.action === 'assign') {
        if (!Array.isArray(args.bots)) throw invalid('Provide the Bots to move.')
        botIds = args.bots.map(ref => {
          if (typeof ref !== 'string') throw invalid('Use exact Bot names or IDs.')
          const bot = rt.findBot(ref)
          if (!bot) throw invalid(`No Bot named ${ref}. Read list_bots first.`)
          return bot.id
        })
      }
      const result = await mutate(args.action === 'unpin' ? 'pin' : args.action, { id: args.action === 'assign' ? undefined : folder.id, name: args.action === 'rename' ? args.new_name : folderName, botIds, pinned: args.action === 'pin' }, exec.agent.id)
      return JSON.stringify({ ok: true, folder: result })
    },
  }))
}
