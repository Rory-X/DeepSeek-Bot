import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { Card } from './bot-settings.js'
import { BotAvatar } from './mark.js'
import { MarkdownText } from './dsh-primitives.js'
import { CheckIcon, PaperclipIcon, ChevronRightIcon } from './icons.js'
import { relativeShort } from './text.js'
import { t } from './i18n.js'
import { boardExcerpt, splitBackgroundJobs } from './board-detail-model.js'

export function BoardText({ text = '', compact = true }) {
  const [expanded, setExpanded] = useState(false)
  const preview = compact ? boardExcerpt(text) : null
  if (!text) return null
  return h('div', { className: 'bt-board-text' },
    h(MarkdownText, { text: preview && !expanded ? preview : text, variant: 'compact', labels: { code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') } }),
    preview ? h('button', { type: 'button', className: 'bt-more', 'aria-expanded': expanded, onClick: () => setExpanded(value => !value) }, t(expanded ? 'Show less' : 'Read full text')) : null)
}

export function BoardDisclosure({ title, count, children, defaultOpen = false, className = '' }) {
  return h('details', { className: 'bt-board-disclosure ' + className, open: defaultOpen || undefined },
    h('summary', null, h(ChevronRightIcon), h('span', null, title), count === undefined ? null : h('span', { className: 'bt-board-section-count' }, count)),
    h('div', { className: 'bt-board-disclosure-body' }, children))
}

const STATES = {
  done: 'Done', running: 'Working', blocked: 'Blocked', paused: 'Paused', cancelled: 'Cancelled', queued: 'Queued',
  passed: 'Passed', failed: 'Failed', 'not-run': 'Not run', stopping: 'Stopping…', killed: 'Stopped', completed: 'Finished',
  unknown: 'Needs verification after restart', 'confirmed-stopped': 'Shutdown verified by user',
}
function Status({ value }) {
  return h('span', { className: 'bt-board-status', 'data-state': value }, ['done', 'passed'].includes(value) ? h(CheckIcon) : null, t(STATES[value] ?? value))
}

export function ArtifactReference({ value }) {
  return value ? h('div', { className: 'bt-board-source' },
    h('code', { className: 'bt-board-reference' }, value),
    /^https?:\/\//i.test(value) ? h('a', { href: value, target: '_blank', rel: 'noopener noreferrer', className: 'bt-more' }, t('Open source')) : null) : null
}

export function ExecutionSteps({ card, roster }) {
  const steps = card.steps ?? []
  return h(Card, { title: t('Execution steps') }, steps.length
    ? h('div', null,
      h('p', { className: 'bt-board-section-note' }, t('{done} of {total} steps', { done: steps.filter(step => step.status === 'done').length, total: steps.length })),
      h('ol', { className: 'bt-board-step-list' }, steps.map((step, index) => h('li', { key: step.id },
        h('div', { className: 'bt-board-item-heading' }, h('span', { className: 'bt-board-step-number' }, index + 1), h('strong', null, step.title), h(Status, { value: step.status })),
        h('div', { className: 'bt-board-step-owner' }, h(BotAvatar, { bot: roster.byId[step.assigneeId], size: 22, live: false }),
          h('span', null, roster.byId[step.assigneeId]?.name ?? t('Unassigned')), step.phase ? h('span', null, '· ', t(step.phase === 'validation' ? 'Validation' : 'Implementation')) : null),
        step.summary ? h(BoardText, { text: step.summary }) : null,
        step.scope || step.evidence ? h(BoardDisclosure, { title: t('Scope and evidence'), className: 'bt-board-inline-disclosure' },
          step.scope ? h('div', null, h('h4', null, t('Work scope')), h(BoardText, { text: step.scope, compact: false })) : null,
          step.evidence ? h('div', null, h('h4', null, t('Verification evidence')), h(BoardText, { text: step.evidence, compact: false })) : null) : null))))
    : h('p', { className: 'bt-board-prose bt-board-muted' }, t('The lead Bot will break down the work.')))
}

export function VerificationEvidence({ card }) {
  return (card.evidence ?? []).length ? h(Card, { title: t(card.deliveryPlanVersion && card.deliveryPlanVersion !== card.approvedPlan ? 'Evidence from an earlier delivery' : 'Verification evidence') },
    !card.collaboratorIds.length ? h('p', { className: 'bt-board-section-note' }, t('Single-Bot delivery: no independent reviewer.')) : null,
    card.evidence.map((item, index) => h('div', { key: index, className: 'bt-board-result' },
      h('div', { className: 'bt-board-item-heading' }, h('strong', null, item.criterion), h(Status, { value: item.result })),
      h(BoardText, { text: item.detail }), item.reference ? h(BoardDisclosure, { title: t('Evidence source'), className: 'bt-board-inline-disclosure' }, h(ArtifactReference, { value: item.reference })) : null))) : null
}

function DeliverablePreview({ card, item, actions }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState(null)
  const pending = useRef(null)
  useEffect(() => {
    setBusy(false); setError(''); setPreview(null)
    return () => pending.current?.abort()
  }, [card.id, item.id, item.reference])
  const open = async target => {
    pending.current?.abort()
    const controller = new AbortController(); pending.current = controller
    setBusy(true); setError('')
    try {
      const next = await call('board-artifact-preview', { id: card.id, artifactId: item.id }, controller.signal)
      if (controller.signal.aborted) return
      setPreview(next)
      if (!next.targets.length) throw new Error('This reference contains no previewable file or link.')
      const selected = target ? next.targets.find(entry => entry.value === target.value && entry.kind === target.kind) : next.targets.length === 1 ? next.targets[0] : null
      if (selected) await actions.previewBoardArtifact(next, selected, controller.signal)
      else if (target) throw new Error('This deliverable changed. Choose its current file or link.')
    } catch (failure) { if (!controller.signal.aborted) setError(failure.message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return h('div', null,
    h('div', { className: 'bt-board-preview-actions' }, h('button', { type: 'button', className: 'bt-soft bt-board-button', disabled: busy, onClick: () => open() }, h(PaperclipIcon), t(busy ? 'Opening preview…' : 'Preview deliverable'))),
    preview?.targets.length > 1 ? h('ul', { className: 'bt-board-preview-targets' }, preview.targets.map((target, index) => h('li', { key: index },
      h('button', { type: 'button', className: 'bt-soft bt-board-button', disabled: busy, title: target.value, onClick: () => open(target) }, target.label)))) : null,
    error ? h('p', { className: 'bt-board-preview-error', role: 'alert' }, t(error)) : null,
    error && preview ? preview.targets.filter(target => target.kind === 'url').map(target => h('a', { key: target.value, href: target.value, target: '_blank', rel: 'noopener noreferrer', className: 'bt-more' }, t('Open link in new tab'))) : null)
}

export function Deliverables({ card, actions }) {
  return h(Card, { title: t('Deliverables') }, (card.artifacts ?? []).length
    ? card.artifacts.map(item => h('div', { key: item.id, className: 'bt-board-result bt-board-deliverable' },
      h('div', { className: 'bt-board-item-heading' }, h(PaperclipIcon), h('strong', null, item.title)),
      item.reference && actions ? h(DeliverablePreview, { card, item, actions }) : null,
      h(BoardText, { text: item.summary }), item.reference ? h(BoardDisclosure, { title: t('File or link'), className: 'bt-board-inline-disclosure' }, h(ArtifactReference, { value: item.reference })) : null))
    : h('p', { className: 'bt-board-prose bt-board-muted' }, t('Deliverables and verification evidence will appear here.')))
}

function BackgroundJobs({ jobs }) {
  return h('ul', { className: 'bt-board-jobs' }, jobs.map((job, index) => h('li', { key: [job.bootId, job.owner, job.id, job.startedAt, index].join(':') },
    h('div', { className: 'bt-board-item-heading' }, h('span', null, job.kind, ' · ', job.id), h(Status, { value: job.status })),
    job.resolution?.evidence ? h(BoardText, { text: job.resolution.evidence }) : null)))
}

export function CurrentBackgroundTasks({ card }) {
  const { current } = splitBackgroundJobs(card.backgroundJobs)
  return current.length ? h(Card, { title: t('Background tasks') },
    h('p', { className: 'bt-board-section-note' }, t('Pause and cancel wait for background tasks to stop. Saved files are retained.')),
    h(BackgroundJobs, { jobs: current })) : null
}

export function RequirementContext({ card }) {
  return h(BoardDisclosure, { title: t('Requirement and plan'), defaultOpen: card.status === 'backlog', className: 'bt-board-context' },
    [[t('Requirement brief'), card.description || t('No description yet')], [t('Acceptance criteria'), card.acceptance || t('To be clarified with the lead Bot')],
      [t('Team assignment'), card.staffing?.summary], [t('Implementation plan'), card.plan]].filter(([, text]) => text).map(([title, text]) =>
      h('section', { key: title }, h('h4', null, title), h(BoardText, { text }))))
}

export function RequirementHistory({ card, roster }) {
  const { history } = splitBackgroundJobs(card.backgroundJobs)
  const recovery = (card.deliveries ?? []).filter(job => job.reconciled)
  const answered = (card.decisions ?? []).filter(item => item.status === 'answered')
  const submissions = (card.submissions ?? []).slice(0, -1)
  return h(BoardDisclosure, { title: t('Activity and technical history'), className: 'bt-board-history' },
    history.length ? h(BoardDisclosure, { title: t('Finished background tasks'), count: history.length }, h(BackgroundJobs, { jobs: history })) : null,
    recovery.length ? h(BoardDisclosure, { title: t('Recovery checks'), count: recovery.length }, recovery.map(job => h('div', { key: job.id, className: 'bt-board-result' },
      h('strong', null, roster.byId[job.botId]?.name ?? t('Unavailable Bot')), h(BoardText, { text: job.reconciled.observations }),
      job.reconciled.references.map((value, index) => h(ArtifactReference, { key: index, value }))))) : null,
    h(BoardDisclosure, { title: t('Activity'), count: (card.activity ?? []).length }, h('ol', { className: 'bt-board-activity' },
      [...(card.activity ?? [])].reverse().map(item => h('li', { key: item.id }, h('span', null, t(item.text), roster.byId[item.actor] ? ' · ' + roster.byId[item.actor].name : ''), h('small', null, relativeShort(item.at)))))),
    submissions.length ? h(BoardDisclosure, { title: t('Earlier deliveries'), count: submissions.length }, submissions.map(item => h('div', { key: item.id, className: 'bt-board-result' },
      h('strong', null, t('Plan version {version}', { version: item.planVersion })), h(BoardText, { text: item.summary }),
      item.evidence.map((entry, index) => h('div', { key: index }, h('strong', null, entry.criterion), h(Status, { value: entry.result }), h(BoardText, { text: entry.detail }), h(ArtifactReference, { value: entry.reference }))),
      item.artifacts.map(entry => h('div', { key: entry.id }, h('strong', null, entry.title), h(BoardText, { text: entry.summary }), h(ArtifactReference, { value: entry.reference })))))) : null,
    answered.length ? h(BoardDisclosure, { title: t('Decision history'), count: answered.length }, answered.map(item => h('div', { key: item.id, className: 'bt-board-result' },
      h('strong', null, t(item.question)), h('p', null, t(item.choice === 'approve' ? 'Approved' : item.choice === 'reject' ? 'Changes requested' : 'Answered')), h(BoardText, { text: item.answer })))) : null)
}
