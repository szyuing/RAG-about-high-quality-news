# OpenSearch 优化报告 V2（逐项目对照）

日期：2026-03-18

## 1. 我这次补充了什么

这版是按你列的每个项目逐个对照，不再只做泛化总结。重点看了：
- 定位/能力边界
- 架构与工作流
- API/评测/部署特性
- 对你当前仓库可直接迁移的改造点

## 2. 逐项目对照与可迁移项

## Perplexica / Vane
- 关键点：强调“私有化 + 带引用回答 + Search API”，并明确 API 路径（`/api/search`、`/api/providers`）。
- 对你的启发：你已有研究引擎，但“对外 API 产品面”还不够标准化。
- 建议：优先补统一 `POST /api/search`，输出稳定 citation schema（source_id/url/snippet/claim 映射）。

## Scira (MiniPerplx)
- 关键点：极简 AI 搜索产品，突出“多模型 + 引用 + 实时检索体验”。
- 对你的启发：你后端能力强于它，但前端“即搜即得、引用可读性、速度模式”可以借鉴。
- 建议：增加 `speed / balanced / quality` 模式参数，映射到你的 `max_rounds / selected_candidates / read_budget`。

## MindSearch
- 关键点：明确多智能体搜索框架，对标 Perplexity Pro / SearchGPT，支持异步 agent 与多搜索引擎切换。
- 对你的启发：你已是多 agent，但可以更“并行任务优先”与“显式搜索引擎策略化”。
- 建议：把 connector 选择升级成“并行搜索计划”（primary + fallback engines）并输出执行图。

## dzhng/deep-research
- 关键点：极简实现迭代式 deep research（breadth/depth 参数、递归追搜、并发处理、报告汇总）。
- 对你的启发：你的流程更完整，但缺少显式 `breadth/depth` 外部参数。
- 建议：在 API 层加入 `breadth`, `depth`, `max_iterations`，映射你内部 loop 与候选上限。

## langchain-ai/open_deep_research
- 关键点：可配置搜索 API、MCP 兼容、Deep Research Bench 评测链路（RACE 分数）。
- 对你的启发：你目前缺统一 benchmark 管线，难稳定比较改动前后质量。
- 建议：新增 `tests/eval`，固定题集输出 `coverage/conflict/citation/completion/cost` 并做回归基线。

## langchain-ai/local-deep-researcher
- 关键点：本地模型驱动的迭代研究，核心是“总结→反思缺口→再检索”的循环。
- 对你的启发：你有 stop-controller，但“knowledge gap 显式化”可以更产品化。
- 建议：把 `missing_questions` 提升为前端可视研究缺口面板（每轮变更 diff）。

## LearningCircuit/local-deep-research
- 关键点：本地隐私、加密存储、REST API、实时进度、性能分析、多源检索（含私有文档）。
- 对你的启发：你已有经验记忆/审计，但缺“隐私模式与数据隔离策略”。
- 建议：加 `local_only` 与数据策略（日志脱敏、会话隔离、可选加密存储）。

## browser-use
- 关键点：让 agent 直接操作网站（点击、输入、登录态、复杂页面流程），补足传统 search+read 的盲区。
- 对你的启发：你在登录态页面、JS 强交互页面会受限。
- 建议：新增 `browser_agent` 作为失败兜底 connector，仅在常规 read 失败后触发。

## Open WebUI
- 关键点：平台层能力聚合（多模型、多工具），社区大量围绕 SearxNG 接入调优。
- 对你的启发：你可作为“搜索研究后端”，而不仅是独立应用。
- 建议：提供 OpenAI-compatible 风格 endpoint，便于被 Open WebUI/其它前端直接挂载。

## 3. 你项目的“短板优先级”

P0（先做）
- 统一 Search API（外部可调用协议）
- 引用结构标准化（可审计）
- 模式化检索参数（speed/balanced/quality + depth/breadth）

P1（第二阶段）
- 独立 reranker 策略层
- benchmark 回归体系（固定题集）
- 研究缺口可视化

P2（第三阶段）
- browser agent 兜底链路
- local-only 隐私模式
- Open WebUI/平台化适配层

## 4. 我建议你下一步直接做

从 `P0-1` 开始：先落 `POST /api/search` 标准接口（含 citations schema + 模式参数）。

---

## 参考链接

- Perplexica: https://github.com/ItzCrazyKns/Perplexica
- Vane Search API: https://github.com/ItzCrazyKns/Vane/blob/master/docs/API/SEARCH.md
- Scira: https://github.com/zaidmukaddam/scira
- MindSearch: https://github.com/InternLM/MindSearch
- dzhng/deep-research: https://github.com/dzhng/deep-research
- open_deep_research: https://github.com/langchain-ai/open_deep_research
- local-deep-researcher: https://github.com/langchain-ai/local-deep-researcher
- local-deep-research: https://github.com/LearningCircuit/local-deep-research
- browser-use: https://github.com/browser-use/browser-use
- Open WebUI: https://github.com/open-webui/open-webui
