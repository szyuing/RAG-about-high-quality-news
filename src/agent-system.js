const { AgentManager } = require("./agent-manager");
const {
  AgentStatus,
  AgentType,
  BaseAgent,
  LLMOrchestratorAgent,
  ToolCreatorAgent,
  createAgent
} = require("./agents");
const { createResearchWorkflow } = require("./workflow");
const { applyAgentSystemTooling } = require("./agent-system-tooling");
const { applyAgentSystemPersistence } = require("./agent-system-persistence");
const { applyAgentSystemCommunication } = require("./agent-system-communication");
const { applyAgentSystemKnowledge } = require("./agent-system-knowledge");
const { applyAgentSystemTasking } = require("./agent-system-tasking");
const { applyAgentSystemAnalysis } = require("./agent-system-analysis");

function registerAgentFactory(agentManager, type, name, AgentClass = BaseAgent) {
  agentManager.registerAgentType(type, (config) => new AgentClass({
    id: `${type}_${Date.now()}`,
    type,
    name,
    ...config
  }));
}

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
      AgentType.LLM_ORCHESTRATOR,
      AgentType.WEB_RESEARCHER,
      AgentType.LONG_TEXT_COLLECTOR,
      AgentType.VIDEO_PARSER,
      AgentType.CHART_PARSER,
      AgentType.TABLE_PARSER,
      AgentType.FACT_VERIFIER,
      AgentType.TOOL_CREATOR
    ];

    for (const type of agentTypes) {
      this.agents.set(type, createAgent(type));
    }
  }

  initializeWorkflows() {
    this.workflows.set("research", createResearchWorkflow());
  }

  initializeAgentManager() {
    registerAgentFactory(this.agentManager, AgentType.LLM_ORCHESTRATOR, "LLM-Orchestrator", LLMOrchestratorAgent);
    registerAgentFactory(this.agentManager, AgentType.WEB_RESEARCHER, "Web Researcher");
    registerAgentFactory(this.agentManager, AgentType.LONG_TEXT_COLLECTOR, "Long Text Collector");
    registerAgentFactory(this.agentManager, AgentType.VIDEO_PARSER, "Video Parser");
    registerAgentFactory(this.agentManager, AgentType.CHART_PARSER, "Chart Parser");
    registerAgentFactory(this.agentManager, AgentType.TABLE_PARSER, "Table Parser");
    registerAgentFactory(this.agentManager, AgentType.FACT_VERIFIER, "Fact Verifier");
    registerAgentFactory(
      this.agentManager,
      AgentType.TOOL_CREATOR,
      "Tool Creator",
      ToolCreatorAgent
    );
  }

  getAgent(type) {
    return this.agents.get(type);
  }

  getAllAgents() {
    return Array.from(this.agents.values()).map((agent) => ({
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

    return workflow.run({
      ...initialState,
      agentSystem: this
    });
  }

  getSystemStatus() {
    const agents = Array.from(this.agents.values());
    const activeAgents = agents.filter((agent) => agent.status === AgentStatus.RUNNING);
    const completedAgents = agents.filter((agent) => agent.status === AgentStatus.COMPLETED);
    const failedAgents = agents.filter((agent) => agent.status === AgentStatus.FAILED);

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

  getSystemHealth() {
    const agents = Array.from(this.agents.values());
    const failedAgents = agents.filter((agent) => agent.status === AgentStatus.FAILED);
    const totalAgents = agents.length;
    const failureRate = totalAgents > 0 ? failedAgents.length / totalAgents : 0;

    let status = "healthy";
    if (failureRate > 0.5) {
      status = "critical";
    } else if (failureRate > 0.2) {
      status = "warning";
    }

    return {
      status,
      failureRate: Number(failureRate.toFixed(2)),
      totalAgents,
      failedAgents: failedAgents.length,
      timestamp: Date.now()
    };
  }

  getPerformanceMetrics() {
    const agents = Array.from(this.agents.values());
    const completedAgents = agents.filter((agent) => agent.status === AgentStatus.COMPLETED);
    const executionTimes = completedAgents.map((agent) => agent.executionTime).filter(Boolean);
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

  monitorAgentStatus() {
    const agents = Array.from(this.agents.values());
    const statusReport = {
      timestamp: Date.now(),
      agents: agents.map((agent) => ({
        id: agent.id,
        type: agent.type,
        status: agent.status,
        lastSuccessTime: agent.lastSuccessTime,
        lastFailureTime: agent.lastFailureTime,
        executionTime: agent.executionTime
      }))
    };

    console.log("Agent Status Monitor:", statusReport);
    return statusReport;
  }

  async recoverFromFailure(agentId, error) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, message: "Agent not found" };
    }

    console.log(`Attempting to recover agent ${agentId} from error: ${error.message}`);

    try {
      agent.reset();
      return { success: true, message: "Agent reset successfully" };
    } catch (recoveryError) {
      return { success: false, message: `Recovery failed: ${recoveryError.message}` };
    }
  }
}

applyAgentSystemTooling(AgentSystem);
applyAgentSystemPersistence(AgentSystem);
applyAgentSystemCommunication(AgentSystem);
applyAgentSystemKnowledge(AgentSystem);
applyAgentSystemTasking(AgentSystem);
applyAgentSystemAnalysis(AgentSystem);

module.exports = {
  AgentSystem
};
