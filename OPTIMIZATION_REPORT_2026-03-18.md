# OpenSearch 优化报告（对标开源联网搜索/深度研究项目）

日期：2026-03-18  
范围：`d:\opensearch` 当前实现（`research-engine` + `source-connectors` + `stop-controller` + `runtime`）

## 1) 结论摘要

你的项目已经具备较完整的“规划→检索→阅读→核验→停止→总结”闭环，尤其在动态 connector 选择、事实核验、经验记忆方面已经超过多数“搜索+回答”类开源项目的基础形态。  
下一阶段建议从 **产品化 API、检索质量控制、深度研究评测、浏览器代理能力、本地隐私模式** 五条线推进。

---

## 2) 对标项目要点（外部参考）

### A. 联网搜索/问答引擎
- **Perplexica/Vane**：强调可自托管、带引用回答，并提供 Search API（`/api/providers`, `/api/search`）。
- **Scira (MiniPerplx)**：定位清晰，AI 搜索 + 引用来源，工具/数据源整合非常激进。
- **MindSearch**：多智能体 Web Search Engine，明确对标 Perplexity Pro / SearchGPT。

### B. 深度研究工作流
- **dzhng/deep-research**：迭代式研究（query 迭代、深度/广度控制）且实现简洁。
- **langchain-ai/open_deep_research**：强调可配置、可评测（Bench/Eval）、MCP 兼容。
- **local-deep-researcher / local-deep-research**：强调本地化、隐私、可控数据源。

### C. 浏览器代理
- **browser-use**：不是传统“搜索引擎式检索”，而是让 agent 直接操作网页，适合复杂采集任务。

### D. 平台化接入
- **Open WebUI**：支持多家 Web Search Provider + URL 浏览注入，适合“平台层能力聚合”。

---

## 3) 你当前项目的优势（建议保持）

- 已有多轮研究循环与停止决策：`src/research-engine.js`, `src/stop-controller.js`
- 已有动态 connector 选择与建议回流（本轮已接入）：`src/research-engine.js`
- 已有事实核验与冲突处理：`src/research-ops.js`, `src/fact-verifier.js`
- 已有经验记忆 / 知识图谱 / 工具审计：`src/research-engine.js`, `src/knowledge-graph.js`, `src/runtime.js`
- 已有多源 connector 框架：`src/source-connectors.js`

---

## 4) 核心优化建议（按优先级）

## P0（1-2周）：把“能力”变成“稳定 API 产品”

1. **补齐统一 Search API 层**
   - 目标：提供稳定外部接口（类似 Vane 的 `/api/search`）。
   - 建议新增：
     - `POST /api/search`（query + mode + connector_ids + stream）
     - `GET /api/search/capabilities`（可用 connector、模型、限制）
     - `POST /api/search/evaluate`（返回 scorecard/stop_state）
   - 价值：前端、第三方调用、A/B 实验都会更顺畅。

2. **输出结构标准化（强制 citation schema）**
   - 统一最终响应中的 `sources[]`、`claims[]`、`confidence`、`uncertainty` 字段。
   - 对 `final_answer` 与 `evaluation` 增加版本号 `schema_version`。

3. **建立线上质量看板最小集**
   - KPI 建议：
     - 引用覆盖率（答案句子可追溯 source 的比例）
     - 冲突率（`verification.conflicts / claims`）
     - 平均轮次与平均耗时
     - 每 connector 成功率/错误率

## P1（2-4周）：检索质量与深度研究能力升级

1. **候选重排器（Reranker）独立化**
   - 从 `selectCandidates` 扩展为“可替换策略模块”：
     - 词匹配分、时效分、权威分、多样性分、历史成功分
   - 输出 `ranking_explain` 便于调参与审计。

2. **研究预算控制（Borrow from deep-research）**
   - 增加可配置预算：
     - `max_queries`, `max_reads`, `max_tokens`, `max_cost`
   - 让 stop-controller 除“是否足够”外也考虑“预算到顶”。

3. **评测基线（Borrow from open_deep_research）**
   - 新增离线评测脚本：
     - 固定问题集 + 固定随机种子 + 对比输出分数
   - 每次改动自动记录：覆盖率、冲突率、成本、时延。

## P2（4-8周）：复杂网页能力与本地化能力

1. **浏览器代理 connector（Borrow from browser-use）**
   - 新增 `browser_agent` connector（登录态、滚动加载、反爬页面）
   - 只在普通 `fetch/read` 失败时触发（降成本）。

2. **本地隐私模式**
   - 提供 `local_only` 开关：
     - 禁外部模型、禁外部搜索、仅本地索引/本地模型
   - 与 `experience-memory`、`tool-audit` 配套数据留存策略。

3. **平台化接入（兼容 Open WebUI 场景）**
   - 增加 OpenAI-compatible endpoint（或轻量适配层）
   - 让你的搜索引擎能力可作为上层 Chat UI 的“工具后端”。

---

## 5) 具体落地清单（可直接开工）

- [ ] 新建 `src/api/search-controller.js`，封装统一 Search API
- [ ] 在 `server.js` 新增 `/api/search` 和 `/api/search/capabilities`
- [ ] 在 `src/research-engine.js` 输出标准化 `citations` + `schema_version`
- [ ] 在 `src/research-ops.js` 抽离 `reranker` 策略接口
- [ ] 在 `src/stop-controller.js` 加入 budget stop rules
- [ ] 新建 `tests/eval-benchmark.test.js`（固定题集回归）
- [ ] 新增 `browser_agent` connector（失败兜底触发）
- [ ] 新增 `config/local-mode`（隐私模式）

---

## 6) 风险与防护

- **风险1：系统变复杂、可解释性下降**  
  防护：所有决策（connector/routing/stop）落审计日志，输出 rationale。

- **风险2：成本失控**  
  防护：预算上限 + connector 优先级 + 失败熔断。

- **风险3：引用质量下降**  
  防护：答案落地前做“引用完整性校验”（无来源句子标红或降置信度）。

---

## 7) 推荐执行顺序

1. 先做 API 标准化（P0）  
2. 再做重排器与预算控制（P1）  
3. 最后扩展浏览器代理与本地模式（P2）

这样可以在不打断现有主流程的前提下，最快提升“可用性 + 可运营性 + 可迭代性”。

---

## 参考链接

- Perplexica/Vane（含 Search API 文档）：https://github.com/ItzCrazyKns/Vane  
- Vane Search API 文档：https://github.com/ItzCrazyKns/Vane/blob/master/docs/API/SEARCH.md  
- Scira：https://github.com/zaidmukaddam/scira  
- MindSearch：https://github.com/InternLM/MindSearch  
- dzhng/deep-research：https://github.com/dzhng/deep-research  
- LangChain open_deep_research：https://github.com/langchain-ai/open_deep_research  
- LangChain local-deep-researcher：https://github.com/langchain-ai/local-deep-researcher  
- LearningCircuit local-deep-research：https://github.com/LearningCircuit/local-deep-research  
- browser-use：https://github.com/browser-use/browser-use  
- Open WebUI：https://github.com/open-webui/open-webui
