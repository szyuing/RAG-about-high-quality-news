const { Task } = require("./agent-manager");
const { createAgent } = require("./agents");

function applyAgentSystemTasking(AgentSystem) {
  Object.assign(AgentSystem.prototype, {
    createAgent(type, config = {}) {
      const agent = this.agentManager.createAgent(type, config);
      this.agents.set(agent.id, agent);
      return agent;
    },

    destroyAgent(agentId) {
      return this.agentManager.destroyAgent(agentId);
    },

    assignTask(taskType, content, priority = "medium", metadata = {}) {
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
    },

    completeTask(agentId, taskId, result) {
      const success = this.agentManager.completeTask(agentId, taskId);
      if (success) {
        const task = this.taskHistory.find((entry) => entry.id === taskId);
        if (task) {
          task.complete(result);
        }
      }
      return success;
    },

    getAgentStatus() {
      return this.agentManager.getAgentStatus();
    },

    adjustAgentPool() {
      this.agentManager.adjustAgentPool();
    },

    getAgentManager() {
      return this.agentManager;
    },

    registerWorkflow(id, workflow) {
      this.workflows.set(id, workflow);
    },

    createAndRegisterAgent(type, config) {
      const agent = createAgent(type, config);
      this.agents.set(config.id || type, agent);
      return agent;
    }
  });
}

module.exports = {
  applyAgentSystemTasking
};
