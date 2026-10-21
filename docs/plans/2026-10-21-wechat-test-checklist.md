# 微信连接器测试清单（P1 / P2）

- 日期：2026-10-21
- 对应设计：`docs/plans/2026-10-21-wechat-connector.md`
- 用例骨架：`ds-bot/test/wechat.test.js`（`test.todo` 占位）+ 测试替身 `ds-bot/test/wechat-fakes.js`（loopback webhook 接收器、双向签名、`until`）
- 范围：P1 纯出站；P2 通用 JSON 入站 + HMAC。企业微信应用 callback 不做（设计 §3.3）；clawbot 只有可行性 spike，不在本清单。

## P1 用例（纯出站 + 卡片 + 设置）

| ID | 场景 | 期望 |
|---|---|---|
| P1-01 | 实例：创建 `wechat-2`、删除、再建第 9 个 | 前两者成功；第 9 个返回宿主原文，客户端禁用 Add |
| P1-02 | 卡片字段描述符 | `fields` 带 `kind`（text/secret/bot/segmented）；`webhookSecret` 只有 `saved`，无 value |
| P1-03 | readiness 四缺 | 缺 `botId` / Bot 被删 / 缺 `webhookUrl` / 缺 secret → `levelNotes` 各给一句，无 Connect |
| P1-04 | `connector-connect` webhook | 转 `ready`；`canTest:true`；P1 无 `inbound` 字段 |
| P1-05 | `wechat_notify` 级别 | 仅 write 级注册；line 含通道名与 webhook host，不含完整 URL/secret |
| P1-06 | 审批四路 | allow 只 POST 一次；deny/dismiss/timeout/cancel 各 0 请求 |
| P1-07 | 出站错误映射 | 401/403/404/429/其它 → 固定文案；不含 URL、secret |
| P1-08 | 文本限长 | generic >4000 / wecom >2048 → 先报错，0 请求 |
| P1-09 | 已连接改 transport | 拒绝，文案 `Disconnect this channel before changing the transport.`；disconnect 后可保存 |
| P1-10 | `connector-test` | POST 固定测试通知；成功/失败都返回整个 view；失败 state 仍 ready、error 原文 |
| P1-11 | 删除实例 | 停监听/清 secret（F2b 命名）；另一个实例仍 ready |
| P1-12 | profile `wechat:false` | 无行、无端口、无 secret 读写 |
| P1-13 | `connector-set-settings` 的 `clearSecrets:['webhookSecret']` | secret 被清除，`fields.saved` 转 false；文本空串仍只清文本 |
| P1-14 | F2b 命名不变量（独立用例） | ①首实例裸名；②`wechat-2` 派生 `_2`；③两实例 secret 共存互不覆盖；④删 `wechat-2` 不影响首实例（secret 与 view 都在） |

## P2 用例（入站监听、绑定、回复）

| ID | 场景 | 期望 |
|---|---|---|
| P2-01 | 监听地址 | 断言 `127.0.0.1`；无任何配置可变成 `0.0.0.0` |
| P2-02 | 端口被占 | 该通道 `error`（含端口与改法）；插件正常启动；其他连接器 ready |
| P2-03 | `dispose` 零路由 | 端口 `ECONNREFUSED`；DSH 路由表无任何 wechat 路径 |
| P2-04 | HMAC 缺失/错 | 401 `bad-signature`；0 轮次 |
| P2-05 | 时间戳超窗（±300s） | 401 `stale-timestamp`；0 轮次 |
| P2-06 | nonce 重放 | 401 `replayed-nonce`；0 轮次 |
| P2-07 | msgId 重推（含重启后） | 200 `{ok:true,duplicate:true}`；0 新轮次；重启后仍吞掉 |
| P2-08 | 新 msgId 同文本 | 正常触发一轮（不做内容哈希） |
| P2-09 | 超限速 | 429 + `retry_after`；0 轮次 |
| P2-10 | sender 不在 allowlist | 403 `sender-not-allowed`；0 轮次 |
| P2-11 | Bot 被删/轮次失败 | 502 `bot-unavailable` + 回落文案；不无限重试 |
| P2-12 | 两条入站串行 | 回复分别对应各自 msgId（`msgId→exchangeId→turn→turn/end`） |
| P2-13 | 120s 无回复 | 504 `timeout`；不重投 |
| P2-14 | 换绑 A→B | 旧 session 全部归档并留记录；B 用新 session；在途 503 `channel-rebound` |
| P2-15 | 入站触发审批 | 微信只收到「请回 DS Bot 处理」；审批卡未被回答；工具 0 调用 |
| P2-16 | 脱敏 | 日志/diagnostics/state.json 无 sender 原文、正文、secret；sender 只有哈希/长度 |
| P2-17 | read 级入站 | 入站可收发；`wechat_notify` 未注册 |
| P2-18 | `connector-command` 边界 | 未声明的 action / 参数不合法 / 非 clawbot 调 `login-*` → 拒绝；不允许任意 action 透传 |
| P2-19 | 体积与回调地址 | body 超 64KB 流式累计即拒（含 chunked）；`callbackUrl` 只接受 https 或三个 loopback 字面值 |
| P2-21 | Bearer 开关 | 默认关：不带 Bearer 也通过（只要有 HMAC）；打开后缺/错 Bearer → 401 |
| P2-20 | 可见性隔离 | 外部消息不出现在 search / `read_own_chat` / 会话索引 / 侧栏 / 工作区列表；其它 session 看不到 |
| P2-22a | 记忆面隔离 | channel session 不进 memory review 枚举、不注入记忆 prompt、不写 MEMORY.md |
| P2-22b | parts 隔离 | `parts.js` 的 checkpoint/segment 排除 channel session |
| P2-23 | 单 conversation | 每个通道只有创建者 DM 一条 conversation session；不会为 group 预建会话 |
| P2-24 | 工具与消息头 | channel session 无任何工具（allowReadTools 只放 `web_search`）；denylist 各项不可用；注入正文含 `untrusted` 段 |
| P2-25 | 异步与 `wait` | **= P2-13a + P2-13b**：默认 202 + 回调（HMAC/msgId 幂等）；`wait` ≤20s 内 200 且不发回调；同步超时 504 `code:'timeout'`，异步 120s 未完成发 failure callback |
| P3-01 | token 与合规 | token 只在 0600 文件或凭据库，state/日志/设置页无明文；未获用户明确同意时 P3 不启用 |

## 错误文案矩阵（宿主给用户/调用方的原文）

**卡面 readiness 与挂载错误（英文，卡片显示）**

| 情况 | 文案 |
|---|---|
| 未选 Bot | `Choose a Bot for this channel.` |
| Bot 被删 | `The Bot this channel is bound to no longer exists. Choose another Bot.` |
| 缺 webhook URL | `Add the push webhook URL for this channel.` |
| 缺 webhook secret | `Add a webhook secret for this channel before it can receive messages.` |
| 端口被占 | `The inbound port <port> is already in use. Change wechat.listenPort in the profile or stop the process using that port.` |
| clawbot 未登录 | `This ClawBot channel is not logged in. Paste its bot token in the channel settings.` |
| 改 transport（已连接） | `Disconnect this channel before changing the transport.` |

**入站 HTTP（JSON `{ok:false, code, message}`）**

| 状态 | code | message |
|---|---|---|
| 401 | `bad-token` | `The inbound token did not match.` |
| 401 | `bad-signature` | `The request signature did not match.` |
| 401 | `stale-timestamp` | `The request timestamp is outside the accepted window.` |
| 401 | `replayed-nonce` | `This request was already seen.` |
| 403 | `sender-not-allowed` | `This sender is not allowed to talk to this channel.` |
| 404 | `not-found` | （路径白名单外，不回内部信息） |
| 429 | `rate-limited` | `Too many messages; try again later.`（带 `retry_after` 秒） |
| 502 | `bot-unavailable` | `The Bot is not available right now; try again later.` |
| 503 | `channel-rebound` | `This channel was rebound to another Bot; send the message again.` |
| 504 | `timeout` | `The Bot did not answer in time.` |
| 200 | — | `{ok:true, msgId, reply}`；重复入站为 `{ok:true, duplicate:true, msgId}` |

**出站（`wechat_notify` 与 `connector-test`）**

| 情况 | 文案 |
|---|---|
| 401/403 | `The webhook refused the credential.` |
| 404 | `The webhook URL was not found.` |
| 429 | `The webhook is rate-limited; try again in <n>s.` |
| 其它状态 | `The webhook answered <status>.` |
| 网络失败 | `Could not reach the webhook.` |

## 验证方法备注

- 重启后幂等：构造 `state.channels[id].seenMsgIds` 持久化文件 → 重新 `apply()` → 用同 msgId 入站 → 断言 `duplicate` 且 `tools/call` 计数 0。
- 端口被占：测试里先 `listen` 同端口再 `apply()`；断言通道 error、其他连接器 ready、`apply()` 不抛。
- 零路由：`ctx.dispose()` 后 `fetch` 端口应 `ECONNREFUSED`；同时检查 DSH 侧 `connection.fetch` 路由表无 wechat 路径（用 fakeContext 记录）。
- 审批不代答：入站消息触发需要审批的工具 → 等微信侧提示文本出现，断言 `state.questions` 未被回答、工具 0 调用。


## 清单 ID ↔ 测试名 ↔ 文件行（P2 验收前定稿）

测试文件：`ds-bot/test/wechat.test.js`（行号基于 P1 tip；改文件后需同步本表）。`pass` = 已转绿，`todo` = P2 待实现。
两个 fakes 自测不计入清单 ID：`fakes: signed request verifies`（第 93 行）、`fakes: one signature both directions`（第 103 行），均 pass。

| 清单 ID | 测试函数名 | 行 | 状态 | 覆盖断言 |
|---|---|---|---|---|
| P1-01 | P1-01 a channel is one instance: create adds wechat-2, delete removes it, the ninth is refused | 114 | pass | 实例上限/创建/删除/第九个拒绝 |
| P1-02 | P1-02 the row carries the channel settings and never a secret value | 130 | pass | settings 行与 secret 不下发 |
| P1-03 | P1-03 readiness names the missing field and a deleted Bot is a mount error | 144 | pass | readiness 文案 + Bot 不存在挂载错误 |
| P1-04 | P1-04 connect turns the channel ready and P1 has no inbound field | 166 | pass | connect 后 ready、P1 无 inbound/login |
| P1-05 | P1-05 wechat_notify asks first, runs once on allow and never on deny | 177 | pass | 审批卡、allow 一次、deny 零请求 |
| P1-06 | P1-06 outbound errors map to the fixed sentences and over-long text fails first | 205 | pass | 错误映射 + 4000/2048 限长 |
| P1-07 | P1-07 transport change while ready: needs a host settings-change hook (open gap with Forge, P2 blocker) | 235 | todo | 待 host settings-change 钩子（P2 阻塞） |
| P1-10 | P1-10 deleting an instance stops its mount and leaves the other channel ready | 236 | todo | 删实例只停自己（todo） |
| P1-11 | P1-11 profile wechat:false hides the rows and opens nothing | 237 | todo | profile false（todo） |
| P1-12 | P1-12 an empty text field clears its stored value | 238 | pass | 文本空串清空 |
| P1-08 | P1-08 connector-test posts the fixed notice and a failure stays on the row | 250 | pass | test 钩子成功/失败/清 error |
| P1-09 | P1-09 a secret saved on the card shows saved, never a value, and clearSecrets removes it | 273 | pass | secret saved / 不下发值 / clearSecrets |
| P1-14 | P1-14 F2b naming invariants: bare first, _2 second, coexist, delete only its own | 291 | pass | F2b 命名不变量四条 |
| P1-15 | P1-15 the F5 card shape: field kinds, level descriptions, canTest and instance.max | 314 | pass | F5 卡片 shape（fields kind/levels/canTest/instance.max） |
| P1-13 | P1-13 two channels keep separate secrets: wechat-2 writes _2 and deleting it touches only its own | 333 | pass | 两通道 secret 共存 + 各自签名 + 删实例只删自己 |
| P2-01 | P2-01 the listener binds 127.0.0.1 only: address is asserted, and no configuration can make it 0.0.0.0 | 371 | todo | 监听地址 127.0.0.1 |
| P2-02 | P2-02 a taken port leaves only that channel error with port and fix; the plugin boots and other connectors are ready | 372 | todo | 端口被占降级 |
| P2-03 | P2-03 dispose closes the listener and unregisters every route: the port refuses connections, nothing stays in the route table | 373 | todo | dispose 零路由 |
| P2-04 | P2-04 a missing or wrong HMAC signature answers 401 bad-signature and starts 0 Bot turns | 374 | todo | HMAC 401 |
| P2-05 | P2-05 a timestamp outside ±300s answers 401 stale-timestamp and starts 0 turns | 375 | todo | 时间戳 401 |
| P2-06 | P2-06 a replayed nonce answers 401 replayed-nonce and starts 0 turns | 376 | todo | nonce 401 |
| P2-07 | P2-07 a replayed msgId answers 200 duplicate and starts 0 turns; after a plugin restart it is still swallowed | 377 | todo | msgId 幂等（含重启） |
| P2-08 | P2-08 the same text under a new msgId starts a turn (no content-hash swallowing) | 378 | todo | 新 msgId 同文本触发 |
| P2-09 | P2-09 over the per-channel rate limit answers 429 with retry_after and starts 0 turns | 379 | todo | 429 限速 |
| P2-10 | P2-10 a sender outside the allowlist answers 403 sender-not-allowed and starts 0 turns | 380 | todo | 403 发送者 |
| P2-11 | P2-11 a deleted or failing Bot answers 502 bot-unavailable with the fallback sentence and no retry loop | 381 | todo | 502 Bot 不可用 |
| P2-12 | P2-12 two inbound messages are serialized: each reply answers its own msgId, correlated to that turn end | 382 | todo | 串行与回复关联 |
| P2-13a | P2-13a a synchronous wait over 20s answers 504 timeout; P2-13b an async turn over 120s sends a failure callback | 383 | todo | 同步 wait 504 |
| P2-14 | P2-14 rebinding A->B archives the A session, creates a new session for B, and answers in-flight requests 503 channel-rebound | 384 | todo | 换绑归档/新 session/503 |
| P2-15 | P2-15 an inbound turn that needs approval gets the WeChat notice only: the card stays unanswered and the tool runs 0 times | 385 | todo | 审批不代答 |
| P2-16 | P2-16 logs, diagnostics and state.json carry no sender text, no message body and no secret | 386 | todo | 日志/state 脱敏 |
| P2-17 | P2-17 the read level still answers inbound while wechat_notify stays unregistered | 387 | todo | read 级入站 |
| P2-18 | P2-18 an unsupported connector-command action is refused: per-action allow-list, args checked, login-* only on clawbot | 388 | todo | connector-command 白名单/参数/transport |
| P2-19 | P2-19 body over 64KB is refused while streaming (chunked included) and callbackUrl outside the loopback literals is refused | 389 | todo | 流式 64KB + callbackUrl loopback |
| P2-20 | P2-20 visibility: channel sessions never appear in search, read_own_chat, the index, the sidebar or another session | 390 | todo | 可见性隔离 |
| P2-21 | P2-21 HMAC is mandatory and Bearer optional (default off); with Bearer on, a missing one answers 401 | 391 | todo | HMAC 必选/Bearer 可选 |
| P2-22a | P2-22a memory: no review enumeration, no memory prompt injection and no MEMORY.md entry for channel sessions | 392 | todo | memory review/prompt/MEMORY.md 排除 |
| P2-22b | P2-22b parts: channel sessions are excluded from checkpoints and segments | 393 | todo | parts/checkpoint 排除 |
| P2-23 | P2-23 v1 keeps exactly one conversation session (the creator DM); no group session is pre-created | 394 | todo | 单 conversation |
| P2-24 | P2-24 the tool denylist holds and untrusted travels in the headerFor message header | 395 | todo | denylist + headerFor untrusted |
| P2-25 | P2-25 is covered by P2-13a + P2-13b (async 202 plus callback, wait cap, 504) | 396 | todo | = P2-13a/13b |

**偏差与别名**：P2-25 由 P2-13a + P2-13b 覆盖，不单列；P2-20 管「可见性」，P2-22a 管「记忆 review/注入/MEMORY.md」，P2-22b 管「parts/checkpoint」；P1-07 因缺 host 的 settings-change 钩子暂为 todo（已报 Forge，P2 前置）。
