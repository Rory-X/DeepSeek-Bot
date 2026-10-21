<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DeepSeek Bot" width="260">
  </picture>
</p>

# DeepSeek Bot

[English](README.md) | 中文

![版本](https://img.shields.io/badge/版本-v0.2_预览-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-4D6BFE) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green)

DeepSeek Bot（简称 DS Bot）是一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 dsh）的 bot 插件，插件将 dsh 改造为 bot 形式。你可以与自己创建的 bot 交流、工作。

![和 Chief 说一句话，它就把 bot 和群聊建好](docs/images/team.zh.png)

## 项目看板预览

项目看板功能分支为 DSH 已注册项目增加主导航看板，支持四列布局、待开始需求保存、一位主负责人和多位协作者。点击开始后建立需求专属任务对话；主负责人澄清并提交方案，用户批准后才开始实现。各 Bot 更新自己的步骤，多人任务由独立审查者复核，主负责人逐条附上验收证据和交付物。用户可以验收或退回修改，只有用户验收才标为完成。Bot 工具与界面共用带版本检查的工作流。

全局队列显示任务正在等待哪位 Bot 或哪个项目。每位 Bot 同时执行一项看板工作，同项目的实现任务依次进行。暂停和取消会停止新派发，并请求执行中的 DSH 回合停止；确认 Agent 空闲且其 DSH 管理的后台任务已停止后才释放执行名额。详情显示 shell 任务状态，包括前台超时转入后台的命令。硬重启可能丢失 DSH 进程内的任务注册表，此时保持阻塞；用户核实旧任务已停止并在详情中记录依据后，恢复工作仍须核对已产生的效果。取消保留文件与记录，不撤销外部操作。重启后先核对持久收件箱和公开会话记录，确认未送达才重发，已中断的工作建立恢复接续。Bot 必须检查并记录已有结果后才能继续修改文件。隔离 bench 使用脚本化 mock 模型验证真实工具流程，并对其专属 web 进程进行受保护的硬中断测试。见[设计与验收阶段](docs/plans/2026-10-20-project-board.md)。

## Bot 列表分组

主 Bot 或其他窗口修改分组后，已打开的 Bot 列表会自动更新。主 Bot 卡片之后依次显示所有置顶项、置顶分组、其他分组，再显示其他未分组项。组内 Bot 置顶后显示在分组上方，保留成员归属，取消置顶后回到原分组。展开的分组在最后一行可见 Bot 下方显示细分割线。分组右侧「…」菜单提供「置顶分组／取消置顶」「管理分组」和「解散分组」；解散后成员回归列表的正常排序，Bot 和聊天记录保留。

点击列表下方的「新建 Bot 分组」，或 Bot 菜单里的「移入分组…」，按工作内容整理 Bot。勾选成员并保存后，列表以 `connector` 这样的小字标题呈现分组，标题不显示数量，点击即可折叠或展开。成员归属在重启后保留，折叠状态由各浏览器记忆。可以修改组名和成员，空组可删除；Bot 的聊天和运行中的工作照常继续。

主 Bot 可先用 `list_bots` 和 `list_bot_folders` 查看职责与分组，再调用 `organize_bots`：`action: "assign"`、`folder: "connector"`、`bots` 中填写 Bot 名称，即可创建或复用分组并一次归入所有成员。分组名留空会将指定 Bot 移出分组。同一工具也支持对现有组名传入 `action: "pin"`、`"unpin"` 或 `"dissolve"`，完成置顶、取消置顶和解散；解散保留所有 Bot 和聊天记录。只有主 Bot 能通过工具整理团队；列表分组与群聊、项目无关。见[设计说明](docs/plans/2026-10-20-bot-folders.md)。

## 安装

**桌面应用（Windows、macOS）**

桌面应用自带 dsh，不用先装 dsh。在 [Releases](https://github.com/Fei2411/DeepSeek-Bot/releases) 里下载：

- Windows（x64）：`DeepSeek-Bot-<版本>-win-x64.exe`。运行它即可安装，只装给当前用户，不要管理员权限。如果提示“Windows 已保护你的电脑”，点 **更多信息** → **仍要运行**。
- macOS：Apple 芯片下载 `DeepSeek-Bot-<版本>-mac-arm64.zip`，Intel 下载 `DeepSeek-Bot-<版本>-mac-x64.zip`。Safari 会自动解压；把 **DeepSeek Bot** 拖进 **应用程序**，再打开。如果提示无法检查这个 App，打开 **系统设置** → **隐私与安全性**，点 **仍要打开**。

第一次打开时，App 会问数据和 Bot 的文件放在哪里，并可以从你的 dsh 复制 Bot 团队（只读取你的 dsh，不改它）。在 App 的设置里配好模型就能用。Windows 版会自动更新；macOS 版有新版本时会提示你下载。

**作为 dsh 插件**

先装好 dsh，并在 dsh 里配好至少一个模型。ds bot 直接使用 dsh 里的模型。

**dsh Desktop（Windows、macOS）**

1. 侧栏点 **插件** → **添加插件**。
2. **包名或地址** 填 `ds-bot`。在中国大陆，**安装源** 选 **中国大陆镜像源**。
3. 点 **安装**，再点 **立即启用**。如果提示“下次启动生效”，完全退出 dsh 再打开。

连不上 npm 时，第 2 步也可以填 [Releases](https://github.com/Fei2411/DeepSeek-Bot/releases) 里下载的 `ds-bot-0.2.0.tgz` 的完整路径，或者 `github:Fei2411/DeepSeek-Bot#v0.2.0&path:/ds-bot`（需要装 Git）。

**dsh Web（Windows、macOS、Linux）**

需要 Node.js `22.19` 以上和 pnpm。

```sh
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.1-rc.2 web
```

**Docker（NAS、Linux 服务器）**

[`docker/`](docker/) 目录构建一个带 dsh Web 和 DS Bot 的镜像，适合 NAS 或其他常开的机器。CI 已配置为向 GHCR 发布 linux/amd64 预构建镜像。容器就是 bot 的沙箱：bot 对挂进容器的目录有完全权限，其他的碰不到。见 [`docker/README.md`](docker/README.md)（英文）。

## 配置

我强烈建议你直接通过和 bot 对话来配置其他 bot 和群聊。

## 功能

### Bot

你可以在一个窗口中和一个 bot 完成所有对话和工作，你无需担心背后的上下文问题。你可以在 bot 详情页查看 bot 信息，也可以为 bot 选择你想使用的模型。你可以随时切换模型，但我仍然建议你为一个 bot 长期保持一个模型，仅在真正必要的时刻切换。

另外，bot 拥有记忆，它会记住你的喜好并在下次的工作中应用。你可以在 bot 的详情页管理记忆，也可以直接和 bot 对话来进行管理。

![bot 详情页：模型、记忆、用量](docs/images/details.zh.png)

### Main bot

这个 bot 作为你的 chief，它拥有非常高的权限，可以管理其他 bot 和群聊。第一次进入 ds bot 时，默认会有一个 main bot 叫 Chief。你可以直接和它对话，让它引导你完成配置。

总之，有问题，找 main bot。

### 群聊

ds bot 拥有群聊功能。群聊是非常好的多 bot 协作方式，但它会带来非常明显的费用问题。ds bot 为此特意做了优化：在一个群聊中，你需要设置一个管理员。你的消息默认由管理员回复，它会帮你调用其他 bot。你也可以直接 @ 你需要沟通的 bot，它会直接回应你：输入 @，从列表里选 bot 就行。想让 bot 参考另一段对话，点输入框的 + → 引用对话。

任何 bot 都可以用 @ 把活派给另一个 bot。接活的 bot 自己去做，群聊照常进行。它干活时会在群里同步进度，群聊、侧边栏和它自己的聊天里也能看到它在做什么。做完后，它把结果发到群里，由派活的 bot 接着回应。要停下它的工作，打开群聊详情。

![群聊：管理员 Chief 把活派给写手和程序员](docs/images/group.zh.png)

### 能力

设置 → **能力** 是团队共享的 MCP 服务、技能和能力包列表。在 Bot 设置中启用能力后，从该 Bot 下一条消息开始生效，也适用于它参与的群聊。Bot 添加的本地 MCP 命令需要你先批准才能运行。有其他 Bot 在用的能力，只有你或主 Bot 能修改、删除。

### 连接器

设置 → **连接器** 可以连接外部服务，连接后每个 bot 都能使用该服务的工具。GitHub（`GITHUB_TOKEN`）或 Vercel（`VERCEL_TOKEN`）只需连接一次：token 保存在密钥里，只在 MCP 连接中使用。GitHub 的工具名是 `mcp__github__…`；Vercel 只读连接，工具如 `vercel_list_projects`、`vercel_get_runtime_logs`。Vercel 的四个部署动作默认关闭：在连接器里打开后，每次调用前会在聊天里显示一张审批卡（允许一次 / 拒绝），不批准就什么都不会发出。另有一个工具箱开关，打开后会加上 `vercel_search_tools` 和 `vercel_call`，用搜索触达 Vercel 的全部能力；写操作仍需在这张卡上批准，会返回凭据或环境变量值的工具一律不提供。**Cloudflare** 用 OAuth 连接：点 Connect，在 Cloudflare 页面上同意只读权限即可，授权保存在 DSH 的凭据存储里而不是密钥里。它挂载 14 个具名只读工具（`cloudflare_get_zones`、`cloudflare_get_zones_dns_records`、分析类与 Workers 读取等）。可选的 **Full capabilities** 开关会加上 `cloudflare_search_tools` / `cloudflare_call`，覆盖服务器全部端点：GET/HEAD 直接读，任何写操作都先在审批卡上批准，会铸造或读取凭据的端点一律不提供；不走 Cloudflare 的代码执行工具。 **微信**是通道类连接器：每个通道绑定一个 Bot，通过 webhook 发通知（每次发送前都会在审批卡上确认）；在卡片上保存 **Webhook secret** 后，它还会在 `127.0.0.1:8799` 上监听入站消息（`POST /wechat/<实例>/inbound`，用同一个 secret 签名）。推送 webhook URL 按凭据保存，卡片只显示是否已保存；不配 secret 时通道仍可发通知但不开端口，移除或禁用通道会关闭端口。


#### Telegram 通知

Telegram 用你自己的 bot 发出 Bot 被要求发送的消息。

1. 打开 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，复制它给你的 token。
2. 设置 → **连接器** → **Telegram**：粘贴 token，点 **Connect**。Telegram 接受 token 后，卡片上会显示 bot 的 username。
3. 在 Telegram 里先给你的新 bot 发一条任意消息，然后点 **Test message**。连接器会找到这个私聊并向它发送一条测试消息。
4. 如果 bot 收到多个 chat，或者你想发给群：在卡片上手动填 chat id（数字，群是负数），再点一次 **Test message**。留空会清除它。

连接完成后，Bot 用 `notify_telegram(text)` 发消息，最多 4,096 字符。token 只放在密钥里，不会出现在 view、团队文件或日志中。

### 用量

在 设置 → 用量 里，可以按时间、按 bot、按模型查看 Token 用量。

![用量页](docs/images/usage.zh.png)

## 数据

所有数据都在你自己的电脑上，在 dsh 主目录（默认 `~/.dsh`）的 `bot/` 和 `sessions/` 里。卸载插件不会删除这些数据。

## 开发

插件源码在 [`ds-bot/`](ds-bot/)。配置项和内部结构见 [`ds-bot/README.md`](ds-bot/README.md)，开发、测试和协作方式见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：ds bot 建在 dsh 的插件系统上。每个 bot 都在 dsh 会话里工作，用的是 dsh 的工具和模型。
- [esbuild](https://esbuild.github.io/)：用来打包插件的界面代码。
- 感谢下面这些项目公开的设计思路。ds bot 参考了它们的思路，没有使用它们的代码：
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo)：bot 记忆的 Markdown 格式。
  - [OpenAI Codex](https://github.com/openai/codex)：压缩时把用户原话留在摘要旁边，以及搜索聊天记录用的消息锚点。
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮流发言和 @ 接力。
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) 和 [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：每个成员在每个群里一个会话，以及交接时带上用户之前的原话。
  - [OpenCode](https://github.com/sst/opencode)、[goose](https://github.com/block/goose)、[pi](https://github.com/badlogic/pi-mono)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)：长对话什么时候压缩，交接笔记写哪些内容。
  - [obelisk](https://github.com/tommy0103/obelisk)：用 SQLite 全文索引搜索聊天记录。
- 每一位试用 ds bot、提问题、报 bug 的人。

## 许可

[Apache License 2.0](LICENSE)。按“原样”提供，不附带任何担保。用到的第三方代码和它的许可见 [NOTICE](NOTICE)。

## 声明

ds bot 是独立的社区项目，**不是 DeepSeek 官方产品**，与 DeepSeek 没有隶属、认可或赞助关系。“DeepSeek”“DeepSeek Harness”等名称是各自所有者的商标，这里只用来说明本插件和什么一起用。

bot 会消耗你自己的模型额度，也会按你的要求读写文件、运行命令。重要的操作请自己检查。
