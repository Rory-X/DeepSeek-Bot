# Neon 连接器：只读 OAuth MCP

- 日期：2026-10-20
- 相关：`dsbot-research/connectors-next.md` §11.2（OAuth 元数据核实）；`docs/plans/2026-10-20-connector-modules.md`（一连接器一模块）

## 为什么

Neon 是托管 Postgres，官方提供远程 MCP 服务（`https://mcp.neon.tech/mcp`）：支持动态客户端注册 + PKCE 公开客户端，scope 只有 `read` / `write`，并且服务端有 `?readonly=true` 只读模式。数据库属于“读错不行、写错更不行”的服务，所以这个连接器只接读取面，写操作以后再说。

## 已定的行为

- **授权**：浏览器里一次 OAuth（用户在连接器卡片点 Connect）。只请求 `read` scope；MCP 地址带 `readonly=true` 和五个工具类别（`projects`、`branches`、`endpoints`、`schema`、`querying`）。这是一份在授权页确认的固定 grant，之后改 URL 不会放宽，刷新 token 也不会。
- **只读是两层**：
  1. 服务端 `readonly=true` 会丢掉所有写工具，`run_sql` 的每条 SQL 在 `READ ONLY` 事务里执行，`run_sql_transaction` 与 `get_connection_string` 不可用；
  2. DS Bot 只注册白名单里的 16 个工具，服务器即便列出别的也不会进模型上下文。
- **可选的更硬边界**：在 profile 里把该连接器的 `url` 换成带 `projectId` / `roleName` 的地址，就能把 grant 收到一个项目、并以指定的 Postgres 只读角色执行 SQL，由数据库自身决定能读什么。`configure()` 会保留这些参数并强制 `readonly=true`。
- **工具清单（16 个，全部来自 Neon 的 read-only 工具清单）**：`list_organizations`、`list_projects`、`describe_project`、`list_branches`、`describe_branch`、`get_default_branch`、`list_postgres_databases`、`list_postgres_roles`、`list_postgres_endpoints`、`list_branch_computes`、`get_database_tables`、`describe_table_schema`、`run_sql`、`explain_sql_statement`、`list_slow_queries`、`inspect_database`。迁移、建/删分支与项目、连接串、凭据、配额类工具都不注册。
- **失败处理**：401/403 先刷新一次再重试；刷新被 `invalid_grant` 拒绝时删掉 grant，卡片回到 Reconnect。超时报“连不上 MCP 服务器”，不会被误报成授权失效。
- **卡片**：`account` 用组织列表（Neon 没有 whoami 工具）；`card` 里的 `glyph`/`about`/`docsUrl`/`readOnlyNote`/`consent` 由客户端通用层渲染。

## 风险

- `run_sql` 是任意 SQL。只读模式保证事务只读，但授权可见的数据仍能被读出来；要更窄就固定 `projectId` 并把 `roleName` 指向只有必要 `SELECT` 的角色。
- 只读是服务端保证 + 工具白名单，不是我们解析 SQL 判断读写。
- 如果集成时不调用模块的 `configure()`，profile 覆盖 `url` 有可能把 `readonly=true` 丢掉；这是唯一需要在框架侧兜住的地方。
- Neon 自己建议 MCP 用于开发/IDE 场景；生产查询仍建议使用只读角色的连接。

## 集成点

- `connectors.js` 合并 profile override 之后，调用模块的 named export `configure(options)`，用返回值替换该连接器的 options（保住只读、scope、白名单）。
- `connectorsView()` 把定义里的 `card` 字段透传到视图行；客户端据此画 glyph、只读说明与授权前同意文案。不需要 actions / toolbox 字段。

## 验证

`ds-bot/test/neon.test.js`：10 个用例，全部 mock fetch —— 只读声明与白名单、配置覆盖不能关只读、挂载只注册白名单且 `run_sql` 可用、401 刷新一次后重试、403 上报、刷新失败要求重连并删除 grant、超时、只读事务报错、授权 URL 只带 `read` 与只读地址、组织名作为账号。

## 访问级别（第三批）

单行 `neon`，两个级别：**只读（默认、推荐）** / **完整能力（可写）**。Neon 的 grant 在授权时把 `readonly`/`category`/`projectId`/`roleName` 固定死，所以**切换级别 = 断开重连、重新授权**。

- **只读**：`?readonly=true` + 5 个 category + scope `read`；工具面 = 16 个只读工具。
- **完整能力**：不带 `readonly`，`category=branches&querying&snapshots`，必填 `projectId`/`roleName`，scope `read write`；工具面 = 16 个只读工具 + 3 个只在写级别出现的写工具（`create_branch`、`create_snapshot`、`delete_branch`），共 **19 个不同工具名**——`run_sql` 在两级共用同一个工具，写级别下同一调用改走审批卡。每个写走审批卡；删分支卡显示分支标识 +「数据一起删除，不可恢复」，`run_sql` 卡显示角色 + SQL 前 200 字。
- **设置**：`projectId`、`roleName`。写级别两项必填，只读级别可只填 `projectId`（只收窄）；缺项时行保持 off 并给原因，不发起授权。
- **state**：`connectors.neon.settings` 在断开后保留；`level` 记录当前级别；老 grant 无 level 时按 scopes 推断（含写 scope → write）。

## 待框架补齐（第三批依赖）

- **按级别注册工具**：模块的 `toolsOf({ level })` 与按参数审批的 `actionApproval` 需要框架 P1（级别门控 + 审批卡带参数）。
- **挂载地址**：模块 `authorize()` 在写级别返回不带 `readonly` 的地址，但现有挂载仍用 `connector.url`；需要框架在模块带 `authorize` 时用 **grant 的 resource** 挂载，否则写 grant 会挂在只读地址上（`tools/list` 仍是只读清单，写工具永远不出现）。
