const { agentCommunication } = require("./agent-communication");

function applyAgentSystemCommunication(AgentSystem) {
  Object.assign(AgentSystem.prototype, {
    sendMessage(sender, receiver, type, content, metadata = {}) {
      return agentCommunication.sendMessage(sender, receiver, type, content, metadata);
    },

    sendRequest(sender, receiver, content, metadata = {}) {
      return agentCommunication.sendRequest(sender, receiver, content, metadata);
    },

    sendResponse(sender, receiver, content, metadata = {}) {
      return agentCommunication.sendResponse(sender, receiver, content, metadata);
    },

    sendNotification(sender, receiver, content, metadata = {}) {
      return agentCommunication.sendNotification(sender, receiver, content, metadata);
    },

    sendError(sender, receiver, content, metadata = {}) {
      return agentCommunication.sendError(sender, receiver, content, metadata);
    },

    subscribe(role, callback) {
      agentCommunication.subscribe(role, callback);
    },

    unsubscribe(role, callback) {
      agentCommunication.unsubscribe(role, callback);
    },

    getMessageHistory() {
      return agentCommunication.getMessageHistory();
    },

    getMessageStats() {
      return agentCommunication.getMessageStats();
    },

    clearMessageHistory() {
      agentCommunication.clearMessageHistory();
    }
  });
}

module.exports = {
  applyAgentSystemCommunication
};
