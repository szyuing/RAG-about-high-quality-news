const test = require("node:test");
const assert = require("node:assert/strict");
const { createToolRegistry } = require("../src/tool-registry-core");
const { ToolRegistry } = require("../src/source-connectors");
const {
  runSpecialistReads,
  createAgentRegistry,
  createAgentRuntime,
  routeCandidate,
  collectorToolForCandidate
} = require("../src/agent-orchestrator");

test("createToolRegistry executeTool should retry transient failures before succeeding", async () => {
  let attempts = 0;
  const registry = createToolRegistry({
    normalizeCapability: (value) => String(value || "").trim().toLowerCase(),
    scoreToolForTask(tool, task = {}) {
      return tool.id === task.preferred_tool_id ? 10 : 1;
    }
  });

  registry.registerTool({
    id: "primary_reader",
    name: "Primary Reader",
    parameters: [],
    async execute() {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("network timeout while reading source");
      }
      return { source_id: "retry-source", tool: "primary_reader" };
    }
  });

  const execution = await registry.executeTool("primary_reader", {}, { maxAttempts: 2 });
  assert.equal(execution.success, true);
  assert.equal(execution.toolId, "primary_reader");
  assert.equal(attempts, 2);
  assert.equal(execution.meta.fallback_used, false);
  assert.equal(execution.meta.attempts.length, 1);
  assert.equal(execution.meta.attempts[0].error_type, "timeout");
});

test("createToolRegistry executeTool should fall back to a backup tool on non-retriable failures", async () => {
  const calls = [];
  const registry = createToolRegistry({
    normalizeCapability: (value) => String(value || "").trim().toLowerCase(),
    scoreToolForTask(tool, task = {}) {
      if (tool.id === task.preferred_tool_id) {
        return 10;
      }
      if (tool.id === "fallback_reader") {
        return 9;
      }
      return 1;
    }
  });

  registry.registerTool({
    id: "primary_reader",
    name: "Primary Reader",
    parameters: [],
    async execute() {
      calls.push("primary_reader");
      throw new Error("Unsupported connector: demo_source");
    }
  });
  registry.registerTool({
    id: "fallback_reader",
    name: "Fallback Reader",
    parameters: [],
    async execute() {
      calls.push("fallback_reader");
      return { source_id: "fallback-source", tool: "fallback_reader" };
    }
  });

  const execution = await registry.executeTool("primary_reader", { candidate: { content_type: "web", source_type: "web" } }, {
    agent: "long_text_collector",
    capability: "read_web_page",
    fallbackToolIds: ["fallback_reader"]
  });
  assert.equal(execution.success, true);
  assert.equal(execution.toolId, "fallback_reader");
  assert.deepEqual(calls, ["primary_reader", "fallback_reader"]);
  assert.equal(execution.meta.fallback_used, true);
  assert.equal(execution.meta.attempts[0].error_type, "unsupported_source");
  assert.deepEqual(execution.meta.fallback_chain, ["fallback_reader"]);
});

test("ToolRegistry should expose core capabilities and enforce custom validation", () => {
  const capabilityIds = ToolRegistry.getToolCapabilities().map((item) => item.id);
  assert.ok(capabilityIds.includes("analyze_document_multimodal"));
  assert.ok(capabilityIds.includes("layout_analysis"));
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

test("layout_analysis should derive text, table, and visual parser tasks for mixed documents", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";

  global.fetch = async (url, options) => {
    if (!options?.body) {
      return {
        ok: true,
        text: async () => "Title: Mixed Report\n\nMarkdown Content:\n# Overview\nMarket growth is accelerating.\n\n# Findings\nRevenue table and chart summary."
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
                  summary: "Mixed document summary",
                  key_points: ["growth continues"],
                  structured_facts: [],
                  visual_observations: ["bar chart shows a sharp Q4 increase"]
                })
              }
            ]
          }
        ]
      })
    };
  };

  try {
    const execution = await ToolRegistry.executeTool("layout_analysis", {
      candidate: {
        id: "doc-layout",
        title: "Mixed Layout PDF",
        url: "https://example.com/report.pdf",
        connector: "bing_web",
        content_type: "document",
        source_type: "document",
        metadata: {
          page_count: 6,
          page_images: ["https://example.com/page-1.png"]
        }
      }
    });

    assert.equal(execution.success, true);
    assert.equal(execution.data.layout.total_pages, 6);
    assert.ok(execution.data.layout.task_suggestions.some((item) => item.agent === "long_text_collector"));
    assert.ok(execution.data.layout.task_suggestions.some((item) => item.agent === "chart_parser"));
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
});

test("layout_analysis should use llm mode when the model returns block-level layout output", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";

  global.fetch = async (url, options) => {
    if (!options?.body) {
      return {
        ok: true,
        text: async () => "Title: Mixed Report\n\nMarkdown Content:\n# Overview\nMarket growth is accelerating."
      };
    }

    const body = JSON.parse(options.body);
    if (body.text?.format?.name === "document_multimodal_summary") {
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
                    key_points: ["growth continues"],
                    structured_facts: [],
                    visual_observations: ["bar chart shows a sharp Q4 increase"]
                  })
                }
              ]
            }
          ]
        })
      };
    }

    assert.equal(body.text?.format?.name, "document_layout_analysis");
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
                  total_pages: 10,
                  blocks: [
                    {
                      block_id: "doc-layout-llm:text",
                      modality: "text",
                      agent: "long_text_collector",
                      pages: [1, 3],
                      summary: "Opening text sections"
                    },
                    {
                      block_id: "doc-layout-llm:table",
                      modality: "table",
                      agent: "table_parser",
                      pages: [4, 4],
                      summary: "Main KPI table"
                    },
                    {
                      block_id: "doc-layout-llm:visual",
                      modality: "visual",
                      agent: "chart_parser",
                      pages: [5, 5],
                      summary: "Revenue bar chart"
                    }
                  ],
                  task_suggestions: [
                    {
                      task_id: "task:text",
                      agent: "long_text_collector",
                      capability: "read_document",
                      pages: [1, 3],
                      objective: "Summarize opening sections"
                    },
                    {
                      task_id: "task:table",
                      agent: "table_parser",
                      capability: "parse_table",
                      pages: [4, 4],
                      objective: "Extract KPI table"
                    },
                    {
                      task_id: "task:visual",
                      agent: "chart_parser",
                      capability: "analyze_visual_document",
                      pages: [5, 5],
                      objective: "Analyze revenue chart"
                    }
                  ],
                  dominant_modalities: ["text", "table", "visual"]
                })
              }
            ]
          }
        ]
      })
    };
  };

  try {
    const execution = await ToolRegistry.executeTool("layout_analysis", {
      candidate: {
        id: "doc-layout-llm",
        title: "Mixed Layout PDF",
        url: "https://example.com/report.pdf",
        connector: "bing_web",
        content_type: "document",
        source_type: "document",
        metadata: {
          page_count: 10,
          page_images: ["https://example.com/page-1.png"]
        }
      }
    });

    assert.equal(execution.success, true);
    assert.equal(execution.data.layout_analysis_mode, "llm");
    assert.equal(execution.data.layout.blocks.length, 3);
    assert.ok(execution.data.layout.task_suggestions.some((item) => item.agent === "table_parser"));
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
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
    assert.equal(runtime.agents.long_text_collector.completed_tasks, 1);
    assert.equal(runtime.agents.video_parser.completed_tasks, 1);
  } finally {
    ToolRegistry.executeTool = originalExecuteTool;
  }
});

test("runSpecialistReads should request a recovery tool after read failure and retry once", async () => {
  const originalExecuteTool = ToolRegistry.executeTool;
  const originalRegisterTool = ToolRegistry.registerTool;
  const registeredTools = new Map();
  let requestCount = 0;

  ToolRegistry.registerTool = function registerTool(toolDefinition) {
    registeredTools.set(toolDefinition.id, toolDefinition);
  };

  ToolRegistry.executeTool = async (toolId, input) => {
    if (toolId === "deep_read_page") {
      return {
        success: false,
        error: {
          message: "Primary reader failed"
        }
      };
    }

    if (registeredTools.has(toolId)) {
      return {
        success: true,
        data: await registeredTools.get(toolId).execute(input)
      };
    }

    throw new Error(`Unexpected tool: ${toolId}`);
  };

  try {
    const telemetry = {
      events: [],
      failures: [],
      agent_system: {
        async requestToolCreation(requester, toolSpecs) {
          requestCount += 1;
          assert.equal(requester, "llm_orchestrator");
          const tool = {
            id: "recovery_tool",
            name: toolSpecs[0].name,
            description: toolSpecs[0].description,
            parameters: toolSpecs[0].parameters,
            execute: async ({ candidate }) => ({
              source_id: candidate.id,
              title: candidate.title,
              url: candidate.url,
              content_type: candidate.content_type,
              source_type: candidate.source_type,
              tool: "recovery_tool",
              key_points: ["recovered through created tool"],
              timeline: [],
              transcript: [],
              facts: []
            }),
            created_for: requester,
            request_id: "req_recovery"
          };
          ToolRegistry.registerTool(tool);
          return {
            request_type: "tool_creation_result",
            success: true,
            count: 1,
            tools: [tool]
          };
        }
      }
    };

    const runtime = createAgentRuntime(createAgentRegistry());
    const selected = [
      {
        id: "web-2",
        title: "Recoverable source",
        url: "https://example.com/recovery",
        connector: "bing_web",
        content_type: "web",
        source_type: "web"
      }
    ];

    const result = await runSpecialistReads(selected, telemetry, runtime);
    assert.equal(requestCount, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.results[0].read.source_id, "web-2");
    assert.equal(runtime.agents.long_text_collector.completed_tasks, 1);
    assert.equal(telemetry.tool_creation_requests.length, 1);
  } finally {
    ToolRegistry.executeTool = originalExecuteTool;
    ToolRegistry.registerTool = originalRegisterTool;
  }
});

test("chart-heavy document candidates should route to chart_parser with document intel", () => {
  const candidate = {
    id: "chart-1",
    title: "Revenue chart dashboard",
    url: "https://example.com/report.pdf",
    connector: "bing_web",
    content_type: "document",
    source_type: "document",
    metadata: {
      mime_type: "application/pdf",
      page_images: ["https://example.com/report-page-1.png"]
    }
  };

  assert.equal(routeCandidate(candidate), "chart_parser");
  assert.equal(collectorToolForCandidate(candidate), "read_document_intel");
});

test("runSpecialistReads should resolve parser tools through the agent system interface", async () => {
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
        key_points: ["resolved by agent system"],
        timeline: [],
        transcript: [],
        facts: []
      }
    };
  };

  try {
    const telemetry = {
      events: [],
      failures: [],
      agent_system: {
        resolveToolForTask({ agent, capability, candidate, preferred_tool_id }) {
          assert.equal(agent, "long_text_collector");
          assert.equal(capability, "read_web_page");
          assert.equal(preferred_tool_id, "deep_read_page");
          assert.equal(candidate.id, "web-3");
          return {
            tool_id: "deep_read_page",
            reason: "matched_tool_capability"
          };
        }
      }
    };
    const runtime = createAgentRuntime(createAgentRegistry());
    const selected = [
      {
        id: "web-3",
        title: "Web explainer",
        url: "https://example.com/explainer",
        connector: "bing_web",
        content_type: "web",
        source_type: "web"
      }
    ];

    const result = await runSpecialistReads(selected, telemetry, runtime);
    assert.equal(result.results.length, 1);
    assert.equal(result.failures.length, 0);
    assert.deepEqual(calls.map((item) => item.toolId), ["deep_read_page"]);
    assert.equal(runtime.agents.long_text_collector.completed_tasks, 1);
  } finally {
    ToolRegistry.executeTool = originalExecuteTool;
  }
});

test("runSpecialistReads should split mixed documents into text, table, and visual parser outputs", async () => {
  const originalExecuteTool = ToolRegistry.executeTool;
  const calls = [];

  ToolRegistry.executeTool = async (toolId, input) => {
    calls.push({ toolId, input });
    if (toolId === "layout_analysis") {
      assert.equal(input.read.source_id, "doc-mixed-1");
      return {
        success: true,
        data: {
          layout: {
            total_pages: 10,
            blocks: [
              { block_id: "text", modality: "text", agent: "long_text_collector", pages: [1, 3] },
              { block_id: "table", modality: "table", agent: "table_parser", pages: [4, 4] },
              { block_id: "visual", modality: "visual", agent: "chart_parser", pages: [5, 5] }
            ],
            task_suggestions: [
              { task_id: "t1", agent: "long_text_collector", capability: "read_document", pages: [1, 3], objective: "Summarize text" },
              { task_id: "t2", agent: "table_parser", capability: "parse_table", pages: [4, 4], objective: "Extract table" },
              { task_id: "t3", agent: "chart_parser", capability: "analyze_visual_document", pages: [5, 5], objective: "Analyze chart" }
            ]
          }
        }
      };
    }

    if (toolId === "analyze_document_multimodal") {
      return {
        success: true,
        data: {
          summary: "Chart analysis summary",
          key_points: ["Q4 is the strongest quarter"],
          structured_facts: [
            { subject: "Q4 revenue", claim: "Q4 outperforms all other quarters", value: null, unit: null }
          ],
          visual_observations: ["The tallest bar appears in Q4"]
        }
      };
    }

    if (toolId === "read_document_intel") {
      return {
        success: true,
        data: {
          source_id: input.candidate.id,
          title: input.candidate.title,
          url: input.candidate.url,
          content_type: "document",
          source_type: "document",
          tool: "read_document_intel",
          markdown: "# Overview\nGrowth accelerated.\n\n# Appendix\nSupporting notes.",
          key_points: ["Market growth accelerated", "Appendix contains support"],
          sections: [
            { heading: "Overview", excerpt: "Growth accelerated." },
            { heading: "Appendix", excerpt: "Supporting notes." }
          ],
          facts: [{ subject: "market", kind: "document_fact", claim: "Growth accelerated", value: null, unit: null }],
          table_data: {
            headers: ["year", "revenue"],
            rows: [{ year: "2024", revenue: "1.2M" }]
          },
          visual_observations: ["Q4 shows the highest revenue bar"],
          page_images: ["https://example.com/page-5.png"],
          source_metadata: {
            page_images: ["https://example.com/page-5.png"],
            preview_image: "https://example.com/page-5.png"
          }
        }
      };
    }

    throw new Error(`Unexpected tool: ${toolId}`);
  };

  try {
    const telemetry = { events: [], failures: [], agent_system: null };
    const runtime = createAgentRuntime(createAgentRegistry());
    const selected = [
      {
        id: "doc-mixed-1",
        title: "Industry report",
        url: "https://example.com/industry-report.pdf",
        connector: "bing_web",
        content_type: "document",
        source_type: "document",
        metadata: {
          mime_type: "application/pdf"
        }
      }
    ];

    const result = await runSpecialistReads(selected, telemetry, runtime);
    assert.equal(result.results.length, 3);
    assert.ok(result.results.some((item) => item.read.parser_agent === "long_text_collector"));
    assert.ok(result.results.some((item) => item.read.parser_agent === "table_parser"));
    assert.ok(result.results.some((item) => item.read.parser_agent === "chart_parser"));
    assert.equal(calls.filter((item) => item.toolId === "read_document_intel").length, 1);
    assert.equal(calls.filter((item) => item.toolId === "layout_analysis").length, 1);
    assert.equal(calls.filter((item) => item.toolId === "analyze_document_multimodal").length, 1);
    assert.equal(result.routed_tasks.length, 3);
    assert.ok(runtime.agents.long_text_collector.completed_tasks >= 1);
    assert.ok(runtime.agents.table_parser.completed_tasks >= 1);
    assert.ok(runtime.agents.chart_parser.completed_tasks >= 1);
  } finally {
    ToolRegistry.executeTool = originalExecuteTool;
  }
});

// 测试新添加的工具
test("GitHub Repo Info tool should be registered and testable", () => {
  const capabilityIds = ToolRegistry.getToolCapabilities().map((item) => item.id);
  assert.ok(capabilityIds.includes("fetch_github_repo"));

  // 测试无效输入
  const invalidInput = ToolRegistry.testTool("fetch_github_repo", {});
  assert.equal(invalidInput.success, false);
  assert.match(invalidInput.error, /Missing required parameter: repo/);

  // 测试有效输入
  const validInput = ToolRegistry.testTool("fetch_github_repo", {
    repo: "octocat/Hello-World"
  });
  assert.equal(validInput.success, true);
});

test("API Test tool should be registered and testable", () => {
  const capabilityIds = ToolRegistry.getToolCapabilities().map((item) => item.id);
  assert.ok(capabilityIds.includes("test_api_endpoint"));

  // 测试无效输入
  const invalidInput = ToolRegistry.testTool("test_api_endpoint", {});
  assert.equal(invalidInput.success, false);
  assert.match(invalidInput.error, /Missing required parameter: endpoint/);

  // 测试有效输入
  const validInput = ToolRegistry.testTool("test_api_endpoint", {
    endpoint: "https://api.github.com/repos/octocat/Hello-World"
  });
  assert.equal(validInput.success, true);
});

test("Data Converter tool should be registered and testable", () => {
  const capabilityIds = ToolRegistry.getToolCapabilities().map((item) => item.id);
  assert.ok(capabilityIds.includes("convert_data"));

  // 测试无效输入
  const invalidInput = ToolRegistry.testTool("convert_data", {});
  assert.equal(invalidInput.success, false);
  assert.match(invalidInput.error, /Missing required parameter: data/);

  // 测试有效输入
  const validInput = ToolRegistry.testTool("convert_data", {
    data: { name: "test", value: 123 }
  });
  assert.equal(validInput.success, true);
});

test("Bilibili Audio Downloader tool should be registered and testable", () => {
  const capabilityIds = ToolRegistry.getToolCapabilities().map((item) => item.id);
  assert.ok(capabilityIds.includes("download_bilibili_audio"));

  // 测试无效输入
  const invalidInput = ToolRegistry.testTool("download_bilibili_audio", {});
  assert.equal(invalidInput.success, false);
  assert.match(invalidInput.error, /Missing required parameter: videoUrl/);

  // 测试BV格式链接
  const validBVInput = ToolRegistry.testTool("download_bilibili_audio", {
    videoUrl: "https://www.bilibili.com/video/BV1xx411c7mD"
  });
  assert.equal(validBVInput.success, true);

  // 测试av格式链接
  const validAVInput = ToolRegistry.testTool("download_bilibili_audio", {
    videoUrl: "https://www.bilibili.com/video/av170001"
  });
  assert.equal(validAVInput.success, true);
});

test("Douyin Video Downloader tool should be registered and testable", () => {
  const capabilityIds = ToolRegistry.getToolCapabilities().map((item) => item.id);
  assert.ok(capabilityIds.includes("download_douyin_video"));

  // 测试无效输入
  const invalidInput = ToolRegistry.testTool("download_douyin_video", {});
  assert.equal(invalidInput.success, false);
  assert.match(invalidInput.error, /Missing required parameter: videoUrl/);

  // 测试短链接格式
  const validShortUrlInput = ToolRegistry.testTool("download_douyin_video", {
    videoUrl: "https://v.douyin.com/xxxxx"
  });
  assert.equal(validShortUrlInput.success, true);

  // 测试完整链接格式
  const validFullUrlInput = ToolRegistry.testTool("download_douyin_video", {
    videoUrl: "https://www.douyin.com/video/1234567890"
  });
  assert.equal(validFullUrlInput.success, true);
});
