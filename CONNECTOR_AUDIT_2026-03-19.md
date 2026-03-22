# 连接器能力审计清单与整改建议（2026-03-19）

## 摘要

- 当前 `sourceCatalog` 共 **26** 个连接器，覆盖通用网页、社区、论文、视频、新闻与站点型来源。
- 审计结论分为 4 组：
  - **站内搜索已实现（含 native-first + fallback）**：16 个
  - **公开 API 已实现**：2 个
  - **Bing / 搜索引擎间接搜索**：7 个
  - **仅返回搜索入口 / 能力偏弱**：1 个
- 系统内不存在“直接访问站内私有数据库”的实现；当前所有连接器都依赖**公开搜索页、公开 API、或搜索引擎收录**。
- 统一 runtime 会对 discovery 结果执行关键词命中过滤、去重与排序，见 `src/source-connectors-runtime.js:72`, `src/source-connectors-runtime.js:103`, `src/source-connectors-runtime.js:106`。

## 审计方法

- 搜索实现来源于各连接器的 `search()` 入口与 helper：`src/source-connectors.js:3112`, `src/source-connectors.js:3161`, `src/source-connectors.js:3254`。
- 读取实现来源于各连接器的 `read()` 入口与通用/新闻读取 helper：`src/source-connectors.js:3362`, `src/source-connectors.js:4059`。
- 站点映射与 planner 可见性来源于 `site-hints`：`src/site-hints.js:365`。
- 风险评级基于 4 个维度：公开可访问性、是否依赖搜索引擎、是否存在付费墙/登录墙、以及结果列表稳定性。

## 分组结论

### 1) 站内搜索已实现（含 native-first + fallback）

| connector_id | search_mode | direct_in_site_search | 说明 |
| --- | --- | --- | --- |
| `segmentfault` | `native_search` | `yes` | 直接请求站内搜索页并解析结果。 |
| `ithome` | `native_search` | `partial` | 通过标签页聚合检索，不是完整全文搜索。 |
| `bilibili` | `native_search` | `yes` | 直接解析 Bilibili 搜索页结果。 |
| `ted` | `native_search` | `yes` | 直接解析 TED 搜索页结果。 |
| `xinhua` | `native_search` | `partial` | native-first，失败时退到 Bing site。 |
| `people` | `native_search` | `partial` | native-first，失败时退到 Bing site。 |
| `cctv_news` | `native_search` | `partial` | native-first，失败时退到 Bing site。 |
| `the_paper` | `native_search` | `partial` | native-first，失败时退到 Bing site。 |
| `caixin` | `native_search` | `partial` | native-first，读取受付费墙限制。 |
| `jiemian` | `native_search` | `partial` | native-first，失败时退到 Bing site。 |
| `reuters` | `native_search` | `partial` | native-first，失败时退到 Bing site。 |
| `ap_news` | `native_search` | `partial` | native-first，失败时退到 Bing site。 |
| `bbc_news` | `native_search` | `partial` | native-first，失败时退到 Bing site。 |
| `bloomberg` | `native_search` | `partial` | native-first，读取受付费墙限制。 |
| `nytimes` | `native_search` | `partial` | native-first，读取受付费墙限制。 |
| `wsj` | `native_search` | `partial` | native-first，读取受付费墙限制。 |

### 2) 公开 API 已实现

| connector_id | search_mode | direct_in_site_search | 说明 |
| --- | --- | --- | --- |
| `hacker_news` | `public_api` | `yes` | 通过公开 Algolia HN API 查询故事与评论。 |
| `arxiv` | `public_api` | `yes` | 通过公开 arXiv API 查询论文条目。 |

### 3) Bing / 搜索引擎间接搜索

| connector_id | search_mode | direct_in_site_search | 说明 |
| --- | --- | --- | --- |
| `bing_web` | `bing_site` | `no` | 基线搜索引擎连接器，本身不属于站内搜索。 |
| `youtube` | `bing_site` | `no` | 依赖 `site:youtube.com` / `site:youtu.be`。 |
| `github` | `bing_site` | `no` | 依赖 `site:github.com`。 |
| `reddit` | `bing_site` | `no` | 依赖 `site:reddit.com`。 |
| `wikipedia` | `bing_site` | `no` | 依赖 `site:wikipedia.org`。 |
| `zhihu` | `bing_site` | `no` | 依赖 `site:zhihu.com`。 |
| `stack_overflow` | `bing_site` | `no` | 依赖 `site:stackoverflow.com`。 |

### 4) 仅返回搜索入口 / 能力偏弱

| connector_id | search_mode | direct_in_site_search | 说明 |
| --- | --- | --- | --- |
| `douyin` | `search_landing_only` | `partial` | 目前只返回抖音搜索落地页候选，不解析真实结果列表。 |

## 完整审计矩阵

| connector_id | category | search_mode | direct_in_site_search | open_api_integration | auth_required | keyword_query_supported | result_limit | read_mode | access_constraints | rate_limit_risk | accuracy_risk | implementation_evidence | recommended_action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bing_web` | web search | `bing_site` | `no` | `none` | `no` | `yes` | `8` | `generic_read` | `search-engine-dependent` | `high` | `high` | `src/source-connectors.js:3112`, `src/source-connectors.js:4059` | 保持为基线发现层；不作为高精度站内搜索替代 |
| `hacker_news` | forum/community | `public_api` | `yes` | `public_api` | `no` | `yes` | `6` | `native_read` | `public` | `low` | `medium` | `src/source-connectors.js:3425`, `src/source-connectors.js:4097` | 保持 API 路径，补速率与失败遥测 |
| `segmentfault` | developer articles | `native_search` | `yes` | `none` | `no` | `yes` | `6` | `native_read` | `anti-bot-sensitive` | `medium` | `medium` | `src/source-connectors.js:3430`, `src/source-connectors.js:4146` | 增强搜索结果解析健壮性 |
| `ithome` | tech news | `native_search` | `partial` | `none` | `no` | `yes` | `8` | `native_read` | `public` | `medium` | `medium` | `src/source-connectors.js:3435`, `src/source-connectors.js:4175` | 从标签页检索升级到更稳定的全文搜索入口 |
| `arxiv` | papers/research | `public_api` | `yes` | `public_api` | `no` | `yes` | `6` | `native_read` | `public` | `low` | `low` | `src/source-connectors.js:3455`, `src/source-connectors.js:4205` | 保持公开 API；补退避和 429 语义记录 |
| `bilibili` | video | `native_search` | `yes` | `none` | `no` | `yes` | `6` | `native_read` | `anti-bot-sensitive` | `medium` | `medium` | `src/source-connectors.js:3460`, `src/source-connectors.js:4597` | 保持站内搜索；加强反爬失败回退 |
| `douyin` | video | `search_landing_only` | `partial` | `none` | `no` | `yes` | `1` | `native_read` | `anti-bot-sensitive` | `high` | `high` | `src/source-connectors.js:3465`, `src/source-connectors.js:4831` | **P0：补真实结果列表抓取** |
| `ted` | talks/video | `native_search` | `yes` | `none` | `no` | `yes` | `6` | `native_read` | `public` | `low` | `low` | `src/source-connectors.js:3495`, `src/source-connectors.js:4908` | 保持原生搜索；补搜索失败回退遥测 |
| `youtube` | video | `bing_site` | `no` | `none` | `no` | `yes` | `6` | `native_read` | `search-engine-dependent` | `medium` | `medium` | `src/source-connectors.js:3637`, `src/source-connectors.js:3161`, `src/source-connectors.js:4975` | **P1：升级为 native-first** |
| `xinhua` | news | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `native_read` | `public` | `medium` | `low` | `src/source-connectors.js:3653`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P2：监控 native 成功率，保留 fallback** |
| `people` | news | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `native_read` | `public` | `medium` | `low` | `src/source-connectors.js:3667`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P2：监控 native 成功率，保留 fallback** |
| `cctv_news` | news | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `native_read` | `public` | `medium` | `low` | `src/source-connectors.js:3681`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P2：监控 native 成功率，保留 fallback** |
| `the_paper` | news | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `native_read` | `public` | `medium` | `medium` | `src/source-connectors.js:3695`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P2：补专题页与搜索页差异处理** |
| `caixin` | news/business | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `limited_read` | `paywalled` | `medium` | `medium` | `src/source-connectors.js:3709`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P1：补更明确的受限元数据与摘要策略** |
| `jiemian` | news/business | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `native_read` | `public` | `medium` | `medium` | `src/source-connectors.js:3723`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P2：优化搜索页稳定性与解析选择** |
| `reuters` | news | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `native_read` | `public` | `medium` | `low` | `src/source-connectors.js:3737`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P2：保留 native-first，增强速率保护** |
| `ap_news` | news | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `native_read` | `public` | `low` | `low` | `src/source-connectors.js:3751`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P2：维持现状，补监控即可** |
| `bbc_news` | news | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `native_read` | `public` | `low` | `low` | `src/source-connectors.js:3765`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P2：维持现状，补监控即可** |
| `bloomberg` | news/business | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `limited_read` | `paywalled` | `medium` | `medium` | `src/source-connectors.js:3779`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P1：加强付费墙可见摘要与受限标记** |
| `nytimes` | news | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `limited_read` | `paywalled` | `medium` | `medium` | `src/source-connectors.js:3793`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P1：加强付费墙可见摘要与受限标记** |
| `wsj` | news/business | `native_search` | `partial` | `none` | `no` | `yes` | `8 native / 6 fallback` | `limited_read` | `paywalled` | `medium` | `medium` | `src/source-connectors.js:3807`, `src/source-connectors.js:3254`, `src/source-connectors.js:3362` | **P1：加强付费墙可见摘要与受限标记** |
| `github` | site connector | `bing_site` | `no` | `none` | `no` | `yes` | `6` | `generic_read` | `search-engine-dependent` | `medium` | `medium` | `src/source-connectors.js:3821`, `src/source-connectors.js:3161`, `src/source-connectors.js:4059` | **P1：升级为 native-first** |
| `reddit` | site connector | `bing_site` | `no` | `none` | `no` | `yes` | `6` | `generic_read` | `search-engine-dependent` | `medium` | `high` | `src/source-connectors.js:3834`, `src/source-connectors.js:3161`, `src/source-connectors.js:4059` | **P1：升级为 native-first，并处理公开页差异** |
| `wikipedia` | site connector | `bing_site` | `no` | `none` | `no` | `yes` | `6` | `generic_read` | `search-engine-dependent` | `low` | `medium` | `src/source-connectors.js:3847`, `src/source-connectors.js:3161`, `src/source-connectors.js:4059` | **P1：升级为 native-first 或 MediaWiki API** |
| `zhihu` | site connector | `bing_site` | `no` | `none` | `no` | `yes` | `6` | `generic_read` | `login-gated` | `medium` | `high` | `src/source-connectors.js:3860`, `src/source-connectors.js:3161`, `src/source-connectors.js:4059` | **P1：升级为 native-first，并处理登录弹层** |
| `stack_overflow` | site connector | `bing_site` | `no` | `none` | `no` | `yes` | `6` | `generic_read` | `search-engine-dependent` | `low` | `medium` | `src/source-connectors.js:3873`, `src/source-connectors.js:3161`, `src/source-connectors.js:4059` | **P1：升级为 native-first 或 Stack Exchange API** |

## 整改优先级 Backlog

### P0 — 直接影响主链路

**Douyin 结果列表抓取补齐**
- `current_state`：仅返回搜索落地页，不能直接给出站内结果列表，见 `src/source-connectors.js:3465`。
- `gap`：planner 会选择 `douyin`，但 discovery 精度和可排序性弱于其他视频连接器。
- `next_step`：为 `douyin` 增加真实结果列表抓取与结构化解析；保留当前 landing page 作为最后退路。
- `estimated_value`：显著提升中文热点/短视频问题的 discovery 质量与后续 read 命中率。

### P1 — 提升精度或降低搜索引擎依赖

**Bing-site 类连接器升级为 native-first / 公开 API**
- `current_state`：`youtube`、`github`、`reddit`、`wikipedia`、`zhihu`、`stack_overflow` 主要依赖 `createBingSiteConnectorSearch`，见 `src/source-connectors.js:3161`。
- `gap`：结果受搜索引擎收录影响，精度和覆盖率不稳定。
- `next_step`：逐个升级为站内原生搜索或免认证公开 API；优先顺序建议 `wikipedia` / `stack_overflow` / `github` / `youtube` / `reddit` / `zhihu`。
- `estimated_value`：降低对 Bing 收录的依赖，提高排序稳定性和结果可解释性。

**付费墙新闻站的 limited-read 元数据强化**
- `current_state`：`caixin`、`bloomberg`、`nytimes`、`wsj` 已有 `access_limited` 语义，见 `src/source-connectors.js:3362`。
- `gap`：受限原因、可见摘要范围、是否可继续读取的信号还不够细。
- `next_step`：统一补充 `access_notes`、`excerpt_available`、`visible_paragraph_count`、`paywall_detected` 等字段。
- `estimated_value`：让 verifier / synthesizer 更清楚区分“来源可信但正文受限”和“读取失败”。

### P2 — 增强稳定性与可运维性

**native-first 连接器成功率与回退遥测**
- `current_state`：新闻站和部分 native 连接器已具备 fallback，但运行时没有专门暴露 native/fallback 命中比例。
- `gap`：难以判断哪些站点长期依赖 fallback、哪些站点需要优先修复原生解析。
- `next_step`：记录 `search_path = native | fallback`、失败原因、站点成功率与限流命中情况。
- `estimated_value`：为后续 native 解析优化提供明确优先级依据。

**统一退避、速率限制与失败分类**
- `current_state`：`fetchText()` 只有线性重试，见 `src/source-connectors.js:1574`。
- `gap`：对 429、站点限流、临时反爬、超时等没有统一的指数退避和分类策略。
- `next_step`：将 connector 抓取层升级为指数退避、可配置重试次数、按站点限速窗口和错误分类记录。
- `estimated_value`：提高原生搜索/读取的稳定性，降低对单次请求成功率的依赖。

## 关键判断

- **已实现直接站内搜索**：有，但只覆盖部分连接器，而且都基于**公开搜索页 / 公开 API**，不接私有数据库。
- **支持关键词查询**：全部连接器支持。
- **结果是否可准确返回站内相关内容**：整体可用，但 `douyin` 和 Bing-site 类连接器风险更高。
- **是否存在搜索范围限制或权限控制**：存在，主要体现在结果条数上限、runtime 关键词过滤、公开可访问性、付费墙与反爬限制。
