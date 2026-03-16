const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const {
  normalizeToolCreationRequest,
  normalizeToolSpec,
  compileTool,
  executeTool,
  validateToolResult,
  requestToolCreation,
  runEphemeralTool,
  readToolMemory,
  readAuditLog
} = require("../src/tool-platform");
const { ToolRegistry } = require("../src/source-connectors");

test("normalizeToolCreationRequest should preserve the formal requester and tool specs", () => {
  const request = normalizeToolCreationRequest("llm_orchestrator", [
    { id: "tool_a", name: "Tool A" }
  ], {
    purpose: "recovery"
  });

  assert.equal(request.requester, "llm_orchestrator");
  assert.equal(request.tool_specs.length, 1);
  assert.equal(request.metadata.purpose, "recovery");
});

test("compileTool should create a node executable with hashes", () => {
  const tool = compileTool(normalizeToolSpec({
    tool_id: "compiled_tool",
    name: "Compiled Tool",
    description: "Returns a normalized read",
    parameters: [
      { name: "candidate", type: "object", required: true }
    ],
    implementation: async ({ candidate }) => ({
      source_id: candidate.id,
      title: candidate.title,
      content_type: candidate.content_type,
      source_type: candidate.source_type
    })
  }));

  assert.equal(tool.runtime, "node");
  assert.ok(tool.code_hash);
  assert.ok(tool.spec_hash);
});

test("compileTool should preserve python runtime for generated tools", () => {
  const tool = compileTool(normalizeToolSpec({
    tool_id: "compiled_python_tool",
    base_tool_id: "compiled_python_tool",
    runtime: "python",
    name: "Compiled Python Tool",
    description: "Returns a normalized read",
    parameters: [
      { name: "candidate", type: "object", required: true }
    ]
  }));

  assert.equal(tool.runtime, "python");
  assert.equal(tool.executable_kind, "script");
  assert.match(tool.code, /import json/);
});

test("executeTool should reject scripts that violate sandbox network policy", async () => {
  const tool = compileTool(normalizeToolSpec({
    tool_id: "blocked_network_tool",
    base_tool_id: "blocked_network_tool",
    runtime: "node",
    name: "Blocked Network Tool",
    code: `
async function readStdin() { return {}; }
(async () => {
  const result = await fetch("https://example.com");
  process.stdout.write(JSON.stringify({ success: true, status: result.status }));
})();
`
  }));

  await assert.rejects(() => executeTool({
    executable: tool,
    sandbox: {
      network: false
    }
  }), /Sandbox policy rejected tool/);
});

test("executeTool should stop scripts that exceed sandbox output limits", async () => {
  const tool = compileTool(normalizeToolSpec({
    tool_id: "output_limit_tool",
    base_tool_id: "output_limit_tool",
    runtime: "node",
    name: "Output Limit Tool",
    code: `
const payload = "x".repeat(2048);
process.stdout.write(JSON.stringify({ success: true, payload }));
`
  }));

  const result = await executeTool({
    executable: tool,
    sandbox: {
      max_output_bytes: 128
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.error_code, "output_limit_exceeded");
});

test("executeTool and validateToolResult should produce a supported verdict for normalized reads", async () => {
  const executable = compileTool(normalizeToolSpec({
    tool_id: "validator_tool",
    name: "Validator Tool",
    description: "Returns a normalized read",
    parameters: [
      { name: "candidate", type: "object", required: true }
    ],
    implementation: async ({ candidate }) => ({
      source_id: candidate.id,
      title: candidate.title,
      content_type: candidate.content_type,
      source_type: candidate.source_type
    })
  }));

  const result = await executeTool({
    executable,
    input: {
      candidate: {
        id: "cand-1",
        title: "Candidate One",
        content_type: "web",
        source_type: "web"
      }
    }
  });
  const validation = validateToolResult({
    tool: executable,
    result,
    validationContext: {
      expect_read: true,
      expected_source_id: "cand-1"
    }
  });

  assert.equal(result.success, true);
  assert.equal(validation.success, true);
  assert.equal(validation.verdict, "supported");
});

test("requestToolCreation should reject non-orchestrator requesters", async () => {
  await assert.rejects(() => requestToolCreation({
    requester: "web_researcher",
    tool_specs: [
      { id: "bad_request_tool", name: "Bad Request Tool" }
    ]
  }), /LLM-Orchestrator/);
});

test("requestToolCreation should register tools as ephemeral first", async () => {
  const toolId = `platform_tool_${Date.now()}`;
  const response = await requestToolCreation({
    requester: "llm_orchestrator",
    tool_specs: [
      {
        id: toolId,
        name: "Platform Tool",
        description: "Returns a normalized read",
        parameters: [
          { name: "candidate", type: "object", required: true }
        ],
        implementation: async ({ candidate }) => ({
          source_id: candidate.id,
          title: candidate.title,
          content_type: candidate.content_type,
          source_type: candidate.source_type
        })
      }
    ]
  });

  assert.equal(response.success, true);
  assert.equal(response.tools[0].lifecycle_state, "ephemeral");
  assert.equal(ToolRegistry.getTool(toolId).lifecycle_state, "ephemeral");
});

test("requestToolCreation should use creator output as the primary synthesis path", async () => {
  const toolId = `creator_primary_${Date.now()}`;
  const creator = {
    async execute() {
      return {
        tools: [
          {
            tool_id: toolId,
            base_tool_id: "creator_primary",
            name: "Creator Primary Tool",
            runtime: "python",
            parameters: [{ name: "candidate", type: "object", required: true }]
          }
        ]
      };
    }
  };

  const response = await requestToolCreation({
    requester: "llm_orchestrator",
    tool_specs: [
      {
        name: "Ignored Seed Spec",
        parameters: [{ name: "candidate", type: "object", required: true }]
      }
    ]
  }, { creator });

  assert.equal(response.success, true);
  assert.equal(response.tools[0].runtime, "python");
  assert.equal(response.tools[0].tool_id, toolId);
});

test("runEphemeralTool should auto-promote tools after repeated verified successes", async () => {
  const memoryPath = `${process.cwd()}\\data\\tool-platform-test-${Date.now()}.json`;
  const tool = normalizeToolSpec({
    tool_id: `auto_promote_${Date.now()}`,
    base_tool_id: "auto_promote_tool",
    name: "Auto Promote Tool",
    parameters: [{ name: "candidate", type: "object", required: true }],
    implementation: async ({ candidate }) => ({
      source_id: candidate.id,
      title: candidate.title,
      content_type: candidate.content_type,
      source_type: candidate.source_type
    })
  });

  try {
    const payload = {
      candidate: {
        id: "promote-1",
        title: "Promote Candidate",
        content_type: "web",
        source_type: "web"
      }
    };

    const first = await runEphemeralTool(tool, { memoryPath, input: payload });
    const second = await runEphemeralTool(tool, { memoryPath, input: payload });
    const third = await runEphemeralTool(tool, { memoryPath, input: payload });
    const memory = readToolMemory(memoryPath);

    assert.equal(first.promotion.lifecycle_state, "ephemeral");
    assert.equal(second.promotion.lifecycle_state, "candidate");
    assert.equal(third.promotion.lifecycle_state, "registered");
    assert.ok((memory.promotion_history || []).length >= 3);
  } finally {
    try {
      require("fs").unlinkSync(memoryPath);
    } catch (_) {
      // ignore
    }
  }
});

test("runEphemeralTool should fail validation when deterministic replay diverges", async () => {
  const tool = normalizeToolSpec({
    tool_id: `nondeterministic_${Date.now()}`,
    base_tool_id: "nondeterministic_tool",
    name: "Nondeterministic Tool",
    runtime: "node",
    code: `
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}
(async () => {
  const input = await readStdin();
  process.stdout.write(JSON.stringify({
    success: true,
    source_id: input.candidate.id,
    title: String(Date.now()),
    content_type: input.candidate.content_type,
    source_type: input.candidate.source_type
  }));
})();
`
  });

  const result = await runEphemeralTool(tool, {
    input: {
      candidate: {
        id: "det-1",
        title: "Deterministic Candidate",
        content_type: "web",
        source_type: "web"
      }
    },
    require_deterministic: true
  });

  assert.equal(result.validation.success, false);
  assert.match(result.validation.reasons.join(" | "), /Determinism validation failed/);
});

test("requestToolCreation should reuse a previously promoted tool for the same base tool id", async () => {
  const tool = normalizeToolSpec({
    tool_id: `reuse_source_${Date.now()}`,
    base_tool_id: "reuse_base_tool",
    name: "Reuse Source Tool",
    parameters: [{ name: "candidate", type: "object", required: true }],
    implementation: async ({ candidate }) => ({
      source_id: candidate.id,
      title: candidate.title,
      content_type: candidate.content_type,
      source_type: candidate.source_type
    })
  });

  const payload = {
    candidate: {
      id: "reuse-1",
      title: "Reuse Candidate",
      content_type: "web",
      source_type: "web"
    }
  };

  await runEphemeralTool(tool, { input: payload });
  await runEphemeralTool(tool, { input: payload });
  await runEphemeralTool(tool, { input: payload });

  const response = await requestToolCreation({
    requester: "llm_orchestrator",
    tool_specs: [
      {
        base_tool_id: "reuse_base_tool",
        name: "Reuse Source Tool",
        parameters: [{ name: "candidate", type: "object", required: true }]
      }
    ]
  });

  assert.equal(response.tools[0].reused, true);
});

test("promoted registered tools should roll back after repeated execution failures", async () => {
  const baseToolId = `rollback_base_${Date.now()}`;
  const stable = normalizeToolSpec({
    tool_id: `${baseToolId}_stable`,
    base_tool_id: baseToolId,
    version: "1.0.0",
    name: "Stable Rollback Tool",
    parameters: [{ name: "candidate", type: "object", required: true }],
    implementation: async ({ candidate }) => ({
      source_id: candidate.id,
      title: candidate.title,
      content_type: candidate.content_type,
      source_type: candidate.source_type
    })
  });
  const unstable = normalizeToolSpec({
    tool_id: `${baseToolId}_unstable`,
    base_tool_id: baseToolId,
    version: "1.0.1",
    name: "Unstable Rollback Tool",
    parameters: [{ name: "candidate", type: "object", required: true }],
    implementation: async ({ candidate, fail }) => {
      if (fail) {
        throw new Error("regression failure");
      }
      return {
        source_id: candidate.id,
        title: candidate.title,
        content_type: candidate.content_type,
        source_type: candidate.source_type
      };
    }
  });
  const payload = {
    candidate: {
      id: "roll-1",
      title: "Rollback Candidate",
      content_type: "web",
      source_type: "web"
    }
  };

  await runEphemeralTool(stable, { input: payload });
  await runEphemeralTool(stable, { input: payload });
  await runEphemeralTool(stable, { input: payload });

  await runEphemeralTool(unstable, { input: payload });
  await runEphemeralTool(unstable, { input: payload });
  await runEphemeralTool(unstable, { input: payload });

  const thirdFailure = await runEphemeralTool(unstable, {
    input: {
      ...payload,
      fail: true
    }
  });
  await runEphemeralTool(unstable, {
    input: {
      ...payload,
      fail: true
    }
  });
  await runEphemeralTool(unstable, {
    input: {
      ...payload,
      fail: true
    }
  });

  assert.ok(ToolRegistry.getTool(baseToolId));
  assert.equal(ToolRegistry.getTool(baseToolId).id, `${baseToolId}_stable`);
});

test("runEphemeralTool should append execution audit events", async () => {
  const auditPath = `${process.cwd()}\\data\\tool-platform-audit-test-${Date.now()}.jsonl`;
  process.env.OPENSEARCH_TOOL_AUDIT_PATH = auditPath;
  const { runEphemeralTool: runAuditedTool } = require("../src/tool-platform");
  const tool = normalizeToolSpec({
    tool_id: `audit_${Date.now()}`,
    base_tool_id: "audit_tool",
    name: "Audit Tool",
    parameters: [{ name: "candidate", type: "object", required: true }],
    implementation: async ({ candidate }) => ({
      source_id: candidate.id,
      title: candidate.title,
      content_type: candidate.content_type,
      source_type: candidate.source_type
    })
  });

  try {
    await runAuditedTool(tool, {
      input: {
        candidate: {
          id: "audit-1",
          title: "Audit Candidate",
          content_type: "web",
          source_type: "web"
        }
      }
    });
    const content = fs.readFileSync(auditPath, "utf8");
    assert.match(content, /tool_execution/);
    assert.ok(readAuditLog(5).some((entry) => entry.type === "tool_execution"));
  } finally {
    delete process.env.OPENSEARCH_TOOL_AUDIT_PATH;
    try {
      fs.unlinkSync(auditPath);
    } catch (_) {
      // ignore
    }
  }
});
