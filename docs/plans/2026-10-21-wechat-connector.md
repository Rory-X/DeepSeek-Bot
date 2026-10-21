# 微信连接器（wechat）：通道绑定 Bot，webhook 与 ClawBot 两条通道

- 日期：2026-10-21
- 状态：设计稿（待 Chief 审）
- 相关：DS Bot 0.2.0 现网源码（`~/.dsh/profiles/web/node_modules/ds-bot`）、参考实现 `wechat-clawbot`（`docs/ilink-protocol.md`）
- 一句话：一个多实例连接器，每个实例是一条「通道」，通道 1:1 绑定一个 Bot；P1 做通用 HTTP webhook 出站通知，P2 做入站并把回复同步回传，P3 只做个人微信 ClawBot/iLink 的可行性，P4 做卡片与媒体，P5 QA/打包。

## 1. 目标与不做什么

**目标**：让微信侧的消息进入 DS Bot、把 Bot 的回答送回微信；让 Bot 能主动向微信群/服务发通知。两条通道都要，分批上。

**分批与门槛**

1. **P1：纯出站 webhook（通用 HTTP）**，先做。向配置的 URL POST 一条通知：企业微信群机器人、n8n、自建服务都行。
   - 企业微信群机器人**没有入站回调**；企业微信应用 callback（加密 XML/AES）**不做**，列为后续可选（见 §3.3）。
2. **P2：入站**，通用 JSON webhook + HMAC，面向**同机 sidecar**（clawbot-gateway / n8n）——不接企业微信官方回调。
3. **P3：clawbot（个人微信 ClawBot / iLink 原生）**，在以下两件事有结论之前**只做可行性验证，不排开发**：
   - ① 用户微信是否在 ClawBot 灰度内；
   - ② iLink 个人号使用的合规与封号风险有结论。
   可行性验证的产出是协议客户端 spike + 登录 CLI 原型 + 风险清单，不含上线代码。

**不做什么**

- P1/P2 只做文本 + 通知；图片/文件/语音/视频留 P4。
- 不自动答应 Bot 的审批/提问（见 §7）。
- 不把微信消息注入 Bot 的私聊 Session（见 §5）。
- P1 不做大 UI 改动；卡片只加必要字段。

## 2. 形态：多实例、每实例一张卡

`mode: 'custom'`，模块 `ds-bot/src/host/connectors/wechat.js`，仿 Neon 的 `instances` 机制：每张卡一个实例，实例 id 为 `wechat`、`wechat-2`……，各自独立的设置、凭据、会话与状态。

**依赖框架改动（见 §12）**：现框架的 `instances` 只允许 `oauth-mcp`（`registry.js` 的 `checkInstances`），WeChat 的凭据不是 OAuth 授权而是「DSH 凭据库里的 secret + 本地 0600 文件」，需要 Forge 放宽为 `custom` 模式也允许实例。这是 P1 的阻塞项。

**实例设置**（`settings`，非密钥；`normalizeSettings` 校验，`readiness` 决定是否 ready）：

| 字段 | 说明 |
|---|---|
| `label` | 卡片名，可空 |
| `transport` | `webhook` 或 `clawbot` |
| `botId` | **必填**，绑定一个 Bot；不存在则不 ready |
| `webhookUrl` | webhook 模式的出站地址（企业微信群机器人 URL 或任意 HTTP 接收端） |
| `webhookFormat` | `generic`（发送 `{text}`）或 `wecom`（发送企业微信 `{msgtype:'text',text:{content}}`） |
| `notifyPrefix` | 可选，出站消息前缀 |

**凭据（不进 state / view / 日志，只写名字与注入方式）**

| 凭据名 | 来源 | 用途 |
|---|---|---|
| `WECHAT_WEBHOOK_SECRET`（基名；`-N` 实例由 `secretNameOf` 加 `_N`） | 设置页 secret 字段（F5）为主；`request_secret` 只用于 CLI/调试 | 出站签名（可选）+ 入站 HMAC 校验（必选）；两边都落 DSH 凭据库 |
| `WECHAT_INBOUND_TOKEN`（首实例）/ `WECHAT_INBOUND_TOKEN_2` | 模块生成（32 字节随机），写入 DSH 凭据库 | 入站 Bearer 校验（可选）；用户在 Secrets 页读取，配置到网关 |

clawbot 模式的登录凭据是**本地文件** `<rt.home>/wechat/<instance>.json`（目录 0700、文件 0600），不进 DSH 凭据库、不进 state；结构见 §6。

**级别**：`levels: ['read','write']`，`defaultLevel: 'read'`。

- `read`：只接收/回复自己触发的对话；不注册任何主动发送工具。
- `write`：额外注册 `wechat_notify`（主动发消息，**每次走审批卡**）。出站工具只出现在 write 级。

**能力展示**（`capabilities` / `permissions` / `card`）：只列显示信息——接收消息并回复、主动发通知（write）、ClawBot 通道（P3 后）；`permissions.summary` 写「使用你提供的凭据；主动发消息前会请求你的批准」。

## 3. 通道 A：webhook（P1 出站 / P2 入站）

### 3.1 出站通知（P1，整条通道的第一刀）

P1 只有出站：通道可配置、可连接、可发通知、卡片可见，**不开任何入站监听**。

- 工具 `wechat_notify({ text })`，write 级注册，参数只有 `text`。
- 每次调用先走插件审批卡（`approve`，line 写「向 <通道名> 发送通知」+ 目标 URL 的 host，不显示完整 URL/密钥候选项），批准后 POST 到 `webhookUrl`。
- 文本限长：`generic` 4,000 字符；`wecom` 2,048 字符；超长直接报错、不截断。
- 请求头带 HMAC 签名（同 §3.2 的格式，方向反过来），便于接收端校验来源。
- **secret 可选**：P1 出站不强制配 secret——缺 secret 时仍可 ready，POST **不签名**并在卡片提示「未配置 secret，接收端无法校验来源」；配了才签。secret 轮换同时影响出站签名与入站验签（同一把 secret，两处共用）。
- 超时 10s；错误映射：401/403 → 凭据被拒；404 → 地址不对；429 → 限流并给 retry 提示；其他 → 状态码 + 服务端短消息。错误文案不含 URL 全文、不含密钥。
- 结果：成功返回「已发送到 <通道名>」；不返回响应体全文，避免把接收端内容带进对话。

### 3.2 入站（P2）

**这是「通用 HTTP 网关契约」，不是企业微信官方应用回调**：P1/P2 面向同机 sidecar（clawbot-gateway / n8n）；企业微信应用 callback（XML+AES+签名校验）是另一套协议，明确不做（§3.3）。

**监听**：模块自己起一个 loopback HTTP 监听（**只绑 `127.0.0.1`**），端口来自 profile 配置 `wechat.listenPort`（默认 `8799`），所有实例共用一个监听，路径为白名单：

```
POST /wechat/<instance>/inbound
```

只接受这一个路径、`POST`、`application/json`；其余一律 404，不返回任何内部信息。

**请求**（与 clawbot-gateway 的 HTTP 端点契约一致）：

```json
{ "msgId": "唯一消息 id", "sender_id": "发送者", "text": "内容", "context_token": "可选" }
```

**校验顺序**（任一失败即拒绝，且不触发任何 Bot 轮次）：路径白名单 → HMAC 签名（**必选**）→ 时间戳（±300s）→ nonce 防重放 → Bearer token（**可选，默认关**）→ 发送者 allowlist（v1 只有创建者本人）→ 速率限制 → 请求体大小 → `msgId` 幂等。

**鉴权最小配置**：只配 `WECHAT_WEBHOOK_SECRET`（`wechat-2` 为 `WECHAT_WEBHOOK_SECRET_2`）即可（HMAC 必选）；网关能带 Bearer 时再打开 `inbound.bearerRequired`，token 用 `WECHAT_INBOUND_TOKEN` / `..._2`。命名规则见 §12 F2b：**首实例裸名、`-N` 实例加 `_N` 后缀**。

**数值上限**（超限返回码写死）：

- **限速**：每实例 **30 req/min，burst 10**（令牌桶）；超出 → **429** + `retry_after` 秒。
- **请求体**：≤ **64 KB**；超出 → **413**。**不能只信 `Content-Length`**：chunked 请求要**流式累计**，超过 64KB 立即断开并回 413（不先把 body 读进内存）。
- **入站文本**：≤ **8 KB**（UTF-8 字节）；超出 → **413**。
- **`callbackUrl` 白名单**：只接受 `https://` 或 **三个 loopback 字面值**（`127.0.0.1`、`localhost`、`::1`）；其余 `http://` 一律拒绝，防 SSRF。

**签名头**：

```
X-WeChat-Timestamp: <unix 秒>
X-WeChat-Nonce: <随机串>
X-WeChat-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + nonce + "." + rawBody)>
```

nonce 用每实例 LRU（1,000 条）挡重放；`msgId` 幂等见 §6。

**响应：默认异步（P2 契约写死，不能后移）**

网关与常见 HTTP 客户端的超时通常只有 5–30s，Bot 的一轮往往更久，**同步等待会丢回复**。

**默认（异步）**

- 入站**立即**返回 **202** `{ "ok": true, "accepted": true, "msgId": "...", "instance": "wechat" }`。
- Bot 回复完成后，宿主 POST `callbackUrl`（请求里给，或用通道设置 `callbackUrl`）：
  `{ "ok": true, "msgId": "...", "instance": "wechat", "reply": "Bot 的最终文本", "completedAt": <ms> }`；
  失败回调 `{ "ok": false, "msgId": "...", "instance": "wechat", "code": "bot-unavailable"|"timeout"|"channel-rebound", "message": "..." }`。
- **回调鉴权**：与入站同一套 `X-WeChat-Timestamp` / `X-WeChat-Nonce` / `X-WeChat-Signature`（HMAC 覆盖 `timestamp.nonce.body`），另带 `X-WeChat-Callback: 1`；**幂等键是 `msgId`**（接收端同 msgId 只处理一次）。
- **回调地址**：只接受 `https://` 或 loopback `http://127.0.0.1`（同机 sidecar）；不跟随重定向；超时 10s。
- **回调重试**：网络错误/5xx/408/429 退避 3 次（1s/5s/25s）；其它 4xx 视为回调配置错误，不重试、只记状态卡。

**同步模式（可选，`wait` 参数）**

- 请求可带 `"wait": <ms>`，**上限 20,000ms**（超出按 20,000 处理，不报错）；未带或 0 = 纯异步。
- `wait` 内拿到回复 → **200** `{ "ok": true, "msgId": "...", "reply": "..." }`，且**不再发回调**。
- `wait` 到上限仍未回复 → **504** `{ "ok": false, "code": "timeout", "message": "The Bot did not answer in time." }`；**消息继续跑完并照常发回调**（不丢结果），调用方以回调为准。
- `callbackUrl` 与 `wait` 同给：先到者生效（回调送达后同步等待结束）。

`202` 只表示「已接受」，不代表 Bot 已回复。校验失败、限速、超大请求分别回 401/403/429/413。

### 3.3 企业微信官方回调（不做，后续可选）

企业微信应用的 callback 是加密 XML（AES + 签名校验），不是 JSON，还要走企业微信应用管理配置；它与 P2 的「通用 JSON + HMAC」是两套契约。**P1/P2 都不做**，列为后续可选：那时单独开一个 transport（例如 `wecom-app`），复用绑定、幂等与队列，只替换报文编解码。

## 4. 通道 B：clawbot / iLink（P3，仅可行性）

只做文字；媒体 P4。

**门槛状态（2026-10-21 用户回复）**：①「用户能看到 ClawBot/iLink」——**已满足**（技术可验收前提）；② 合规/封号风险——**未解决**。因此 P3 仍**只做不碰账号的可行性**：协议客户端 spike + mock 服务端 + 登录 CLI 原型；**不拿用户的个人微信做登录测试**，没有书面同意前一行都不碰真实账号。即使之后同意，也按 §4.1 的真实账号最小化方案执行。排期不变：P3 不占 P1/P2 人力，等 P1/P2 之后再决定做不做。

- **协议**：`https://ilinkai.weixin.qq.com`，公共头 `iLink-App-Id: bot`、`iLink-App-ClientVersion: <uint32>`；POST 另带 `AuthorizationType: ilink_bot_token`、`Authorization: Bearer <token>`、`X-WECHAT-UIN`（随机 uint32→十进制→base64）。
- **能力**：`getUpdates` 长轮询（服务端最长挂 35s，`get_updates_buf` 游标必须持久化，否则重收）、`sendMessage`（`context_token` 回传以匹配会话）、`getconfig`/`sendtyping` 可选。
- **登录（v1，合规约束）**：用**官方 CLI 登录拿 `bot_token`，粘贴到卡片**（secret 字段）。token **只进 DSH 凭据库或 `<rt.home>/wechat/<instance>.json`（0600）**，不得进 state、日志、设置页明文。v1 **不做自动登录/扫码轮询**；二维码（接口返回 data URL，不需要二维码库）放 P4。
- **合规门槛**：iLink 是逆向/非公开协议，个人微信号有封号风险。**只有用户明确书面同意后才做**（P3 spike 前先拿到两个结论：灰度状态 + 风险接受），风险说明单独成文，不默认开启。
- **守护**：mount 启动长轮询；断线指数退避（1s→2s→…→60s 封顶，带抖动）；`dispose`/通道关闭时停止；日志只记状态与错误码，不记消息正文与凭据。
- **可行性验证产出**：协议客户端 spike（mock 服务端单测）、QR CLI 原型、灰度与合规风险清单。**在 §1 的两个结论出来前不排上线开发。**

### 4.1 真实账号测试的最小化方案与止损条件（仅在有书面同意后）

> P3 的可行性验证**不需要**真实账号；以下是为「万一之后需要实测」预先定死的边界，Chief 审稿时一并看。

- **账号**：只用**小号**（非主号、可弃用），不用用户主微信；登录前确认该号没有重要联系人/资产。
- **窗口与数据**：测试窗口 ≤24h；只发一条固定测试文本给自己；不读取历史消息、不拉联系人/群列表、不上传或下载媒体。
- **可撤销**：token 用后**立即删除**（0600 文件与 DSH 凭据库都清），不留备份；日志/状态只记事件与错误码，不记 token、正文、sender 原文。
- **失败即停**：登录失败、出现风控/验证/异地登录提示或任何异常，**立即停止**、删除 token、不自动重登、不自动重试登录，并把结果告知用户。
- **止损条件**：账号被限制/封禁/要求验证 → 终止整条 P3 实测线，记录结论（不含凭据）；是否继续由用户决定。
- **回滚**：关闭通道即停长轮询；删除实例清凭据文件；确认目录无残留后结束。
- **优先级**：mock 服务端能覆盖的验证（游标恢复、重复/乱序、context_token、退避、-14、断线重连）**一律不碰真实账号**。

## 5. 绑定语义与会话（写死）

- **通道 ↔ Bot 1:1**：一个通道只绑一个 Bot；同一个 Bot 可以被多个通道绑定（多对一允许）。
- **每个通道按 conversation 一条独立 Session**（否决「注入 Bot 私聊」）：外部消息带 `sender` 元数据、显式标记 `untrusted`；不写入 Bot 的长期记忆，不进用户私聊。
  - **新增 `channelSessionFor`**（不复用 `groupSessionFor`）：Forge 指出复用会把 room log、群提示、群 UI 和记忆 review 一起带进来。落地为 `store.js` 的 `channelOwners` map + 新文件 `src/host/channels.js`，并在 `memory.js` 把 channel session 排除出 memory review/注入。
  - **粒度（v1 只做 1 条）**：每通道只有**创建者 DM 一条** conversation session（`dm:<senderHash>`）。「≤8 条 conversation + LRU 归档」与 `group:<group_id>` 都移到 **P4**；P2 的状态与表按单 conversation 设计，不预先建空会话。
  - 选择「专属 channel session」而不是「隐藏 room」：room 有成员/群渲染语义，隐藏 room 会牵动侧栏与会话列表；专属 session 不挂任何列表，影响面最小。
  - 消息注入用 `rt.deliver({ sessionId, toId: botId, text, role: 'request', exchangeId })`（`deliver` 已支持显式 sessionId），不调用 `rt.chatOf(botId)`。
  - **工具白名单**：channel session 默认**无任何工具**。`restrict({ allow })` 形态尚未验证（仓库现有用法只有 `restrict({ deny })`，见 `agents.js:61`）；**P2 开工前与 Forge 确认**：若只支持 deny，则改为「deny 全量已知工具 + 新注册工具默认不放行」，并加负例（后注册的工具也不会漏进 channel session）。`settings.allowReadTools === true` 时只放行 `web_search`。**denylist 逐项点名**：连接器写、文件、bash、记忆写、`ask_user`、`request_secret`、审批代答、Bot 管理。
  - **`untrusted` 必须进消息头**：不能只存 `source`；框架的 `headerFor` 要在注入正文里带 `[external channel · untrusted]` 段，模型从正文即可看到；`source` 仍带 `sender`/`untrusted` 供审计。
  - 需要框架补的小改动：`source` 上允许 `untrusted: true` 与 `sender`（现在的 source 字段是白名单的），见 §12。
- **串行处理**：同一通道内单飞行队列；一条入站处理完（回复或超时）才处理下一条。
- **回复关联键**：`msgId → exchangeId`。`deliver` 返回的 exchangeId 用于在该 Session 的 `session/event` 里认出对应的 `user/message`，再取紧随的 `turn/start` 的 turn 号，收集该 turn 内的 `assistant/message` 文本，`turn/end` 时用最后一段文本作为回复。**内部 turn 收口上限 120s**；同步 `wait` 见 §3.2（≤20s 到点先回 504，消息继续跑完）；异步在 120s 内未完成发 failure callback。
- **换绑**：`A → B` 的序列是：标记「换绑中」→ 丢弃在途消息（等待中的请求回 `503 channel-rebound`，不重试）→ 归档旧 Session（owner 仍是 A，记录 `{sessionId, botId:A, at, reason:'rebind'}`）→ 为 B **新建** Session（新 id，不继承上下文）→ 更新 owner → ready。旧 Session 不删除、不复用。
- **解绑/关闭通道**：同样丢弃在途、归档 Session、记录 `{reason:'unbind'|'instance-deleted'|'transport-changed'}`，通道转 off。
- **Bot 不可用**：Bot 被删/不在线/轮次报错时，入站返回 `502 { code:'bot-unavailable', message:'Bot 暂不可用，稍后再试' }`，状态卡记录原因；**不无限重试**（每个入站最多一次投递）。
- **归档 API**：用 `ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })`（group Session 已在用），失败只告警不阻塞换绑。

## 6. 状态、幂等与迁移

**状态机（每实例独立，互不影响）**

```
off ──设置完整且挂载成功──▶ ready
off ──设置不完整/未绑定 Bot──▶ off（readiness 给出原因，不显示 Connect）
ready ──端口被占/凭据被拒/Bot 被删/监听失败──▶ error（带可操作原因，30s 退避重试）
error ──条件恢复──▶ ready
ready/error ──关闭通道、删除实例、transport 改变──▶ off（归档 Session）
```

- `off`：`transport` 未填、缺 `botId`、Bot 不存在、webhook 模式缺 `webhookUrl`、clawbot 模式无凭据文件。
- `ready`：webhook = 监听已绑 `127.0.0.1:<port>` 且 HMAC/Bearer 凭据齐；clawbot = 长轮询在跑。两种情况都要求绑定的 Bot 存在。
- `error`：可操作文案（哪个端口被占、缺哪个凭据、Bot 被删）；错误不静默。
- **端口冲突降级**：监听绑定失败（如 `EADDRINUSE`）时，只有使用 webhook 的实例进入 `error`，文案给端口号与修改方法（`wechat.listenPort`）；**插件启动不受影响**，其他连接器照常 ready（负例测试见 §11）。
- **`EADDRINUSE` 是永久错误，不自动重试**（否则日志刷屏）：进入 `error` 后等设置变更或用户手动 Connect；其他瞬时错误（凭据被拒、Bot 暂时不可用）才按 30s 退避重试。

**state 新增命名空间 `state.channels`**（不改动已有连接器数据；读取时缺省为 `{}`，无版本号升级）。**不放 `state.connectors[id]`**：disconnect / set-settings 会重建那个对象，非框架字段会丢。

```
state.channels[instanceId] = {
  boundBotId,
  conversations: { "dm:<senderHash>": { sessionId, boundBotId, createdAt, lastUsedAt } },   // v1 仅一条 dm:<senderHash>；≤8/LRU 见 P4
  sessionHistory: [{ sessionId, botId, conversation, at, reason }],                          // 归档记录，最多 20 条
  seenMsgIds: [{ id, at }],                                                                   // 幂等环，最多 200 条
  status: { lastInboundAt, lastOutboundAt, lastError, lastErrorAt, retryAt }
}
```

- **幂等只按 `msgId`**（不看内容哈希）：同 `msgId` 重推 → `{ok:true, duplicate:true}`，不触发新轮次；用户手动重发同一句话是新 `msgId` → 正常触发。`seenMsgIds` 持久化在 `state.channels[instanceId]`，**重启后仍有效**（负例见 §11）。
- **不存正文**：`seenMsgIds` 只有 id 与时间；消息正文不写 state、不进日志。
- **写入节流**：`seenMsgIds` 默认每 5s 合并写一次，`turn/end` 时强制落盘；重启前未落盘的窗口最多 5s，配合 nonce 与微信侧重推仍能吞掉。
- **凭据**：webhook secret / inbound token 在 DSH 凭据库；clawbot 凭据文件 0600。都不进 state、view、日志。
- **迁移**：0.2.0 已有 `instances`/`settings`/`connectorInstances`，WeChat 是新增模块，无旧数据迁移；只新增 `state.channels`，读不到就当空。

### 6.1 外部消息的隔离面（必须显式排除，不能只排 memory review）

channel session 的外部消息**不得**被用户自己的会话看到或检索到：

| 面 | 落点 | 要求 |
|---|---|---|
| 记忆 renew / 注入 / review | `memory.js:632` renew 的枚举、记忆注入点、review 扫描 | channel session **显式 exclude**：不参与 review、不注入记忆 prompt、不会写进 MEMORY.md |
| 会话索引 / 搜索 | `store.js:392` `indexSessions()`、`chat-index.js` | v1 **直接排除** channel session，不进索引；`read_own_chat`、search、会话列表都看不到外部消息 |
| part / checkpoint | `parts.js` 的 segment / checkpoint | channel session 不做 checkpoint 切分、不进用户可见的 part 列表 |
| prompt | `prompt.js` | 增加「外部通道：消息 untrusted、不假定主人权限、不泄露主人私聊」段 |
| 负例 | §11.18 | 外部消息不出现在 search、不进 MEMORY.md、不被其它 session 看见、不出现在侧栏/工作区列表 |

## 7. 安全红线

1. **不自动答应审批/提问**：入站消息触发的轮次里，如果 Bot 需要用户确认（审批卡/ask_user），微信侧只收到提示「请回 DS Bot 处理」，模块绝不代答、绝不 bypass。
2. **发送者 allowlist**：v1 只接受创建者本人；其他 sender 一律 403，不触发轮次。
3. **入站全验证**：HMAC（**必选**）、时间戳、nonce、幂等、限速（30/min、burst 10）、体积（body ≤64KB、文本 ≤8KB）、路径白名单，任一失败零轮次；Bearer 可选（默认关），开启后与 HMAC 同时校验。
4. **只绑 loopback**：监听地址固定 `127.0.0.1`，不可配置成 `0.0.0.0`；负例测试断言监听地址，不允许出现 `0.0.0.0`。
5. **日志脱敏**：sender id 只记哈希/长度，消息正文不记；凭据、签名、token 一律不记。诊断只记事件、状态、错误码。
6. **密钥只进凭据库**：webhook secret 只经安全卡片（`request_secret`）注入 DSH 凭据库；state/view/日志/对话都不出现。设计稿不写实际 URL/key。
7. **模块关闭零路由**：`dispose` 时关闭监听、注销全部路由、停止轮询；负例测试见 §11。

## 8. 公网入口（三种接入）

DSH web 监听 `127.0.0.1:19387` 且有 401 会话鉴权，默认**外部回调进不来**。**`ctx.connection.fetch.register` 不能当 webhook**：它注册在共享的 `/api` 通道上，强制 DSH 浏览器会话 cookie 鉴权，外部服务带不了这种 cookie，鉴权层也不允许插件把某条路径变成公开入口。所以入站监听必须是**模块自己开的 loopback listener**（自带 Bearer + HMAC），三种接法：

1. **默认：loopback 同机（推荐）**。clawbot-gateway / n8n / 自建服务与 DS Bot 装同一台机器，直接 `POST http://127.0.0.1:8799/wechat/<instance>/inbound`。不开公网、不动防火墙、不需要证书。验收默认走这条路。
2. **可选：Caddy 反代**。公网域名 → Caddy → `reverse_proxy 127.0.0.1:8799`；只放行 `/wechat/*/inbound` 一个路径前缀，其他 404；TLS 用 Let's Encrypt（域名/HTTP-01 或 DNS-01）；可选来源 IP allowlist。Caddyfile 片段与证书目录写进部署文档，不在本稿贴实际配置。
3. **可选：Cloudflare Tunnel**。`cloudflared tunnel` 指向 `http://127.0.0.1:8799`，暴露一个 hostname + 路径白名单；可在 Cloudflare Access 上加一层策略。适合没有公网 IP 的机器。

**需要用户 root 执行的操作（单独列）**

- 安装系统级服务（Caddy、cloudflared）或用 systemd **系统**单元常驻；
- 绑定 80/443 等特权端口；
- 修改防火墙/安全组（放行 443 或保持全关）；
- 为公网域名配置 DNS 解析与证书（DNS-01 时涉及 DNS 提供商凭据）；
- 机器级变更（`/etc` 下配置、开机自启）。

不需要 root 的默认路径：同机 loopback 调用；`cloudflared` 以当前用户运行 `--url` 快速隧道；Caddy 用高位端口或 user 级服务。

## 9. 观测：每通道一张状态卡

在连接器卡片上按实例展示：

- 最近入站时间、最近出站时间；
- 最近失败原因（可操作文案）与时间；
- 重试状态（下次重试时间、退避次数）；
- 通道与 Bot 绑定：`transport`、绑定的 Bot 名、Session 是否有主。

数据来自 `state.channels[instance].status`，由模块在 `status` 钩子里返回（§12 的小框架改动）；框架没有该钩子前，P1 先用卡片 settings + 错误状态展示，P2 再补。

两通道**独立开关**：改一个实例的 `transport` 或关闭它，不影响其他实例。

## 10. 迁移与兼容

- WeChat 是新模块，无旧连接器数据迁移。
- `state.channels` 新命名空间缺失即为空；`state.connectorInstances` 沿用框架已有的实例编号高水位。
- 凭据文件目录不存在则创建（0700），文件写入用「临时文件 + rename」保证原子，权限 0600。
- 关闭/删除实例时清理该实例的凭据文件与 state 记录；DSH 凭据库里的 secret 由框架 disconnect 流程删除。

## 11. 验收与负例测试（P1/P2 必含）

1. **模块关闭零路由**：`dispose` 后监听端口不可连（`ECONNREFUSED`），且未在 DSH 路由表注册任何路径；其他连接器不受影响。
2. **端口被占降级**：先占住 `listenPort` 再启动 → 该通道 `error` 且文案含端口与修改方法；**插件正常启动**，其他连接器 ready。
3. **只绑 loopback**：断言监听地址为 `127.0.0.1`；配置里没有把监听改成 `0.0.0.0` 的入口。
4. **HMAC 失败**：缺签名/签名错/时间戳超窗 → 401，`tools/call` 计数 0。
5. **nonce 重放**：同 nonce 第二次 → 401，零轮次。
6. **msgId 幂等**：同 msgId 重推 → `duplicate:true`，零新轮次；**重启后**再推同 msgId 仍吞掉（state 持久化验证）。
7. **新 msgId 同文本**：正常触发一轮（不按内容哈希误吞）。
8. **限速**：超过配额 → 429 + `retry_after`，零轮次。
9. **sender 不在 allowlist** → 403，零轮次。
10. **Bot 不存在**：mount 不 ready，文案可操作（去设置里选一个存在的 Bot）。
11. **换绑归档**：A→B 后旧 Session 被归档且记录 `{botId:A, reason:'rebind'}`；新 Session id 不同；在途请求收到 `503 channel-rebound` 且不重试。
12. **串行与关联**：两条入站按序处理，回复分别回到各自 msgId；并发第二条不会抢到第一条的回复。
13a. **同步超时**：`wait` 到点（≤20s）先回 504 `code:'timeout'`，消息继续跑完、不重试、不重复投递；
13b. **异步超时**：120s 内未完成 → 发 failure callback（同一 HMAC、msgId 幂等），不重复投递。
14. **不代答审批**：入站触发需要审批的工具 → 微信侧收到「请回 DS Bot 处理」，审批卡未被自动回答、工具零调用。
15. **脱敏**：日志与 diagnostics 不含 sender 原文、正文、secret；state.json 不含正文与 secret。
16. **级别**：`read` 级无 `wechat_notify`；写等级别下审批卡出现且 allow 只执行一次、deny/超时/取消零请求。
17. **profile 关闭**：连接器整体 `false` 时无监听、无实例行。
18. **channel session 不可见**：channel session 不出现在用户会话侧栏、工作区列表或 Bot 私聊的历史里；`createSession` 不带 `dir` 时的落点行为在 P1 确认并加断言（不落到用户可见文件夹）。
19. **异步回调**：默认 202 + 回调送达；`callbackUrl` 缺失时 `wait` 生效且上限 20s；回调失败退避 3 次后只记状态卡。
20. **体积与限速**：body >64KB / 文本 >8KB → 413（零轮次）；超过 30/min 或 burst 10 → 429 + `retry_after`。

## 12. 依赖框架的改动（Forge）

| 编号 | 改动 | Owner | 阶段 | 工时 |
|---|---|---|---|---|
| F1 | `registry.js:105` `checkInstances` 放宽为 `mode` ∈ {`oauth-mcp`, `custom`}；其余校验（prefix、min/max、id 长度、`checkInstanceIds`）不动；custom 模块必须自己声明 `credentials`/`tokenSecret`。测试：custom+instances 通过、rest-tools+instances 仍拒绝、缺凭据声明报错清楚 | Forge | P1 阻塞（**先落 F1 再开 P1 实例**） | 0.5d，今天 |
| F2b | `secretNameOf(id, field)`：首实例裸名、`-N` 实例 `_N` 后缀（须过 `SECRET_NAME` 校验，两实例不得同名）；`configuredOf`/`credentialKeyOf`/`secretMapOf`/connect 写 secret/disconnect 删 secret/`notifyTokenOf` 全走它；mount 给模块 `secretName(field)`。测试：两实例互不覆盖、删实例只删自己、view/state/logs 不含值 | Forge | P1 阻塞 | 0.25d，今天 |
| F5 | Host 侧缺口：① `connector-test` 增加模块 `test` 钩子（custom 也能测）；② `connector-set-settings` 支持 secret 字段（缺省/空串=保留、非空=替换写凭据库、`clearSecrets` 显式清除）；③ 通用 `connector-command {id, action, args}` → 模块 `command` 钩子（per-action 白名单 + 参数校验 + 仅 clawbot，禁止透传）；④ view 由模块 `view`/`status` 钩子合并进 row，`instance.max` 从 `instances.max` 填 | Forge | P1 阻塞（卡片/测试/登录） | 1d |
| F2a | 会话归属（P2）：`store.js` `channelOwners: Map<sessionId,{botId,instance}>`，`indexSessions()` 从 `state.channels[...].conversations[*].sessionId` 重建；`selfOf`/`isBotSession` 纳入 channel session；新 `src/host/channels.js`：`channelSessionFor`（createSession + 模型/权限/capabilities + 工具白名单）、`rebindChannel`/`closeChannel`（archiveSession + 归档记录，不删不复用）、`assistant/message` 累积 + `turn/end` 收口回调；`agent.ctx.tools.restrict({allow:[...]})`；`memory.js` exclude；`prompt.js` untrusted 段；`delivery.js:57` source 改为可扩展并处理 `headerFor` 与客户端标识 | Forge | P2 阻塞 | 1–1.5d，明天 |
| F3 | `connectorRow` 增加模块 `status` 钩子（display-only，异常吞掉） | Forge | 可选 | 0.25d |
| F4 | `readiness({level,settings,instance,rt})` 传只读 `rt`（或更窄 `{botOf}`）；每行每级都会调，要求纯内存、无 IO | Forge | 可选 | 0.25d |
| F6 | Client 渲染：`fields.kind`（bot/segmented/secret）、`instance.max`、`inbound`、`login`、`canTest`、`connector-command` 动作的卡片/表单实现（通道列表、Bot 下拉、segmented、secret 只显 saved、异步回调说明） | Prism 实现，Pixel 复核 | P1 | 0.5d |

Forge 已开分支 `fix/connector-instances-custom` @ `357c1fa`（worktree `dsbot-wechatfwwt`，基线 `6255c87`），F1/F2b 先交；F2a 明天交。没有 F1 之前实例机制用不了，**不做「不合主线」的单实例骨架**。

### 12.1 iLink 客户端附录（P3 可行性）

- **实现规模**：核心客户端约 **600–800 行 + 测试**，**无新 npm 依赖**（`fetch`/`crypto` 足够）。
- **协议要点**：认证头三件套（`iLink-App-Id: bot`、`iLink-App-ClientVersion`、`AuthorizationType: ilink_bot_token` + Bearer + `X-WECHAT-UIN`）；`getUpdates` 35s 长轮询 + `get_updates_buf` 游标**持久化**（重启恢复，否则重收）；`sendMessage` 回传 `context_token`；`getconfig`/`sendtyping` 可选；指数退避重连；`errcode=-14` 暂停 1h 再试；入站 `msgId` 幂等复用 P2 的 `seenMsgIds`。
- **二维码**：接口直接返回 data URL，**不需要二维码库**；P3 v1 用「官方 CLI 登录拿 bot_token 粘到卡片」，卡内 QR 留 P4。
- **测试**：本地 mock iLink（复用 `fakeWebServer` 模式），覆盖游标重启恢复、重复/乱序消息、`context_token` 传递、退避与 `-14`、断线重连。
- **不进 v1**：媒体 CDN（AES-ECB 上传/下载）、voice SILK 转码。
- **门槛与风险**：灰度门槛①已满足、②合规/封号风险未解决；P3 只做 mock/CLI 原型，不碰真实账号。真实账号测试仅在书面同意后按 **§4.1** 执行（小号、≤24h、token 用后即删、失败即停、不自动重登）。


## 13. 分阶段计划与工作量

| 阶段 | 内容 | 工作量（人日） | 产出 |
|---|---|---|---|
| P0 | 本设计稿 | 0.5（今天） | 本文档 + 框架依赖清单 |
| P1 | **纯出站**：custom 实例、settings/凭据、`wechat_notify`（write + 审批）、readiness、状态卡字段、单测（依赖 F1/F2b/F5） | 2 | 可发通知的通道卡；出站单测 |
| P2 | webhook 入站：loopback 监听、HMAC/时间戳/nonce/幂等/限速/体积、allowlist、**默认异步 202 + 回调**、绑定与 channel session、串行队列、回复关联、换绑归档、端口降级、负例测试 | 3 | 同步收发的完整 webhook 通道；验收负例全绿 |
| P3 | clawbot 可行性（**不排开发**）：协议客户端 spike（mock）、QR 登录 CLI 原型、灰度/合规风险清单；灰度①已满足、②未解决，不碰真实账号（§4.1） | 2（验证） | 可行性报告 + 原型；等合规结论 |
| P4 | UI/媒体：卡片内嵌 QR、媒体收发（图片/文件，iLink CDN 加密）、状态卡细化 | 2–3 | 卡片与媒体能力 |
| P5 | QA/打包：门槛、smoke、证据（390/1280）、Harbor 交付、README/文档 | 1.5 | 可上线包 |

**排期**：**F1 先落（0.5 人日，今天）→ 再开 P1**；核心 P1+P2 约 **5 人日**，按 4–6 天窗口排，**先不对外承诺**。Forge：F1/F2b 今天、F5 1d、F2a 明天 1–1.5d；Prism：F6 0.5d；F5/F6 与 P1 并行。P3 只做验证；P4/P5 在 P2 验收后再排。

**每日能出什么**

- D1：F1 落地（Forge）+ P1 模块骨架（实例声明、settings、readiness、凭据注入）与单测骨架；F5/F6 shape 确认。
- D2：P1 完成——`wechat_notify` 出站 + 审批 + 错误映射 + 状态字段，P1 门槛全绿，发 Marshal/Forge review。
- D3：P2 监听与安全层（HMAC/时间戳/nonce/幂等/限速/allowlist）+ 负例 1–9。
- D4：P2 绑定与专属 Session、串行队列、回复关联、换绑归档、端口降级 + 负例 10–17。
- D5：P2 联调与证据、全量门槛、交给 Harbor 打包；P3 可行性 spike 启动（若 P1/P2 按计划完成）。
- D6（余量）：修复、文档、P3 spike 收尾。

**资源与优先级**

- 这条线主要由 Relay 承担；Forge 需投入约 **2.5–3 人日**（F1 0.5 + F2b 0.25 + F5 1 + F2a 1–1.5）；Prism 0.5 人日做 F6（Pixel 复核）。
- 与其他线的关系（按已定优先级）：**微信连接器 > Neon follow-up > ima backlog**；Upstream 同步独立跑，不受影响。
- 不占用第三方账号资源：P1/P2 只需用户提供 webhook URL 与 secret（安全卡片）；clawbot 验证另需用户的灰度状态。


## 14. 客户端契约（与 Prism 对齐的最终 shape）

宿主按下面这份给客户端；`fields`/`inbound`/`login`/`levels` 对象化、`instance.max` 是框架新增（Forge 一起做）。

**视图行（每实例一行，沿用 connectorRow + instance）**

```
id, name,
instance: { base:'wechat', id, label, max: 8 },
state: 'off'|'connecting'|'ready'|'error',
error?, level,
levels: [ { id:'read',  title:'Read',        description:'Receive messages and answer them' },
          { id:'write', title:'Full access', description:'Also send notifications for you; every message asks for your approval first' } ],
levelNote?, levelNotes?, needsReauth?,
transport: 'webhook'|'clawbot',
fields: [ { name, kind:'text'|'secret'|'bot'|'segmented', label, required?, saved?, options? } ],
inbound?: { url, token },        // 仅 webhook；url 同机默认 loopback，配了 publicBaseUrl 才是公网地址
login?:   { state:'logged-out'|'qr'|'logged-in'|'expired', qr?:'data:image/png;base64,…', expiresAt?, account? }, // 仅 clawbot；v1 只有 logged-out/logged-in（token 粘贴），qr/expired 随 P4
canTest: boolean,                // webhook ready 时为 true
card: { glyph:'wechat', about, docsUrl }
```

- `fields` 由模块 settings 声明生成，`kind`/`required`/`options` 是新增描述符；`webhookSecret` 是 `kind:'secret'`，**只下发 `saved:true/false`，永不下发 value**。
- `inbound` 只在 P2 出现（P1 纯出站，没有入站字段）；`inbound.token` 非 secret，可显示/复制；`url` 拿不到公网地址时给同机地址 + 一句 note（客户端原样显示）。

**动作（复用 + 一处新增）**

- `connector-connect { id }`：两种模式都用它。webhook = 校验 settings + 启动监听 + ready；clawbot = 有凭据文件则启动轮询，否则返回可操作错误（去登录）。
- `connector-test { id }`：仅 webhook；向 `webhookUrl` 发一条固定测试通知，成功/失败都返回整个 connectorsView（失败时 state 仍 ready、`error` 放原文）。
- `connector-set-settings { id, values }`：
  - `values` 里**缺省或空串的 secret 字段 = 保留原值**；非空才替换（写入 DSH 凭据库，不进 state/view）。
  - **显式清除 secret** 用 `clearSecrets: ['webhookSecret']`（与 `values` 平级），客户端「移除密钥」时带它；不靠空串表达清除。
  - 文本字段空串 = 清空。
  - **已连接（ready/error）时改 `transport` 会被拒绝**，错误文案固定为 “Disconnect this channel before changing the transport.”；客户端先 `connector-disconnect` 再保存（与 Prism 方案一致）。
- `connector-disconnect { id }`：停监听/轮询，state 转 off；保留 settings 与凭据，供重连。
- `connector-create-instance { base:'wechat' }` / `connector-delete-instance { id }`：上限 8（min 1），实例 id 为 `wechat`、`wechat-2`…；删除时模块在 `close` 里清理该实例的凭据文件、secret 名与监听路由（best effort，失败只告警）。
- **新增通用动作** `connector-command { id, action, args? }`（**F5 host + F6 client**），转发到模块 `command` 钩子。**安全约束**：per-action 白名单（模块声明允许的 action 列表）、每个 action 参数校验、**仅 `transport==='clawbot'` 可用**；其它 transport 调 `login-*` 返回 400 `unsupported-transport`，**禁止任意 action 透传**。WeChat 的 action：`login-start` / `login-refresh` / `login-cancel`（结果在 `login` 回，UI 轮询 state）。TTL 到期宿主把 `login.state` 置 `expired`，刷新走 `login-refresh`（不自动轮换）。**v1 登录是 token 粘贴**，`qr/expired` 随 P4。
- view 的 `fields`/`inbound`/`login`/`levels` 对象化与 `instance.max` 由 F5 的模块 `view`/`status` 钩子给出，框架合并进 row。
- `connector-set-level { id, level }` 不变。

**readiness 与级别**

- 缺 `botId`、Bot 不存在、webhook 模式缺 `webhookUrl`、clawbot 未登录：通过 `levelNotes` 给每级原因（read/write 可不同），客户端禁用 Connect 与 write 级并显示宿主原文。
- `levels[].description` 用上表的文案（write 明确写「每次审批」）。

**安全**

- `webhookSecret` 与 iLink token 永不下发明文；`inbound.token` 允许显示/复制。
- 二维码只接受 `data:image/png;base64,…`，客户端不请求外部图片域名。


## 15. 评审意见落实表（逐条对）

| 编号 | 意见 | 落在 | Owner | 工时 | 对应负例 |
|---|---|---|---|---|---|
| R1 | 入站 HMAC 必选、Bearer 可选（默认关），给最小配置 | §3.2 校验顺序/鉴权最小配置；§7 第 3 条 | Relay（设计） | 0 | P2-04/05/06、新增 P2-21 |
| R2 | 限速与体积数字：30 req/min、burst 10；body ≤64KB；文本 ≤8KB；429/413 | §3.2 数值上限；§7 第 3 条 | Relay（设计） | 0 | §11.20 |
| R3 | `EADDRINUSE` 不自动重试（永久错误），等设置变更/手动 connect | §6 端口冲突降级后两条 | Relay（设计） | 0 | §11.2 |
| R4 | 企业微信口径写死：P1/P2 是通用 HTTP 网关契约，不做官方应用回调（XML+AES） | §1 分批；§3.2 开头；§3.3 | Relay（设计） | 0 | 无（明确不做） |
| R5 | `seenMsgIds` 写 state 要节流（5s 合并 + turn/end 强制落盘） | §6 写入节流 | Relay（设计） | 0 | §11.7 |
| R6 | `clearSecrets:['webhookSecret']` 显式清除，不靠空串 | §14 动作 | Relay（设计） | <0.1d | 新增 P1-13 |
| C1 | 记忆/检索排除面列全：`memory.js:632`、`store.js:392 indexSessions()`、`chat-index.js`、`parts.js` 显式 exclude | §6.1 表（逐文件落点）；§12 F2a | Relay 设计 + Forge 实现 | Forge 1–1.5d（含在 F2a） | §11.18、新增 P2-22 |
| C2 | v1 只做 1 条 conversation（创建者 DM）；≤8 + LRU 移 P4 | §5 粒度 | Relay（设计） | 0 | 新增 P2-23 |
| C3 | channel session denylist 逐项点名；`untrusted` 进 `headerFor` 消息头 | §5 工具白名单/`untrusted`；§12 F2a | Relay 设计 + Forge 实现 | 含在 F2a | P2-15、新增 P2-24 |
| C4 | P3 token 只进 0600/凭据库；逆向+封号风险「用户明确同意才做」；v1 不做自动登录/扫码 | §4 登录/合规门槛；§12.1 | Relay（设计） | 0 | 新增 P3-01 |
| C5 | `secretNameOf`：删实例只删自己、名字过校验、两实例不同名 | §2 凭据表；§12 F2b | Forge | 0.25d | P1-11、新增 P1-14 |
| F5 | Host 缺口：`connector-test` 模块钩子、secret 字段与 clearSecrets、通用 `connector-command`（承载 `login-start/refresh/cancel`）、view/status 合并、`instance.max` | §12 F5；§14 | Forge | 1d | P1-02/04/09/13 |
| F6 | Client 渲染上述字段/动作（通道列表、Bot 下拉、segmented、secret 只显 saved、异步回调说明） | §12 F6；§14 | Prism（Pixel 复核） | 0.5d | P1-02 |
| A1 | P2 异步契约写死：`202 {ok,accepted}` + `callbackUrl`（HMAC、msgId 幂等、重试 3 次）；`wait` ≤20s；同步超时 `504 code:'timeout'` | §3.2 默认异步/同步模式 | Relay（设计）+ P2 实现 | 含在 P2 的 3d | §11.19、新增 P2-25 |

> Chief 原话里的 `connector-wechat-login` 在实现时收敛为通用 `connector-command {id, action, args}`（Forge 建议），功能等价，只是端点名更通用；§14 与 F5 已按通用端点写。
