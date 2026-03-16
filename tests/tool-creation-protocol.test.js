const test = require("node:test");
const assert = require("node:assert/strict");
const { AgentSystem, AgentType } = require("../src/agent-orchestrator");
const { ToolRegistry } = require("../src/source-connectors");

test("AgentSystem should route tool creation requests through Tool Creator Agent messaging", async () => {
  const agentSystem = new AgentSystem();
  agentSystem.clearMessageHistory();

  const toolId = `protocol_tool_${Date.now()}`;
  const response = await agentSystem.requestToolCreation(AgentType.WEB_RESEARCHER, [
    {
      id: toolId,
      name: "Protocol Tool",
      description: "Created through the tool creation request protocol.",
      parameters: [
        {
          name: "query",
          type: "string",
          required: true,
          description: "Input query"
        }
      ]
    }
  ], {
    purpose: "Normalize research outputs",
    timeout_ms: 3000
  });

  assert.equal(response.request_type, "tool_creation_result");
  assert.equal(response.success, true);
  assert.equal(response.count, 1);
  assert.equal(response.tools[0].id, toolId);
  assert.equal(response.tools[0].created_for, AgentType.WEB_RESEARCHER);

  const registered = ToolRegistry.getTool(toolId);
  assert.equal(registered.id, toolId);

  const history = agentSystem.getMessageHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].metadata.request_id, history[1].metadata.correlation_id);
  assert.equal(history[1].content.request_type, "tool_creation_result");
});

test("AgentSystem should expose a standard request-response protocol for tool creation", async () => {
  const agentSystem = new AgentSystem();
  agentSystem.clearMessageHistory();

  const toolId = `protocol_calc_${Date.now()}`;
  const response = await agentSystem.requestToolCreation(AgentType.LONG_TEXT_COLLECTOR, [
    {
      id: toolId,
      name: "Protocol Calculator",
      description: "Generated via standard tool creation request.",
      parameters: [
        {
          name: "value",
          type: "number",
          required: true,
          description: "Numeric value"
        }
      ],
      implementation: async (input) => ({
        doubled: Number(input.value) * 2
      })
    }
  ], {
    purpose: "Create a small numeric helper",
    timeout_ms: 3000
  });

  assert.equal(response.tools[0].request_id !== null, true);
  const execution = await ToolRegistry.executeTool(toolId, { value: 4 });
  assert.equal(execution.success, true);
  assert.equal(execution.data.doubled, 8);
});

test("Tool lifecycle management should track versions, promotion, deprecation, and rollback", async () => {
  const agentSystem = new AgentSystem();
  const baseToolId = `lifecycle_tool_${Date.now()}`;

  const first = await agentSystem.requestToolCreation(AgentType.WEB_RESEARCHER, [
    {
      id: `${baseToolId}_v1`,
      base_tool_id: baseToolId,
      version: "1.0.0",
      name: "Lifecycle Tool",
      description: "First version",
      parameters: [],
      implementation: async () => ({ version: "v1" })
    }
  ], { timeout_ms: 3000 });

  const second = await agentSystem.requestToolCreation(AgentType.WEB_RESEARCHER, [
    {
      id: `${baseToolId}_v2`,
      base_tool_id: baseToolId,
      version: "2.0.0",
      name: "Lifecycle Tool",
      description: "Second version",
      parameters: [],
      implementation: async () => ({ version: "v2" })
    }
  ], { timeout_ms: 3000 });

  const history = agentSystem.getToolHistory(baseToolId);
  assert.equal(history.length, 2);
  assert.equal(ToolRegistry.getTool(baseToolId).id, `${baseToolId}_v2`);

  const promoted = agentSystem.promoteTool(baseToolId, "high success rate");
  assert.equal(promoted.promoted_to_builtin, true);

  const deprecated = agentSystem.deprecateTool(`${baseToolId}_v2`, "bad regression");
  assert.equal(deprecated.status, "deprecated");

  const deprecatedExecution = await ToolRegistry.executeTool(`${baseToolId}_v2`, {});
  assert.equal(deprecatedExecution.success, false);

  const rollback = agentSystem.rollbackTool(baseToolId, `${baseToolId}_v1`);
  assert.equal(rollback.active.id, `${baseToolId}_v1`);

  const execution = await ToolRegistry.executeTool(baseToolId, {});
  assert.equal(execution.success, true);
  assert.equal(execution.data.version, "v1");

  const lifecycle = ToolRegistry.getLifecycleEvents(baseToolId);
  assert.ok(lifecycle.some((item) => item.type === "registered"));
  assert.ok(lifecycle.some((item) => item.type === "promoted"));
  assert.ok(lifecycle.some((item) => item.type === "deprecated"));
  assert.ok(lifecycle.some((item) => item.type === "rolled_back"));

  assert.equal(first.tools[0].version, "1.0.0");
  assert.equal(second.tools[0].version, "2.0.0");
});

test("AgentSystem should expose a unified tool resolution interface for parser agents", () => {
  const agentSystem = new AgentSystem();

  const videoResolution = agentSystem.resolveToolForTask({
    agent: "video_parser",
    capability: "parse_video",
    candidate: {
      url: "https://example.com/watch",
      content_type: "video",
      source_type: "video"
    }
  });

  const chartResolution = agentSystem.resolveToolForTask({
    agent: "chart_parser",
    capability: "parse_chart_document",
    candidate: {
      url: "https://example.com/report.pdf",
      content_type: "document",
      source_type: "document",
      metadata: {
        mime_type: "application/pdf",
        page_images: ["https://example.com/page-1.png"]
      }
    }
  });

  assert.equal(videoResolution.tool_id, "extract_video_intel");
  assert.equal(chartResolution.tool_id, "read_document_intel");
});
