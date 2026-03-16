const test = require("node:test");
const assert = require("node:assert/strict");
const { ToolRegistry } = require("../src/source-connectors");
const { runSpecialistReads } = require("../src/agent-orchestrator");

test("ToolRegistry should expose core capabilities and enforce custom validation", () => {
  const capabilityIds = ToolRegistry.getToolCapabilities().map((item) => item.id);
  assert.ok(capabilityIds.includes("deep_read_page"));
  assert.ok(capabilityIds.includes("extract_video_intel"));
  assert.ok(capabilityIds.includes("cross_check_facts"));

  const invalidRead = ToolRegistry.testTool("deep_read_page", {});
  assert.equal(invalidRead.success, false);
  assert.match(invalidRead.error, /Either url or candidate\.url is required/);

  const validRead = ToolRegistry.testTool("deep_read_page", {
    candidate: {
      url: "https://example.com",
      connector: "bing_web",
      content_type: "web",
      source_type: "web"
    }
  });
  assert.equal(validRead.success, true);
});

test("cross_check_facts registry tool should return real conflict comparison", async () => {
  const execution = await ToolRegistry.executeTool("cross_check_facts", {
    evidenceItems: [
      {
        source_id: "source-a",
        source_type: "web",
        claims: [
          {
            id: "a1",
            type: "numeric_statement",
            claim: "Latency is 120 ms",
            subject: "latency",
            value: 120,
            unit: "ms",
            source_id: "source-a",
            authority_score: 0.7,
            published_at: "2026-03-01T00:00:00Z",
            evidence_span_ids: ["a:1"]
          }
        ],
        source_metadata: { authority_score: 0.7, published_at: "2026-03-01T00:00:00Z" }
      },
      {
        source_id: "source-b",
        source_type: "document",
        claims: [
          {
            id: "b1",
            type: "numeric_statement",
            claim: "Latency is 95 ms",
            subject: "latency",
            value: 95,
            unit: "ms",
            source_id: "source-b",
            authority_score: 0.92,
            published_at: "2026-03-10T00:00:00Z",
            evidence_span_ids: ["b:1"]
          }
        ],
        source_metadata: { authority_score: 0.92, published_at: "2026-03-10T00:00:00Z" }
      }
    ]
  });

  assert.equal(execution.success, true);
  assert.equal(execution.data.conflicts.length, 1);
  assert.equal(execution.data.conflicts[0].comparison.preferred_source, "source-b");
});

test("runSpecialistReads should read through ToolRegistry adapters", async () => {
  const originalExecuteTool = ToolRegistry.executeTool;
  const calls = [];

  ToolRegistry.executeTool = async (toolId, input) => {
    calls.push({ toolId, input });
    return {
      success: true,
      data: {
        source_id: input.candidate.id,
        title: input.candidate.title,
        url: input.candidate.url,
        content_type: input.candidate.content_type,
        source_type: input.candidate.source_type,
        tool: toolId,
        key_points: ["adapter output"],
        timeline: [],
        transcript: [],
        facts: []
      }
    };
  };

  try {
    const telemetry = { events: [], failures: [] };
    const selected = [
      {
        id: "web-1",
        title: "Web source",
        url: "https://example.com/page",
        connector: "bing_web",
        content_type: "web",
        source_type: "web"
      },
      {
        id: "video-1",
        title: "Video source",
        url: "https://www.ted.com/talks/demo",
        connector: "ted",
        content_type: "video",
        source_type: "video"
      }
    ];

    const result = await runSpecialistReads(selected, telemetry);
    assert.deepEqual(calls.map((item) => item.toolId), ["deep_read_page", "extract_video_intel"]);
    assert.equal(result.results.length, 2);
    assert.equal(result.failures.length, 0);
  } finally {
    ToolRegistry.executeTool = originalExecuteTool;
  }
});
