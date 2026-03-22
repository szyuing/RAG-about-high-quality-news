# Planner 提示词与站点 Connector 方案设计

## 1. 文档目标

本文档用于说明当前项目中 `planner` 与“站点驱动的动态 connector”之间的协作关系，重点回答四个问题：

- `planner` 现在到底负责什么，不负责什么
- 为什么要把“网站选择”放在 `planner`，而不是把“connector 选择”放在最前面
- 当 `planner` 选中了某个网站后，执行器如何决定“复用已有 connector / 新建 generated connector / 回退到 site query”
- 当前实现相较于旧方案有哪些变化，以及后续扩展应该遵守什么边界

当前相关实现入口：

- `src/research-engine.js:1346`：主 planner prompt
- `src/research-engine.js:1524`：主 planner LLM 调用
- `src/research-engine.js:1653`：planner 输出与本地上下文合并
- `src/research-engine.js:3082`：执行前的站点 connector 解析与 connector 选择
- `src/site-connector-provisioner.js:232`：站点 connector provision / 复用 / 降级 / 回退
- `src/source-connectors.js`：静态 connector 与 generated connector 统一注册

---

## 2. 设计结论

一句话概括当前方案：

**planner 先决定要什么证据、去哪几个网站、怎么搜；runtime 再根据这些网站决定用哪个 connector，没有就新建，失败再回退。**

这意味着系统的主轴已经从：

- 先看有哪些 connector
- 再勉强拼一个研究计划

转成了：

- 先看问题需要什么证据
- 再看应该去哪些网站找这些证据
- 最后再由 runtime 把这些网站映射成可执行 connector

换句话说：

- **网站是 planning 对象**
- **connector 是 execution 适配层**
- **generated connector 是 runtime 对网站策略的补全能力，不是 planner 的主输入**

---

## 3. 当前总体流程

### 3.1 阶段一：主 planner 先做“证据形态优先”的网站规划

主 planner 的第一职责不是选工具，而是回答下面几个问题：

- 这个问题要回答清楚，最需要哪类证据
- 这些证据最可能出现在哪些网站/域名
- 对每个网站，应该直接站内搜、做 `site:domain` 搜索，还是只保留为后续验证站点

因此，主 planner prompt 明确要求：

1. 先决定证据形态，再决定网站，再决定搜索动作
2. 不要从 connector 可用性出发做规划
3. `site_search_strategies` 是 planner 输出网站策略的主要结构化字段
4. `chosen_connector_ids` 只是轻量运行提示，不是规划阶段的硬约束

当前 prompt 强调的证据形态包括：

- 官方公告
- 官方博客
- API 文档
- GitHub release / 仓库说明页
- 原文文本
- 字幕
- 剧本
- 书籍
- 论文
- 视频
- 数据库
- 二级报道

这让 planner 在面对不同类型问题时，会优先思考“哪种证据最像答案”。

例如：

- “DeepSeek 发布 v4 模型了吗” → 优先官网、官方博客、API 文档、GitHub release
- “甄嬛传最后一句话是什么” → 优先字幕、台词稿、视频结尾、原文页、书籍

### 3.2 阶段二：planner 输出网站策略，而不是强依赖 connector

主 planner 输出的重点字段是：

- `sub_questions`
- `required_evidence`
- `initial_queries`
- `site_search_strategies`

其中：

- `site_search_strategies` 描述“应该去哪些网站，以及怎么搜”
- `chosen_connector_ids` 可以为空

这一步的核心变化是：

**没有 connector，也不妨碍 planner 把某个高价值网站写进计划。**

只要该网站对回答问题有帮助，就应该先被规划出来。

### 3.3 阶段三：执行前按网站做 connector 解析

在 `preparePlanPhase` 中，runtime 才真正开始处理 connector：

1. 读取 `site_search_strategies`
2. 对每个策略里的域名检查是否已有 connector 覆盖
3. 如果已有 connector 覆盖，则直接复用
4. 如果没有覆盖，则尝试 provision generated site connector
5. 如果 provision 失败，则保留 `site_query` 路径
6. 在这一轮站点解析完成后，再从“和这些网站真正相关”的 connector 候选里选择 `chosen_connector_ids`

这一步的本质是：

**connector 选择被延后到网站已经确定之后。**

因此系统不会再在主 planner 阶段被已有 connector 生态强烈牵着走。

---

## 4. Planner Prompt 的核心原则

当前主 planner prompt 已改为中文主提示，并显式采用 `Step 1` 到 `Step 6` 的链式推理框架：拆解问题、认知实体、判断信息载体、定位信息渠道、筛选最优渠道、获取并提取答案。

这个六步框架替换的是主 prompt 的推理组织方式，不改变现有结构化输出 contract；`sub_questions`、`required_evidence`、`initial_queries`、`site_search_strategies`、`chosen_connector_ids` 以及它们的排序语义仍然保留。

### 4.1 证据形态优先

planner 必须先回答：

- 需要的是公告、文档、发布页，还是字幕、台词、原始文本
- 是否存在版本差异、改编差异、不同发布渠道差异
- 哪类证据最接近第一手答案

而不是一上来就想：

- 现在系统里有哪些 connector
- 哪个 connector 最好用

### 4.2 网站优先于 connector

planner 需要直接输出网站策略，而不是把网站想法折叠进 connector 选择里。

因此当前设计要求：

- 网站/域名尽量落在 `site_search_strategies`
- 普通查询落在 `initial_queries`
- `chosen_connector_ids` 不再作为 planner 成功与否的必要条件

### 4.3 官方优先，但不是流量优先

对于“发布 / 版本 / 模型 / 产品更新 / API 变更 / 公告”类问题：

- 官方域名
- 官方博客
- API 文档
- GitHub release
- 官方仓库说明页

必须优先于媒体、社区和转载页。

同时 prompt 还明确约束：

- 可信度排序不是流量排序
- 可信度排序不是热度排序
- 可信度排序不是社区声量排序
- 不要因为某站点热门、好搜，就把它排在更高可信来源前面

### 4.4 精确文本问题要优先“可直接核对”的证据

对于：

- 最后一句话
- 台词原文
- 精确措辞
- 对话原句
- 字幕内容
- 原著结尾

这类问题，planner 必须优先规划：

- 字幕页
- 台词稿
- 剧本页
- 原文页
- 书籍/章节页
- 可直接检视结尾的视频页

也就是说，此类问题的重点不是“谁讨论过”，而是“谁提供了可直接核对的文本”。

### 4.5 官网域名应该显式进入站点策略

如果问题明显涉及某个官方站点，planner 不应只把它藏在查询词里，而应尽量显式写入 `site_search_strategies`。

此外，当前系统还有一个额外兜底：

- 如果 `initial_queries` 里已经明显出现官方域名意图
- 但 `site_search_strategies` 里没有该域名
- runtime 会自动补一条官方站点策略

这个机制的目的不是替代 planner，而是避免模型偶发漏掉明显应规划的官网域名。

---

## 5. 为什么不能再让 planner 强依赖 connector catalog

旧思路的隐患是：

- planner 很容易围绕“当前有什么 connector”做局部最优规划
- 没有 connector 的站点，即使非常关键，也容易被忽略
- 模型会倾向选择熟悉、现成、低风险的 connector，而不是最有证据价值的网站
- 精确文本类问题会被导向社区讨论页，而不是字幕、书籍、原文页

所以当前主 planner 已经做了一个关键变化：

**不再向主 planner 注入 connector catalog 作为主要决策输入。**

这保证 planner 首先思考“该去哪找证据”，而不是“系统现在有哪些工具”。

注意：这并不意味着系统彻底不使用 connector 信息。

当前实现是：

- 主 planner 不以 connector catalog 为主输入
- 但执行前仍会根据 planner 选中的网站，挑出真正相关的 runtime connector 候选
- 然后再由单独的 connector-selection LLM 步骤从这些候选里选出最终 `chosen_connector_ids`

所以是“**规划阶段去 connector 中心化**”，不是“**整个系统完全去 connector 化**”。

---

## 6. 站点驱动的 connector 生命周期

### 6.1 输入

运行时的输入来自 planner 的 `site_search_strategies`。

每条站点策略至少表达：

- `site_name`
- `domain`
- `search_mode`
- `query_variants`
- `rationale`

### 6.2 触发条件

只有同时满足以下条件时，runtime 才会尝试创建 generated site connector：

1. planner 选中了该网站
2. 当前没有已有 connector 覆盖该域名

这保证 generated connector 的生成是：

- 按需发生
- 由 planner 选中的网站驱动
- 不会对所有陌生域名做无差别预生成

### 6.3 复用已有 connector

如果某个站点已被静态 connector 或历史 generated connector 覆盖：

- 直接复用
- 不重复生成
- 站点策略上补充 `resolved_connector_id`
- `provisioning_status` 标记为 `existing` 或 `reused`

### 6.4 现场 provision 新 connector

如果没有现成覆盖：

- runtime 根据规范化域名生成稳定 id
- 尝试为该站点生成 `read` 能力
- 如果探测到站内搜索入口，再尝试生成 `search` 能力
- 成功后立即注册到 runtime
- 同时持久化到本地 generated connector 数据文件

这样做的结果是：

- 本轮请求可立即使用
- 后续请求也可继续复用
- `GET /api/search/capabilities` 可立即看到这些 generated connector

### 6.5 read-only 降级

如果 generated connector 只能 `read`，不能 `search`：

- connector 仍然保留价值
- 站点策略会被降级
- `connector_search` 会改写为 `site_query`
- `hybrid` 会改写为 `site_query_with_generated_read`

这意味着：

- 发现候选页仍然靠 `bing_web + site:domain`
- 但真正读取候选页时，仍可优先使用该站点的 generated read connector

### 6.6 失败回退

如果生成失败，或者 read / search 验证失败：

- 不让请求硬失败
- 回退到 `bing_web + site:domain`
- 记录 telemetry / audit 事件

所以 generated connector 只是增益能力，不是单点依赖。

---

## 7. 当前实现下 `chosen_connector_ids` 的语义

在新流程下，`chosen_connector_ids` 的语义已经变成：

**针对 planner 已经选中的网站策略，runtime 在执行前最终决定要启用哪些 connector。**

这和旧语义不同。

旧语义更像：

- planner 先决定用哪些 connector
- 再围绕这些 connector 规划研究动作

新语义则是：

- planner 先决定网站和证据路线
- runtime 再基于这些网站形成 connector 候选
- connector-selection LLM 再从这些候选里选择最终执行优先级

因此现在的 `chosen_connector_ids`：

- 仍然由 LLM 选择
- 但选择时机在执行前，不在主 planner 阶段
- 选择范围也不再是“全量 connector catalog”，而是“和 planner 已选网站真正相关的 runtime connector 候选”

这让 `chosen_connector_ids` 更接近“执行决策”，而不是“规划起点”。

---

## 8. DeepSeek 发布类问题的典型路径

以“DeepSeek 发布 v4 模型”为例：

1. planner 先判断这是“发布 / 模型 / 版本更新类问题”
2. 优先证据形态应是：
   - DeepSeek 官网
   - 官方博客
   - API 文档
   - GitHub release / 仓库页
   - 高可信外部验证
3. planner 应显式输出 `deepseek.com` 等官方站点策略
4. 如果模型漏掉官网，但查询意图已明显出现官网域名，runtime 会自动补一条官方站点策略
5. 执行前：
   - 若已有 connector 覆盖该域名，直接复用
   - 没有就尝试 provision generated site connector
   - 失败则回退 `site:deepseek.com`
6. 然后 runtime 再从与这些网站相关的 connector 候选中选出最终 `chosen_connector_ids`

这条路径体现的原则是：

**先把正确网站选出来，再讨论用什么 connector 执行。**

---

## 9. 精确文本类问题的典型路径

以“甄嬛传最后一句话”为例：

1. planner 先识别这是精确文本类问题
2. 所需证据应优先是：
   - 字幕
   - 台词稿
   - 视频结尾
   - 原文页 / 书籍 / 剧本
3. planner 应尽量把这些证据承载网站写进 `site_search_strategies`
4. 如果某些站点没有现成 connector，也不应阻止 planner 输出这些网站
5. 执行前 runtime 再看：
   - 哪些网站已有 connector
   - 哪些网站需要现场生成 connector
   - 哪些只能退回 `site_query`

这比“直接让 planner 从现有 connector 里挑几个”更符合问题本质。

因为这类问题的关键不是“广泛讨论”，而是“能不能拿到可直接核对的原始文本”。

---

## 10. 当前方案的优势

### 10.1 planner 更像研究规划器，而不是工具路由器

planner 不再被现成 connector 生态锁死，能更自由地规划真正高价值的网站。

### 10.2 generated connector 变成网站策略的自然补全

站点一旦被 planner 选中，就有机会在运行时被补齐成正式 connector 能力。

### 10.3 系统可以持续“长出新站点能力”

generated connector 成功后会持久化，并在后续启动中继续参与 `source_capabilities`。

### 10.4 失败不会中断主链路

即使站点 connector 无法生成，也仍然有 `bing_web + site:domain` 的兜底。

### 10.5 `chosen_connector_ids` 更符合真实执行语义

它不再是“主 planner 的先验偏好”，而是“执行前围绕已选网站做的最终 connector 决策”。

---

## 11. 当前边界与注意事项

### 11.1 主 planner 仍可输出 `chosen_connector_ids`

为了兼容现有 schema，主 planner 仍然可以输出 `chosen_connector_ids`。

但当前实现中：

- 这不再是 planner 成功的硬条件
- 执行前仍会基于网站策略重新形成 runtime connector 候选
- 如果执行前 LLM 给出新的 connector 选择，会以执行前结果为准

### 11.2 generated connector 仍只面向公开站点

第一版仅考虑：

- 公开可访问页面
- 可直接读取页面
- 可探测的简单双态搜索入口

不支持：

- 登录态
- 验证码
- 强交互复杂站点
- 私有接口逆向

### 11.3 网站策略仍然需要质量约束

并不是所有网站都值得单独写入 `site_search_strategies`。

只有当某网站能显著提升以下至少一项时，才应进入：

- 召回
- 精度
- 证据质量
- 交叉验证能力

---

## 12. 后续建议

### 12.1 继续强化“证据形态 -> 网站”的 prompt 约束

尤其是以下问题类型：

- 原文 / 台词 / 引语 / 最后一句 / 章节结尾
- 发布 / 版本 / release notes / API 更新
- 法规 / 政策 / 标准 /官方规则

### 12.2 让 planner 更主动表达“版本差异”

例如：

- 电视剧版 vs 小说版
- 官网公告 vs GitHub release
- API 文档现行版 vs 历史版

### 12.3 继续减少与静态站点画像库的耦合

当前主 planner 已经不再注入 connector catalog，但仍然会接收一定的站点 hint 信息。

后续如果希望进一步提升 planner 的独立判断能力，可以继续收缩默认 hint 注入范围，只保留：

- 用户显式指定的站点
- 高置信官方站点提示
- 极少量领域性强约束站点

---

## 13. 最终结论

当前方案已经完成一次关键转向：

- 从“connector 驱动规划”转向“网站驱动规划”
- 从“先选工具再决定去哪找证据”转向“先决定去哪找证据，再决定如何执行”

其核心原则可以浓缩为一句话：

**planner 决定网站，runtime 决定 connector；有 connector 就用，没有就新建，实在不行就回退 site query。**

这就是当前 `planner + site connector` 设计的主干逻辑。
