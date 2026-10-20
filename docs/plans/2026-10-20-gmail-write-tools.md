# Gmail 写能力（第三批）：P1 + P2 工具规格

状态：规格待 Marshal/Probe 确认后实施；底座（`_imap-write.js`、`_smtp.js`、能力开关、审批接入）由 Forge 提供。
范围：**P1 + P2**，凭证走现有应用密码（IMAP 写 + SMTP），零外部依赖。
**不做**：P3（永久删除、批量删除、发信带附件）；**永不做**：过滤器/自动转发/签名等设置类（可静默外泄整箱）。
只读版（第二批）不变。

## 1. 能力开关（连接器声明）

```js
capabilities: {
  write: { default: true,  label: 'Write mail (each action asks for approval)' },
  send:  { default: false, label: 'Full capabilities: send, reply and forward mail' },
}
```

- `write` 打开：注册 P1 与 P2 中“非发送”工具（标记已读、标签、归档、草稿、附件、移动、回收站删除）。
- `send` 打开（Full capabilities）：在上面的基础上再注册发送/回复/转发/发草稿四个工具，每个仍要审批。
- 关闭时不注册对应工具（模型看不到、调不到）；切换后按底座现有机制重挂。
- 待确认：`write` 默认值。本规格暂按 Marshal 口径“仅发送默认关”，即 `write` 默认开；若要与 Vercel actions（默认关）一致，可改成默认关。

## 2. 工具清单（P1）

| 工具 | 参数 | 批量上限 | 风险 | 审批卡（英文原文，卡片用） |
| --- | --- | --- | --- | --- |
| `gmail_mark_read` | `uids[]`、`folder?`、`read?`（默认 true；false=标未读） | 10 封/次 | 低 | **Mark 3 Gmail messages as read?** / “Only the read/unread flag changes. The messages stay where they are; nothing is sent or deleted.” |
| `gmail_label` | `uids[]`、`folder?`、`add?[]`、`remove?[]`（标签名，各 ≤5 个） | 10 封/次 | 中 | **Change labels on 3 Gmail messages?** / “Add: Work. Remove: Inbox. Only the labels named here change; nothing is sent or deleted. Gmail filters that act on labels may run afterwards.” |
| `gmail_archive` | `uids[]`、`folder?` | 10 封/次 | 中 | **Archive 3 Gmail messages?** / “They leave the inbox and stay in All Mail; nothing is deleted.” |
| `gmail_save_draft` | `to?[]`、`cc?[]`、`bcc?[]`、`subject`、`body`、`replyToUid?`（可选：作为对某封的回复草稿） | 1 封/次 | 低-中 | **Save a draft in Gmail?** / “The draft is stored in Drafts and is not sent. To: … Subject: … Preview: …” |
| `gmail_list_attachments` | `uid`、`folder?` | 1 封/次 | 中（隐私） | 只读工具，不弹审批（同 `gmail_get_message`） |
| `gmail_read_attachment` | `uid`、`folder?`、`index`、`maxChars?`（默认 8000，≤20000） | 1 封/次 | 中 | 只读工具，不弹审批；只对 text/*、csv、json、html 做文本提取，二进制不返回字节 |
| `gmail_save_attachment`（可选，P1.5） | `uid`、`folder?`、`index`、`path` | 1 封/次 | 中（落盘/恶意文件） | **Save an attachment from Gmail?** / “Writes <name> (<size>) to <path>. Files from mail can be dangerous; only open it if you trust the sender.” 依赖 DSH 文件路径策略确认 |

## 3. 工具清单（P2，默认不注册，需 `send` 能力）

| 工具 | 参数 | 批量上限 | 风险 | 审批卡（英文原文） |
| --- | --- | --- | --- | --- |
| `gmail_move` | `uids[]`、`folder?`、`target`（目标文件夹） | 10 封/次 | 中-高 | **Move 3 Gmail messages to “Receipts”?** / “They leave the current folder and appear in Receipts. Nothing is permanently deleted.” |
| `gmail_trash` | `uids[]`、`folder?` | 10 封/次 | 高 | **Move 3 Gmail messages to Trash?** / “They can be restored from Trash for 30 days. This tool never deletes permanently.” |
| `gmail_send` | `to[]`、`cc?[]`、`bcc?[]`、`subject`、`body` | 1 封/次；收件人合计 ≤20 | 高 | **Send this message as you@gmail.com?** / “To: … Cc: … Subject: … Preview: … This cannot be undone.” |
| `gmail_reply` | `uid`、`folder?`、`body`、`replyAll?` | 1 封/次；收件人合计 ≤20 | 高 | **Reply to “<subject>”?** / “To: … (reply all: yes/no) Preview: … This cannot be undone.” |
| `gmail_forward` | `uid`、`folder?`、`to[]`、`body?` | 1 封/次；收件人合计 ≤20 | 高 | **Forward “<subject>” to …?** / “This cannot be undone.” |
| `gmail_send_draft` | `draftUid`（Drafts 里的 uid） | 1 封/次 | 高 | **Send the saved draft “<subject>”?** / “To: … Preview: … This cannot be undone.” |

P2 的“发送/回复/转发/发草稿”四个工具整体受 `send` 能力开关控制（Marshal：默认关，开 Full capabilities 才注册）。
**删除只做进回收站**：没有永久删除工具、没有清空回收站、没有批量删除；`gmail_trash` 的批量上限同样 10。

## 4. 全局约束

- **审批先于任何上游命令**：deny / cancel / timeout → 该次调用 0 条 IMAP/SMTP 命令；单测逐条断言。
- **批量上限 10 封/次**，超过直接报错并提示分批；标签名 ≤5 个、≤200 字符；正文 ≤100 KB；单封收件人合计 ≤20。
- **错误**：不重试发送（避免重复发信）；失败返回人话（SMTP 5xx/4xx、IMAP NO/BAD、配额），不打印密码/正文。
- **不发正文进日志/审计**：审批卡展示的正文预览 ≤500 字符；日志只记工具名、uid 数、目标文件夹、收件人数量。
- **Gmail IMAP 写语义由 `_imap-write.js` 保证**（共享层）：
  - 已读/未读：`UID STORE ±FLAGS (\Seen)`；
  - 标签/归档：`UID STORE ±X-GM-LABELS`（Gmail 扩展；归档=去掉 `\Inbox`）；
  - 移动/回收站：`UID COPY` 到目标（回收站=`[Gmail]/Trash`）+ `UID EXPUNGE` 源文件夹；**绝不允许裸 EXPUNGE 永久删除**；
  - 草稿：`APPEND "[Gmail]/Drafts" (...)`（需要 literal 与 continuation 支持）。
- **SMTP**：`smtp.gmail.com:465`（TLS），AUTH 用应用密码；From = `GMAIL_ADDRESS`；回复带 `In-Reply-To` / `References`，主题按 `Re:` 规则；纯文本正文（HTML 可选，v1 不做）。
- **凭证**：沿用 `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD` 两字段；写能力不需要新凭证。应用密码=整箱权限，写能力只是把“能发/能改”真正用起来，风险提示沿用只读版文档。

## 5. 依赖 Forge 的底座改动（与 Marshal 已转清单对齐）

1. **能力开关**：连接器定义 `capabilities`（name/default/label）+ 切换端点（或复用 toolbox 开关语义），状态进 `state.connectors`，挂载时传给模块。
2. **审批接入**：custom/imap 模块的写工具能在执行前走现有插件审批卡（框架把 `approve({ tool, args, preview })` 或等价钩子传给 `mount`；deny/cancel/timeout 直接失败且不发命令）。
3. **`_imap-write.js`**（共享新文件）：写会话（SELECT 写模式、UID STORE/COPY/MOVE/EXPUNGE、APPEND literal + continuation、UIDPLUS），Gmail 安全语义（移动/回收站=COPY+EXPUNGE，无裸 EXPUNGE 暴露）。
4. **`_smtp.js`**（共享新文件，Gmail/QQ 共用）：TLS SMTP、AUTH、MIME 组装、大小上限、线程头。
5. **附件读取**：BODYSTRUCTURE 解析 + part 解码（文本提取）；`gmail_save_attachment` 的路径/落盘策略需 DSH 文件权限确认。

## 6. 验收硬要求（对齐 Probe checklist §13.8 / W7.1–W7.10）

实现时必须逐条满足，Probe 会按矩阵（工具 × 审批卡 × 执行 × 状态一致）验收：

- **能力关闭 = 工具不存在**：`write`/`send` 关时对应工具不注册（注册表里查不到），不是“注册后禁用”。
- **拒绝零副作用**：deny / dismiss / timeout / cancel 时，IMAP 写命令 **0 条**、SMTP **0 连接**；审批不可用时给人话错误，不发命令。
- **允许后只出现声明命令**：每次允许后的单次调用只出现该工具声明的命令——已读/标签/归档路径不得出现 EXPUNGE/MOVE/COPY/DELETE；`gmail_trash` 只允许 `COPY 到 [Gmail]/Trash + UID EXPUNGE 源`，不得出现裸 EXPUNGE；`gmail_move` 只能是 `COPY 到目标 + UID EXPUNGE 源`。
- **反绕过**：直接调用工具、经元工具（toolbox/search-call 一类）旁路、别名/大小写变体、复用旧审批 questionId、模型自批——全部必须失败。
- **参数越权/注入**：未知字段、uid 超过批量上限、header 注入（`\r\n`）、目标文件夹/标签名注入，全部在发命令前拒绝。
- **审批不可复用**：同一会话连续两次写，第二次必须重新弹卡；不缓存“上次允许”。
- **`save_attachment` 路径策略未定前不注册**（不给模型可见工具）。
- **`read_attachment`**：≤20,000 字符并带截断说明；二进制不返回字节。
- **发送类卡面**：必须展示收件人/主题/正文预览，并写“永久不可撤回”；收件人合计 ≤20、正文 ≤100KB。
- **回收站文案**：`gmail_trash` 写“30 天可恢复”；永久删除/批量删除不接入（注册表断言不存在）。
- **不自动重试**：写失败/超时不重试（避免重复发信或重复写入），只返回人话错误。
- **草稿去重**：同一内容重复保存不得静默产生重复草稿——同会话内按内容指纹返回已存在草稿的 uid（或明确报“已存在”），不重复 APPEND。

## 7. 单测计划（实现时随代码交付）

- 每个写工具：allow → 发出的 IMAP/SMTP 命令正确；deny/cancel/timeout → 0 命令。
- 批量 >10 拒绝；uid 非整数/注入拒绝；folder/标签名 CRLF 拒绝。
- `send` 能力关：发送类工具不在注册表；开：注册且仍需审批。
- 工具清单里**不存在**永久删除/批量删除/设置类工具（断言注册表）。
- 发送类审批内容含收件人/主题/预览；删除类文案含“30 天可恢复”。
- 密码/正文不进错误文本与日志。
