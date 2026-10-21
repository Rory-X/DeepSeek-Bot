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
| `WECHAT_WEBHOOK_SECRET_<INSTANCE>` | 用户通过安全卡片（`request_secret`）提供 | 出站签名 + 入站 HMAC 校验 |
| `WECHAT_INBOUND_TOKEN_<INSTANCE>` | 模块生成（32 字节随机），写入 DSH 凭据库 | 入站 Bearer 校验；用户在 Secrets 页读取，配置到网关 |

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
- 超时 10s；错误映射：401/403 → 凭据被拒；404 → 地址不对；429 → 限流并给 retry 提示；其他 → 状态码 + 服务端短消息。错误文案不含 URL 全文、不含密钥。
- 结果：成功返回「已发送到 <通道名>」；不返回响应体全文，避免把接收端内容带进对话。

### 3.2 入站（P2）

**监听**：模块自己起一个 loopback HTTP 监听（**只绑 `127.0.0.1`**），端口来自 profile 配置 `wechat.listenPort`（默认 `8799`），所有实例共用一个监听，路径为白名单：

```
POST /wechat/<instance>/inbound
```

只接受这一个路径、`POST`、`application/json`；其余一律 404，不返回任何内部信息。

**请求**（与 clawbot-gateway 的 HTTP 端点契约一致）：

```json
{ "msgId": "唯一消息 id", "sender_id": "发送者", "text": "内容", "context_token": "可选" }
```

**校验顺序**（任一失败即拒绝，且不触发任何 Bot 轮次）：路径白名单 → Bearer token → HMAC 签名 → 时间戳（±300s）→ nonce 防重放 → 发送者 allowlist（v1 只有创建者本人）→ 速率限制 → `msgId` 幂等。

**签名头**：

```
X-WeChat-Timestamp: <unix 秒>
X-WeChat-Nonce: <随机串>
X-WeChat-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + nonce + "." + rawBody)>
```

nonce 用每实例 LRU（1,000 条）挡重放；`msgId` 幂等见 §6。

**响应**（同步等待 Bot 回复）：

- 200 `{ "ok": true, "msgId": "...", "reply": "Bot 的最终文本", "instance": "wechat" }`
- 400/401/403/404/429/504 + `{ "ok": false, "code": "...", "message": "..." }`
- `504` 表示 120s 内没有等到回复；**不重试**，由调用方决定。
- 可选异步回调（P2 之后）：请求可带 `callbackUrl`，此时先回 `202`，回复完成后再回调；P1/P2 不做。

### 3.3 企业微信官方回调（不做，后续可选）

企业微信应用的 callback 是加密 XML（AES + 签名校验），不是 JSON，还要走企业微信应用管理配置；它与 P2 的「通用 JSON + HMAC」是两套契约。**P1/P2 都不做**，列为后续可选：那时单独开一个 transport（例如 `wecom-app`），复用绑定、幂等与队列，只替换报文编解码。

## 4. 通道 B：clawbot / iLink（P3，仅可行性）

只做文字；媒体 P4。

- **协议**：`https://ilinkai.weixin.qq.com`，公共头 `iLink-App-Id: bot`、`iLink-App-ClientVersion: <uint32>`；POST 另带 `AuthorizationType: ilink_bot_token`、`Authorization: Bearer <token>`、`X-WECHAT-UIN`（随机 uint32→十进制→base64）。
- **能力**：`getUpdates` 长轮询（服务端最长挂 35s，`get_updates_buf` 游标必须持久化，否则重收）、`sendMessage`（`context_token` 回传以匹配会话）、`getconfig`/`sendtyping` 可选。
- **登录（v1）**：先用**官方 CLI 登录拿 `bot_token`，粘贴到卡片**（secret 字段，写 DSH 凭据库），模块把 token 存成 `<rt.home>/wechat/<instance>.json`（0600）或按实例 secret 读取。二维码流程（`GET /ilink/bot/get_bot_qrcode?bot_type=3` → 轮询 `GET /ilink/bot/get_qrcode_status`）**放 P4** 再接；接口返回 data URL，不需要二维码库。
- **守护**：mount 启动长轮询；断线指数退避（1s→2s→…→60s 封顶，带抖动）；`dispose`/通道关闭时停止；日志只记状态与错误码，不记消息正文与凭据。
- **可行性验证产出**：协议客户端 spike（mock 服务端单测）、QR CLI 原型、灰度与合规风险清单。**在 §1 的两个结论出来前不排上线开发。**

## 5. 绑定语义与会话（写死）

- **通道 ↔ Bot 1:1**：一个通道只绑一个 Bot；同一个 Bot 可以被多个通道绑定（多对一允许）。
- **每个通道按 conversation 一条独立 Session**（否决「注入 Bot 私聊」）：外部消息带 `sender` 元数据、显式标记 `untrusted`；不写入 Bot 的长期记忆，不进用户私聊。
  - **新增 `channelSessionFor`**（不复用 `groupSessionFor`）：Forge 指出复用会把 room log、群提示、群 UI 和记忆 review 一起带进来。落地为 `store.js` 的 `channelOwners` map + 新文件 `src/host/channels.js`，并在 `memory.js` 把 channel session 排除出 memory review/注入。
  - **粒度**：按 conversation 区分——`dm:<senderHash>`（v1 只做创建者 DM）与 `group:<group_id>`（预留，P4 之后）。每通道最多 **8 个** conversation session，LRU 淘汰并归档；每条 session 的 owner 是当时绑定的 Bot。
  - 选择「专属 channel session」而不是「隐藏 room」：room 有成员/群渲染语义，隐藏 room 会牵动侧栏与会话列表；专属 session 不挂任何列表，影响面最小。
  - 消息注入用 `rt.deliver({ sessionId, toId: botId, text, role: 'request', exchangeId })`（`deliver` 已支持显式 sessionId），不调用 `rt.chatOf(botId)`。
  - **工具白名单默认空**（纯对话）：channel session 默认拿不到任何工具；预留 `allowReadTools`，v1 只允许 `web_search`。写/文件/bash/连接器写/记忆/`ask_user`/`request_secret`/Bot 管理全部 deny——即使模型想调用也不存在或直接被拒。
  - 需要框架补的小改动：`source` 上允许 `untrusted: true` 与 `sender`（现在的 source 字段是白名单的），见 §12。
- **串行处理**：同一通道内单飞行队列；一条入站处理完（回复或超时）才处理下一条。
- **回复关联键**：`msgId → exchangeId`。`deliver` 返回的 exchangeId 用于在该 Session 的 `session/event` 里认出对应的 `user/message`，再取紧随的 `turn/start` 的 turn 号，收集该 turn 内的 `assistant/message` 文本，`turn/end` 时用最后一段文本作为回复。超时 120s。
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

**state 新增命名空间 `state.channels`**（不改动已有连接器数据；读取时缺省为 `{}`，无版本号升级）。**不放 `state.connectors[id]`**：disconnect / set-settings 会重建那个对象，非框架字段会丢。

```
state.channels[instanceId] = {
  boundBotId,
  conversations: { "dm:<senderHash>": { sessionId, boundBotId, createdAt, lastUsedAt } },   // ≤8，LRU
  sessionHistory: [{ sessionId, botId, conversation, at, reason }],                          // 归档记录，最多 20 条
  seenMsgIds: [{ id, at }],                                                                   // 幂等环，最多 200 条
  status: { lastInboundAt, lastOutboundAt, lastError, lastErrorAt, retryAt }
}
```

- **幂等只按 `msgId`**（不看内容哈希）：同 `msgId` 重推 → `{ok:true, duplicate:true}`，不触发新轮次；用户手动重发同一句话是新 `msgId` → 正常触发。`seenMsgIds` 持久化在 `state.channels[instanceId]`，**重启后仍有效**（负例见 §11）。
- **不存正文**：`seenMsgIds` 只有 id 与时间；消息正文不写 state、不进日志。
- **凭据**：webhook secret / inbound token 在 DSH 凭据库；clawbot 凭据文件 0600。都不进 state、view、日志。
- **迁移**：0.2.0 已有 `instances`/`settings`/`connectorInstances`，WeChat 是新增模块，无旧数据迁移；只新增 `state.channels`，读不到就当空。

## 7. 安全红线

1. **不自动答应审批/提问**：入站消息触发的轮次里，如果 Bot 需要用户确认（审批卡/ask_user），微信侧只收到提示「请回 DS Bot 处理」，模块绝不代答、绝不 bypass。
2. **发送者 allowlist**：v1 只接受创建者本人；其他 sender 一律 403，不触发轮次。
3. **入站全验证**：HMAC + 时间戳 + nonce + 幂等 + 限速 + 路径白名单，任一失败零轮次。
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
13. **超时**：120s 无回复 → 504 + `code:'timeout'`，不重试、不重复投递。
14. **不代答审批**：入站触发需要审批的工具 → 微信侧收到「请回 DS Bot 处理」，审批卡未被自动回答、工具零调用。
15. **脱敏**：日志与 diagnostics 不含 sender 原文、正文、secret；state.json 不含正文与 secret。
16. **级别**：`read` 级无 `wechat_notify`；写等级别下审批卡出现且 allow 只执行一次、deny/超时/取消零请求。
17. **profile 关闭**：连接器整体 `false` 时无监听、无实例行。

## 12. 依赖框架的改动（Forge）

| 编号 | 改动 | 阶段 | 工作量 |
|---|---|---|---|
| F1 | `registry.js` 的 `checkInstances` 允许 `mode:'custom'` 使用 `instances`（凭据由模块自己管理，不要求 OAuth grant） | P1 阻塞 | ~0.5d |
| F2 | Channel session：`store.js` 的 `channelOwners`、新 `src/host/channels.js`（`channelSessionFor` 按 conversation 建/复用/LRU 归档）、`memory.js` 排除 channel session、`source` 允许 `untrusted`/`sender`、默认空工具白名单 + `allowReadTools` | P2 阻塞 | ~1d |
| F2b | 每实例凭据名：框架当前按全局字段名存 secret，两个实例会互相覆盖；加 `secretNameOf(id, field)`（如 `WECHAT_WEBHOOK_SECRET_WECHAT_2`） | P1 阻塞 | ~0.25d |
| F3 | 连接器 view 行支持模块 `status` 钩子（每实例状态卡数据） | P1 可选/P2 | ~0.25d |
| F4 | `readiness({ level, settings })` 增加只读的 `rt`（校验 `botId` 存在）；没有也可在 mount 时报错降级 | 可选 | ~0.25d |

没有 F1 之前，实例机制用不了，P1 只能先做单实例的骨架与出站实现（可并行，但不合主线）。

## 13. 分阶段计划与工作量

| 阶段 | 内容 | 工作量（人日） | 产出 |
|---|---|---|---|
| P0 | 本设计稿 | 0.5（今天） | 本文档 + 框架依赖清单 |
| P1 | **纯出站**：custom 实例、settings/凭据、`wechat_notify`（write + 审批）、readiness、状态卡字段、单测 | 1.5 | 可发通知的通道卡；出站单测 |
| P2 | webhook 入站：loopback 监听、HMAC/时间戳/nonce/幂等/限速/allowlist、绑定与专属 Session、串行队列、回复关联、换绑归档、端口降级、负例测试 | 2.5 | 同步收发的完整 webhook 通道；验收负例全绿 |
| P3 | clawbot 可行性（**不排开发**）：协议客户端 spike（mock）、QR 登录 CLI 原型、灰度/合规风险清单 | 2（验证） | 可行性报告 + 原型；等结论 |
| P4 | UI/媒体：卡片内嵌 QR、媒体收发（图片/文件，iLink CDN 加密）、状态卡细化 | 2–3 | 卡片与媒体能力 |
| P5 | QA/打包：门槛、smoke、证据（390/1280）、Harbor 交付、README/文档 | 1.5 | 可上线包 |

**排期**：核心 P1+P2 约 **4 人日**，按 4–6 天窗口排，**先不对外承诺**。P3 只做验证；P4/P5 在 P2 验收后再排。

**每日能出什么**

- D1：本设计稿 + 框架依赖（F1/F2）确认；P1 模块骨架（实例声明、settings、readiness、凭据注入）与单测骨架。
- D2：P1 完成——`wechat_notify` 出站 + 审批 + 错误映射 + 状态字段，P1 门槛全绿，发 Marshal/Forge review。
- D3：P2 监听与安全层（HMAC/时间戳/nonce/幂等/限速/allowlist）+ 负例 1–9。
- D4：P2 绑定与专属 Session、串行队列、回复关联、换绑归档、端口降级 + 负例 10–17。
- D5：P2 联调与证据、全量门槛、交给 Harbor 打包；P3 可行性 spike 启动（若 P1/P2 按计划完成）。
- D6（余量）：修复、文档、P3 spike 收尾。

**资源与优先级**

- 这条线主要由 Relay 承担；Forge 需投入约 1–1.5 人日做 F1/F2（可与 P1 并行）。
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
  - 文本字段空串 = 清空。
  - **已连接（ready/error）时改 `transport` 会被拒绝**，错误文案固定为 “Disconnect this channel before changing the transport.”；客户端先 `connector-disconnect` 再保存（与 Prism 方案一致）。
- `connector-disconnect { id }`：停监听/轮询，state 转 off；保留 settings 与凭据，供重连。
- `connector-create-instance { base:'wechat' }` / `connector-delete-instance { id }`：上限 8（min 1），实例 id 为 `wechat`、`wechat-2`…；删除时模块在 `close` 里清理该实例的凭据文件、secret 名与监听路由（best effort，失败只告警）。
- **新增** `connector-wechat-login { id, action:'start'|'refresh'|'cancel' }`：仅 clawbot；start 生成二维码（结果在 `login` 回，UI 轮询 state），refresh 换新码，cancel 清空；二维码 TTL 到期由宿主把 `login.state` 置为 `expired`，刷新走 refresh（不自动轮换）。
- `connector-set-level { id, level }` 不变。

**readiness 与级别**

- 缺 `botId`、Bot 不存在、webhook 模式缺 `webhookUrl`、clawbot 未登录：通过 `levelNotes` 给每级原因（read/write 可不同），客户端禁用 Connect 与 write 级并显示宿主原文。
- `levels[].description` 用上表的文案（write 明确写「每次审批」）。

**安全**

- `webhookSecret` 与 iLink token 永不下发明文；`inbound.token` 允许显示/复制。
- 二维码只接受 `data:image/png;base64,…`，客户端不请求外部图片域名。
