# WeRead 连接器：声明清单（给 QA 的验收底稿）

> 用于 Probe 的只读核对。源码只有两个文件：`ds-bot/src/host/connectors/weread.js`、
> `ds-bot/test/weread.test.js`（另有截图脚本 `ds-bot/dev/shots-weread.mjs`）。本文不是设计文档，
> 只记录「接了什么、拒了什么、边界在哪」。
> 分支 `feat/connector-weread`，基于第二批底座 `5abb19b`（= `d51b7d8` + `resultMax` 修复）。
> 适配器用例在底座缺席的中间 rebase 上会自动 skip，底座在场时全跑。

## 1. 形态

- `mode: 'rest-tools'`，`api: 'https://i.weread.qq.com'`，所有工具同一个走位：
  `POST /api/agent/gateway`，body 平铺 `{api_name, skill_version, ...业务参数}`。
- 官方来源：`github.com/Tencent/WeChatReading`（Apache-2.0，skill v1.0.5）。
- `api_name`、`skill_version`、path、method、header 全部由模块常量固定；模型只能传各工具
  schema 里声明的业务参数。
- 连接器级声明：`envelope`（成功无 `errcode`、失败取 `errmsg`）、`verify`（POST 校验 key）、
  `auth`（Bearer 头）；卡片元数据放 `card: {glyph, about, docsUrl, readOnlyNote}`（新客户端读这个对象，
  放顶层会看不见），单密钥用 `credentials: [{name, label}]` 让输入框显示 "WeRead API key"。

## 2. 只读工具（13 个：核心 10 + 可选 3）

工具名是 `<id>_<name>`，即 `weread_<name>`。

### 核心 10

| 工具 | api_name | 参数（必填 *） |
| --- | --- | --- |
| `weread_shelf` | `/shelf/sync` | — |
| `weread_search` | `/store/search` | `keyword*`、`scope`、`maxIdx`、`count` |
| `weread_book` | `/book/info` | `bookId*` |
| `weread_chapters` | `/book/chapterinfo` | `bookId*` |
| `weread_progress` | `/book/getprogress` | `bookId*` |
| `weread_notebooks` | `/user/notebooks` | `count`、`lastSort` |
| `weread_highlights` | `/book/bookmarklist` | `bookId*` |
| `weread_my_notes` | `/review/list/mine` | `bookid*`（该接口拼写如此）、`synckey`、`count` |
| `weread_popular_highlights` | `/book/bestbookmarks` | `bookId*`、`chapterUid` |
| `weread_stats` | `/readdata/detail` | `mode`、`baseTime` |

### 可选 3

| 工具 | api_name | 参数（必填 *） |
| --- | --- | --- |
| `weread_similar` | `/book/similar` | `bookId*`、`count*`、`maxIdx*`、`sessionId` |
| `weread_reviews` | `/review/list` | `bookId*`、`reviewListType`、`count`、`maxIdx`、`synckey` |
| `weread_chapter_heat` | `/book/underlines` | `bookId*`、`chapterUid*` |

## 3. 未注册端点 / blocked

- 确认**不注册**：`/_list`（授权后自省用，只作调试；也不该暴露给模型）、
  `/book/readreviews`（划线下的想法，二级详情）、`/review/single`（单条想法详情）。
- 另有 `/book/recommend`（个性化推荐）**未注册**：Ada 的 §11.9.2 映射表未列入，本线按映射表执行；
  它是只读接口，若要补，属于加一个工具声明，不影响只读性质。
- 真 key 调 `/_list` 实见 **17 个接口**（比 Ada 的 16 个多一个 `/discover/interact/type3`：
  「发现页朋友在读动态」，只读、`need_login=true`）。**17 个全部是读**，没有写接口出现。
  未注册的四个是 `/_list`、`/book/readreviews`、`/review/single`、`/book/recommend`
  （外加新见的 `/discover/interact/type3`，候选，未注册）。
- blocked 列表：**空**。本连接器没有 toolbox、没有 actionTools、没有任何写工具声明，
  13 个工具全部 `readOnly: true` 的 POST，适配器还会在构建时拒绝非 GET/POST、以及没写
  `readOnly` 或没给显式 body 映射的 POST。

## 4. 凭据

- secret 名：`WEREAD_API_KEY`（值只在 DSH 凭据库；模块、state、日志、connectorsView 都不出现值）。
- header：`Authorization: Bearer <key>`，由模块的 `auth({token})` 在宿主侧拼；`content-type: application/json`。
- `skill_version`：常量 `1.0.5`，每个请求 body 都带，模型不可改。
- `upgrade_info`：**当前不做自动暂停**。回包原样交给模型，模块头注释提示以官方 SKILL.md 为准重取版本。
  适配器的 envelope 只处理 `errcode`，不看 `upgrade_info`，这是已知缺口。
- 连接校验：模块自带 `verify({token, api})`，**POST** `{api_name:"/shelf/sync", skill_version:"1.0.5"}`；
  2xx 且无 `errcode` 视为可用，401 报 "did not accept this token or key"，其余取 `errmsg`。
  真 key 实测通过（返回 `{}`，不写 account）。
- `account`：恒为 `null`——key 绑身份在服务端，没有可探测的账号名。

## 5. 出站 host

- 只允许 `https://i.weread.qq.com`，路径固定 `/api/agent/gateway`；模块里没有第二个请求目标。
- `docsUrl: https://weread.qq.com/r/weread-skills` 只是卡片上的帮助链接（客户端渲染，不是宿主请求）。
- 浏览器侧不发请求：网关 CORS 固定 `weread.qq.com`，全部调用在宿主完成。

## 6. 单测与门槛

- 本线：`node --test test/weread.test.js` → **11 tests / 11 pass / 0 fail**，约 1.2–1.6 s。
  覆盖：声明形态（gateway/Bearer/rest-tools/verify）、13 个工具全为只读 POST 且参数不得含
  `api_name`/`path`/`url`/`method`/`headers`、工具与 `api_name` 白名单逐条相等、成功回包（无 errcode）、
  只转发声明参数（含模型走私 `api_name`/`path`/`url` 的负例）、鉴权错误不回显 key、
  业务错误取 `errmsg`（不是 "answered 499"）、网络失败归一、空结果不算失败、POST 校验成功/401/业务码/不可达。
- `test/connectors.test.js`（底座已改为只比内置行）：**32 / 32 pass**，外部模块不再撞全等断言。
- 全仓 `npm test`（本 branch，第二批底座 `5abb19b`）：**979 tests / 977 pass / 0 fail / 2 skip**，
  全绿；先前 `test/files.test.js` 的计时 flaky 也被底座修掉（改为断言重试路径）。
- `node scripts/build-client.mjs --check` → exit 0；`npm run lint` → 0 errors。
- 截图脚本已就绪：`ds-bot/dev/shots-weread.mjs`，Prism 的卡片客户端合入后一键出
  `390-01-connectors.png`、`390-02-form.png`、`390-03-error.png`、`1280-01/02`；当前未跑、无图。
- 自查文档：本文件。

## 7. 真实调用取证（2026-10-20，真 key，只记录形状）

13 个工具对应端点全部用真 key 调通，只记录顶层字段，未记录任何书架/笔记内容：

| 端点 | HTTP | 顶层字段 |
| --- | --- | --- |
| `/shelf/sync` | 200 | `mp,albums,archive,books`（books[]: bookId/deepLink/readerLink/title/author/cover/updateTime/secret/finishReading/readUpdateTime） |
| `/store/search` | 200 | `sid,hasMore,results`（results[]: title,books,scope,scopeCount,currentCount,type） |
| `/book/info` | 200 | `bookId,deepLink,readerLink,title,author,cover,newRating,isbn,newRatingDetail,publishTime,publisher,newRatingCount` |
| `/book/chapterinfo` | 200 | `bookId,synckey,chapterUpdateTime,chapters`（`chapters[].chapterUid` 是 int） |
| `/book/getprogress` | 200 | `bookId,book,timestamp`（progress 在 `book.progress`，0–100） |
| `/user/notebooks` | 200 | `synckey,totalBookCount,totalNoteCount,noBookReviewCount,hasMore,books` |
| `/book/bookmarklist` | 200 | `synckey,updated,removed,chapters,book` |
| `/review/list/mine` | 200 | `reviews,totalCount,hasMore,synckey,removed` |
| `/book/bestbookmarks` | 200 | 有热门划线时 `synckey,totalCount,items,chapters`；无热门划线时只回 `synckey` |
| `/readdata/detail` | 200 | `readTimes,readDays,totalReadTime,dayAverageReadTime,compare,baseTime,readLongest,readStat,preferCategory,preferCategoryWord,registTime,preferBooks,readRecordsWord,readDistributionWord` |
| `/book/similar` | 200 | `booksimilar`（`booksimilar.books`, `booksimilar.booksHasMore`） |
| `/review/list` | 200 | `synckey,reviews,reviewsHasMore,reviewsCnt,recentTotalCnt,friendCommentCount,friendUniqueCount,friendCommentUsers,deepVRecommendInfo,…` |
| `/book/underlines` | 200 | `synckey,bookId,chapterUid,underlines`（本章无划线时为空数组） |

- **成功信封**：HTTP 2xx，业务回包 **不含 `errcode`**（只有 `/_list` 自带 `errcode:0`）。
- **业务错误信封**：HTTP **499**（非标准状态码）+ `{errcode:-2003, errmsg, errlog}`；
  `errmsg` 示例：「参数格式错误」「缺少必填参数: bookId (书籍 ID)」「缺少 api_name 参数…」。
  `errlog` 是 7 字符关联 ID（如 `CDQ34Je`），无信息量，不应转给模型。
- **鉴权错误信封**：HTTP 401 + `{errcode:-2013, errmsg:"鉴权失败"}`；不带 key 时
  HTTP 401 + `{errcode:-2010, errmsg:"用户不存在"}`。
- **`skill_version`**：省略也不报错（服务端有默认），但仍按官方文档每请求都带 `1.0.5`。
- **`/book/recommend`**（未注册）：200，顶层 `books`。
- **`/discover/interact/type3`**（未注册候选）：200，顶层 `synckey,count,hasMore,nextMaxIdx,items`。
- **一个 bookId 格式边界**：`/review/list` 对书架里 `CB_…` 形式的新书 id 回 `-2003 参数格式错误`，
  换同一本书的数字 id 可正常返回；`/book/info`、`/book/chapterinfo`、`/book/bookmarklist` 等对
  `CB_…` id 正常。属服务端行为，工具按 errmsg 原样上报，不重试。

## 8. 已知边界 / 未验

- **隐私**：key 绑定用户身份，回包是书架/笔记/划线/阅读统计等个人数据；工具只读，不写 state，
  不落日志；截图计划不拍真实书架与笔记。
- **错误映射（已实现）**：模块 `envelope` 把成功判定为「2xx 且 errcode 缺失或 0」，业务失败取 `errmsg`
  （如 `WeRead: 参数格式错误`），`-2010`/`-2013` 映射为 "did not accept this token or key"，
  `errlog` 不外传。真 key 实测：业务错误不再显示 "answered 499"。
- **`resultMax` 在 envelope 分支被忽略（底座 bug）**：`rest-tools.js` 只在无 envelope 的分支用
  `definition.resultMax`；微信读书有 envelope，所以 `shelf` 声明的 40k 上限没生效，28k 的书架仍被 20k 截断
  （JSON 不完整）。**已修并随第二批底座进来**（`5abb19b`）：envelope 分支同样取
  `definition.resultMax ?? REST_RESULT_MAX`。真 key 复验：`shelf` 回包 28,199 字符、JSON 完整、无
  `result cut:` 提示（books=53 / albums=3 / archive=3 / mp=true）；`notebooks` 4,123 字符完整。
- **mock vs 真实**：单测全部 mock fetch；真实调用做了形状核对 + `verify` 实测通过，但没有跑真实数据的
  数值/单位校验。
- **连接/卸载/重启**：连接态、secret 删除后的卸载、重启后按 secret 重新挂载都归
  `connectors.js` 的 reconcile 管；本模块无状态，这部分待 framework 合入后联合验证。
