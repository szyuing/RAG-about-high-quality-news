const { dataAnalyzer, researchProgressTracker } = require("./data-analysis");
const { smartInformationRetriever } = require("./smart-retriever");

function applyAgentSystemAnalysis(AgentSystem) {
  Object.assign(AgentSystem.prototype, {
    analyzeText(data, options = {}) {
      return dataAnalyzer.analyzeText(data, options);
    },

    analyzeStructuredData(data, options = {}) {
      return dataAnalyzer.analyzeStructuredData(data, options);
    },

    analyzeResearchData(researchData, options = {}) {
      return dataAnalyzer.analyzeResearchData(researchData, options);
    },

    getAnalysisHistory() {
      return dataAnalyzer.getAnalysisHistory();
    },

    clearAnalysisHistory() {
      dataAnalyzer.clearAnalysisHistory();
    },

    createResearchTask(id, title, description, priority = "medium") {
      return researchProgressTracker.createTask(id, title, description, priority);
    },

    updateTaskStatus(id, status) {
      return researchProgressTracker.updateTaskStatus(id, status);
    },

    updateTaskProgress(id, progress) {
      return researchProgressTracker.updateTaskProgress(id, progress);
    },

    addTaskStep(id, step) {
      return researchProgressTracker.addTaskStep(id, step);
    },

    updateStepStatus(taskId, stepId, status) {
      return researchProgressTracker.updateStepStatus(taskId, stepId, status);
    },

    getResearchTask(id) {
      return researchProgressTracker.getTask(id);
    },

    getAllResearchTasks() {
      return researchProgressTracker.getAllTasks();
    },

    getTaskStats() {
      return researchProgressTracker.getTaskStats();
    },

    deleteResearchTask(id) {
      return researchProgressTracker.deleteTask(id);
    },

    cleanupCompletedTasks() {
      return researchProgressTracker.cleanupCompletedTasks();
    },

    generateSearchQueries(question, options = {}) {
      return smartInformationRetriever.generateSearchQueries(question, options);
    },

    filterSearchResults(results, options = {}) {
      return smartInformationRetriever.filterSearchResults(results, options);
    },

    async executeSmartSearch(query, options = {}) {
      return smartInformationRetriever.executeSmartSearch(query, options);
    },

    batchProcessResults(results, options = {}) {
      return smartInformationRetriever.batchProcessResults(results, options);
    },

    getSearchHistory() {
      return smartInformationRetriever.getSearchHistory();
    },

    clearSearchHistory() {
      smartInformationRetriever.clearSearchHistory();
    }
  });
}

module.exports = {
  applyAgentSystemAnalysis
};
