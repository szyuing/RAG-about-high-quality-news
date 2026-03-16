const { knowledgeSharingSystem } = require("./knowledge-sharing");

function applyAgentSystemKnowledge(AgentSystem) {
  Object.assign(AgentSystem.prototype, {
    shareKnowledge(source, content, tags = [], confidence = 0.8) {
      return knowledgeSharingSystem.shareKnowledge(source, content, tags, confidence);
    },

    getKnowledge(id) {
      return knowledgeSharingSystem.getKnowledge(id);
    },

    searchKnowledge(query, tags = []) {
      return knowledgeSharingSystem.searchKnowledge(query, tags);
    },

    resolveConflict(conflictId, resolution) {
      return knowledgeSharingSystem.resolveConflict(conflictId, resolution);
    },

    getConflicts() {
      return knowledgeSharingSystem.getConflicts();
    },

    getUnresolvedConflicts() {
      return knowledgeSharingSystem.getUnresolvedConflicts();
    },

    getKnowledgeStats() {
      return knowledgeSharingSystem.getKnowledgeStats();
    },

    cleanupOldKnowledge(maxAge) {
      return knowledgeSharingSystem.cleanupOldKnowledge(maxAge);
    }
  });
}

module.exports = {
  applyAgentSystemKnowledge
};
