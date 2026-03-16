const { ToolRegistry } = require("./source-connectors");
const { agentCommunication } = require("./agent-communication");
const { AgentType, ToolCreatorPool } = require("./agents");
const { requestToolCreation: requestToolCreationFromRuntime } = require("./runtime");

function applyAgentSystemTooling(AgentSystem) {
  Object.assign(AgentSystem.prototype, {
    initializeToolCreatorPool(poolSize = 2) {
      this.toolCreatorPool = new ToolCreatorPool(this, poolSize);
    },

    getToolCreatorPool() {
      return this.toolCreatorPool;
    },

    initializeCommunicationProtocols() {
      const toolCreator = this.getAgent(AgentType.TOOL_CREATOR);
      if (!toolCreator) {
        return;
      }

      this.boundToolCreationHandler = async (message) => {
        if (message.type !== "request") {
          return;
        }
        if (message.content?.request_type !== "tool_creation") {
          return;
        }

        message.metadata = message.metadata || {};
        if (message.metadata._tool_creation_handled) {
          return;
        }

        message.metadata._tool_creation_handled = true;
        await toolCreator.handleToolCreationRequest(message);
      };

      agentCommunication.subscribe(AgentType.TOOL_CREATOR, this.boundToolCreationHandler);
    },

    async createTool(toolSpec) {
      if (this.toolCreatorPool) {
        return this.toolCreatorPool.execute([toolSpec]);
      }

      const toolCreator = this.getAgent(AgentType.TOOL_CREATOR);
      return toolCreator.execute({ toolSpecs: [toolSpec] });
    },

    async createTools(toolSpecs) {
      if (this.toolCreatorPool) {
        return this.toolCreatorPool.execute(toolSpecs);
      }

      const toolCreator = this.getAgent(AgentType.TOOL_CREATOR);
      return toolCreator.execute({ toolSpecs });
    },

    async requestToolCreation(requester, toolSpecs, metadata = {}) {
      if (requester !== AgentType.LLM_ORCHESTRATOR) {
        throw new Error("Only LLM-Orchestrator can formally request tool creation");
      }

      const { response } = await agentCommunication.requestToolCreation(
        requester,
        AgentType.TOOL_CREATOR,
        toolSpecs,
        metadata
      );
      return requestToolCreationFromRuntime({
        requester,
        metadata: {
          ...metadata,
          request_id: response.content?.request_id || response.metadata?.correlation_id || null
        },
        tool_specs: response.content?.tools || toolSpecs
      }, {
        creator: this.getAgent(AgentType.TOOL_CREATOR)
      });
    },

    respondToolCreation(sender, receiver, requestId, payload, metadata = {}) {
      return agentCommunication.respondToolCreation(
        sender,
        receiver,
        requestId,
        payload,
        metadata
      );
    },

    getToolHistory(toolId) {
      return ToolRegistry.getToolHistory(toolId);
    },

    deprecateTool(toolId, reason = "deprecated_by_agent_system") {
      return ToolRegistry.deprecateTool(toolId, reason);
    },

    rollbackTool(toolId, targetToolId = null) {
      return ToolRegistry.rollbackTool(toolId, targetToolId);
    },

    promoteTool(toolId, reason = "promoted_by_agent_system") {
      return ToolRegistry.promoteTool(toolId, reason);
    },

    resolveToolForTask(taskSpec = {}) {
      return ToolRegistry.resolveToolForTask(taskSpec);
    }
  });
}

module.exports = {
  applyAgentSystemTooling
};
