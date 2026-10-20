// Synthetic rendering data only; no shell work, deliveries or production state.
export function detailFixture(card, leadId, reviewerId) {
  const path = '/workspace/demo/releases/' + 'long-project-name-'.repeat(14) + '/receipt.json'
  const hash = '0123456789abcdef'.repeat(8)
  const raw = `读取文件并验证 JSON 字段。\n\n\`\`\`json\n${JSON.stringify({ deployment: 'demo-build', status: 'ok', sha256: hash })}\n\`\`\`\n\n文件：${path}\n\n断言输出：BOARD_RELEASE_OK。退出码：0。\n\n` + '核对记录：仅验证此文件，未修改项目中的其他内容。'.repeat(12)
  return {
    ...card, title: '交付验收与长文本 · 合成演示', stage: 'validation', status: 'active', column: 'needs-you',
    collaboratorIds: [reviewerId], approvedPlan: 1, deliveryPlanVersion: 1,
    summary: '两个步骤已完成，等待用户验收。此卡片仅用于界面测试。',
    staffing: { summary: 'Atlas 负责实现，Sage 独立验证；主控 Bot 汇总交付。' },
    plan: '1. 在指定目录生成验收文件。\n2. 由另一位 Bot 只读验证字段并提交证据。',
    steps: [
      { id: 'build', title: '生成部署验收文件 receipt.json', status: 'done', assigneeId: leadId, stage: 'implementation', scope: path, summary: '已创建验收文件，字段与约定一致。' + '写入后回读核对内容与文件属性，保留原始证据。'.repeat(12), evidence: raw },
      { id: 'verify', title: '独立验证内容并检查结果', status: 'done', assigneeId: reviewerId, stage: 'validation', scope: '只读检查交付文件', summary: '两项字段断言通过，退出码 0。', evidence: raw },
    ],
    evidence: [
      { criterion: '交付文件字段与验收约定一致', result: 'passed', detail: 'deployment 与 status 字段匹配；只读回查通过。', reference: path },
      { criterion: '独立验证输出 BOARD_RELEASE_OK', result: 'passed', detail: raw, reference: 'https://example.invalid/checks/' + hash },
    ],
    artifacts: [{ id: 'receipt', title: '部署验收文件 · receipt.json', summary: '包含部署标识和验证状态。详细回执保留在项目目录中。', reference: path }],
    decisions: [{ id: 'review', version: 1, kind: 'acceptance', status: 'open', question: 'Accept this delivery?', recommendation: '实现与独立验证均已完成。请检查下方步骤、验证证据和交付物，然后确认验收或提出修改。', impact: '这是一张合成演示卡片，验收操作不可用。' }],
    backgroundJobs: Array.from({ length: 18 }, (_, index) => ({ id: 'bash-' + index, kind: 'bash', status: 'completed', bootId: 'demo', owner: leadId, startedAt: index })),
    deliveries: [{ id: 'recovery', botId: leadId, status: 'done', reconciled: { observations: '已核对中断前保存的进展。' + raw, references: [path] } }],
  }
}
