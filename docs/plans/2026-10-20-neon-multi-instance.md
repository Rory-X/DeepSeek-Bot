# Neon 多实例连接器 · 设计稿（维护期后下一批）

- 日期：2026-10-20
- 状态：**设计稿，未实现，不动现网**。排期由 Chief 定；另附「今晚先上第二张卡」的轻量快速路径评估（§8）。
- 相关：`docs/plans/2026-10-20-connector-neon.md`（单实例：访问级别/设置/工具面）、`docs/plans/2026-10-20-connector-modules.md`（一连接器一模块的注册表）、3b hotfix（`levelNotes`/readiness-first/旧 grant 保留）
- 目标：**每个 Neon 项目一张卡片**，各自 OAuth 授权、各自 level 与 settings；只读实例默认能看全部项目。

## 1. 实例模型

### 1.1 id 规则与唯一性

- id 语法沿用注册表：`^[a-z][a-z0-9-]{0,39}$`。
- 第一个实例固定 **`neon`**（现网已有，平滑保留）；新增实例 `neon-2`、`neon-3`…，**单调递增、删除后不复用编号**（避免旧 grant/旧状态串到新实例）。
- 唯一性三层校验：①不与 builtin id 冲突（现有规则）；②不与其它模块 id 冲突；③同一 base 模块内不得重复（`neon-2` 只能有一个）。
- id 创建后不可改（它同时是工具前缀 `<id>_<tool>`、凭据库 key、state 键、OAuth 回调 `/oauth/ds-bot/<id>`）；改名只允许改 **label**。

### 1.2 显示名 / displayName / checkPath 口径

- 卡片名优先级：实例 `settings.label`（用户自填，如「生产库」）→ 挂载后从 `list_projects`/`describe_project` 拿到的项目名（写入 `state.connectors.<id>.projectName`）→ 兜底 `Neon`（第一）/`Neon 2`（按 id 数字后缀）。
- 模块静态 `displayName` 仍是 `Neon`；**多实例的显示名由 view 行覆盖**（`connectorsView()` 每行 `name`），客户端已按行渲染。
- `checkPath`：Neon 走 OAuth，**没有 checkPath、没有静态 token 表单**；账号名用 `accountTool: list_organizations` + `accountOf`（现状）。每个实例的 `account`（组织名）独立存。未来若加 API key 模式，才需要 `checkPath=/api/v2/projects`（本批不做）。

### 1.3 一个 Bot 能看到哪些实例

- **默认全部可见**：DS Bot 的 connector 工具是挂在插件上下文上的全局工具，所有 Bot/会话共享；多实例只会多出 `<id>_*` 前缀的工具集，不做按 Bot 裁剪（与现状一致，改动最小）。
- 若将来需要“某 Bot 只准用一个项目”，那需要框架在 `ctx.tools.register` 层做按 Bot/Session 的可见性过滤（当前没有，成本高，列为后续风险项）；在 3b 之前不承诺。
- 文档口径：每个实例在卡片上明确标 `label`/项目名，提示词里也按项目区分，减少模型用错实例。

## 2. 凭据隔离

### 2.1 每个实例一份 grant

- OAuth grant key 沿用 `ds-bot/connector-<id>`：`ds-bot/connector-neon`、`ds-bot/connector-neon-2`…
- 每个实例独立 DCR client、独立 access/refresh token、独立 scope（只读 `read`；可写 `read+write`）。**禁止跨实例复用 grant**。
- 回调路由 `/oauth/ds-bot/<id>` 由框架按 id 生成，天然分离；pending attempt 也按 id 存在流内存里。

### 2.2 secret 与不串号

- Neon 没有 secret（OAuth grant 只在 DSH 凭据库，不进 state/Secrets 页/任何 shell）。
- 非机密配置（`level`、`settings.projectId/roleName/label`、`account`、`projectName`、`authorizedAt`、`needsReauth`）都进 `state.connectors.<id>`，每实例一份，互不继承。
- 不变量（写成单测）：
  1. 挂载实例 A 只允许读 `ds-bot/connector-A`，**没有任何“找不到就用别的实例”的回退**；
  2. 断开/删除实例 A 只动 A 的 grant、state 键与 pending attempt；
  3. 日志/诊断只出现 id 与工具名，不出现 token；label 可进日志（用户自填）。

### 2.3 删除实例时的凭据清理

- 顺序：卸载工具 → 清 pending attempt → 调 OAuth revoke（Neon 有 `revocation_endpoint`）→ 删凭据记录 → 删 `state.connectors.<id>` → 保存并刷新 view。
- 不可删除最后一个实例（至少保留 `neon`）。
- 删除后该 id 永不重用（见 1.1）。

## 3. 能力级别按实例

- 每实例独立 `level: 'read' | 'write'`：只读实例只注册 16 个只读工具；可写实例再加 3 个写工具（`create_branch`/`create_snapshot`/`delete_branch`），`run_sql` 两级共用，写级别共 19 个不同工具名（与单实例口径一致）。
- 每实例独立 `settings`：`projectId`、`roleName`。**只读实例 `projectId` 可空（看全部项目）**；**可写实例两项必填**（grant 锁项目、SQL 锁 Postgres 角色）。
- 切级别只影响该实例；其它实例的连接状态、授权、工具面不变。
- **沿用 3b hotfix 不变量**：
  - `readiness` 不满足时拒绝切级别，且**先 readiness 后动 state**（旧 grant 不被拿掉、已连接状态不倒）；
  - 切级别成功后旧 grant 删除、`needsReauth` 提示重新授权；
  - 已连接 OAuth 的级别切换走宿主 `connector-set-level`（不是只改前端草稿）；
  - 未保存的 settings 不解锁写级别（客户端用已保存值判断）。
- 工具审批、只读事务、永不开放清单（`get_connection_string`、realtime secret、凭据类、`delete_project` 等）都按实例沿用，不变。

## 4. 状态迁移（单实例 → 多实例）

- 现网 `state.connectors.neon`（含 grant、level、settings、account）**原样保留为默认实例**；不删键、不删 grant、不要求重新授权。
- 新实例从 `neon-2` 起；旧用户升级后看到的仍是同一个 Neon 卡，行为不变。
- 实例清单来源：`state.connectors` 里匹配 `^neon(-\d+)?$` 的键（+ 模块声明的前缀约束），不另建实例表；删除实例 = 删键。
- 迁移只发生一次：如果旧 state 里没有实例元数据，默认视为 `neon` 实例；不写新字段也不影响（view 兜底显示）。
- 回滚：删掉新实例的 state 键即可回到单实例形态；旧实例从未被改写，回滚安全。

## 5. 宿主 / 注册表 / UI

### 5.1 注册表与框架（建议的最小扩展）

1. **多实例声明**：模块可选导出 `instances: { prefix: 'neon', min: 1, max: 8 }`（或 `multiInstance: true`）；registry 校验前缀、上限、id 冲突。
2. **实例解析 hook**：`instances({ config, state }) → [{ id, label? }...]`；`install()` 组装 `options` 时按实例克隆定义（注入实例 id、显示名、`configure`），默认至少含 `neon`。
3. **view 多行**：`connectorsView()` 已输出数组；每行加 `instance: { base:'neon', id, label }` 供 UI 区分与分组。
4. **端点**：新增 `connector-create-instance`（`{ base:'neon' }`，分配下一个空闲编号，写 `state.connectors.<id>={level:'read',settings:{}}`，**不自动授权**）与 `connector-delete-instance`（`{ id }`，拒绝删最后一个，清理见 §2.3）；两者走宿主同步队列，避免与挂载并发竞争。
5. **OAuth flow**：`oauth.start(id, { level, settings })` 与回调已按 id 工作，无需改；grant/attempt/credential key 全部按实例 id（现状满足）。
6. **profile**：`rt.config.<id> = false` 隐藏实例；`url`/其它覆盖按实例生效，与现有一致。

### 5.2 客户端（390 / 1280 形态）

- **Connectors 页**：每实例一行（mark + 名称 + 状态 + Connect/Disconnect），行内展开设置面板（label、projectId、roleName、level、保存）。
- **新增实例**：卡片列表底部「Add a Neon project」按钮；点击后不弹授权，只新增一张 off 卡（label 默认 `Neon 2`），用户自己去授权。
- **重命名**：实例设置里的 `label` 输入，保存即改卡片名；不影响工具名/id。
- **删除**：行内菜单「Remove this instance」→ 二次确认（写清会断开并删除授权）→ 执行；最后一个实例按钮禁用。
- **390**：单列、行高紧凑；名称过长省略号 + title；设置面板全宽；新增/删除在列表底部，不放进行内 hover 菜单（触屏没有 hover）。
- **1280**：设置面板两列（label/projectId 一行、roleName/level 一行），实例多时面板内滚动。
- 错误态：某实例授权失败/需要重授权只影响该行（红字 + Connect again），其它行不受影响。

## 6. 失败与清理

- **断开实例**：只清该实例 grant/attempt、卸载该实例工具、`state` 保留 settings/level（供下次连接复用），不触碰其它实例。
- **删除实例**：清理顺序见 §2.3；并发保护：create/delete/connect/disconnect/set-level 都排进宿主同步队列，一个实例的删除不会与它的挂载/授权并发；UI 在请求期间禁用该行按钮。
- **授权回收**：删除/断开都 best-effort 调 revoke（失败只记 warn，不阻断本地清理）。
- **审计**：diagnostics 记录实例 id + 工具名 + 结果（`connector-deleted`/`connector-disconnected`/`approval outcome`），不记 token/参数原文；删除记一条带 label 的审计行。
- **上限**：软上限 8 个实例；超过时 UI 提示并拒绝 create（防止 DCR/上下文膨胀）。
- **失败态**：本地 mock/真实服务不可达时，只有该实例行 error；重启后按各实例 grant 独立恢复。

## 7. 工作量拆解（框架 vs 每实例配置）

| 批次 | 范围 | 内容 | 估时 | 验收点 |
| --- | --- | --- | --- | --- |
| **Batch 0（快速路径，§8）** | — | **用户已决定跳过，不做**（不新增 `neon-2.js`、不动代码） | — | — |
| **Batch 1** | 框架 + 模块 | **第一步：拆 `neon.js` 模块级可变状态（`baseAddress`/`mountedSettings`），改为每实例一份**；再做多实例声明/解析 hook、create/delete 端点、id 冲突规则、view `instance` 字段、Neon 实例声明、迁移 | **3–4 天** | 动态增删实例；老 `neon` 不掉线不重授权；不串号单测；删除清 grant |
| **Batch 2** | 客户端 | Add/remove/rename 入口、390/1280 形态、删除确认、每行独立状态 | **1.5–2 天** | 390/1280 截图验收；三态行；删除有确认且清凭据 |
| **Batch 3** | 加固 + QA/文档 | 并发/审计/上限、多实例 mock 矩阵、文档、Batch 0 卡片平滑并入 | **1–1.5 天** | 并发/删除/重启矩阵全绿；QA 底稿更新 |
| 合计 | | | **6–8.5 天**（含缓冲 7–9 天） | **排期口径：维护期结束后直接从 Batch 1 开始**（Batch 0 已由用户决定跳过） |

### 7.1 风险与 Batch 1 前置项

1. **模块级可变状态跨实例（必须先修）**：`neon.js` 里的 `baseAddress` 与 `mountedSettings` 是模块内单例；两个实例共用同一个模块实例时，后挂载的实例会覆盖前者的 settings，直接后果是 `run_sql` 审批卡显示成另一个实例的项目/角色（串台）。Batch 0 已跳过，**Batch 1 第一步必须把它拆成每实例一份**（实例 wrapper 各自保存，或只从调用上下文取），并加单测锁住。
2. **DCR 客户端数量**：每实例一个动态注册的公开 client（Neon 不支持标准删除，旧实例删除后 client 留在 Neon 侧），软上限 8 可接受，记已知残留。
3. **token/凭据串号**：框架按 id 取 grant 与 state 是现有的正确基础；仍要单测锁住“实例 A 的 token 不会挂到实例 B”。
4. **UI 复杂度**：多行 + 每行设置面板会让设置页变长；建议每行折叠、只展开当前连接项，label 可编辑。
5. **显示名解析**：项目名来自 API，off 状态拿不到；off 行显示 label 或「Neon N」，连接后再补项目名。
6. **按 Bot 可见性**：本期不做（全局工具），保留为后续风险。

## 8. 轻量快速路径评估：固定第二张卡 `neon-2`（**用户已选择跳过，本方案不执行，仅保留作评估记录**）

**做法**：新增一个模块文件 `ds-bot/src/host/connectors/neon-2.js`，把现有 `neon` 定义克隆一份、只覆盖 `id: 'neon-2'`（`displayName` 可写 `Neon 2` 或沿用 `Neon`）。其余全部复用：同一套 `authorize`/`toolsOf`/`readiness`/`actionApproval`/`card`/settings/levels。框架按现有一文件一模块加载，`state.connectors.neon-2`、grant `ds-bot/connector-neon-2`、工具前缀 `neon-2_*`、回调 `/oauth/ds-bot/neon-2` 全部天然独立。

**需要动的文件**：
- 新增 `ds-bot/src/host/connectors/neon-2.js`（薄封装，约 10–20 行：`import neon from './neon.js'; export default { ...neon, id: 'neon-2', displayName: 'Neon 2' }`，注意 `card.about` 可加“第二个项目”提示）；
- 新增 `ds-bot/test/neon-2.test.js`（或扩 `neon.test.js`）：两个 id 的定义独立、工具前缀不同、不共享 settings/grant；
- 文档一行（README/Neon 文档注明“第二张卡”只能固定一个，等动态多实例替代）；
- **不需要改**：`connectors.js`/registry/client.js（客户端按 view 数组渲染，多一行自动出现；Add/Remove 入口不在本批）。

**风险**：
0. **模块级状态跨实例共享**：`neon.js` 的 `baseAddress`/`mountedSettings` 是模块内单例，两个 id 共用同一模块实例会导致 `run_sql` 审批卡角色串台；第 0 批必须先把这两项拆成每实例一份（薄封装里各自保存，或只从调用上下文取）。
1. **只能固定一个**（要第三个还得再加文件），不是真多实例；可作为临时方案。
2. 两文件定义易漂移：建议 `neon-2.js` 纯克隆，所有逻辑只在 `neon.js`，避免复制业务代码。
3. `displayName` 与卡片名固定，无法重命名/自动项目名（要等 Batch 1/2）。
4. QA 需覆盖“互不影响”：断 A 不动 B、改 A level 不动 B、A/B 的 token 不串。
5. 与未来动态实例的关系：Batch 1 上线后，`neon-2` 作为**普通固定实例**存在；动态实例从 `neon-3` 起分配，或提供一次性迁移把 `neon-2` 的 settings/grant 原样保留（键不变，无需重授权）。**迁移成本≈0**，因为 state/grant 都以 id 为键。

**能否作为第 0 批先上**：可以，估 **2–3 小时**（薄封装 + 单测 + 文档 + **`neon.js` 模块级状态拆分** + 宿主级双实例验证），不动框架、不动客户端，回滚 = 删文件与 state 键。建议作为 Batch 0 先满足“今晚要第二张卡”，完整多实例按 Batch 1–3 推进。

## 9. 拍板状态

已定：
1. 实例软上限 **8**（超限给清晰提示，不做硬性拒绝测试）；
2. **Batch 0 跳过**，不写 `neon-2.js`，维护期结束后直接从 Batch 1 开始；
3. 删除入口走**行内**（触屏友好），二次确认 + 明示「会吊销该实例授权」；
4. **按 Bot 可见实例本期不做**，保留为后续风险。

仍开放：删除实例的最终文案、实例软上限到 8 时的具体提示语（实现时随 Batch 2 定）。
