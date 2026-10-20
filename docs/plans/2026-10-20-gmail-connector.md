# Gmail 连接器：路线评估与只读 IMAP 方案

状态：路线 B 已由用户选择、Marshal 正式锁定；实现完成，等待底座合并。
日期：2026-10-20。作者：Courier。分支 `feat/connector-gmail`（worktree `conn-gmailwt`）。

## 1. 结论

**推荐 B：IMAP 只读 + 应用专用密码，先上线；A（谷歌官方远程 MCP）留作后续升级，不作为第一版。**
用户在 07:07 直接选择「直接开做 IMAP 只读」，Marshal 复核后锁定 B；A 只进设计文档，不进第一版。

一句话理由：B 是**当天用户就能用**的路（用户只需开两步验证 + 生成一个应用密码），A 的成本大头不在代码而在**外部资格与审核**（Developer Preview 资格 + 敏感 scope 验证），不可控且慢。

## 2. 两条路对比

| | A：谷歌官方远程 MCP | B：IMAP 只读（本方案） |
| --- | --- | --- |
| 端点 | `https://gmailmcp.googleapis.com/mcp/v1`（Streamable HTTP，23 工具，只读 6 个） | `imap.gmail.com:993`（TLS） |
| 宿主框架 | 复用现有 `read-tools`（白名单只读 6 工具） | 底座已有 `imap` 模式 + `verify`/`mount` 钩子（现网 `d51b7d8`） |
| 用户要做什么 | ① 有 Google Workspace Developer Preview 资格 ② 建 Google Cloud 项目 ③ 启用 Gmail API 与 Gmail MCP ④ 同意屏幕 + OAuth 客户端（Web，预注册 redirect URI）⑤ 发布/验证 `gmail.readonly`（敏感 scope） | ① 开两步验证 ② 生成应用专用密码 ③ 连接器卡片填两个字段：Gmail 地址 + 应用密码 |
| 代码工作量 | 3–5 天（OAuth 客户端/回调/刷新已有框架，可复用）+ 审核等待 | 1.5–2 天（共享 IMAP 核心由 QQ 邮箱线提供并已进底座；Gmail 模块是配置 + 适配，几小时；单测 0.5 天） |
| 上线门槛 | 外部：Preview 资格、`gmail.readonly` 验证；Testing 状态 refresh token **7 天过期** | 无外部审核；随时可上 |
| 只读保证 | **服务端 scopes**（`gmail.readonly`），最硬 | **客户端构造保证**：共享核心只有 EXAMINE/LIST/UID SEARCH/UID FETCH，正文只用 BODY.PEEK |
| 凭证权限 | 仅 `gmail.readonly` | 应用密码**等于整个邮箱**（IMAP 可读全部；拿去配 SMTP 还能发信，虽然本连接器没有发信代码） |
| 风险 | Preview 资格拿不到 → 整条线卡死；审核周期不可控；同意屏幕测试用户上限 100 | Google 账号策略可关掉应用密码（关闭两步验证/Advanced Protection/Workspace 管理员禁用）；长期凭证需用户手动撤销；无服务端 scope 兜底 |
| 可逆性 | 用户在 Google 账号撤销授权；删 OAuth 客户端 | 用户在 Google 账号删除该应用专用密码 → 立即失效；删连接器 secret 同样立即失效 |
| 维护 | 跟官方 MCP 版本与 scope 变化 | 跟 IMAP（稳定 20+ 年）与共享核心的接口 |

## 3. 为什么先 B

1. **用户步骤少且不依赖外部审批**：两步验证 + 应用密码，5 分钟。
2. **工作量与风险都在自己手里**：没有 Preview 资格、没有 Google 审核排队。
3. **只读目标能达成**：连接器只注册 4 个读工具，底层共享核心的写命令根本不存在，单测逐条断言实际发出的命令。
4. **A 的收益主要是“服务端 scope 兜底”和“统一 MCP 工具形态”**，属于产品化收益，不是当下“能读邮件”的阻塞点。

**B 的诚实边界**（需要让用户知道）：
- 应用密码是**整邮箱凭证**，不是只读 scope。泄露的后果比 OAuth `gmail.readonly` 令牌大，必须按最高等级密钥处理（只进 DSH 凭据库，不进日志、不进 shell、不进聊天）。
- “只读”由共享核心的代码保证，不是 Google 保证。
- 若账号开启 Advanced Protection 或 Workspace 管理员关闭了 IMAP/应用密码，此路不可用，只能回 A。

## 4. B 的实现设计

### 4.1 文件与归属（不碰共享文件）

- `ds-bot/src/host/connectors/_imap.js`（**共享核心，归 QQ 邮箱线 Pigeon，已由 Forge 收进底座并冻结**）：只读 IMAP 客户端 + 4 个工具构造器 + MIME/头部解析 + Gmail 搜索开关。**本分支不带副本**，`gmail.js` 直接 import 底座这份（762 行，md5 `422fbafc3dcc09a7192200a67078cfba`）。
- `ds-bot/src/host/connectors/gmail.js`（本线唯一实现文件，约 90 行）：Gmail 的 host/凭据/卡片元数据 + `verify`/`mount` 适配，不重复实现协议。
- `ds-bot/test/gmail.test.js`：Gmail 接线级单测（假 IMAP socket）。
- 底座（现网 `d51b7d8`，第一批连接器框架已上线）提供：`imap` 模式、`credentialFields`/`connectValues` 多字段凭据、`verifyConnector` 与 `mountConnectorTools` 钩子、connector 模块注册表、共享 IMAP 核心（Pigeon 版 + `gmailQuery`）。

### 4.2 凭据（两个命名凭据，登录时拆开保存）

- `GMAIL_ADDRESS`：Gmail 地址，非秘密，state 里显示为 `account`。
- `GMAIL_APP_PASSWORD`：16 位应用专用密码，进 DSH 凭据库，只在宿主侧 IMAP LOGIN 使用。
- 卡片是多字段表单（`credentials: [{name,label}, ...]`），不再使用「邮箱:密码」单串。

### 4.3 只读保证（由共享核心提供，单测逐条验证）

1. **代码里没有写命令**：只发送 `LOGIN / LIST / EXAMINE / UID SEARCH / UID FETCH / ID / LOGOUT`；没有 SELECT、STORE、APPEND、COPY、MOVE、EXPUNGE。
2. **EXAMINE**：邮箱以只读方式选中。
3. **BODY.PEEK**：取正文/头部只用 BODY.PEEK，不设置 `\Seen`。

### 4.4 四个工具（共享核心按 `<id>` 生成）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `gmail_list_folders` | 列文件夹（IMAP mailbox） | 无 |
| `gmail_search` | 搜索并返回最新 N 个 UID | `folder`、`unseen`、`from`、`subject`、`since`、`before`、`limit` |
| `gmail_list_messages` | 列最新邮件的发件人/日期/主题 | `folder`、`unseen`、`newest` |
| `gmail_get_message` | 按 UID 读一封：头 + 纯文本正文 | `uid`、`folder` |

### 4.5 Gmail 特有能力的现状与缺口

- 共享核心的搜索支持标准 IMAP SEARCH（UNSEEN/FROM/SUBJECT/SINCE/BEFORE）；Gmail 自己的搜索语法通过底座新增的可选开关 `gmailQuery` 提供：`gmail.js` 传 `gmailQuery: true` 后，`gmail_search` 多一个 `query` 参数（`is:unread`、`has:attachment`、`newer_than:7d` 等 Gmail 语法），发送为 `X-GM-RAW "…"` 并与标准键 AND。QQ 邮箱不传该开关，行为不变。
- 文件夹名：共享核心已处理 modified UTF-7，中文文件夹可读。
- 解析：RFC 2047 编码头、quoted-printable/base64、multipart、GBK 等 charset 由共享核心处理。

## 5. 用户操作清单（B，逐步）

1. 打开 Google 账号 → 安全性 → 打开 **两步验证**（必须）。
2. 同一页面进入 **应用专用密码**（https://myaccount.google.com/apppasswords），新建一个，名字随意（如 `DS Bot`），复制 16 位密码。
3. DS Bot 设置 → 连接器 → Gmail → 连接：
   - `Gmail address`：你的邮箱地址（例如 `you@gmail.com`）
   - `App password`：刚复制的 16 位密码（空格可以保留或去掉）
4. 点 Connect。显示 `Connected as you@gmail.com` 即成功，工具出现在所有 Bot 的工具列表里。
5. 停用：Google 账号里删除这个应用专用密码（立即失效），并在连接器卡片断开。

> 密钥只进连接器卡片 → DSH 凭据库；不要贴在聊天/文档/命令行里。

## 6. 测试与验收

- `npm test`：`test/gmail.test.js` 14 条（假 IMAP socket，Gmail 接线 + 只读命令断言 + 两字段凭据 + Gmail 搜索语法 + 卡片字段映射）；现网 `d51b7d8` 上全量 981 条 979 pass / 0 fail / 2 skipped。
- `node scripts/build-client.mjs --check`：不改客户端，应通过。
- `npm run lint`：oxlint。
- 真机验收（需要用户密钥后）：由 Probe 做黑盒验收，用户密钥走卡片。
- 底座合并后的集成点：registry 真加载 `gmail.js`、两字段卡片映射、verify/mount 走底座钩子——单测已按底座契约覆盖。

## 7. 若以后升级 A

- 触发条件：产品化多用户、需要服务端 scope 兜底、或用户拿不到/不愿用应用密码。
- 复用：现有 `oauth` 流程 + `read-tools` 模式 + 6 个只读工具白名单（`search_threads/get_thread/get_message/list_labels/list_drafts/get_draft`）。
- 迁移成本：连接器定义换 `mode: 'oauth-mcp'`，用户在新卡片走一次授权；B 的 4 个工具名可保留映射。
- 卡点要提前确认：Developer Preview 资格、`gmail.readonly` 审核、Testing 状态 refresh token 7 天过期。

## 8. 未验证 / 待验证

- Gmail 真实账号上的 IMAP 行为只按协议与官方文档实现，尚未用真应用密码跑过（等用户提供）。
- `X-GM-RAW`/Gmail 搜索语法：底座已支持该开关，假服务器已断言发出的报文；真机验收时确认 Gmail 服务端接受 `X-GM-RAW` 与 `X-GM-EXT-1` 能力。
- Gmail 非 ASCII 文件夹名的 modified UTF-7 由共享核心实现，未在真账号验证。
- Google 对应用密码的长期策略（例如逐步收紧）未验证，属外部风险。
- 应用密码权限等于整邮箱，**不建议**把这个连接器开放给不受信任的会话/群聊场景（只读边界的责任在我们代码）。
