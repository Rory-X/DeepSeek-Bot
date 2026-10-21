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
| P1-14 | 两个实例的 secret 命名 | 首实例裸名、`wechat-2` 为 `_2`；两实例互不覆盖；删 `wechat-2` 只删自己的 secret |

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
| P2-21 | Bearer 开关 | 默认关：不带 Bearer 也通过（只要有 HMAC）；打开后缺/错 Bearer → 401 |
| P2-22 | 隔离面 | 外部消息不出现在 search / `read_own_chat` / 会话索引 / MEMORY.md / 侧栏 / 工作区列表；其它 session 看不到 |
| P2-23 | 单 conversation | 每个通道只有创建者 DM 一条 conversation session；不会为 group 预建会话 |
| P2-24 | 工具与消息头 | channel session 无任何工具（allowReadTools 只放 `web_search`）；denylist 各项不可用；注入正文含 `untrusted` 段 |
| P2-25 | 异步与 `wait` | 默认 202 + 回调（HMAC/msgId 幂等）；`wait` ≤20s 内 200 且不发回调；超时 504 `code:'timeout'` 且仍发回调 |
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
