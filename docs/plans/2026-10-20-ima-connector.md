# ima 连接器（只读）

- 日期：2026-10-20
- 相关：连接器六条线之一（ima），框架基座见 `2026-10-20-connector-modules.md`（Forge 分支）

## 为什么

用户要接腾讯 ima（ima.copilot 笔记 / 知识库）。官方 skill 包 1.1.10 的接口文档与端点探测确认：ima 有官方 OpenAPI，没有 MCP、没有 OAuth、没有 DCR / scope，只有一对长期凭证（client id + API key）和 `ima-openapi-clientid` / `ima-openapi-apikey` 两个 header。读取面清楚（笔记 4 个、知识库 5 个），写入面也存在，而这对凭证**本身带写权限**，服务端没有只读 key。所以只读只能由我们裁：只声明读调用，写端点一个都不映射，模型就没有可调用的写入路径。

## 已定的行为

- 连接器 id `ima`，mode `rest-tools`，声明文件 `ds-bot/src/host/connectors/ima.js`。
- 只读工具 9 个，工具名 `<id>_<name>`：

| 工具 | 端点 | 用途 |
| --- | --- | --- |
| `ima_search_notes` | `/openapi/note/v1/search_note` | 按标题或正文搜笔记 |
| `ima_list_notebooks` | `/openapi/note/v1/list_notebook` | 列笔记本（cursor 首页 `"0"`） |
| `ima_list_notes` | `/openapi/note/v1/list_note` | 列笔记（cursor 首页 `""`，可按 notebook 过滤） |
| `ima_get_note` | `/openapi/note/v1/get_doc_content` | 读笔记纯文本（`target_content_format=0`） |
| `ima_get_kb` | `/openapi/wiki/v1/get_knowledge_base` | 按 id 读知识库信息（1–20 个） |
| `ima_list_kb` | `/openapi/wiki/v1/get_knowledge_list` | 浏览知识库 / 文件夹（limit 1–50） |
| `ima_search_kb` | `/openapi/wiki/v1/search_knowledge` | 知识库内搜索 |
| `ima_search_kb_list` | `/openapi/wiki/v1/search_knowledge_base` | 按名查知识库；`query:""` 列出全部 |
| `ima_get_media` | `/openapi/wiki/v1/get_media_info` | 取原文入口；笔记型返回 `notebook_id` 再走 `ima_get_note` |

- 出站只有 `https://ima.qq.com`。文件上传才需要 COS（`*.myqcloud.com`），只读路线用不到，声明里没有上传相关调用。
- 鉴权：两个 header + `ima-openapi-ctx: skill_version=1.1.10`。连接器用 `credentials` 声明两个 secret 输入：`IMA_OPENAPI_CLIENTID`（Client ID）与 `IMA_OPENAPI_APIKEY`（API key）；两个都只进请求头，不写 state / view / diagnostics。
- 回包是 `{ code, msg, data }`，声明为连接器 `envelope`：`code=0` 取 `data`；`code≠0` 抛错，不把失败当工具结果（`20004` / `200002` 鉴权、`20002` / `110021` 限频、`110030` / `210005` / `210011` / `210034` 无权限、其余带 code 与原文）。
- 连接校验（verify）：`search_knowledge_base` 发 `{query:"",cursor:"",limit:1}`，`code=0` 即通过。ima 没有 whoami 接口，所以卡片不显示账号名。
- 测试：`ds-bot/test/ima.test.js`，mock fetch 覆盖成功 / 401 / 超时 / 断网 / 业务码 / 半填凭据 / 非信封回包，并静态断言「写入端点不在声明里」「body 只发映射过的字段」。

## 不做什么

- 不注册写调用：`import_doc`、`append_doc`、`create_media`、`add_knowledge`、`import_urls`；`check_repeated_names`、`get_addable_knowledge_base_list` 只是写前预检，也不注册。
- 不做文件上传 / COS 直传，不保存媒体临时凭证。
- 不把笔记正文主动发到群聊；工具结果只返回给发起调用的会话。

## 已知限制

- 凭证是长期 bearer 且带写权限，只读是客户端白名单保证，不是服务端保证。
- 限频只有 `20002` 这个码，数值未公开；鉴权失败实测出现过 `200002`（HTTP 401），文档写 `20004`，两种都按鉴权失败处理。
- `search_notes` 的请求体需要嵌套 `query_info: { title, content }`，声明用点号键 `"query_info.title"` 表达；冻结底座 `integ/connector-base-next` 的 `requestBody` 已支持点号嵌套（`setPath`），实测发出 `{"query_info":{"title":…,"content":…}}`。
- 卡片无账号名：ima 没有 whoami 接口，`verify` 只回 `{ ok: true }`；卡片应显示「已连接」，不显示账号。
- 真实 key 下的联调未做；mock 只覆盖协议形状，不覆盖 ima 真实字段演进。
- `list_note` 的翻页游标语义文档没写清（响应无 `next_cursor`），先按「传 `""` 起页、再传上次结果」声明，联调时校正。

## 证据（2026-10-20）

- 单测：`node --test test/ima.test.js` → 14 tests / 14 pass / 0 fail；覆盖成功、401、超时、断网、业务码、半填凭据、非信封回包、写入端点缺席、body 只发映射字段，以及「声明 → 冻结底座适配器」的 9 个工具挂载、逐条请求与错误映射。
- 底座上（`094ea60`）：861 tests / 861 pass / 0 fail，约 215 s；此时 14 条 ima 单测全跑，含「声明 → 适配器」集成断言。
- 现网主线 `26c61ae`（Bot 文件夹版，不含连接器底座）：928 tests / 923 pass / 0 fail / 5 skipped，约 270 s；`build-client --check` 通过；`lint` 0 error（12 条 warning 全是既有文件）。跳过的 5 条里有 3 条是 ima 的适配器集成断言——主线还没有 `rest-tools.js`，声明本身仍是可加载的独立模块，等底座 rebase 到新主线后这些断言自动恢复执行。
- 门槛：`node scripts/build-client.mjs --check` 通过；`npm run lint` 0 error（14 条 warning 全是既有客户端文件，不在本次改动内）。
- 适配器集成（冻结点 `integ/connector-base-next` @ `100f603`）：9 个工具注册为 `ima_*`，逐条断言 host 只有 `ima.qq.com`、`POST`、两个 header + `ima-openapi-ctx`、body 只含映射字段（含 `query_info` 嵌套与 `target_content_format: 0` 常量）、`code=0` 解包、`20004/20002` 映射为工具错误。
- UI 证据（Prism 的卡片线 `feat/connector-cards`，宿主 mock，非真实库）：`shots/cards/ima-01-two-fields-{390,1280}.png`（Client ID / API key 两个 masked 输入、各自 label、只读说明）、`ima-02-ready-{390,1280}.png`（Connected，无 actions / toolbox）。md5：390 两图 `02ff12e5…` / `dbf4a6c5…`，1280 两图 `497cd039…` / `a7b654f8…`。
- 未做：真实 clientid/apikey 联调，以及「真实库一次工具调用」的截图（`ima_search_kb_list` 空结果）——要等底座 + 卡片合入、用户在卡片里填入 key 后才能拍，不截真实笔记内容。

## 变更

- 2026-10-20：初版（声明 + 单测 + 设计说明）。
