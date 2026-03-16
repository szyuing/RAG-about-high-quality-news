const test = require("node:test");
const assert = require("node:assert/strict");
const { ToolRegistry } = require("../src/source-connectors");
const { runSpecialistReads, createAgentRegistry, createAgentRuntime } = require("../src/agent-orchestrator");

test("ToolRegistry should expose core capabilities and enforce custom validation", () => {
  const capabilityIds = ToolRegistry.getToolCapabilities().map((item) => item.id);
  assert.ok(capabilityIds.includes("analyze_document_multimodal"));
  assert.ok(capabilityIds.includes("read_document_intel"));
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

test("read_document_intel should parse csv tables into structured output", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => "name,score\nalpha,10\nbeta,20"
  });

  try {
    const execution = await ToolRegistry.executeTool("read_document_intel", {
      url: "https://example.com/report.csv",
      title: "Quarterly Report"
    });

    assert.equal(execution.success, true);
    assert.equal(execution.data.document_kind, "csv");
    assert.equal(execution.data.processing_mode, "native");
    assert.equal(execution.data.table_data.rows.length, 2);
    assert.match(execution.data.markdown, /Columns: name, score/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("analyze_document_multimodal should send document text and page images to the model", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";

  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.input[0].content[0].type, "input_text");
    assert.equal(body.input[0].content[1].type, "input_image");
    return {
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  summary: "Visual summary",
                  key_points: ["chart trend"],
                  structured_facts: [
                    { subject: "revenue", claim: "Revenue reached 10", value: 10, unit: "USDm" }
                  ],
                  visual_observations: ["bar chart compares quarterly revenue"]
                })
              }
            ]
          }
        ]
      })
    };
  };

  try {
    const execution = await ToolRegistry.executeTool("analyze_document_multimodal", {
      url: "https://example.com/report.pdf",
      markdown: "# Report",
      page_images: ["https://example.com/page-1.png"]
    });

    assert.equal(execution.success, true);
    assert.equal(execution.data.summary, "Visual summary");
    assert.equal(execution.data.visual_observations.length, 1);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
});

test("read_document_intel should use multimodal visual mode when page images are available", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";

  global.fetch = async (url, options) => {
    if (!options?.body) {
      return {
        ok: true,
        text: async () => "Title: Demo\n\nMarkdown Content:\nQuarterly revenue chart and notes."
      };
    }

    return {
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  summary: "Visual model summary",
                  key_points: ["revenue rises"],
                  structured_facts: [],
                  visual_observations: ["line chart shows steady growth"]
                })
              }
            ]
          }
        ]
      })
    };
  };

  try {
    const execution = await ToolRegistry.executeTool("read_document_intel", {
      candidate: {
        id: "doc-1",
        title: "Visual PDF",
        url: "https://example.com/report.pdf",
        connector: "bing_web",
        content_type: "document",
        source_type: "document",
        metadata: {
          page_images: ["https://example.com/page-1.png"]
        }
      }
    });

    assert.equal(execution.success, true);
    assert.equal(execution.data.processing_mode, "multimodal_visual");
    assert.equal(execution.data.visual_observations[0], "line chart shows steady growth");
    assert.equal(execution.data.key_points[0], "revenue rises");
    assert.match(execution.data.markdown, /Visual model summary/);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
});

test("read_document_intel should auto-discover page images from document landing pages", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";

  global.fetch = async (url, options) => {
    if (options?.body) {
      const body = JSON.parse(options.body);
      assert.equal(body.input[0].content[1].type, "input_image");
      assert.equal(body.input[0].content[1].image_url, "https://example.com/cover.png");
      return {
        ok: true,
        json: async () => ({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    summary: "Auto visual summary",
                    key_points: ["chart extracted from landing page"],
                    structured_facts: [],
                    visual_observations: ["cover image contains the main chart"]
                  })
                }
              ]
            }
          ]
        })
      };
    }

    if (String(url).includes("r.jina.ai")) {
      return {
        ok: true,
        text: async () => "Title: Demo\n\nMarkdown Content:\nQuarterly revenue chart and notes."
      };
    }

    return {
      ok: true,
      text: async () => "<html><head><meta property=\"og:image\" content=\"/cover.png\"></head><body>Landing page</body></html>"
    };
  };

  try {
    const execution = await ToolRegistry.executeTool("read_document_intel", {
      candidate: {
        id: "doc-landing",
        title: "Landing page PDF",
        url: "https://example.com/report",
        connector: "bing_web",
        content_type: "document",
        source_type: "document",
        metadata: {
          mime_type: "application/pdf"
        }
      }
    });

    assert.equal(execution.success, true);
    assert.equal(execution.data.processing_mode, "multimodal_visual");
    assert.equal(execution.data.page_images[0], "https://example.com/cover.png");
    assert.equal(execution.data.source_metadata.preview_image, "https://example.com/cover.png");
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
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
    const runtime = createAgentRuntime(createAgentRegistry());
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

    const result = await runSpecialistReads(selected, telemetry, runtime);
    assert.deepEqual(calls.map((item) => item.toolId), ["deep_read_page", "extract_video_intel"]);
    assert.equal(result.results.length, 2);
    assert.equal(result.failures.length, 0);
    assert.equal(runtime.tasks.length, 2);
    assert.equal(runtime.agents.deep_analyst.completed_tasks, 1);
    assert.equal(runtime.agents.multimedia.completed_tasks, 1);
  } finally {
    ToolRegistry.executeTool = originalExecuteTool;
  }
});
