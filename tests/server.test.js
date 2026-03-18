const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createServer } = require("../server");

function request(server, options = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: options.path || "/",
      method: options.method || "GET",
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json: body ? JSON.parse(body) : null
        });
      });
    });

    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function withServer(fn) {
  const server = createServer({
    runResearch: async () => ({ ok: true }),
    getSamples: () => [],
    getExperienceMemory: () => [],
    summarizeExperienceMemory: () => ({ schema_version: "experience-overview.v1", total_entries: 0 }),
    listExperienceMemory: () => [],
    setExperiencePinned: () => null,
    clearExperienceMemory: () => ({ removed_count: 0, remaining_count: 0, entries: [] }),
    getToolMemory: () => ({}),
    getToolAuditLog: () => [{ type: "tool_execution", tool_id: "tool-1" }],
    getSourceCapabilities: () => [],
    synthesizeTool: async () => ({ id: "tool-1" }),
    runEphemeralTool: async () => ({ success: true })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(server);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }));
  }
}

test("POST /api/research should reject invalid JSON with 400", async () => {
  await withServer(async (server) => {
    const response = await request(server, {
      path: "/api/research",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: "{invalid"
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json.error, "invalid_json");
  });
});

test("POST /api/research should reject missing question with 400", async () => {
  await withServer(async (server) => {
    const response = await request(server, {
      path: "/api/research",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ mode: "deep" })
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json.error, "invalid_request");
    assert.match(response.json.message, /question is required/);
  });
});

test("POST /api/research should return response schema version on success", async () => {
  const server = createServer({
    runResearch: async () => ({
      task_id: "task_demo",
      final_answer: { quick_answer: "ok" }
    }),
    getSamples: () => [],
    getExperienceMemory: () => [],
    summarizeExperienceMemory: () => ({ schema_version: "experience-overview.v1", total_entries: 0 }),
    getToolMemory: () => ({}),
    getToolAuditLog: () => [],
    getSourceCapabilities: () => [],
    synthesizeTool: async () => ({ id: "tool-1" }),
    runEphemeralTool: async () => ({ success: true })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(server, {
      path: "/api/research",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ question: "demo question", mode: "deep" })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json.response_schema_version, "research_response.v1");
    assert.equal(response.json.task_id, "task_demo");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }));
  }
});

test("POST /api/search should return normalized answer with citations", async () => {
  const server = createServer({
    runResearch: async () => ({
      task_id: "task_1",
      plan: {
        site_search_strategies: [
          { site_name: "OpenAI", search_mode: "site_query", domain: "openai.com" }
        ]
      },
      rounds: [
        { executed_search_tasks: [{ query: "OpenAI Sora official update site:openai.com" }] },
        {}
      ],
      evidence: [
        {
          source_id: "source-1",
          title: "Example Source",
          key_points: ["Important finding from source one."],
          source_metadata: {
            url: "https://example.com/source-1",
            connector: "bing_web",
            platform: "Bing Web",
            published_at: "2026-03-18T00:00:00Z"
          }
        }
      ],
      evaluation: {
        evaluator_mode: "llm",
        stop_state: { should_stop_now: true, reason: "llm_stop_decision" }
      },
      final_answer: {
        quick_answer: "Short answer",
        deep_research_summary: {
          conclusion: "Detailed conclusion",
          confidence: 0.82,
          uncertainty: ["Benchmark source is single-provider."]
        }
      }
    }),
    getSamples: () => [],
    getExperienceMemory: () => [],
    summarizeExperienceMemory: () => ({ schema_version: "experience-overview.v1", total_entries: 0 }),
    getToolMemory: () => ({}),
    getToolAuditLog: () => [],
    getSourceCapabilities: () => [],
    synthesizeTool: async () => ({ id: "tool-1" }),
    runEphemeralTool: async () => ({ success: true })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(server, {
      path: "/api/search",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: "test query", mode: "deep" })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json.response_schema_version, "search_response.v1");
    assert.equal(response.json.schema_version, "search.v1");
    assert.equal(response.json.query, "test query");
    assert.equal(response.json.search_profile, "quality");
    assert.equal(response.json.answer, "Short answer");
    assert.equal(response.json.summary, "Detailed conclusion");
    assert.equal(response.json.citations[0].source_id, "source-1");
    assert.equal(response.json.citations[0].url, "https://example.com/source-1");
    assert.equal(response.json.diagnostics.evidence_units, 1);
    assert.equal(response.json.diagnostics.mode_source, "mode");
    assert.equal(response.json.diagnostics.site_search_strategy_count, 1);
    assert.equal(response.json.diagnostics.executed_search_task_count, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }));
  }
});

test("POST /api/search should map speed profile to quick mode", async () => {
  let callInput = null;
  const server = createServer({
    runResearch: async (input) => {
      callInput = input;
      return {
        task_id: "task_profile",
        plan: { site_search_strategies: [] },
        rounds: [],
        evidence: [],
        evaluation: { evaluator_mode: "fallback", stop_state: null },
        final_answer: {
          quick_answer: "profile answer",
          deep_research_summary: { conclusion: "", confidence: null, uncertainty: [] }
        }
      };
    },
    getSamples: () => [],
    getExperienceMemory: () => [],
    getToolMemory: () => ({}),
    getToolAuditLog: () => [],
    getSourceCapabilities: () => [],
    synthesizeTool: async () => ({ id: "tool-1" }),
    runEphemeralTool: async () => ({ success: true })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(server, {
      path: "/api/search",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: "fast query", search_profile: "speed" })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json.response_schema_version, "search_response.v1");
    assert.equal(callInput.question, "fast query");
    assert.equal(callInput.mode, "quick");
    assert.equal(response.json.mode, "quick");
    assert.equal(response.json.search_profile, "speed");
    assert.equal(response.json.diagnostics.mode_source, "search_profile");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }));
  }
});

test("POST /api/search should reject missing query with 400", async () => {
  await withServer(async (server) => {
    const response = await request(server, {
      path: "/api/search",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ mode: "deep" })
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json.error, "invalid_request");
    assert.match(response.json.message, /query is required/);
  });
});

test("POST /api/tools/synthesize should reject invalid payloads with 400", async () => {
  await withServer(async (server) => {
    const response = await request(server, {
      path: "/api/tools/synthesize",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ constraints: "not-an-array" })
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json.error, "invalid_request");
    assert.match(response.json.message, /goal is required/);
  });
});

test("GET /api/tools/audit should return recent tool audit entries", async () => {
  await withServer(async (server) => {
    const response = await request(server, {
      path: "/api/tools/audit?limit=5",
      method: "GET"
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json.entries, [{ type: "tool_execution", tool_id: "tool-1" }]);
  });
});

test("GET /api/samples should include tool audit entries", async () => {
  await withServer(async (server) => {
    const response = await request(server, {
      path: "/api/samples",
      method: "GET"
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json.tool_audit_recent, [{ type: "tool_execution", tool_id: "tool-1" }]);
    assert.equal(response.json.experience_overview.schema_version, "experience-overview.v1");
  });
});

test("GET /api/search/capabilities should return supported modes and connectors", async () => {
  const server = createServer({
    runResearch: async () => ({ ok: true }),
    getSamples: () => [],
    getExperienceMemory: () => [],
    summarizeExperienceMemory: () => ({ schema_version: "experience-overview.v1", total_entries: 0 }),
    listExperienceMemory: () => [],
    setExperiencePinned: () => null,
    clearExperienceMemory: () => ({ removed_count: 0, remaining_count: 0, entries: [] }),
    getToolMemory: () => ({}),
    getToolAuditLog: () => [],
    getSourceCapabilities: () => [
      { id: "bing_web", label: "Bing Web", capabilities: ["search", "web"] }
    ],
    synthesizeTool: async () => ({ id: "tool-1" }),
    runEphemeralTool: async () => ({ success: true })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(server, {
      path: "/api/search/capabilities",
      method: "GET"
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json.schema_version, "search-capabilities.v1");
    assert.deepEqual(response.json.modes, ["quick", "deep"]);
    assert.equal(response.json.default_mode, "deep");
    assert.deepEqual(response.json.search_profiles.values, ["speed", "balanced", "quality"]);
    assert.equal(response.json.search_profiles.default, "quality");
    assert.equal(response.json.search_profiles.mode_mapping.speed, "quick");
    assert.equal(response.json.limits.max_citations, 10);
    assert.equal(response.json.source_capabilities[0].id, "bing_web");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }));
  }
});

test("GET /api/experience should return filtered experience entries", async () => {
  let receivedFilters = null;
  const server = createServer({
    runResearch: async () => ({ ok: true }),
    getSamples: () => [],
    getExperienceMemory: () => [],
    summarizeExperienceMemory: (entries) => ({ schema_version: "experience-overview.v1", total_entries: entries.length }),
    listExperienceMemory: (filters) => {
      receivedFilters = filters;
      return [{ question_key: "openai sora update", question: "OpenAI Sora update", pinned: true }];
    },
    setExperiencePinned: () => null,
    clearExperienceMemory: () => ({ removed_count: 0, remaining_count: 0, entries: [] }),
    getToolMemory: () => ({}),
    getToolAuditLog: () => [],
    getSourceCapabilities: () => [],
    synthesizeTool: async () => ({ id: "tool-1" }),
    runEphemeralTool: async () => ({ success: true })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(server, {
      path: "/api/experience?query=Sora&pinned=true&connector_id=bing_web&limit=5",
      method: "GET"
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json.schema_version, "experience-memory.v1");
    assert.equal(response.json.total, 1);
    assert.equal(response.json.overview.total_entries, 1);
    assert.equal(receivedFilters.q, "Sora");
    assert.equal(receivedFilters.pinned, true);
    assert.equal(receivedFilters.connector_id, "bing_web");
    assert.equal(receivedFilters.limit, 5);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }));
  }
});

test("POST /api/experience/pin should update entry pin state", async () => {
  let callInput = null;
  const server = createServer({
    runResearch: async () => ({ ok: true }),
    getSamples: () => [],
    getExperienceMemory: () => [],
    summarizeExperienceMemory: () => ({ schema_version: "experience-overview.v1", total_entries: 0 }),
    listExperienceMemory: () => [],
    setExperiencePinned: (questionKey, options) => {
      callInput = { questionKey, options };
      return {
        question_key: questionKey,
        question: "OpenAI Sora update",
        pinned: options.pinned,
        pin_note: options.pinNote
      };
    },
    clearExperienceMemory: () => ({ removed_count: 0, remaining_count: 0, entries: [] }),
    getToolMemory: () => ({}),
    getToolAuditLog: () => [],
    getSourceCapabilities: () => [],
    synthesizeTool: async () => ({ id: "tool-1" }),
    runEphemeralTool: async () => ({ success: true })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(server, {
      path: "/api/experience/pin",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ question_key: "openai sora update", pinned: true, pin_note: "keep this" })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json.schema_version, "experience-memory.v1");
    assert.equal(callInput.questionKey, "openai sora update");
    assert.equal(callInput.options.pinned, true);
    assert.equal(callInput.options.pinNote, "keep this");
    assert.equal(response.json.entry.pinned, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }));
  }
});

test("POST /api/experience/clear should support only_unpinned cleanup", async () => {
  let callInput = null;
  const server = createServer({
    runResearch: async () => ({ ok: true }),
    getSamples: () => [],
    getExperienceMemory: () => [],
    summarizeExperienceMemory: () => ({ schema_version: "experience-overview.v1", total_entries: 0 }),
    listExperienceMemory: () => [],
    setExperiencePinned: () => null,
    clearExperienceMemory: (input) => {
      callInput = input;
      return { removed_count: 2, remaining_count: 1, entries: [{ question_key: "pinned one", pinned: true }] };
    },
    getToolMemory: () => ({}),
    getToolAuditLog: () => [],
    getSourceCapabilities: () => [],
    synthesizeTool: async () => ({ id: "tool-1" }),
    runEphemeralTool: async () => ({ success: true })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(server, {
      path: "/api/experience/clear",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ only_unpinned: true })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json.schema_version, "experience-memory.v1");
    assert.equal(callInput.onlyUnpinned, true);
    assert.equal(response.json.removed_count, 2);
    assert.equal(response.json.remaining_count, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }));
  }
});
