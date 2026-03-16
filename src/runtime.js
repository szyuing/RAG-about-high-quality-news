const {
  createAgentRegistry,
  createAgentRuntime,
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentRuntimeSnapshot
} = require("./agent-runtime");
const { resolveDataDir, resolveDataFile, resolveStateDir } = require("./data-paths");
const {
  toolPlatformApi,
  requestToolCreation,
  compileTool,
  executeTool,
  validateToolResult,
  recordToolOutcome,
  promoteToolCandidate,
  synthesizeTool,
  runEphemeralTool,
  readToolMemory,
  readAuditLog
} = require("./tool-platform");

const runtimeCapabilities = Object.freeze({
  tools: Object.freeze({
    lifecycle: ["request_tool_creation", "compile_tool", "execute_tool", "validate_tool_result", "record_tool_outcome", "promote_tool_candidate"],
    requestToolCreation: "requestToolCreation",
    compileTool: "compileTool",
    executeTool: "executeTool",
    validateToolResult: "validateToolResult",
    recordToolOutcome: "recordToolOutcome",
    promoteToolCandidate: "promoteToolCandidate",
    readAuditLog: "readAuditLog"
  }),
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
  toolPlatformApi,
  requestToolCreation,
  compileTool,
  executeTool,
  validateToolResult,
  recordToolOutcome,
  promoteToolCandidate,
  synthesizeTool,
  runEphemeralTool,
  readToolMemory,
  readAuditLog,
  resolveDataDir,
  resolveDataFile,
  resolveStateDir,
  runtimeCapabilities
};
