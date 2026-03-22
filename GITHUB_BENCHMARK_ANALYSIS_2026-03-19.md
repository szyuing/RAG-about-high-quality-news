# GitHub 对标项目本地解析报告（2026-03-19）

## 项目筛选结论

本次对标选择：

- `langchain-ai/open_deep_research`
- `assafelovic/gpt-researcher`

选择原因：

- 两者都属于高相关的 research-agent / orchestration 项目，不是单纯的聊天应用或 RAG 包装层。
- 两者都具备可与你当前 `opensearch` 对比的核心模块：planning、search/retrieval、report synthesis、状态管理、失败恢复。
- 两者都在 GitHub 上保持较高活跃度，适合作为中短期架构借鉴对象。

截至本次分析时采集到的 GitHub 基本面：

| 项目 | Stars | Forks | 主要语言 | 最近推送时间（UTC） | 最近本地 HEAD 提交日期 |
| --- | ---: | ---: | --- | --- | --- |
| `langchain-ai/open_deep_research` | 10872 | 1559 | Python | 2026-03-12T00:23:05Z | 2026-02-25 |
| `assafelovic/gpt-researcher` | 本地已拉取并解析，README/结构/调用链确认有效；本次重点放在架构能力而非榜单比较 | - | Python | 以本地拉取代码为准 | 已确认可解析 |

本地下载目录：

- `C:\Users\19891\AppData\Local\Temp\opensearch-benchmarks-20260319-121224\open_deep_research`
- `C:\Users\19891\AppData\Local\Temp\opensearch-benchmarks-20260319-121224\gpt-researcher`

## 架构卡片

### 1) `open_deep_research`

**核心循环**

- 主流程是显式状态图：`clarify_with_user -> write_research_brief -> research_supervisor -> final_report_generation`。
- supervisor 和 researcher 都是子图，不是简单的 while-loop prompt 拼接。
- 终止条件显式编码：最大研究迭代数、无 tool calls、出现 `ResearchComplete` 工具调用。

**模块边界**

- `deep_researcher.py`：主状态图、supervisor 子图、researcher 子图。
- `configuration.py`：模型、token、重试、search API、MCP 配置集中定义。
- `state.py`：输入状态、研究状态、结构化输出模型。
- `utils.py`：search 工具、token limit 判断、工具注入、消息压缩。

**关键设计点**

- 用 `StateGraph` 把控制流从“超级 orchestrator 函数”抽离成显式节点与边。
- 把 `ConductResearch` / `ResearchComplete` / `think_tool` 变成 supervisor 的工具接口，等于把策略动作做成 typed contract。
- 在 `compress_research` 和 `final_report_generation` 里加入 token-limit 退避逻辑，而不是一次失败直接结束。
- 配置层把 model / token / max iterations / MCP 收口，运行策略不散落在主流程里。

**明显短板**

- 强依赖 LangGraph / LangChain 生态，抽象整洁但框架绑定较重。
- “多 agent”更像 graph node + tool loop，不是独立 runtime actor 系统。
- 对证据验证、冲突消解、可信度评分的独立层次不如你当前 `opensearch` 明确。

### 2) `gpt-researcher`

**核心循环**

- `GPTResearcher` 负责总控：选 agent、conduct research、积累 context、生成报告。
- deep research 是单独 skill：先生成 research plan / search queries，再按 breadth/depth 并发递归研究。
- 把“普通研究”和“深度研究”分成两条路径：常规路径偏串行，深度路径偏并发递归。

**模块边界**

- `agent.py`：顶层 orchestrator，对外主入口。
- `skills/deep_research.py`：深度研究策略、递归扩展、并发处理、进度上报。
- `skills/researcher.py` / `actions/query_processing.py`：sub-query、检索和上下文生成。
- `utils/workers.py`：全局限流 + 并发池。
- `memory/`、`context/`、`vector_store/`：上下文组织和记忆存取。

**关键设计点**

- 更重视并发执行：`asyncio.gather` + `Semaphore` + 全局 rate limiter。
- 对 LLM 调用提供了降级路径，例如 strategic model 失败后改用 token 限制重试，再退回 smart model。
- deep research 分支允许部分失败继续推进，容忍单条子查询失败。
- 日志、websocket 流式进度、成本统计相对成熟，更接近“产品化 agent”。

**明显短板**

- 顶层 orchestrator 仍是较大的 class，控制面和执行面分离不彻底。
- 研究停止逻辑更偏启发式和流程驱动，缺少像你当前 `stop-controller` 那种单独的 sufficiency 判定器。
- 多模块较多，扩展性强但一致性成本高，阅读门槛明显高于 `open_deep_research`。

## 双项目架构对比表（映射到 `opensearch`）

| 维度 | `opensearch` 当前形态 | `open_deep_research` | `gpt-researcher` | 结论 |
| --- | --- | --- | --- | --- |
| planning | 已有独立 planner schema，强于多数项目 | 有明确 brief/planning 阶段，但更 graph-native | 有 planning/sub-query，但更偏 workflow 逻辑 | 你的 planning 方向是对的，不必推倒重来 |
| routing | 通过 connector + specialist route，偏产品化 | 通过 supervisor tool + researcher subgraph | 通过 skill / report_type / retriever 组合 | 你可以学习 `open_deep_research` 的 typed action contract |
| runtime / task lifecycle | 有轻量 runtime、task、message、audit | 更像 graph execution，不是 actor runtime | 有执行对象和日志，但 runtime 契约不独立 | 你在 runtime 账本这块反而更先进，但仍偏轻 |
| memory | experience memory + knowledge graph + scratchpad | 主要是 graph state / notes | context / memory / vector store 较丰富 | 你应补“运行时压缩与上下文预算”，不必照搬其 memory 结构 |
| verification / stop | 已有 `stop-controller` + verifier，分层清楚 | stop 多依赖图内退出条件和完成工具 | 更偏流程结束，不够独立 | 这是你当前的明显优势，应继续强化 |
| tooling | connector / runtime tool / ephemeral tool | tools 与 graph 深度融合，typed 明确 | retriever / scraper / MCP 更丰富 | 你更需要统一 tool contract，而不是单纯增加工具数 |
| error recovery | 有 retry，但主循环里耦合较多 | token limit / structured output retry 明确 | 并发失败容忍、模型 fallback 做得更全 | 应吸收两边的失败恢复策略 |
| observability | progress + runtime snapshot + audit | 依赖 graph/state，可追踪但产品感一般 | websocket + log + costs 更成熟 | 建议你向 `gpt-researcher` 学产品级 telemetry |
| extensibility | 模块多但主 orchestrator 偏胖 | graph 边界最清楚 | skill 生态丰富但复杂 | 你更适合向 `open_deep_research` 学“控制流拆分” |

## 哪些能力是“它强你弱”

### `open_deep_research` 强于你

- **控制流显式化**：节点、边、终止条件都在图里，而不是集中在 `runResearch` 大函数里。
- **策略动作类型化**：`ConductResearch` / `ResearchComplete` / `think_tool` 这类动作接口比自由路由更稳定。
- **上下文缩减更内建**：研究压缩、最终报告 token limit 退避都是标准路径的一部分。

### `gpt-researcher` 强于你

- **并发治理更成熟**：有限并发、全局限流、部分失败继续执行。
- **运行时产品化更强**：事件流、成本统计、websocket 进度更接近真实用户场景。
- **LLM 降级策略更完整**：失败后不是简单重试，而是切 token / 切模型 / 切路径。

## 哪些能力是“你已有但它实现更干净”

- 你已经有 planner / runtime / verifier / stop-controller / memory / knowledge graph 的完整雏形。
- 但这些能力目前主要由 `src/research-engine.js` 统一编排，缺少更清晰的 policy 边界。
- 你已经比这两个项目更接近“research OS 内核”，只是还没有把契约和状态机再抽薄一层。

## 哪些做法“看起来高级但不适合你当前阶段”

- 不建议现在直接把整个系统迁移到 LangGraph 这类重框架。
- 不建议现在全面引入 vector store-first memory；你的问题首先不是检索，而是 orchestration 边界。
- 不建议为了“多 agent”而增加更多 agent 类型；当前更大的收益来自控制流与 runtime 契约收敛。

## 针对 `opensearch` 的修改建议

### 立即可做

#### 1) 把 `runResearch` 拆成显式阶段节点

- **要解决的问题**：`src/research-engine.js:2568` 已经承担 planning、round control、routing、memory writeback、progress emit、final synthesis，耦合过高。
- **建议设计改动**：抽出 `plan_phase`、`research_round_phase`、`verification_phase`、`stop_phase`、`synthesis_phase` 五个纯函数或 node handlers，由一个轻量 phase runner 调度。
- **影响模块**：`src/research-engine.js:2568`、`src/stop-controller.js:195`、`src/research-ops.js:743`。
- **预期收益**：更容易测试单阶段行为；后续加 budget policy / fallback policy 不会继续塞进大函数。
- **复杂度/风险**：中；主要风险是状态对象切分不当导致参数传递变多。

#### 2) 把“控制动作”做成 typed policy contract

- **要解决的问题**：当前 planner、evaluator、connector selection、site strategy 各自返回结构，但 round 内决策仍较多依赖 orchestrator 内部逻辑拼接。
- **建议设计改动**：定义统一控制动作，例如 `ContinueSearch`、`RouteReads`、`RunVerification`、`AnswerNow`、`StopPartial`。
- **影响模块**：`src/research-engine.js:1301`、`src/research-engine.js:2568`、`src/stop-controller.js:195`。
- **预期收益**：把“模型判断”与“运行时执行”彻底解耦，更接近 `open_deep_research` 的可验证控制流。
- **复杂度/风险**：中低；先加 adapter 层即可，不需要一次性重写主逻辑。

#### 3) 增加统一 budget / backoff / degrade policy

- **要解决的问题**：你有 OpenAI retry，但尚未形成“轮次预算、连接器预算、token 预算、失败退化”的统一策略面。
- **建议设计改动**：新增一个 budget policy，对每轮限定 connector 数、specialist reads 数、tool attempts 数；失败时优先缩小范围，再切模型/路径，而不是只重试。
- **影响模块**：`src/research-engine.js` 的 round loop、`src/research-ops.js:743`、`src/runtime.js:1`。
- **预期收益**：成本更可控，异常场景更稳定，能直接吸收 `gpt-researcher` 的优点。
- **复杂度/风险**：中低。

### 中期重构

#### 4) 让 runtime 从“审计账本”升级为“调度内核”

- **要解决的问题**：`src/agent-runtime.js:40` 和 `src/agent-runtime.js:85` 已有 task/message 模型，但还缺少优先级、取消、重试、并发上限、任务结果分类。
- **建议设计改动**：为 task 增加 `priority`、`attempt`、`budget_tag`、`timeout_ms`、`cancellation_reason`；由 runtime 统一处理 dispatch policy。
- **影响模块**：`src/agent-runtime.js:40`、`src/runtime.js:1`、`src/research-engine.js:2568`。
- **预期收益**：你的多 agent 会从“逻辑上多 agent”变成“运行时上多 agent”。
- **复杂度/风险**：中高；但这是把系统从 8/10 拉到 9/10 的关键一步。

#### 5) 加入 research compression / context compaction 层

- **要解决的问题**：当前 memory 与 evidence 在累积，但中间压缩策略不够一等公民。
- **建议设计改动**：在每轮后引入 `round_digest` 和 `evidence_compaction`，只把高价值事实、冲突、未决问题留给下一轮。
- **影响模块**：`src/research-engine.js:2568`、`src/knowledge-graph.js:35`。
- **预期收益**：减少 prompt 膨胀，提升多轮研究稳定性。
- **复杂度/风险**：中。

#### 6) 把 site strategy / connector strategy 升级成独立策略层

- **要解决的问题**：你已有 `site_search_strategies`，但仍主要服务于当前轮搜索，而不是长期的策略治理对象。
- **建议设计改动**：抽出 `search_policy`，统一管理 connector 健康、site hint、query family、verify_only/hybrid 选择。
- **影响模块**：`src/research-engine.js:1225`、`src/research-engine.js:1301`、`src/site-hints.js`。
- **预期收益**：让 planner 不只是“选连接器”，而是“选搜索策略”。
- **复杂度/风险**：中。

### 暂不建议

#### 7) 暂不建议引入完整 LangGraph 化重写

- **原因**：会带来框架迁移成本，但不能优先解决你当前最痛的 orchestrator 过胖问题。

#### 8) 暂不建议扩充更多 specialist agents

- **原因**：当前短板不是 specialist 数量，而是 task contract 和 policy contract 还不够强。

#### 9) 暂不建议先做重型向量记忆体系

- **原因**：当前更需要中间态压缩、预算治理、运行时调度，而不是更复杂的长期存储。

## 可直接落地的下一步

如果下一步由我直接改代码，建议按这个顺序做：

1. **先抽 orchestrator phases**：把 `runResearch` 拆为 5 个阶段函数，不改外部接口。
2. **再抽 control actions**：给 planner / stop-controller / round executor 之间加统一动作协议。
3. **最后补 deterministic guardrails**：加入 budget policy、connector degrade policy、partial-failure policy。

这样改动最小、收益最大，也最符合你当前 `opensearch` 已有的代码资产。
