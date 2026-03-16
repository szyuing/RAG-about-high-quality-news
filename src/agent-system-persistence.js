const { statePersistence } = require("./state-persistence");

function applyAgentSystemPersistence(AgentSystem) {
  Object.assign(AgentSystem.prototype, {
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

      return statePersistence.saveState("system", state);
    },

    async loadSystemState() {
      const result = await statePersistence.loadState("system");
      if (result.success) {
        console.log("System state loaded successfully");
        return result.data;
      }
      return null;
    },

    async saveSession(sessionId, sessionData) {
      return statePersistence.saveSession(sessionId, sessionData);
    },

    async loadSession(sessionId) {
      const result = await statePersistence.loadSession(sessionId);
      if (result.success) {
        console.log(`Session ${sessionId} loaded successfully`);
        return result.data;
      }
      return null;
    },

    async saveAgentState(agentId, additionalState = {}) {
      const agent = this.agents.get(agentId);
      if (!agent) {
        return { success: false, message: "Agent not found" };
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

      return statePersistence.saveAgentState(agentId, state);
    },

    async loadAgentState(agentId) {
      const result = await statePersistence.loadAgentState(agentId);
      if (result.success) {
        console.log(`Agent ${agentId} state loaded successfully`);
        return result.data;
      }
      return null;
    },

    listSavedStates() {
      return statePersistence.listStates();
    }
  });
}

module.exports = {
  applyAgentSystemPersistence
};
