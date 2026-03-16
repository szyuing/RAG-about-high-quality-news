const {
  createAgentRegistry,
  createAgentRuntime,
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentRuntimeSnapshot
} = require("./agent-runtime");
const { resolveDataDir, resolveDataFile, resolveStateDir } = require("./data-paths");

const runtimeCapabilities = Object.freeze({
  tools: ["tool_registry", "tool_invocation"],
  state: ["workflow_state", "node_state"],
  memory: ["scratchpad", "experience_memory", "runtime_trace"],
  execution: ["agent_dispatch", "task_lifecycle", "runtime_snapshot"]
});

module.exports = {
  createAgentRegistry,
  createAgentRuntime,
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentRuntimeSnapshot,
  resolveDataDir,
  resolveDataFile,
  resolveStateDir,
  runtimeCapabilities
};
