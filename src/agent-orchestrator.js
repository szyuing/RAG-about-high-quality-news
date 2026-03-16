const { ToolRegistry } = require("./source-connectors");
const { verifyEvidenceUnits } = require("./fact-verifier");
const { statePersistence } = require("./state-persistence");
const { agentCommunication } = require("./agent-communication");
const { knowledgeSharingSystem } = require("./knowledge-sharing");
const { AgentManager, Task } = require("./agent-manager");
const { dataAnalyzer, researchProgressTracker } = require("./data-analysis");
const { smartInformationRetriever } = require("./smart-retriever");
const {
  AgentStatus,
  AgentType,
  BaseAgent,
  SupervisorAgent,
  WebResearcherAgent,
  LongTextCollectorAgent,
  VideoParserAgent,
  ChartParserAgent,
  TableParserAgent,
  FactVerifierAgent,
  SynthesizerAgent,
  ToolCreatorAgent,
  ToolCreatorPool,
  createAgent
} = require("./agents");
const { StateGraph, createResearchWorkflow } = require("./workflow");
const {
  createAgentRegistry,
  createAgentRuntime,
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentRuntimeSnapshot
} = require("./agent-runtime");
const {
  routeCandidate,
  collectorToolForCandidate,
  collectorCapabilityForTask,
  selectCandidates,
  evaluateResearch,
  runWebResearcher,
  runSpecialistReads,
  runFactVerifierReview
} = require("./research-ops");
// Agent 管理系统
class AgentSystem {
  constructor() {
    this.agents = new Map();
    this.workflows = new Map();
    this.taskHistory = [];
    this.agentManager = new AgentManager();
    this.toolCreatorPool = null;
    this.boundToolCreationHandler = null;
    this.initializeAgents();
    this.initializeWorkflows();
    this.initializeAgentManager();
    this.initializeToolCreatorPool();
    this.initializeCommunicationProtocols();
  }

  initializeAgents() {
    const agentTypes = [
      AgentType.SUPERVISOR,
      AgentType.WEB_RESEARCHER,
      AgentType.LONG_TEXT_COLLECTOR,
      AgentType.VIDEO_PARSER,
      AgentType.CHART_PARSER,
      AgentType.TABLE_PARSER,
      AgentType.FACT_VERIFIER,
      AgentType.SYNTHESIZER,
      AgentType.TOOL_CREATOR
    ];

    for (const type of agentTypes) {
      this.agents.set(type, createAgent(type));
    }
  }

  initializeToolCreatorPool(poolSize = 2) {
    this.toolCreatorPool = new ToolCreatorPool(this, poolSize);
  }

  getToolCreatorPool() {
    return this.toolCreatorPool;
  }

  initializeCommunicationProtocols() {
    const toolCreator = this.getAgent(AgentType.TOOL_CREATOR);
    if (!toolCreator) {
      return;
    }

    this.boundToolCreationHandler = async (message) => {
      if (message.type !== 'request') {
        return;
      }
      if (message.content?.request_type !== 'tool_creation') {
        return;
      }
      if (message.metadata?._tool_creation_handled) {
        return;
      }
      message.metadata._tool_creation_handled = true;
      await toolCreator.handleToolCreationRequest(message);
    };

    agentCommunication.subscribe(AgentType.TOOL_CREATOR, this.boundToolCreationHandler);
  }

  async createTool(toolSpec) {
    if (this.toolCreatorPool) {
      return await this.toolCreatorPool.execute([toolSpec]);
    }
    
    // 回退到单个 Tool Creator Agent
    const toolCreator = this.getAgent(AgentType.TOOL_CREATOR);
    return await toolCreator.execute({ toolSpecs: [toolSpec] });
  }

  async createTools(toolSpecs) {
    if (this.toolCreatorPool) {
      return await this.toolCreatorPool.execute(toolSpecs);
    }
    
    // 回退到单个 Tool Creator Agent
    const toolCreator = this.getAgent(AgentType.TOOL_CREATOR);
    return await toolCreator.execute({ toolSpecs });
  }

  async requestToolCreation(requester, toolSpecs, metadata = {}) {
    const { response } = await agentCommunication.requestToolCreation(
      requester,
      AgentType.TOOL_CREATOR,
      toolSpecs,
      metadata
    );
    return response.content;
  }

  respondToolCreation(sender, receiver, requestId, payload, metadata = {}) {
    return agentCommunication.respondToolCreation(sender, receiver, requestId, payload, metadata);
  }

  getToolHistory(toolId) {
    return ToolRegistry.getToolHistory(toolId);
  }

  deprecateTool(toolId, reason = "deprecated_by_agent_system") {
    return ToolRegistry.deprecateTool(toolId, reason);
  }

  rollbackTool(toolId, targetToolId = null) {
    return ToolRegistry.rollbackTool(toolId, targetToolId);
  }

  promoteTool(toolId, reason = "promoted_by_agent_system") {
    return ToolRegistry.promoteTool(toolId, reason);
  }

  resolveToolForTask(taskSpec = {}) {
    return ToolRegistry.resolveToolForTask(taskSpec);
  }

  initializeWorkflows() {
    this.workflows.set('research', createResearchWorkflow());
  }

  initializeAgentManager() {
    // 注册Agent类型
    this.agentManager.registerAgentType(AgentType.WEB_RESEARCHER, (config) => {
      return new BaseAgent({
        id: `web_researcher_${Date.now()}`,
        type: AgentType.WEB_RESEARCHER,
        name: 'Web Researcher',
        ...config
      });
    });
    
    this.agentManager.registerAgentType(AgentType.LONG_TEXT_COLLECTOR, (config) => {
      return new BaseAgent({
        id: `long_text_collector_${Date.now()}`,
        type: AgentType.LONG_TEXT_COLLECTOR,
        name: 'Long Text Collector',
        ...config
      });
    });
    
    this.agentManager.registerAgentType(AgentType.VIDEO_PARSER, (config) => {
      return new BaseAgent({
        id: `video_parser_${Date.now()}`,
        type: AgentType.VIDEO_PARSER,
        name: 'Video Parser',
        ...config
      });
    });

    this.agentManager.registerAgentType(AgentType.CHART_PARSER, (config) => {
      return new BaseAgent({
        id: `chart_parser_${Date.now()}`,
        type: AgentType.CHART_PARSER,
        name: 'Chart Parser',
        ...config
      });
    });

    this.agentManager.registerAgentType(AgentType.TABLE_PARSER, (config) => {
      return new BaseAgent({
        id: `table_parser_${Date.now()}`,
        type: AgentType.TABLE_PARSER,
        name: 'Table Parser',
        ...config
      });
    });
    
    this.agentManager.registerAgentType(AgentType.FACT_VERIFIER, (config) => {
      return new BaseAgent({
        id: `fact_verifier_${Date.now()}`,
        type: AgentType.FACT_VERIFIER,
        name: 'Fact Verifier',
        ...config
      });
    });
    
    this.agentManager.registerAgentType(AgentType.SYNTHESIZER, (config) => {
      return new BaseAgent({
        id: `synthesizer_${Date.now()}`,
        type: AgentType.SYNTHESIZER,
        name: 'Synthesizer',
        ...config
      });
    });
    
    this.agentManager.registerAgentType(AgentType.TOOL_CREATOR, (config) => {
      return new ToolCreatorAgent({
        id: `tool_creator_${Date.now()}`,
        type: AgentType.TOOL_CREATOR,
        name: 'Tool Creator',
        ...config
      });
    });
  }

  getAgent(type) {
    return this.agents.get(type);
  }

  getAllAgents() {
    return Array.from(this.agents.values()).map(agent => ({
      id: agent.id,
      type: agent.type,
      name: agent.name,
      status: agent.status
    }));
  }

  async executeWorkflow(workflowId, initialState) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const state = {
      ...initialState,
      agentSystem: this
    };

    return await workflow.run(state);
  }

  getSystemStatus() {
    const agents = Array.from(this.agents.values());
    const activeAgents = agents.filter(a => a.status === AgentStatus.RUNNING);
    const completedAgents = agents.filter(a => a.status === AgentStatus.COMPLETED);
    const failedAgents = agents.filter(a => a.status === AgentStatus.FAILED);
    
    return {
      agents: this.getAllAgents(),
      totalTasks: this.taskHistory.length,
      activeAgents: activeAgents.length,
      completedAgents: completedAgents.length,
      failedAgents: failedAgents.length,
      workflows: Array.from(this.workflows.keys()),
      systemHealth: this.getSystemHealth(),
      performanceMetrics: this.getPerformanceMetrics()
    };
  }

  // 系统健康检查
  getSystemHealth() {
    const agents = Array.from(this.agents.values());
    const failedAgents = agents.filter(a => a.status === AgentStatus.FAILED);
    const totalAgents = agents.length;
    const failureRate = totalAgents > 0 ? failedAgents.length / totalAgents : 0;
    
    let status = 'healthy';
    if (failureRate > 0.5) {
      status = 'critical';
    } else if (failureRate > 0.2) {
      status = 'warning';
    }
    
    return {
      status,
      failureRate: Number(failureRate.toFixed(2)),
      totalAgents,
      failedAgents: failedAgents.length,
      timestamp: Date.now()
    };
  }

  // 性能指标
  getPerformanceMetrics() {
    const agents = Array.from(this.agents.values());
    const completedAgents = agents.filter(a => a.status === AgentStatus.COMPLETED);
    const executionTimes = completedAgents.map(a => a.executionTime).filter(Boolean);
    
    const avgExecutionTime = executionTimes.length > 0 
      ? executionTimes.reduce((sum, time) => sum + time, 0) / executionTimes.length 
      : 0;
    
    return {
      averageExecutionTime: Number(avgExecutionTime.toFixed(2)),
      completedTasks: completedAgents.length,
      totalAgents: agents.length,
      timestamp: Date.now()
    };
  }

  // 监控Agent状态
  monitorAgentStatus() {
    const agents = Array.from(this.agents.values());
    const statusReport = {
      timestamp: Date.now(),
      agents: agents.map(agent => ({
        id: agent.id,
        type: agent.type,
        status: agent.status,
        lastSuccessTime: agent.lastSuccessTime,
        lastFailureTime: agent.lastFailureTime,
        executionTime: agent.executionTime
      }))
    };
    
    console.log('Agent Status Monitor:', statusReport);
    return statusReport;
  }

  // 故障恢复
  async recoverFromFailure(agentId, error) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, message: 'Agent not found' };
    }
    
    console.log(`Attempting to recover agent ${agentId} from error: ${error.message}`);
    
    try {
      agent.reset();
      return { success: true, message: 'Agent reset successfully' };
    } catch (recoveryError) {
      return { success: false, message: `Recovery failed: ${recoveryError.message}` };
    }
  }

  // 状态持久化
  async saveSystemState() {
    const state = {
      agents: Array.from(this.agents.entries()).map(([id, agent]) => ({
        id,
        type: agent.type,
        status: agent.status,
        lastSuccessTime: agent.lastSuccessTime,
        lastFailureTime: agent.lastFailureTime
      })),
      taskHistory: this.taskHistory,
      workflows: Array.from(this.workflows.keys()),
      timestamp: Date.now()
    };
    
    return await statePersistence.saveState('system', state);
  }

  // 加载系统状态
  async loadSystemState() {
    const result = await statePersistence.loadState('system');
    if (result.success) {
      console.log('System state loaded successfully');
      return result.data;
    }
    return null;
  }

  // 保存会话状态
  async saveSession(sessionId, sessionData) {
    return await statePersistence.saveSession(sessionId, sessionData);
  }

  // 加载会话状态
  async loadSession(sessionId) {
    const result = await statePersistence.loadSession(sessionId);
    if (result.success) {
      console.log(`Session ${sessionId} loaded successfully`);
      return result.data;
    }
    return null;
  }

  // 保存Agent状态
  async saveAgentState(agentId, additionalState = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, message: 'Agent not found' };
    }
    
    const state = {
      id: agent.id,
      type: agent.type,
      status: agent.status,
      lastSuccessTime: agent.lastSuccessTime,
      lastFailureTime: agent.lastFailureTime,
      executionTime: agent.executionTime,
      ...additionalState
    };
    
    return await statePersistence.saveAgentState(agentId, state);
  }

  // 加载Agent状态
  async loadAgentState(agentId) {
    const result = await statePersistence.loadAgentState(agentId);
    if (result.success) {
      console.log(`Agent ${agentId} state loaded successfully`);
      return result.data;
    }
    return null;
  }

  // 列出所有保存的状态
  listSavedStates() {
    return statePersistence.listStates();
  }

  // Agent通信
  sendMessage(sender, receiver, type, content, metadata = {}) {
    return agentCommunication.sendMessage(sender, receiver, type, content, metadata);
  }

  // 发送请求
  sendRequest(sender, receiver, content, metadata = {}) {
    return agentCommunication.sendRequest(sender, receiver, content, metadata);
  }

  // 发送响应
  sendResponse(sender, receiver, content, metadata = {}) {
    return agentCommunication.sendResponse(sender, receiver, content, metadata);
  }

  // 发送通知
  sendNotification(sender, receiver, content, metadata = {}) {
    return agentCommunication.sendNotification(sender, receiver, content, metadata);
  }

  // 发送错误
  sendError(sender, receiver, content, metadata = {}) {
    return agentCommunication.sendError(sender, receiver, content, metadata);
  }

  // 订阅角色消息
  subscribe(role, callback) {
    agentCommunication.subscribe(role, callback);
  }

  // 取消订阅
  unsubscribe(role, callback) {
    agentCommunication.unsubscribe(role, callback);
  }

  // 获取消息历史
  getMessageHistory() {
    return agentCommunication.getMessageHistory();
  }

  // 获取消息统计
  getMessageStats() {
    return agentCommunication.getMessageStats();
  }

  // 清理消息历史
  clearMessageHistory() {
    agentCommunication.clearMessageHistory();
  }

  // 知识共享
  shareKnowledge(source, content, tags = [], confidence = 0.8) {
    return knowledgeSharingSystem.shareKnowledge(source, content, tags, confidence);
  }

  // 获取知识
  getKnowledge(id) {
    return knowledgeSharingSystem.getKnowledge(id);
  }

  // 搜索知识
  searchKnowledge(query, tags = []) {
    return knowledgeSharingSystem.searchKnowledge(query, tags);
  }

  // 解决冲突
  resolveConflict(conflictId, resolution) {
    return knowledgeSharingSystem.resolveConflict(conflictId, resolution);
  }

  // 获取冲突
  getConflicts() {
    return knowledgeSharingSystem.getConflicts();
  }

  // 获取未解决的冲突
  getUnresolvedConflicts() {
    return knowledgeSharingSystem.getUnresolvedConflicts();
  }

  // 获取知识统计
  getKnowledgeStats() {
    return knowledgeSharingSystem.getKnowledgeStats();
  }

  // 清理过期知识
  cleanupOldKnowledge(maxAge) {
    return knowledgeSharingSystem.cleanupOldKnowledge(maxAge);
  }

  // 动态创建Agent
  createAgent(type, config = {}) {
    const agent = this.agentManager.createAgent(type, config);
    this.agents.set(agent.id, agent);
    return agent;
  }

  // 销毁Agent
  destroyAgent(agentId) {
    return this.agentManager.destroyAgent(agentId);
  }

  // 分配任务
  assignTask(taskType, content, priority = 'medium', metadata = {}) {
    const task = new Task(null, taskType, content, priority, metadata);
    const result = this.agentManager.assignTask(task);
    
    if (result.success) {
      task.assignTo(result.agentId);
      this.taskHistory.push(task);
    }
    
    return {
      ...result,
      task
    };
  }

  // 完成任务
  completeTask(agentId, taskId, result) {
    const success = this.agentManager.completeTask(agentId, taskId);
    if (success) {
      const task = this.taskHistory.find(t => t.id === taskId);
      if (task) {
        task.complete(result);
      }
    }
    return success;
  }

  // 获取Agent状态
  getAgentStatus() {
    return this.agentManager.getAgentStatus();
  }

  // 动态调整Agent池
  adjustAgentPool() {
    this.agentManager.adjustAgentPool();
  }

  // 获取Agent管理器
  getAgentManager() {
    return this.agentManager;
  }

  // 分析文本数据
  analyzeText(data, options = {}) {
    return dataAnalyzer.analyzeText(data, options);
  }

  // 分析结构化数据
  analyzeStructuredData(data, options = {}) {
    return dataAnalyzer.analyzeStructuredData(data, options);
  }

  // 分析研究数据
  analyzeResearchData(researchData, options = {}) {
    return dataAnalyzer.analyzeResearchData(researchData, options);
  }

  // 获取分析历史
  getAnalysisHistory() {
    return dataAnalyzer.getAnalysisHistory();
  }

  // 清理分析历史
  clearAnalysisHistory() {
    dataAnalyzer.clearAnalysisHistory();
  }

  // 创建研究任务
  createResearchTask(id, title, description, priority = 'medium') {
    return researchProgressTracker.createTask(id, title, description, priority);
  }

  // 更新任务状态
  updateTaskStatus(id, status) {
    return researchProgressTracker.updateTaskStatus(id, status);
  }

  // 更新任务进度
  updateTaskProgress(id, progress) {
    return researchProgressTracker.updateTaskProgress(id, progress);
  }

  // 添加任务步骤
  addTaskStep(id, step) {
    return researchProgressTracker.addTaskStep(id, step);
  }

  // 更新步骤状态
  updateStepStatus(taskId, stepId, status) {
    return researchProgressTracker.updateStepStatus(taskId, stepId, status);
  }

  // 获取任务
  getResearchTask(id) {
    return researchProgressTracker.getTask(id);
  }

  // 获取所有研究任务
  getAllResearchTasks() {
    return researchProgressTracker.getAllTasks();
  }

  // 获取任务统计
  getTaskStats() {
    return researchProgressTracker.getTaskStats();
  }

  // 删除任务
  deleteResearchTask(id) {
    return researchProgressTracker.deleteTask(id);
  }

  // 清理完成的任务
  cleanupCompletedTasks() {
    return researchProgressTracker.cleanupCompletedTasks();
  }

  // 智能搜索查询生成
  generateSearchQueries(question, options = {}) {
    return smartInformationRetriever.generateSearchQueries(question, options);
  }

  // 智能搜索结果筛选
  filterSearchResults(results, options = {}) {
    return smartInformationRetriever.filterSearchResults(results, options);
  }

  // 执行智能搜索
  async executeSmartSearch(query, options = {}) {
    return smartInformationRetriever.executeSmartSearch(query, options);
  }

  // 批量处理搜索结果
  batchProcessResults(results, options = {}) {
    return smartInformationRetriever.batchProcessResults(results, options);
  }

  // 获取搜索历史
  getSearchHistory() {
    return smartInformationRetriever.getSearchHistory();
  }

  // 清理搜索历史
  clearSearchHistory() {
    smartInformationRetriever.clearSearchHistory();
  }

  // 动态注册工作流
  registerWorkflow(id, workflow) {
    this.workflows.set(id, workflow);
  }

  // 动态创建Agent
  createAndRegisterAgent(type, config) {
    const agent = createAgent(type, config);
    this.agents.set(config.id || type, agent);
    return agent;
  }
}

module.exports = {
  createAgentRuntime,
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentRuntimeSnapshot,
  createAgentRegistry,
  routeCandidate,
  collectorToolForCandidate,
  collectorCapabilityForTask,
  selectCandidates,
  runWebResearcher,
  runSpecialistReads,
  runFactVerifierReview,
  verifyEvidenceUnits,
  evaluateResearch,
  AgentSystem,
  createAgent,
  AgentType,
  AgentStatus,
  BaseAgent,
  SupervisorAgent,
  WebResearcherAgent,
  LongTextCollectorAgent,
  VideoParserAgent,
  ChartParserAgent,
  TableParserAgent,
  FactVerifierAgent,
  SynthesizerAgent,
  ToolCreatorAgent,
  ToolCreatorPool,
  StateGraph,
  createResearchWorkflow
};




