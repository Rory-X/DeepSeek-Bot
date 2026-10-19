import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call } from './api.js'
import { Card, Row } from './bot-settings.js'
import { BotAvatar } from './mark.js'
import { CheckIcon, CloseIcon, FolderIcon, PlusIcon, SearchIcon, SidePanelIcon, PaperclipIcon } from './icons.js'
import { relativeShort } from './text.js'
import { t } from './i18n.js'

const COLUMNS = [
  ['backlog', 'Backlog'], ['in-progress', 'In progress'], ['needs-you', 'Needs you'], ['done', 'Done'],
]
const STAGES = [
  ['confirmation', 'Requirement confirmation'], ['clarification', 'Clarification'],
  ['design', 'Solution design'], ['implementation', 'Implementation'], ['validation', 'Validation'],
]
const stageName = key => t(STAGES.find(([id]) => id === key)?.[1] ?? 'Requirement confirmation')
const decisionName = kind => t(kind === 'acceptance' ? 'Final acceptance' : kind === 'design' ? 'Confirm the plan' : 'Your decision')
const VIEW_KEY = 'ds-bot.project-board.view.v1'
function readView() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') ?? {} } catch { return {} }
}
function remember(patch) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ ...readView(), ...patch })) } catch { /* storage is optional */ }
}

export function BoardEntry({ actions, wide = true, pending = 0 }) {
  return h('button', { type: 'button', className: 'bt-board-entry', onClick: actions.openBoard, title: t('Project board'), 'aria-label': t('Project board') },
    h(SidePanelIcon), wide ? h('span', null, t('Project board')) : null,
    pending > 0 ? h('span', { className: 'bt-board-count' }, pending) : null)
}

export function ProjectBoard({ useUi, useRoster, actions }) {
  const open = useUi(value => value.board === true)
  const roster = useRoster(value => value)
  return open ? createPortal(h(BoardPage, { roster, actions }), document.body) : null
}

function BoardPage({ roster, actions }) {
  const [data, setData] = useState(null)
  const [projectId, setProjectId] = useState(() => readView().projectId ?? '')
  const [queries, setQueries] = useState(() => readView().queries ?? {})
  const [selected, setSelected] = useState(null)
  const [creating, setCreating] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [showCancelled, setShowCancelled] = useState(() => readView().showCancelled === true)
  const [error, setError] = useState('')
  const [left, setLeft] = useState(0)
  const columns = useRef(null)
  const query = queries[projectId] ?? ''
  const refresh = useCallback(async (signal) => {
    const next = await call('board-view', {}, signal)
    setData(previous => previous && previous.revision > next.revision ? previous : next)
    setError('')
    setProjectId(id => id || next.projects[0]?.id || '')
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    let timer
    const poll = async () => {
      try { await refresh(controller.signal) } catch (problem) {
        if (!controller.signal.aborted) setError(problem.message)
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, document.hidden ? 10000 : 1500)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [refresh])
  useEffect(() => {
    const measure = () => {
      const sidebar = document.querySelector('.bt-side')
      const rect = sidebar?.getBoundingClientRect()
      setLeft(window.innerWidth >= 900 && rect && rect.width > 0 ? rect.right : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    const side = document.querySelector('.bt-side')
    if (side) observer.observe(side)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  useEffect(() => {
    remember({ projectId, queries, showCancelled })
  }, [projectId, queries, showCancelled])
  useEffect(() => {
    const box = columns.current
    if (!box) return undefined
    box.scrollLeft = readView().scroll?.[projectId] ?? 0
    const save = () => remember({ scroll: { ...readView().scroll, [projectId]: box.scrollLeft } })
    box.addEventListener('scroll', save, { passive: true })
    return () => box.removeEventListener('scroll', save)
  }, [projectId, Boolean(data)])
  useEffect(() => {
    const close = event => {
      if (event.key !== 'Escape' || event.defaultPrevented || selected || creating) return
      event.preventDefault()
      actions.closeBoard()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [actions, selected, creating])
  const project = data?.projects.find(item => item.id === projectId)
  const projectCards = (data?.cards ?? []).filter(card => card.projectId === projectId && (showCancelled || card.status !== 'cancelled'))
  const cards = projectCards.filter(card => (card.title + ' #' + card.number).toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const card = (data?.cards ?? []).find(item => item.id === selected)
  return h('main', { className: 'bt-board', style: { left }, 'aria-label': t('Project board') },
    h('header', { className: 'bt-board-header' },
      h('div', { className: 'bt-board-heading' }, h(SidePanelIcon), h('h1', null, t('Project board'))),
      h('div', { className: 'bt-board-header-actions' },
        h('button', { type: 'button', className: 'bt-board-button', onClick: actions.closeBoard }, t('Back to chats')),
        h('button', { type: 'button', className: 'bt-board-button', onClick: () => { setSelected(null); setQueueOpen(true) } }, t('Queue'), ' ', data?.queue?.length ?? 0),
        h('button', { type: 'button', className: 'bt-board-button bt-board-primary', disabled: !project || Boolean(data?.readOnly), onClick: () => setCreating(true) }, h(PlusIcon), t('New requirement')))),
    h('div', { className: 'bt-board-toolbar' },
      h('nav', { className: 'bt-board-projects', 'aria-label': t('Projects') },
        (data?.projects ?? []).map(item => h('button', {
          key: item.id, type: 'button', className: 'bt-board-project', 'aria-pressed': item.id === projectId, title: item.path,
          onClick: () => { setSelected(null); setCreating(false); setProjectId(item.id) },
        }, h(FolderIcon), item.title, item.pending > 0 ? h('span', { className: 'bt-board-count' }, item.pending) : null))),
      h('label', { className: 'bt-board-search' }, h(SearchIcon),
        h('input', { type: 'search', value: query, placeholder: t('Search requirements'), 'aria-label': t('Search requirements'),
          onChange: event => setQueries({ ...queries, [projectId]: event.target.value }) }))),
    project ? h('div', { className: 'bt-board-project-info' },
      h('span', { title: project.path }, project.path),
      h('span', null, t('{count} requirements', { count: projectCards.length }))) : null,
    error || data?.readOnly ? h('p', { className: 'bt-board-error', role: 'alert' }, error || data.readOnly) : null,
    !data ? h('p', { className: 'bt-board-empty' }, t('Loading…'))
      : !project ? h('div', { className: 'bt-board-empty' }, h(FolderIcon), h('h2', null, t('Select a DSH project')), h('p', null, t('Your registered DSH projects appear here.')))
        : h('div', { className: 'bt-board-columns', ref: columns },
          COLUMNS.map(([id, title]) => {
            const items = cards.filter(item => item.column === id).sort((a, b) => b.updatedAt - a.updatedAt)
            return h('section', { key: id, className: 'bt-board-column', 'data-column': id, 'aria-label': t(title) },
              h('div', { className: 'bt-board-column-title' }, h('span', { className: 'bt-board-dot' }), h('h2', null, t(title)), h('span', { className: 'bt-board-column-count' }, items.length)),
              h('div', { className: 'bt-board-column-cards' }, items.map(item => h(RequirementCard, { key: item.id, card: item, roster, onOpen: () => setSelected(item.id) })),
                items.length === 0 ? h('p', { className: 'bt-board-empty-column' }, query ? t('No matching requirements') : t('No requirements here yet')) : null))
          })),
    h('label', { className: 'bt-board-cancel-filter' }, h('input', { type: 'checkbox', checked: showCancelled, onChange: event => setShowCancelled(event.target.checked) }), t('Show cancelled')),
    card ? h(RequirementDetail, { key: card.id, card, project, roster, actions, queue: data?.queue ?? [], onClose: () => setSelected(null), onSaved: refresh, readOnly: Boolean(data?.readOnly) }) : null,
    queueOpen ? h(Drawer, { title: t('Global execution queue'), onClose: () => setQueueOpen(false) },
      h('p', { className: 'bt-board-muted' }, t('Each Bot handles one board task at a time. Project implementation also waits its turn.')),
      h(QueueList, { entries: data?.queue ?? [], roster, onOpen: entry => { const target = data.cards.find(card => card.id === entry.cardId); setProjectId(target.projectId); setSelected(target.id); setQueueOpen(false) } })) : null,
    creating && project ? h(DraftDialog, { roster, project, onClose: () => setCreating(false), onSaved: async (saved) => { await refresh(); setCreating(false); setSelected(saved.id) } }) : null)
}

function Owners({ card, roster, label = false }) {
  const ids = [card.leadId, ...(card.collaboratorIds ?? [])]
  return h('div', { className: 'bt-board-owners' },
    ids.slice(0, 4).map((id, index) => h('span', { key: id, title: (index === 0 ? t('Lead Bot') + ': ' : '') + (roster.byId[id]?.name ?? t('Unavailable Bot')) },
      h(BotAvatar, { bot: roster.byId[id], size: 28, main: (roster.mainBotIds ?? []).includes(id), live: false }))),
    ids.length > 4 ? h('span', null, '+' + (ids.length - 4)) : null,
    label ? h('span', { className: 'bt-board-owner-name' }, roster.byId[card.leadId]?.name ?? t('Unavailable Bot')) : null)
}

function RequirementCard({ card, roster, onOpen }) {
  const waiting = (card.decisions ?? []).find(item => item.status === 'open')
  const steps = card.steps ?? []
  const done = steps.filter(step => step.status === 'done').length
  return h('button', { type: 'button', className: 'bt-board-card', onClick: onOpen, 'aria-label': card.title },
    h('span', { className: 'bt-board-card-meta' }, h('span', { className: 'bt-board-stage' }, stageName(card.stage)), h('span', null, '#' + card.number)),
    h('span', { className: 'bt-board-card-title' }, card.title),
    ['paused', 'pausing', 'cancelling', 'cancelled'].includes(card.status) ? h('span', { className: 'bt-board-waiting' }, t({ paused: 'Paused', pausing: 'Pausing…', cancelling: 'Cancelling…', cancelled: 'Cancelled' }[card.status])) : null,
    card.summary ? h('span', { className: 'bt-board-card-summary' }, t(card.summary)) : null,
    waiting ? h('span', { className: 'bt-board-waiting' }, h('span', { className: 'bt-board-dot' }), decisionName(waiting.kind)) : null,
    card.blocker ? h('span', { className: 'bt-board-waiting' }, card.blocker) : null,
    card.deliveryError ? h('span', { className: 'bt-board-waiting' }, t('Task delivery needs attention')) : null,
    steps.length > 0 ? h('span', { className: 'bt-board-step-count' }, h(CheckIcon), t('{done} of {total} steps', { done, total: steps.length })) : null,
    h('span', { className: 'bt-board-card-foot' },
      h(Owners, { card, roster }),
      h('span', { className: 'bt-board-time' }, relativeShort(card.updatedAt)),
      (card.artifacts ?? []).length > 0 ? h('span', { className: 'bt-board-attachment', title: t('Deliverables') }, h(PaperclipIcon), card.artifacts.length) : null,
      h('span', { className: waiting ? 'bt-board-card-action bt-board-action-review' : 'bt-board-card-action' }, waiting ? t('Review') : t('Details'))))
}

function Drawer({ title, onClose, children, footer }) {
  const ref = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.querySelector('button,input,textarea')?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); onClose() }
    if (event.key !== 'Tab') return
    const focus = [...ref.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el => el.getClientRects().length)
    const first = focus[0], last = focus.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return h('div', { className: 'bt-board-drawer-veil', onClick: event => { if (event.target === event.currentTarget) onClose() } },
    h('section', { className: 'bt-board-drawer', ref, role: 'dialog', 'aria-modal': true, 'aria-label': title, onKeyDown },
      h('header', { className: 'bt-board-drawer-header' }, h('span', null, title), h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Close'), onClick: onClose }, h(CloseIcon))),
      h('div', { className: 'bt-board-drawer-body' }, children),
      footer ? h('footer', { className: 'bt-board-drawer-foot' }, footer) : null))
}

function DecisionForm({ card, decision, readOnly, onSaved }) {
  const [snapshot] = useState(() => ({ decisionId: decision.id, decisionVersion: decision.version }))
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const clarify = decision.kind === 'clarification'
  const submit = async choice => {
    setBusy(true); setError('')
    try {
      await call('board-decide', { id: card.id, ...snapshot, choice, answer })
      await onSaved()
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return h('section', { className: 'bt-board-decision' },
    h('p', { className: 'bt-board-eyebrow' }, decisionName(decision.kind)),
    h('h3', null, decision.question), h('p', { className: 'bt-board-decision-text' }, decision.recommendation),
    decision.impact ? h('p', { className: 'bt-board-muted' }, decision.impact) : null,
    h('label', { className: 'bt-board-answer' }, t(clarify ? 'Your answer' : 'Feedback or requested changes'),
      h('textarea', { className: 'bt-bs-input bt-bs-area', rows: 3, maxLength: 4000, value: answer, disabled: busy || readOnly, onChange: event => setAnswer(event.target.value) })),
    h('div', { className: 'bt-board-decision-actions' },
      !clarify ? h('button', { className: 'bt-board-button', disabled: busy || readOnly || !answer.trim(), onClick: () => submit('reject') }, t('Request changes')) : null,
      h('button', { className: 'bt-board-button bt-board-primary', disabled: busy || readOnly || (clarify && !answer.trim()), onClick: () => submit(clarify ? 'answer' : 'approve') },
        t(clarify ? 'Send answer' : decision.kind === 'acceptance' ? 'Accept delivery' : 'Approve plan'))),
    error ? h('p', { className: 'bt-board-error', role: 'alert' }, error) : null)
}

function ArtifactReference({ value }) {
  return /^https?:\/\//i.test(value ?? '') ? h('a', { href: value, target: '_blank', rel: 'noopener noreferrer', className: 'bt-board-reference' }, value)
    : value ? h('code', { className: 'bt-board-reference' }, value) : null
}

function QueueList({ entries, roster, onOpen }) {
  return entries.length ? h('ol', { className: 'bt-board-queue' }, entries.map(entry => {
    const state = entry.blockedBy === 'project' ? t('Waiting for requirement #{number}', { number: entry.waitingNumber })
      : entry.blockedBy === 'bot' ? t('Waiting for this Bot') : entry.blockedBy === 'chat' ? t('Waiting for the current conversation')
        : t({ pending: 'Queued', held: 'Paused', sending: 'Dispatching', sent: 'Waiting for the Bot', running: entry.recovery ? 'Checking saved progress' : 'Working', settling: 'Working', stopping: 'Stopping…', recovering: 'Checking saved progress' }[entry.state] ?? 'Queued')
    return h('li', { key: entry.id }, h('div', { className: 'bt-board-queue-top' }, h(BotAvatar, { bot: roster.byId[entry.botId], size: 24, live: false }),
      h('strong', null, roster.byId[entry.botId]?.name ?? t('Unavailable Bot')), h('span', { className: 'bt-board-muted' }, state)),
    onOpen ? h('button', { className: 'bt-board-queue-link', onClick: () => onOpen(entry) }, '#' + entry.number + ' · ' + entry.title) : null,
    h('p', null, entry.step), entry.state === 'pending' ? h('small', null, t('Bot queue position {position}', { position: entry.position })) : null)
  })) : h('p', { className: 'bt-board-prose bt-board-muted' }, t('No queued work'))
}

function BackgroundVerification({ card, onSaved, readOnly }) {
  const [evidence, setEvidence] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const submit = async () => {
    setBusy(true); setError('')
    try {
      await call('board-background-resolve', { id: card.id, evidence, jobKeys: card.backgroundJobs.filter(job => job.status === 'unknown').map(job => [job.bootId, job.owner, job.id, job.startedAt].join(':')) })
      await onSaved()
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return h('section', { className: 'bt-board-decision' }, h('h3', null, t('Verify background task shutdown')),
    h('p', null, t('Check that the old processes stopped and inspect their saved effects. Record your evidence before allowing recovery. This does not stop an unknown process for you.')),
    h('label', { className: 'bt-board-answer' }, t('Shutdown verification evidence'), h('textarea', { className: 'bt-bs-input bt-bs-area', value: evidence, maxLength: 4000, rows: 3, disabled: readOnly || busy, onChange: event => setEvidence(event.target.value) })),
    h('button', { className: 'bt-board-button', disabled: readOnly || busy || evidence.trim().length < 10, onClick: submit }, t('Confirm stopped and continue')),
    error ? h('p', { className: 'bt-board-error', role: 'alert' }, error) : null)
}

function RequirementDetail({ card, project, roster, actions, queue, onClose, onSaved, readOnly }) {
  const [editing, setEditing] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = async (endpoint = 'board-start') => {
    setBusy(true); setError('')
    try { await call(endpoint, { id: card.id, version: card.version }); await onSaved() }
    catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  const control = async endpoint => {
    setBusy(true); setError('')
    try { await call(endpoint, { id: card.id, requestId: crypto.randomUUID() }); await onSaved(); setConfirmCancel(false) }
    catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  if (editing) return h(DraftDialog, { card, project, roster, onClose: () => setEditing(false), onSaved: async () => { await onSaved(); setEditing(false) } })
  const stage = STAGES.findIndex(([id]) => id === card.stage)
  return h(Drawer, { title: t('Requirement') + ' #' + card.number, onClose,
    footer: h('div', { className: 'bt-board-detail-actions' },
      card.roomId ? h('button', { className: 'bt-board-button', onClick: () => actions.openSession(card.roomId) }, t(card.collaboratorIds.length ? 'Open task group' : 'Open task conversation')) : null,
      card.status === 'active' ? h('button', { className: 'bt-board-button', disabled: busy || readOnly, onClick: () => control('board-pause') }, t('Pause requirement')) : null,
      card.status === 'paused' ? h('button', { className: 'bt-board-button bt-board-primary', disabled: busy || readOnly, onClick: () => control('board-resume') }, t('Resume requirement')) : null,
      ['backlog', 'active', 'paused'].includes(card.status) ? h('button', { className: 'bt-board-button', disabled: busy || readOnly, onClick: () => setConfirmCancel(true) }, t('Cancel requirement')) : null,
      card.status === 'backlog' ? h('button', { className: 'bt-board-button', disabled: readOnly || busy, onClick: () => setEditing(true) }, t('Edit draft')) : null,
      card.status === 'backlog' ? h('button', { className: 'bt-board-button bt-board-primary', disabled: readOnly || busy || !card.description.trim() || !card.acceptance.trim(), onClick: () => start() }, t(busy ? 'Starting…' : 'Start requirement')) : null) },
    h('p', { className: 'bt-board-eyebrow' }, project?.title, ' · ', t(COLUMNS.find(([id]) => id === card.column)?.[1] ?? 'Backlog')),
    h('h2', { className: 'bt-board-detail-title' }, card.title),
    h(Owners, { card, roster, label: true }),
    confirmCancel ? h('section', { className: 'bt-board-decision' }, h('h3', null, t('Cancel this requirement?')),
      h('p', null, t('Running work will stop. Files, deliverables and history remain available. Cancellation does not undo changes.')),
      h('div', { className: 'bt-board-decision-actions' }, h('button', { className: 'bt-board-button', disabled: busy, onClick: () => setConfirmCancel(false) }, t('Keep requirement')),
        h('button', { className: 'bt-board-button', disabled: busy || readOnly, onClick: () => control('board-cancel') }, t('Confirm cancellation')))) : null,
    ['paused', 'pausing', 'cancelling', 'cancelled'].includes(card.status) ? h('p', { className: 'bt-board-control-state', role: 'status' },
      t({ paused: 'Paused; progress retained', pausing: 'Stopping work before pausing', cancelling: 'Stopping work before cancellation', cancelled: 'Cancelled; deliverables and history retained' }[card.status])) : null,
    card.status === 'backlog' ? h('p', { className: 'bt-board-muted' }, t('Start asks the lead Bot to clarify and plan. Implementation waits for your approval.')) : null,
    card.deliveryError || error ? h('p', { className: 'bt-board-error', role: 'alert' }, t(card.deliveryError || error)) : null,
    card.deliveryError && card.deliveries?.some(job => job.status === 'failed') && !card.deliveries.some(job => job.status === 'failed' && job.mayHaveSent)
      ? h('button', { className: 'bt-board-button', disabled: busy || readOnly, onClick: () => start('board-retry') }, t('Retry task delivery')) : null,
    h('ol', { className: 'bt-board-stages', 'aria-label': t('Development stages') },
      STAGES.map(([id, title], index) => h('li', { key: id, 'data-current': index === stage, 'data-complete': index < stage || card.status === 'done' },
        h('span', { className: 'bt-board-stage-index' }, index < stage || card.status === 'done' ? h(CheckIcon) : index + 1), h('span', null, t(title))))),
    (queue ?? []).some(entry => entry.cardId === card.id) ? h(Card, { title: t('Execution queue') }, h(QueueList, { entries: queue.filter(entry => entry.cardId === card.id), roster })) : null,
    (card.backgroundJobs ?? []).length ? h(Card, { title: t('Background tasks') },
      h('p', { className: 'bt-board-prose bt-board-muted' }, t('Pause and cancel wait for background tasks to stop. Saved files are retained.')),
      card.backgroundJobs.slice(-8).map((job, index) => h('div', { key: index, className: 'bt-board-evidence' },
        h('strong', null, job.kind + ' · ' + job.id), h('p', null, t({ running: 'Running', stopping: 'Stopping…', killed: 'Stopped', completed: 'Finished', failed: 'Failed', unknown: 'Needs verification after restart', 'confirmed-stopped': 'Shutdown verified by user' }[job.status] ?? job.status)), job.resolution ? h('p', null, job.resolution.evidence) : null))) : null,
    (card.backgroundJobs ?? []).some(job => job.status === 'unknown') ? h(BackgroundVerification, { card, onSaved, readOnly }) : null,
    (card.deliveries ?? []).some(job => job.reconciled) ? h(Card, { title: t('Recovery checks') }, card.deliveries.filter(job => job.reconciled).slice(-3).map(job => h('div', { key: job.id, className: 'bt-board-evidence' }, h('strong', null, roster.byId[job.botId]?.name), h('p', null, job.reconciled.observations), job.reconciled.references.map((reference, i) => h(ArtifactReference, { key: i, value: reference }))))) : null,
    (card.decisions ?? []).filter(item => item.status === 'open').map(item => h(DecisionForm, { key: item.id, card, decision: item, readOnly: readOnly || card.status !== 'active', onSaved })),
    card.plan && !card.decisions.some(item => item.status === 'open' && item.kind === 'design') ? h(Card, { title: t('Implementation plan') }, h('p', { className: 'bt-board-prose' }, card.plan)) : null,
    (card.evidence ?? []).length ? h(Card, { title: t(card.deliveryPlanVersion && card.deliveryPlanVersion !== card.approvedPlan ? 'Evidence from an earlier delivery' : 'Verification evidence') },
      !card.collaboratorIds.length ? h('p', { className: 'bt-board-prose bt-board-muted' }, t('Single-Bot delivery: no independent reviewer.')) : null,
      card.evidence.map((item, index) => h('div', { key: index, className: 'bt-board-evidence' },
        h('strong', null, item.result === 'passed' ? h(CheckIcon) : null, item.criterion),
        h('p', null, item.detail), h(ArtifactReference, { value: item.reference })))) : null,
    h(Card, { title: t('Requirement brief') }, h('p', { className: 'bt-board-prose' }, card.description || t('No description yet'))),
    h(Card, { title: t('Acceptance criteria') }, h('p', { className: 'bt-board-prose' }, card.acceptance || t('To be clarified with the lead Bot'))),
    h(Card, { title: t('Execution steps') }, (card.steps ?? []).length
      ? h('ol', { className: 'bt-board-steps' }, card.steps.map(step => h('li', { key: step.id },
        h('span', { className: 'bt-board-step-state', 'data-done': step.status === 'done' }, step.status === 'done' ? h(CheckIcon) : h('span', { className: 'bt-board-dot' })),
        h('div', null, h('span', null, step.title), h('small', null, (roster.byId[step.assigneeId]?.name ?? t('Unassigned')) + ' · ' + t(step.status === 'done' ? 'Done' : step.status === 'running' ? 'Working' : step.status === 'blocked' ? 'Blocked' : step.status === 'paused' ? 'Paused' : step.status === 'cancelled' ? 'Cancelled' : 'Queued')),
          step.scope ? h('small', null, step.scope) : null, step.summary ? h('p', { className: 'bt-board-muted' }, step.summary) : null,
          step.evidence ? h('small', null, step.evidence) : null))))
      : h('p', { className: 'bt-board-prose bt-board-muted' }, t('The lead Bot will break down the work.'))),
    h(Card, { title: t('Deliverables') }, (card.artifacts ?? []).length
      ? card.artifacts.map(item => h('div', { key: item.id, className: 'bt-board-artifact' }, h(PaperclipIcon), h('div', null, h('strong', null, item.title), h('small', null, item.summary), h(ArtifactReference, { value: item.reference }))))
      : h('p', { className: 'bt-board-prose bt-board-muted' }, t('Deliverables and verification evidence will appear here.'))),
    h(Card, { title: t('Activity') }, h('ol', { className: 'bt-board-activity' },
      [...(card.activity ?? [])].reverse().map(item => h('li', { key: item.id }, h('span', null, t(item.text), item.actor !== 'user' && roster.byId[item.actor] ? ' · ' + roster.byId[item.actor].name : ''), h('small', null, relativeShort(item.at)))))),
    (card.submissions ?? []).length > 1 ? h(Card, { title: t('Earlier deliveries') }, card.submissions.slice(0, -1).map(item => h('details', { key: item.id, className: 'bt-board-evidence' },
      h('summary', null, t('Plan version {version}', { version: item.planVersion }) + ' · ' + item.summary),
      item.evidence.map((entry, index) => h('p', { key: index }, entry.criterion, ' · ', entry.detail, h(ArtifactReference, { value: entry.reference }))),
      item.artifacts.map(entry => h('p', { key: entry.id }, entry.title, h(ArtifactReference, { value: entry.reference })))))) : null,
    (card.decisions ?? []).filter(item => item.status === 'answered').length ? h(Card, { title: t('Decision history') }, card.decisions.filter(item => item.status === 'answered').map(item => h('div', { key: item.id, className: 'bt-board-evidence' },
      h('strong', null, item.question), h('p', null, t(item.choice === 'approve' ? 'Approved' : item.choice === 'reject' ? 'Changes requested' : 'Answered')), item.answer ? h('p', null, item.answer) : null))) : null)
}

function DraftDialog({ card, project, roster, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => ({
    requestId: crypto.randomUUID(), version: card?.version, title: card?.title ?? '', description: card?.description ?? '',
    acceptance: card?.acceptance ?? '', leadId: card?.leadId ?? roster.mainBotId ?? '',
    collaboratorIds: card?.collaboratorIds ?? [],
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const submit = async event => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const saved = await call(card ? 'board-edit' : 'board-create', { ...draft, projectId: project.id, ...(card ? { id: card.id, version: draft.version } : {}) })
      await onSaved(saved)
    } catch (problem) { setError(problem.message) } finally { setBusy(false) }
  }
  return h(Drawer, { title: card ? t('Edit draft') : t('New requirement'), onClose,
    footer: h('button', { type: 'submit', form: 'bt-board-draft', className: 'bt-board-button bt-board-primary', disabled: busy || !draft.title.trim() || !draft.leadId }, busy ? t('Saving…') : t('Save draft')) },
    h('p', { className: 'bt-board-eyebrow' }, project.title),
    h('form', { id: 'bt-board-draft', onSubmit: submit, className: 'bt-board-form' },
      h(Card, null,
        h(Row, { label: t('Requirement title'), stack: true }, h('input', { className: 'bt-bs-input', value: draft.title, required: true, maxLength: 180, onChange: event => change('title', event.target.value) })),
        h(Row, { label: t('Requirement brief'), stack: true }, h('textarea', { className: 'bt-bs-input bt-bs-area', rows: 4, maxLength: 12000, value: draft.description, onChange: event => change('description', event.target.value) })),
        h(Row, { label: t('Acceptance criteria'), stack: true }, h('textarea', { className: 'bt-bs-input bt-bs-area', rows: 3, maxLength: 8000, value: draft.acceptance, onChange: event => change('acceptance', event.target.value) }))),
      h(Card, { title: t('Ownership') },
        h(Row, { label: t('Lead Bot'), stack: true }, h('select', { className: 'bt-bs-input', value: draft.leadId, onChange: event => change('leadId', event.target.value) },
          h('option', { value: '' }, t('Choose a Bot')), roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
        h('fieldset', { className: 'bt-board-collaborators' }, h('legend', null, t('Collaborators')),
          roster.bots.filter(bot => bot.id !== draft.leadId).map(bot => h('label', { key: bot.id },
            h('input', { type: 'checkbox', checked: draft.collaboratorIds.includes(bot.id), onChange: event => change('collaboratorIds', event.target.checked ? [...draft.collaboratorIds, bot.id] : draft.collaboratorIds.filter(id => id !== bot.id)) }),
            h(BotAvatar, { bot, size: 24, live: false }), bot.name)))),
      h('p', { className: 'bt-board-muted' }, t('Saving a draft does not start any Bot.')),
      error ? h('p', { className: 'bt-board-error', role: 'alert' }, error) : null))
}

export const BOARD_CSS = [
  '.bt-board-cancel-filter{display:flex;gap:7px;align-items:center;padding:4px 24px 14px;font-size:12px;color:var(--bt-ink-2)}.bt-board-queue{list-style:none;margin:0;padding:0}.bt-board-queue li{padding:14px;border-bottom:1px solid var(--bt-line);font-size:12px}.bt-board-queue-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.bt-board-queue-top strong{font-weight:550}.bt-board-queue p{margin:8px 0;overflow-wrap:anywhere}.bt-board-queue small{color:var(--bt-ink-3)}.bt-board-queue-link{border:0;padding:8px 0 0;background:transparent;color:var(--bt-accent);text-align:left}.bt-board-control-state{padding:12px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);font-size:12px;color:var(--bt-star)}@media(max-width:899px){.bt-board-header-actions{max-width:70%;flex-wrap:wrap;justify-content:flex-end}.bt-board-detail-actions .bt-board-button{font-size:11px;padding:8px}.bt-board-cancel-filter{padding-left:16px}}',
  '.bt-board-detail-actions,.bt-board-decision-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.bt-board-answer{display:block;font-size:12px;margin:16px 0}.bt-board-answer textarea{display:block;width:100%;resize:vertical;margin-top:7px}.bt-board-decision-text{white-space:pre-wrap}.bt-board-reference{display:block;overflow-wrap:anywhere;font-size:11px;color:var(--bt-accent);margin-top:6px}.bt-board-evidence{padding:14px 16px;border-bottom:1px solid var(--bt-line);font-size:12px;overflow-wrap:anywhere}.bt-board-evidence strong{font-weight:550}.bt-board-evidence svg{display:inline-block;width:14px;height:14px;color:var(--bt-green);vertical-align:middle;margin-right:6px}.bt-board-evidence p{white-space:pre-wrap;color:var(--bt-ink-2);line-height:1.6}.bt-board-decision .bt-board-error{margin:12px 0 0}',
  '.bt-board-entry{display:flex;align-items:center;gap:10px;flex:none;margin:6px 12px 10px;padding:10px 12px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card);color:var(--bt-ink);font:inherit;cursor:pointer;text-align:left}.bt-board-entry:hover{background:var(--bt-hover)}.bt-board-entry>span:first-of-type{flex:1}.bt-board-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 5px;border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-star);font-size:12px;font-weight:600}',
  '.bt-board{position:fixed;z-index:65;top:0;right:0;bottom:0;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;isolation:isolate}.bt-board *{box-sizing:border-box}.bt-board button,.bt-board input,.bt-board textarea,.bt-board select{font:inherit}.bt-board button{cursor:pointer}.bt-board button:disabled{cursor:default;opacity:.5}.bt-board :focus-visible{outline:2px solid var(--bt-accent);outline-offset:3px}.bt-board-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px 18px;border-bottom:1px solid var(--bt-line)}.bt-board-heading{display:flex;align-items:center;gap:10px}.bt-board-heading>svg{width:22px;height:22px;color:var(--bt-ink-2)}.bt-board h1{font-size:19px;font-weight:650;margin:0}.bt-board-header-actions{display:flex;gap:10px}.bt-board-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 14px;min-height:38px;border:1px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);color:var(--bt-ink);white-space:nowrap}.bt-board-primary{background:var(--bt-accent);color:var(--bt-accent-ink);border-color:var(--bt-accent)}',
  '.bt-board-toolbar{display:flex;align-items:center;gap:20px;padding:16px 24px 8px}.bt-board-projects{display:flex;flex:1;gap:6px;min-width:0;overflow:auto;padding:3px}.bt-board-project{display:flex;align-items:center;gap:8px;flex:none;padding:8px 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--bt-ink-2);white-space:nowrap}.bt-board-project[aria-pressed=true]{background:var(--bt-card);color:var(--bt-ink);border-color:var(--bt-line-2)}.bt-board-search{display:flex;align-items:center;gap:8px;max-width:230px;color:var(--bt-ink-3);padding:8px 10px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card)}.bt-board-search input{border:0;outline:none;background:transparent;color:var(--bt-ink);width:100%;min-width:0}.bt-board-project-info{display:flex;justify-content:space-between;gap:16px;padding:2px 27px 16px;font-size:12px;color:var(--bt-ink-3)}.bt-board-project-info>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt-board-project-info>span:last-child{flex:none}',
  '.bt-board-columns{display:grid;grid-template-columns:repeat(4,minmax(240px,1fr));align-items:stretch;gap:14px;flex:1;min-height:0;overflow:auto;padding:0 24px 24px}.bt-board-column{display:flex;flex-direction:column;min-height:0;border:1px solid var(--bt-line);border-radius:16px;background:var(--bt-sidebar);--board-dot:var(--bt-ink-3)}.bt-board-column[data-column=in-progress]{--board-dot:var(--bt-accent)}.bt-board-column[data-column=needs-you]{--board-dot:var(--bt-star)}.bt-board-column[data-column=done]{--board-dot:var(--bt-green)}.bt-board-column-title{display:flex;align-items:center;gap:8px;padding:18px 16px 14px}.bt-board-column-title h2{font-size:14px;font-weight:600;margin:0}.bt-board-dot{display:inline-block;width:7px;height:7px;flex:none;border-radius:50%;background:var(--board-dot,var(--bt-ink-3))}.bt-board-column-count{margin-left:auto;color:var(--bt-ink-3);font-size:12px}.bt-board-column-cards{padding:0 10px 12px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:10px}.bt-board-card{display:flex;flex-direction:column;gap:12px;text-align:left;flex:none;width:100%;padding:16px 14px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink)}.bt-board-card:hover{border-color:var(--bt-line-2);background:var(--bt-main)}.bt-board-card-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--bt-ink-3);font-size:11px}.bt-board-stage{color:var(--bt-ink-2)}.bt-board-card-title{font-size:15px;line-height:1.5;font-weight:600;overflow-wrap:anywhere}.bt-board-card-summary{font-size:12px;color:var(--bt-ink-2);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.bt-board-waiting{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--bt-star);--board-dot:var(--bt-star)}.bt-board-step-count{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--bt-ink-3)}.bt-board-step-count svg{width:13px;height:13px}.bt-board-card-foot{display:flex;align-items:center;gap:8px;padding-top:3px}.bt-board-owners{display:flex;align-items:center;gap:3px;flex:none}.bt-board-owner-name{font-size:13px;margin-left:8px;color:var(--bt-ink-2)}.bt-board-time{color:var(--bt-ink-3);font-size:10px;white-space:nowrap}.bt-board-card-action{margin-left:auto;font-size:11px;padding:4px 8px;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink-2)}.bt-board-action-review{color:var(--bt-accent);background:var(--bt-tag-bg)}.bt-board-attachment{display:flex;align-items:center;font-size:10px;color:var(--bt-ink-3)}.bt-board-attachment svg{width:13px}.bt-board-empty-column{margin:22px 8px;font-size:12px;text-align:center;color:var(--bt-ink-3)}.bt-board-empty{margin:auto;text-align:center;padding:40px;color:var(--bt-ink-2)}.bt-board-error{margin:10px 24px;color:var(--bt-danger);font-size:13px}',
  '.bt-board-drawer-veil{position:absolute;inset:0;z-index:2;background:var(--bt-hover);display:flex;justify-content:flex-end}.bt-board-drawer{display:flex;flex-direction:column;width:min(540px,100%);height:100%;background:var(--bt-main);border-left:1px solid var(--bt-line-2);box-shadow:-12px 0 32px var(--bt-line);min-width:0}.bt-board-drawer-header{display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid var(--bt-line);font-size:12px;color:var(--bt-ink-2)}.bt-board-drawer-body{flex:1;overflow:auto;padding:24px}.bt-board-drawer-foot{padding:14px 24px;border-top:1px solid var(--bt-line);display:flex;justify-content:flex-end}.bt-board-eyebrow{font-size:11px;color:var(--bt-ink-3);margin:0 0 10px}.bt-board-detail-title{font-size:23px;line-height:1.4;margin:0 0 16px;font-weight:600}.bt-board-prose{margin:0;padding:16px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.7}.bt-board-muted{color:var(--bt-ink-2);font-size:12px}.bt-board-stages{display:flex;list-style:none;padding:0;margin:26px 0;gap:4px}.bt-board-stages li{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:8px;font-size:10px;line-height:1.4;text-align:center;color:var(--bt-ink-3)}.bt-board-stage-index{width:25px;height:25px;border:1px solid var(--bt-line-2);border-radius:50%;display:flex;align-items:center;justify-content:center}.bt-board-stages li[data-current=true]{color:var(--bt-accent);font-weight:600}.bt-board-stages li[data-current=true] .bt-board-stage-index{border-color:var(--bt-accent);background:var(--bt-tag-bg)}.bt-board-stages li[data-complete=true] .bt-board-stage-index{color:var(--bt-green)}.bt-board-stage-index svg{width:14px}.bt-board-decision{padding:18px;border:1px solid var(--bt-star);border-radius:12px;background:var(--bt-card);margin:0 0 24px}.bt-board-decision .bt-board-eyebrow{color:var(--bt-star)}.bt-board-decision h3{font-size:15px;margin:0 0 8px}.bt-board-decision p{font-size:12px}.bt-board-steps,.bt-board-activity{list-style:none;padding:0;margin:0}.bt-board-steps li{padding:12px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--bt-line);font-size:13px}.bt-board-steps small,.bt-board-artifact small{display:block;color:var(--bt-ink-3);font-size:11px;margin-top:3px}.bt-board-step-state{width:20px;display:flex;justify-content:center;color:var(--bt-green)}.bt-board-artifact{display:flex;align-items:center;gap:10px;padding:14px;font-size:13px}.bt-board-artifact strong{font-weight:500}.bt-board-activity li{display:flex;justify-content:space-between;gap:16px;padding:12px 14px;font-size:12px;border-bottom:1px solid var(--bt-line)}.bt-board-activity small{color:var(--bt-ink-3);white-space:nowrap}.bt-board-collaborators{border:0;padding:12px 16px;margin:0}.bt-board-collaborators legend{font-size:12px;color:var(--bt-ink-2)}.bt-board-collaborators label{display:inline-flex;align-items:center;gap:6px;margin:4px 12px 4px 0;font-size:12px}.bt-board input[type=checkbox]{accent-color:var(--bt-accent)}.bt-board-form .bt-bs-input{width:100%;box-sizing:border-box}.bt-board-form .bt-bs-area{resize:vertical;min-height:90px}.bt-board-form .bt-board-error{margin:8px 0}.bt-board-drawer .bt-set-section h3{font-size:12px;font-weight:500;color:var(--bt-ink-2)}',
  '@media(max-width:899px){.bt-board{left:0!important}.bt-board-header{padding:16px;gap:8px}.bt-board h1{font-size:17px}.bt-board-heading{gap:6px}.bt-board-heading>svg{display:none}.bt-board-header-actions{gap:6px}.bt-board-header-actions .bt-board-button{font-size:11px;padding:8px;min-height:36px}.bt-board-toolbar{padding:10px 12px 4px;flex-wrap:wrap;gap:8px}.bt-board-projects{flex-basis:100%}.bt-board-project{padding:7px 10px;font-size:12px}.bt-board-search{max-width:none;width:100%;margin:0 3px;font-size:12px}.bt-board-project-info{padding:6px 16px 12px;font-size:10px}.bt-board-columns{grid-template-columns:repeat(4,minmax(280px,82vw));padding:0 12px 16px;gap:12px;scroll-snap-type:x proximity}.bt-board-column{scroll-snap-align:start}.bt-board-drawer{width:100%;border:0}.bt-board-drawer-body{padding:20px}.bt-board-stages{margin:22px 0}.bt-board-drawer-header{padding:12px 18px}.bt-board-drawer-foot{padding-bottom:calc(14px + env(safe-area-inset-bottom))}}',
].join('\n')
