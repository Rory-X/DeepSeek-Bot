import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { ChevronRightIcon, DotsIcon, CloseIcon, PinMarkIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { hostText, t } from './i18n.js'

export function splitBotFolders(order, folders = []) {
  const assigned = new Set(folders.flatMap(folder => folder.botIds))
  return {
    loose: order.filter(entry => entry.kind !== 'bot' || !assigned.has(entry.item.id)),
    folders: [...folders].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))).map(folder => ({ ...folder, entries: order.filter(entry => entry.kind === 'bot' && folder.botIds.includes(entry.item.id)) })),
  }
}

export function BotFolderSection({ folder, roster, actions, useUi, renderRow }) {
  const key = `ds-bot:folder:${roster.workspaceId ?? roster.mainBotId}:${folder.id}`
  const [closed, setClosed] = useState(false)
  const panelId = useId()
  const menuOpen = useUi ? useUi(value => value.menu?.kind === 'bot-folder' && value.menu.id === folder.id) : false
  useEffect(() => {
    const read = () => { try { setClosed(localStorage.getItem(key) === 'closed') } catch {} }
    read()
    const changed = event => { if (event.key === key || event.key === null) read() }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [key])
  const toggle = () => {
    const next = !closed
    setClosed(next)
    try { localStorage.setItem(key, next ? 'closed' : 'open') } catch {}
  }
  return h('section', { className: 'bt-bot-folder', 'data-bot-folder-id': folder.id },
    h('div', { className: 'bt-bot-folder-head' },
      h('button', { type: 'button', className: 'bt-bot-folder-toggle', 'aria-expanded': !closed, 'aria-controls': panelId, onClick: toggle, title: folder.name },
        h('span', { className: 'bt-bot-folder-name' }, folder.name),
        folder.pinned ? h('span', { className: 'bt-bot-folder-pin', 'aria-hidden': true, title: t('Pinned') }, h(PinMarkIcon)) : null,
        h('span', { className: 'bt-bot-folder-chevron', 'data-open': !closed || undefined }, h(ChevronRightIcon))),
      h('button', { type: 'button', className: 'bt-bot-folder-edit', 'aria-label': t('Folder {name} actions', { name: folder.name }), title: t('Folder {name} actions', { name: folder.name }), 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, onClick: event => {
        const rect = event.currentTarget.getBoundingClientRect()
        actions.openMenu({ kind: 'bot-folder', id: folder.id, x: rect.right, y: rect.bottom, align: 'end' })
      } }, h(DotsIcon))),
    h('div', { id: panelId, hidden: closed, className: 'bt-bot-folder-rows' },
      // Keep rows mounted so unread-clearing and active-chat tracking continue when folded.
      folder.entries.map(renderRow),
      folder.entries.length === 0 ? h('button', { type: 'button', className: 'bt-bot-folder-empty', onClick: () => actions.openBotFolders({ folderId: folder.id }) }, t('Add Bots to this folder')) : null))
}

export function BotFoldersDialog({ start, roster, actions }) {
  const folders = roster.botFolders ?? []
  const initial = folders.find(folder => folder.id === start.folderId)
  const [folderId, setFolderId] = useState(initial?.id ?? '')
  const [version, setVersion] = useState(initial?.version)
  const [name, setName] = useState(initial?.name ?? '')
  const [picked, setPicked] = useState(initial?.botIds ?? (start.botId ? [start.botId] : []))
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef(null)
  const titleId = useId()
  const close = () => { if (!busy) actions.closeBotFolders() }
  useEscape(close)
  useEffect(() => {
    const previous = document.activeElement
    box.current?.querySelector('input')?.focus()
    return () => { if (previous?.isConnected) previous.focus?.() }
  }, [])
  const select = (id) => {
    const folder = folders.find(item => item.id === id)
    setFolderId(id)
    setVersion(folder?.version)
    setName(folder?.name ?? '')
    setPicked([...new Set([...(folder?.botIds ?? []), ...(start.botId ? [start.botId] : [])])])
    setError('')
  }
  const run = async (operation) => {
    if (busy || roster.readOnly) return
    setBusy(true)
    setError('')
    try { await operation(); actions.closeBotFolders() } catch (failure) { setError(hostText(failure?.message ?? String(failure))) } finally { setBusy(false) }
  }
  const save = event => {
    event.preventDefault()
    void run(() => actions.saveBotFolder({ id: folderId || undefined, version, name, botIds: picked }))
  }
  const wanted = query.trim().toLowerCase()
  const bots = roster.bots.filter(bot => bot.id !== roster.mainBotId && `${bot.name} ${bot.role ?? ''}`.toLowerCase().includes(wanted))
  const owners = Object.fromEntries(folders.flatMap(folder => folder.botIds.map(id => [id, folder])))
  const selected = folders.find(folder => folder.id === folderId)
  const trap = (event) => {
    if (event.key !== 'Tab') return
    const items = [...box.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')]
    const first = items[0], last = items.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return h('div', { className: 'bt-bot-folders-veil', onMouseDown: event => { if (event.target === event.currentTarget) close() } },
    h('form', { ref: box, className: 'bt-bot-folders-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, onSubmit: save, onKeyDown: trap },
      h('div', { className: 'bt-bot-folders-title' }, h('h2', { id: titleId }, t('Organize Bots')), h('button', { type: 'button', className: 'bt-round', disabled: busy, 'aria-label': t('Close'), onClick: close }, h(CloseIcon))),
      h('p', { className: 'bt-bot-folders-hint' }, t('Group Bots by their work. Their chats and work keep going.')),
      h('fieldset', { disabled: busy || Boolean(roster.readOnly) },
        h('label', { className: 'bt-bot-folders-field' }, t('Bot folder'), h('select', { 'aria-label': t('Bot folder'), value: folderId, onChange: event => select(event.target.value) },
          h('option', { value: '' }, t('New Bot folder')),
          folders.map(folder => h('option', { key: folder.id, value: folder.id }, folder.name)))),
        h('label', { className: 'bt-bot-folders-field' }, t('Folder name'), h('input', { value: name, maxLength: 48, required: true, placeholder: 'connector', onChange: event => setName(event.target.value) })),
        h('label', { className: 'bt-bot-folders-field' }, t('Folder members'), h('input', { type: 'search', value: query, placeholder: t('Search Bots'), onChange: event => setQuery(event.target.value) })),
        h('div', { className: 'bt-bot-folders-members' }, bots.map(bot => h('label', { key: bot.id, className: 'bt-bot-folders-member' },
          h('input', { type: 'checkbox', checked: picked.includes(bot.id), onChange: event => setPicked(current => event.target.checked ? [...current, bot.id] : current.filter(id => id !== bot.id)) }),
          h('span', null, h('strong', null, bot.name), h('small', null, [bot.role, owners[bot.id] && owners[bot.id].id !== folderId ? t('In folder {name}', { name: owners[bot.id].name }) : ''].filter(Boolean).join(' · '))))),
        bots.length === 0 ? h('p', { className: 'bt-bot-folders-hint' }, t('No matching Bots')) : null)),
      h('p', { className: 'bt-bot-folders-hint' }, t('Unchecked members return to the list. Selecting a Bot from another folder moves it here.')),
      error || roster.readOnly ? h('p', { role: 'alert', className: 'bt-bot-folders-error' }, error || hostText(roster.readOnly)) : null,
      h('div', { className: 'bt-bot-folders-actions' },
        selected && selected.botIds.length === 0 ? h('button', { type: 'button', className: 'bt-soft bt-danger', disabled: busy || Boolean(roster.readOnly), onClick: () => { void run(() => actions.deleteBotFolder({ id: selected.id, version })) } }, t('Delete empty folder')) : null,
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: close }, t('Cancel')),
        h('button', { type: 'submit', className: 'bt-soft bt-bot-folders-save', disabled: busy || !name.trim() || Boolean(roster.readOnly) }, busy ? t('Saving…') : t('Save')))))
}

export const BOT_FOLDERS_CSS = `
.bt-bot-folder{margin-top:4px;min-width:0}
.bt-bot-folder-head{display:flex;align-items:center;gap:var(--bt-row-gap,8px);padding:0 var(--bt-row-inset,8px) 0 calc(var(--bt-row-inset,8px) + 4px)}
.bt-bot-folder-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;min-height:32px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:13px;font-weight:500;line-height:20px;text-align:left;cursor:pointer}
.bt-bot-folder-pin{display:flex;flex:none;color:var(--bt-ink-2)}
.bt-bot-folder-pin svg{width:12px;height:12px}
.bt-bot-folder-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-bot-folder-toggle:hover,.bt-bot-folder-edit:hover{color:var(--bt-ink)}
.bt-bot-folder-empty:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-bot-folder-chevron{display:flex;flex:none;margin-left:auto}
.bt-bot-folder-chevron svg{width:16px;height:16px}
.bt-bot-folder-chevron[data-open]{transform:rotate(90deg)}
.bt-bot-folder-edit{display:flex;align-items:center;justify-content:flex-end;flex:none;width:28px;height:32px;padding:0;border:0;border-radius:4px;background:transparent;box-shadow:none;color:var(--bt-ink-2);cursor:pointer}
.bt-bot-folder-edit svg{width:18px;height:18px}
.bt-bot-folder-rows{display:flex;flex-direction:column;gap:var(--bt-row-stack-gap,3px)}
.bt-bot-folder-rows[hidden]{display:none}
.bt-bot-folder-empty{margin:4px 12px;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;text-align:left}
.bt-bot-folder-toggle:focus-visible,.bt-bot-folder-edit:focus-visible,.bt-bot-folder-empty:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-bot-folders-veil{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bt-hover);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;box-sizing:border-box}
.bt-bot-folders-dialog{width:min(480px,100%);max-height:calc(100dvh - 40px);display:flex;flex-direction:column;overflow:auto;padding:24px;border:1px solid var(--bt-line);border-radius:16px;background:var(--bt-card);color:var(--bt-ink);box-sizing:border-box}
.bt-bot-folders-title{display:flex;align-items:center;justify-content:space-between;gap:16px}
.bt-bot-folders-title h2{margin:0;font-size:18px;font-weight:600}
.bt-bot-folders-hint{margin:10px 0;color:var(--bt-ink-2);font-size:12px;line-height:1.6}
.bt-bot-folders-dialog fieldset{border:0;margin:0;padding:0;min-width:0}
.bt-bot-folders-field{display:flex;flex-direction:column;gap:6px;margin:12px 0;color:var(--bt-ink-2);font-size:12px}
.bt-bot-folders-field input,.bt-bot-folders-field select{box-sizing:border-box;width:100%;min-height:38px;padding:8px 10px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:14px}
.bt-bot-folders-members{max-height:260px;overflow:auto;border:1px solid var(--bt-line);border-radius:8px}
.bt-bot-folders-member{display:flex;align-items:center;gap:10px;padding:10px;cursor:pointer}
.bt-bot-folders-member:hover{background:var(--bt-hover)}
.bt-bot-folders-member input{accent-color:var(--bt-accent);width:16px;height:16px;flex:none}
.bt-bot-folders-member span{min-width:0}
.bt-bot-folders-member strong,.bt-bot-folders-member small{display:block;overflow-wrap:anywhere}
.bt-bot-folders-member strong{font-size:13px;font-weight:500}
.bt-bot-folders-member small{font-size:11px;color:var(--bt-ink-2);margin-top:3px}
.bt-bot-folders-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;flex-wrap:wrap}
.bt-bot-folders-save{color:var(--bt-accent)!important}
.bt-bot-folders-error{font-size:13px;color:var(--bt-danger)}
@media (max-width:640px){.bt-bot-folders-veil{padding:12px}.bt-bot-folders-dialog{padding:18px;max-height:calc(100dvh - 24px)}}
`
