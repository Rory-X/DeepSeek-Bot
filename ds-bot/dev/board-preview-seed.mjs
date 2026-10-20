// Create a real task Session, then seed only this stopped bench with preview fixtures.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../..'), home = join(root, '.dsh-test-board-preview'), port = 3121
const log = await readFile(join(home, 'web.log'), 'utf8')
const login = log.match(/http:\/\/127\.0\.0\.1:3121\/\?token=\S+/)?.[0]; assert.ok(login)
const auth = await fetch(login, { redirect: 'manual' }); assert.equal(auth.status, 303)
const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const api = async (endpoint, payload = {}) => {
  const data = await fetch(`http://127.0.0.1:${port}/api/bot`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) }).then(r => r.json())
  assert.ok(data.ok, data.error?.message); return data.value
}
const path = join(root, '.board-test-projects/board-preview'), reports = join(path, 'reports')
await mkdir(reports, { recursive: true })
await writeFile(join(reports, 'acceptance.md'), '# 交付验收报告\n\n这是隔离 bench 的合成报告。\n\n## 检查结果\n\n| 项目 | 结果 |\n| --- | --- |\n| 项目路径绑定 | 通过 |\n| Markdown 预览 | 通过 |\n\n```json\n{"status":"ok","source":"preview-bench"}\n```\n')
await writeFile(join(reports, 'result.json'), '{"status":"ok","source":"preview-bench"}\n')
await writeFile(join(reports, 'screen.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" rx="20" fill="#202124"/><text x="40" y="90" font-size="32" fill="#8ba1ff">Board preview fixture</text><rect x="40" y="130" width="160" height="170" rx="12" fill="#35373d"/><rect x="230" y="130" width="160" height="170" rx="12" fill="#35373d"/><rect x="420" y="130" width="160" height="170" rx="12" fill="#35373d"/></svg>')
await writeFile(join(reports, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>交付页面预览</h1><p>Rendered by DSH Document Preview.</p></body></html>')
let state = await api('state')
const project = await api('board-project-add', { path, title: '交付物预览 · Bench' })
const draft = await api('board-create', { projectId: project.id, requestId: 'preview-' + Date.now(), title: '交付物预览验收 · 合成演示', description: '[stage skip bench] Preview fixtures only. No file mutations.', acceptance: 'Preview files.', leadId: state.mainBotId })
await api('board-start', { id: draft.id, version: draft.version })
let card
for (let i = 0; i < 150; i++) {
  card = (await api('board-view')).cards.find(item => item.id === draft.id)
  if (card.decisions.some(item => item.status === 'open')) break
  await new Promise(resolve => setTimeout(resolve, 400))
}
assert.ok(card.roomId && card.decisions.some(item => item.status === 'open'))
const stop = spawnSync('sh', ['dev/bench.sh', 'board-preview', '3121', '8821', 'stop'], { cwd: join(root, 'ds-bot'), windowsHide: true, stdio: 'pipe' }); assert.equal(stop.status, 0)
const statePath = join(home, 'bot/state.json')
state = JSON.parse(await readFile(statePath, 'utf8'))
card = state.board.cards[card.id]
assert.ok(state.rooms[card.roomId].sessions[card.leadId])
card.status = 'paused'; card.decisions = []; card.steps = []; card.summary = '合成预览样本，不代表任务交付。'
for (const job of card.deliveries) job.status = 'finished'
card.artifacts = [
  ['markdown', '设计与验收报告', '使用 DSH 原有 Markdown 阅读、代码高亮与表格呈现。', 'reports/acceptance.md'],
  ['image', '界面截图', '合成 SVG 图片，仅用于检查图片预览。', 'reports/screen.svg'],
  ['html', '页面交付物', '使用 DSH 的安全本地 HTML 预览。', 'reports/index.html'],
  ['json', '验证结果 JSON', '在代码预览中查看结构化输出。', 'reports/result.json:1'],
  ['links', '报告与截图合集', '同一卡片中有多个文件，点击后选择预览对象。', '[验收报告](reports/acceptance.md)\n[截图](reports/screen.svg)'],
  ['web', '网页交付物', '隔离本地网页，使用 DSH Browser 标签页。', 'http://127.0.0.1:8822/'],
  ['missing', '缺失文件', '缺失时显示 DSH 原生错误。', 'reports/missing.md'],
  ['note', '提交记录说明', '只有提交号的引用保留原始信息。', 'commit demo123'],
].map(([id, title, summary, reference]) => ({ id, title, summary, reference }))
state.revision++
await writeFile(statePath, JSON.stringify(state))
await mkdir(join(root, 'shots/board-preview'), { recursive: true })
await writeFile(join(root, 'shots/board-preview/fixture.json'), JSON.stringify({ cardId: card.id, number: card.number, projectId: project.id, path }, null, 2))
console.log('Preview fixtures saved only in the stopped isolated bench')
