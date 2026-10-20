# Gmail 连接器自查证据（2026-10-20）

分支 `feat/connector-gmail`，worktree `conn-gmailwt`。
路线：B（IMAP 只读 + 应用专用密码），用户 07:07 选择、Marshal 锁定；A（官方 MCP + OAuth）只作为后续升级写入设计文档，不进第一版。
架构（按 Chief/Marshal 07:5x 决定）：**共享 IMAP 核心归 QQ 邮箱线（Pigeon）**，已由 Forge 收进底座批次；Gmail 只做配置 + 适配。

## 1. 分支与提交

- 分支：`feat/connector-gmail`，基于**冻结底座** `integ/connector-base-next` @ `100f603`（`imap` 模式、多字段凭据、`verify`/`mount` 钩子、模块注册表、共享 IMAP 核心 + `gmailQuery`）。
- 共享核心 `connectors/_imap.js` 是 Pigeon 762 行版（Pigeon 758 行 + Forge 的 `gmailQuery` 扩展），md5 `422fbafc3dcc09a7192200a67078cfba`；**本分支不带副本**，`gmail.js` 直接 import 底座这份。
- 本线实际维护的文件只有 `gmail.js`（约 80 行）+ `test/gmail.test.js` + 两份文档。

## 2. 改动范围（相对底座 `4bd6cc7`）

```
 docs/plans/2026-10-20-gmail-connector.md          | 设计/路线
 docs/plans/2026-10-20-gmail-connector-evidence.md | 本文件
 ds-bot/src/host/connectors/gmail.js               | 约 80 行
 ds-bot/test/gmail.test.js                         | 约 420 行
```

没有修改任何共享文件：`connectors.js`、`connector-setup.js`、`registry.js`、`src/client/**`、i18n/styles、`package.json`/lockfile 均未动。新增第三方依赖：无。

## 3. 单测

`test/gmail.test.js`：假 IMAP 服务器跑在内存 socket 上（不连真网），14 条：

```
node --import ./test/harness-resolve.mjs --test test/gmail.test.js
# tests 14  pass 14  fail 0
```

覆盖点：
- 模块形状：`id/displayName/mode='imap'/accountField='account'/readOnly/glyph/docsUrl`，无 `oauth`、无 `actionTools`。
- 两个命名凭据 `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD`；缺字段在保存前就拒绝（不建连接）。
- 基座 registry 真加载 `gmail.js`：`credentialFields` 名称/标签、`connectValues` 两字段映射、旧单串 token 不能填两字段。
- `signIn`：LOGIN + EXAMINE INBOX 只读校验后立即断开；拒绝的凭据只给人话，错误里不含应用密码。
- 挂载：从两份已存凭据（地址 + 密码）登录，四个工具名正确，输出不回显密码。
- 四个工具端到端：列文件夹（含 `[Gmail]/All Mail`）、搜索（断言 `UID SEARCH UNSEEN FROM "boss" SINCE 01-Oct-2026`）、列最新邮件（解码发件人/日期/主题）、读单封（`BODY.PEEK[HEADER.FIELDS ...]` + `BODY.PEEK[TEXT]`，跨包分片）。
- **Gmail 搜索语法**：`gmail_search` 的 schema 有 `query`（描述为 Gmail search syntax）；`query: 'from:boss has:attachment newer_than:7d'` + `unseen` 实际发出 `UID SEARCH UNSEEN X-GM-RAW "from:boss has:attachment newer_than:7d"`，与标准键 AND。
- **只读断言**：跑完全部工具后，逐条检查写入 socket 的命令，写命令（SELECT/STORE/EXPUNGE/APPEND/COPY/MOVE/DELETE/RENAME/SUBSCRIBE/CREATE/CLOSE/CHECK）一条都没有；所有 FETCH 都含 `BODY.PEEK[`。
- 工具错误经 `redact` 后才给模型，错误里不含密码。

## 4. 全量门槛（本分支）

```
npm test
# tests 861
# pass 854
# fail 7
# duration 74s
```

7 条失败全部在 `test/connectors.test.js`，**唯一原因**是这些断言 deep-equal 整张连接器列表，而本分支多了一个 `gmail` 行。已逐条对比 diff：实际值只比期望值多一个完整的 gmail 条目（字段与卡片元数据都正确），没有任何行为断言失败。这是底座测试对「模块化连接器」的假设缺口——每条连接器线加自己的模块都会命中同样 7 条（connecting GitHub / deleting GITHUB_TOKEN / connecting Vercel / deleting VERCEL_TOKEN / each connector mounts and unmounts / github:false / vercel:false）。

底座单独跑 `test/connectors.test.js` 是绿的（Forge 报 847/847）；本分支的 7 条失败随模块新增而来，不随代码质量而来。已在冻结底座上跑过：`gmail.js` 新增不会触发任何挂载/卸载/凭据行为断言失败。建议 Forge 在底座把这几处改成按 id 过滤/包含断言（一次性解决六条线），本线不改共享测试文件。

```
node scripts/build-client.mjs --check   # 通过（未改客户端）
npm run lint                            # 0 error / 15 warnings（均为底座既有代码；gmail.js、gmail.test.js 无告警）
```

## 5. 只读证据（静态）

共享核心 `_imap.js` 只发送：`LOGIN / LIST / EXAMINE / UID SEARCH / UID FETCH / ID / LOGOUT`；没有 SELECT、STORE、APPEND、COPY、MOVE、EXPUNGE 的实现。只读三道：命令白名单 + `EXAMINE` 只读选中 + `BODY.PEEK` 不置 `\Seen`。单测第“every command this connector writes is a read command”条逐条断言实际发出的报文。

## 6. 凭据处理

- secret 名：`GMAIL_ADDRESS`（非秘密，卡片字段、state 显示为 account）、`GMAIL_APP_PASSWORD`（秘密，只进 DSH 凭据库）。
- 连接校验：IMAP `LOGIN` over TLS `imap.gmail.com:993` + `EXAMINE INBOX`，随后立即断开。
- `verify` 只写 `{ account: 邮箱 }`；工具错误经 `redact` 且 300 字符截断；单测断言错误文本不含密码。

## 7. UI 与截图

本分支**没有客户端改动**：卡片的 glyph/about/docsUrl/两字段表单由 Prism 的 `src/client/**` 分支实现，宿主侧已经通过底座 view 提供 `credentials`（两字段）与卡片元数据。因此本分支没有 390/1280 界面截图可拍；真机截图要等 Prism 卡片 + 底座合并后由 Probe 在测试机上拍。

## 8. 已知边界 / 未验项

- **Gmail 搜索语法**：底座已支持 `gmailQuery` 开关（Forge `100f603`），本模块传 `gmailQuery: true`，`gmail_search` 因此有 `query` 参数并发出 `X-GM-RAW "…"`；QQ 线不传该开关、行为不变。真机待验 Gmail 服务端接受该扩展。
- 没用真实 Gmail 账号 + 真应用密码跑过（等用户提供密钥后由 Probe 黑盒验收）；真实 IMAP 行为、modified UTF-7 文件夹名待真机确认。
- 应用密码权限等于**整个邮箱**；只读是共享核心的代码保证，不是 Google 服务端 scope。Advanced Protection / Workspace 管理员禁用 IMAP 或应用密码时不可用。
- v1 不下载附件、不发信、不标已读、不移动/删除（共享核心没有这些命令）。
- 重启保持：两份 secret 在 DSH 凭据库、account 在 state、重启由框架重挂；未真机验证。
- 出站 host：仅 `imap.gmail.com:993`（TLS）；profile 可按其它连接器同样规则覆盖 host/port（管理员配置级，模型不可改）。
