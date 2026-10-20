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
- 最终现网底座 `d51b7d8`（第一批已上线，含 rest-tools / 多字段凭据 / 卡片）：981 tests / 979 pass / 0 fail / 2 skipped，约 228 s；`build-client --check` 通过；`lint` 0 error（13 条 warning 全是既有文件）。14 条 ima 单测全跑（含适配器集成断言），registry 同时加载 `ima` 与 `neon`。
- 卡片客户端在 `d51b7d8` 上已支持多字段 `inputs`，且 `account` 为 null 时只显示 `Connected`（不再出现 "Connected as …"）。
- 门槛：`node scripts/build-client.mjs --check` 通过；`npm run lint` 0 error（14 条 warning 全是既有客户端文件，不在本次改动内）。
- 适配器集成（冻结点 `integ/connector-base-next` @ `100f603`）：9 个工具注册为 `ima_*`，逐条断言 host 只有 `ima.qq.com`、`POST`、两个 header + `ima-openapi-ctx`、body 只含映射字段（含 `query_info` 嵌套与 `target_content_format: 0` 常量）、`code=0` 解包、`20004/20002` 映射为工具错误。
- UI 证据（Prism 的卡片线 `feat/connector-cards`，宿主 mock，非真实库）：`shots/cards/ima-01-two-fields-{390,1280}.png`（Client ID / API key 两个 masked 输入、各自 label、只读说明）、`ima-02-ready-{390,1280}.png`（Connected，无 actions / toolbox）。md5：390 两图 `02ff12e5…` / `dbf4a6c5…`，1280 两图 `497cd039…` / `a7b654f8…`。
- 未做：真实 clientid/apikey 联调，以及「真实库一次工具调用」的截图（`ima_search_kb_list` 空结果）——要等底座 + 卡片合入、用户在卡片里填入 key 后才能拍，不截真实笔记内容。

## 后续：写能力盘点（只报清单，未排期）

官方 skill 包 1.1.10 共 17 个端点，除 `check_skill_update` 与 9 个只读调用外，全部可写端点如下。凭证是同一对 clientid/apikey，**没有只读 key 也没有 scope，写权限已经包含在凭证里**，所以「凭据够不够」一列都是「够」，不需要用户额外 OAuth 授权；真正的门是每次调用的审批卡，以及写操作**不可撤回**（没有任何 delete / update 端点）。

| 能力 | 端点 | 风险 | 凭据够 | 额外授权 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 新建笔记（仅 Markdown） | `note/v1/import_doc` | 中：创建内容，无法通过 API 撤回 | 够 | 无 | P0 |
| 追加到已有笔记 | `note/v1/append_doc` | 中高：污染已有正文，无回滚；单篇有大小上限（100009） | 够 | 无 | P1 |
| 笔记入库 | `wiki/v1/add_knowledge`（`media_type=11`） | 中：内容进入知识库可见范围 | 够 | 无 | P2（依赖 P0 或已有 note_id） |
| 导入网页/公众号文章 | `wiki/v1/import_urls` | 中：服务端抓取外部 URL；`folder_id` 必填，根目录传 kb id | 够 | 无（URL 来源由用户给） | P2 |
| 上传文件到知识库 | `wiki/v1/create_media` → COS 直传 → `wiki/v1/add_knowledge` | 高：读本地文件、出站到 `*.myqcloud.com`、临时 COS 凭据、类型/大小校验、不可撤回 | 够 | **需要**：本地文件读取 + COS 出站域名的显式同意（审批卡写清） | P3（工作量最大） |
| 写前选择目标库 | `wiki/v1/get_addable_knowledge_base_list` | 低（只读） | 够 | 无 | P1（配合写工具） |
| 写前重名检查 | `wiki/v1/check_repeated_names` | 低（只读） | 够 | 无 | P3（随文件上传） |
| 更新笔记正文 / 删除笔记 / 删除或移动知识库条目 / 重命名 / 删除知识库 / 分享权限 | — | 官方 1.1.10 **没有这些端点** | — | — | 不做，只能引导用户去 ima 客户端 |

写能力接入时的额外注意：① 错误码有两套（notes `SKILL.md` 用 `1000xx`/`310001`，`references/api.md` 用 `2100xx`），envelope 映射要把两套都补上；② 审批卡要展示目标（kb 名称/note 标题）、内容摘要与长度、URL 或文件名；③ 文件上传的 COS 临时凭证只留在宿主内存，不下发模型或 shell；④ 每次写调用单独获批，拒绝/超时一律不发送。

## 变更

- 2026-10-20：初版（声明 + 单测 + 设计说明）。
