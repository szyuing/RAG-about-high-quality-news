const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BaseAgent,
  WebResearcherAgent
} = require("../src/agent-orchestrator");
const { ToolRegistry } = require("../src/source-connectors");

test("BaseAgent should fail when every tool execution fails", async () => {
  const toolId = `failing_tool_${Date.now()}`;

  ToolRegistry.registerTool({
    id: toolId,
    name: "Failing Tool",
    description: "Always fails",
    parameters: [],
    execute: async () => {
      throw new Error("tool failure");
    },
    source: "test"
  });

  const agent = new BaseAgent({
    id: "base-failure-agent",
    name: "Base Failure Agent",
    type: "test",
    tools: [toolId]
  });

  const result = await agent.execute({});

  assert.equal(result.status, "failed");
  assert.match(result.error.message, /All tools failed/);
});

test("WebResearcherAgent should fail when search tool execution fails", async () => {
  const agent = new WebResearcherAgent({
    id: "web-failure-agent",
    name: "Web Failure Agent"
  });

  agent.executeTools = async () => ([{
    success: false,
    error: { message: "search connector unavailable" }
  }]);

  const result = await agent.execute({
    query: "Sora latest update",
    connectorIds: ["bing_web"]
  });

  assert.equal(result.status, "failed");
  assert.match(result.result.markdown_report, /search connector unavailable/);
});
