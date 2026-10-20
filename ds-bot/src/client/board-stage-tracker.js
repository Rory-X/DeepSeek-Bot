import { createElement as h, useState } from 'react'
import { CheckIcon } from './icons.js'
import { stageProgress } from '../shared/board-stages.js'
import { t } from './i18n.js'

export const STAGE_TITLES = {
  confirmation: 'Requirement confirmation', clarification: 'Clarification', design: 'Solution design', implementation: 'Implementation', validation: 'Validation',
}
const STATUS_TITLES = { completed: 'Done', skipped: 'Skipped', pending: 'Not started', active: 'In progress', paused: 'Paused' }

export function StageTracker({ card }) {
  const [selected, setSelected] = useState(null)
  const stages = stageProgress(card)
  const detail = stages.find(item => item.stage === selected)
  return h('section', { className: 'bt-board-stage-tracker', 'aria-label': t('Development stages') },
    h('ol', { className: 'bt-board-stages' }, stages.map((item, index) => h('li', { key: item.stage, 'data-status': item.status },
      h('button', { type: 'button', className: 'bt-board-stage-button', 'aria-expanded': selected === item.stage,
        'aria-label': t(STAGE_TITLES[item.stage]) + ' · ' + t(STATUS_TITLES[item.status]), onClick: () => setSelected(value => value === item.stage ? null : item.stage) },
      h('span', { className: 'bt-board-stage-index', 'aria-hidden': true }, item.status === 'completed' ? h(CheckIcon) : item.status === 'skipped' ? '−' : index + 1),
      h('span', null, t(STAGE_TITLES[item.stage])), h('small', null, t(STATUS_TITLES[item.status])))))),
    detail ? h('div', { className: 'bt-board-stage-explanation', role: 'status' },
      h('strong', null, t(STAGE_TITLES[detail.stage]), ' · ', t(STATUS_TITLES[detail.status])),
      h('p', null, detail.reason ? t(detail.reason) : t(detail.status === 'pending' ? 'No completion or skip has been recorded for this stage.' : 'This stage is the current work phase.'))) : null)
}

export const STAGE_TRACKER_CSS = `
.bt-board-stages .bt-board-stage-button{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;min-width:0;padding:4px 1px;border:0;background:transparent;color:inherit;font-size:10px;line-height:1.45;text-align:center;border-radius:8px}
.bt-board-stage-button:hover,.bt-board-stage-button[aria-expanded=true]{background:var(--bt-hover)}
.bt-board-stage-button small{font-size:10px;font-weight:400}
.bt-board-stages li[data-status=active]{color:var(--bt-accent)}
.bt-board-stages li[data-status=active] .bt-board-stage-index{border-color:var(--bt-accent);background:var(--bt-tag-bg)}
.bt-board-stages li[data-status=completed] .bt-board-stage-index{color:var(--bt-green)}
.bt-board-stages li[data-status=skipped] .bt-board-stage-index{border-style:dashed;font-size:16px;color:var(--bt-ink-2)}
.bt-board-stages li[data-status=skipped] small,.bt-board-stages li[data-status=paused] small{color:var(--bt-ink-2)}
.bt-board-stage-explanation{margin:-12px 0 22px;padding:12px 14px;border-radius:8px;border:1px solid var(--bt-line);font-size:12px;overflow-wrap:anywhere;background:var(--bt-card)}
.bt-board-stage-explanation strong{font-weight:550}.bt-board-stage-explanation p{margin:6px 0 0;white-space:pre-wrap;line-height:1.6;color:var(--bt-ink-2)}
`
