# 项目与产品文档对比分析

## 已实现能力

### 核心架构

- ✅ **LLM-Orchestrator + Specialists**：任务规划、候选路由、停止判断、最终答案整合已经统一到 `LLM-Orchestrator`
- ✅ **显式 Runtime**：已收口 `tools / state / memory / execution` 四类运行时职责
- ✅ **StateGraph 工作流**：具备节点状态、handoff、stop signal 和执行历史
- ✅ **Agent Runtime Trace**：支持任务分发、完成、失败和消息快照

### Agent 层

- ✅ **LLM-Orchestrator**：负责 `plan / route / stop / synthesize`
- ✅ **Web Researcher**：负责广度搜索与候选池构建
- ✅ **Long Text / Video / Chart / Table Parser**：负责按内容类型做提取
- ✅ **Fact Verifier / Evaluator**：负责冲突识别、覆盖缺口和验证 follow-up
- ✅ **Tool Creator**：负责按协议创建恢复工具

### Runtime 层

- ✅ **Tools**：统一 source tool、ephemeral tool 注册与调用
- ✅ **State**：工作流状态、节点结果、handoff、stop 状态管理
- ✅ **Memory**：Scratchpad、Experience Memory、Tool Memory、Knowledge Graph
- ✅ **Execution**：agent task dispatch、runtime snapshot、失败追踪

### 研究闭环

- ✅ **任务理解与规划**：由 `LLM-Orchestrator` 完成
- ✅ **候选筛选与任务分发**：由 `LLM-Orchestrator` 完成
- ✅ **深度提取与多模态读取**：由 Specialist Agents 完成
- ✅ **研究质量验证**：由 `Fact Verifier / Evaluator` 完成
- ✅ **最终整合输出**：由 `LLM-Orchestrator` 完成
- ✅ **经验沉淀**：已写入 `Experience Memory`

## 仍未完成的能力

### Phase 2

- ❌ 动态代码验证
- ❌ 更成熟的版本化 Knowledge Graph 演进
- ❌ 更强的复杂文档提取
- ❌ Red Teaming 式反向验证

### Phase 3+

- ❌ Self-evolving knowledge graph
- ❌ 利益链与立场建模
- ❌ 长期主题跟踪
- ❌ 主动监控与预警
- ❌ 假设生成与推荐验证路径

## 当前差距结论

当前仓库已经完成 MVP 主闭环，并且把旧的双层编排 + 隐式 runtime 模型收口为：

- `LLM-Orchestrator` 负责高层研究编排与最终答案
- `Verifier / Evaluator Agent` 负责研究级 validation
- `Runtime` 负责工具、状态、记忆与执行

当前主要缺口已经不再是架构边界不清，而是更高阶的验证能力、复杂文档解析和持续演化能力。
