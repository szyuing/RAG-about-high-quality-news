const test = require("node:test");
const assert = require("node:assert/strict");
const { __internal: researchInternal } = require("../src/research-engine");
const { __internal: sourceInternal } = require("../src/source-connectors");

test("planner should choose a bounded connector set before discovery", () => {
  const plan = researchInternal.planner("美国总统特朗普 演讲视频");

  assert.ok(Array.isArray(plan.preferred_connectors));
  assert.ok(Array.isArray(plan.chosen_connector_ids));
  assert.ok(plan.chosen_connector_ids.length >= 2);
  assert.ok(plan.chosen_connector_ids.length <= 4);
  assert.ok(plan.chosen_connector_ids.includes("bing_web"));
  assert.deepEqual(
    plan.chosen_connector_ids,
    researchInternal.chooseConnectorsForQuestion("美国总统特朗普 演讲视频", plan.preferred_connectors)
  );
  assert.equal(plan.stop_policy.max_rounds, 2);
  assert.equal(plan.stop_policy.min_source_types, 2);
});

test("extractTextFromResponsePayload should read message text from responses payload", () => {
  const payload = {
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "{\"chosen_connector_ids\":[\"douyin\",\"bing_web\"],\"rationale\":\"test\",\"connector_reasons\":[]}"
          }
        ]
      }
    ]
  };

  const text = researchInternal.extractTextFromResponsePayload(payload);
  assert.match(text, /chosen_connector_ids/);
});

test("normalizeModelConnectorIds should keep valid ids and fill from fallback", () => {
  const ids = researchInternal.normalizeModelConnectorIds(
    ["douyin", "missing", "douyin"],
    ["bilibili", "bing_web", "ted"]
  );

  assert.deepEqual(ids, ["douyin", "bilibili", "bing_web", "ted"]);
});

test("mergePlanWithModelSelection should replace chosen connectors with model order", () => {
  const basePlan = researchInternal.planner("美国总统特朗普 演讲视频");
  const merged = researchInternal.mergePlanWithModelSelection(basePlan, {
    chosen_connector_ids: ["douyin", "ted"],
    rationale: "video-first",
    connector_reasons: [
      { id: "douyin", reason: "short-form Chinese clips" },
      { id: "ted", reason: "long-form talks" }
    ]
  });

  assert.equal(merged.planner_mode, "llm");
  assert.deepEqual(merged.chosen_connector_ids.slice(0, 2), ["douyin", "ted"]);
  assert.ok(merged.chosen_connector_ids.includes("bing_web"));
  assert.equal(merged.preferred_connectors[0].id, "douyin");
  assert.equal(merged.preferred_connectors[0].reason, "short-form Chinese clips");
});

test("buildPlan should fall back cleanly when OPENAI_API_KEY is absent", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const plan = await researchInternal.buildPlan("美国总统特朗普 演讲视频");
    assert.equal(plan.planner_mode, "fallback");
    assert.ok(Array.isArray(plan.chosen_connector_ids));
    assert.ok(plan.chosen_connector_ids.length >= 2);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});

test("resolveDiscoverConnectors should only keep planner-selected connectors", () => {
  const connectors = sourceInternal.resolveDiscoverConnectors(["douyin", "bilibili", "missing"]);
  assert.deepEqual(connectors.map((item) => item.id), ["bilibili", "douyin"]);
});

test("evaluator should use stop policy thresholds instead of fixed defaults", () => {
  const plan = {
    task_goal: "test question",
    sub_questions: ["one", "two"],
    stop_policy: {
      min_source_types: 1,
      min_evidence_items: 1,
      overall_coverage_threshold: 0,
      sub_question_coverage_threshold: 0,
      fallback_sub_question_coverage_threshold: 0,
      max_relevant_conflicts: 0,
      require_all_sub_questions: true
    }
  };
  const scratchpad = {
    sources_read: [{ content_type: "web", source_type: "web" }]
  };
  const evidenceItems = [
    {
      title: "test question",
      key_points: ["one two"],
      markdown: "one two",
      timeline: [],
      facts: []
    }
  ];
  const verification = { conflicts: [], confirmations: [] };

  const evaluation = researchInternal.evaluator(plan, scratchpad, evidenceItems, verification, 1);
  assert.equal(evaluation.is_sufficient, true);
  assert.deepEqual(evaluation.missing_questions, []);
});

test("buildEvidenceItems should project unified evidence fields", () => {
  const reads = [
    {
      source_id: "source-1",
      title: "Demo source",
      content_type: "web",
      source_type: "web",
      tool: "deep_read_page",
      url: "https://example.com/demo",
      author: "Example",
      published_at: "2026-03-15T10:00:00Z",
      markdown: "This source states the benchmark improved by 20 percent across two tasks.",
      key_points: ["benchmark improved by 20 percent"],
      sections: [{ heading: "Summary", excerpt: "benchmark improved by 20 percent" }],
      facts: [{ subject: "demo", kind: "numeric_statement", claim: "improved by 20 percent", value: 20, unit: "%", authority_score: 0.8 }]
    }
  ];

  const evidence = researchInternal.buildEvidenceItems(reads, [{ id: "source-1", connector: "bing_web", platform: "Bing Web", url: "https://example.com/demo" }]);
  assert.equal(evidence.length, 1);
  assert.ok(Array.isArray(evidence[0].quotes));
  assert.ok(Array.isArray(evidence[0].evidence_spans));
  assert.ok(Array.isArray(evidence[0].claims));
  assert.equal(evidence[0].source_metadata.connector, "bing_web");
});

test("crossCheckFacts should produce comparison details for conflicts", async () => {
  const verification = await researchInternal.crossCheckFacts([
    {
      source_id: "a",
      source_type: "web",
      claims: [
        {
          id: "a1",
          type: "numeric_statement",
          claim: "Latency is 120 ms",
          subject: "latency",
          value: 120,
          unit: "ms",
          source_id: "a",
          authority_score: 0.7,
          published_at: "2026-03-01T00:00:00Z",
          evidence_span_ids: ["a:1"]
        }
      ],
      source_metadata: { authority_score: 0.7, published_at: "2026-03-01T00:00:00Z" }
    },
    {
      source_id: "b",
      source_type: "document",
      claims: [
        {
          id: "b1",
          type: "numeric_statement",
          claim: "Latency is 95 ms",
          subject: "latency",
          value: 95,
          unit: "ms",
          source_id: "b",
          authority_score: 0.9,
          published_at: "2026-03-10T00:00:00Z",
          evidence_span_ids: ["b:1"]
        }
      ],
      source_metadata: { authority_score: 0.9, published_at: "2026-03-10T00:00:00Z" }
    }
  ]);

  assert.equal(verification.conflicts.length, 1);
  assert.equal(verification.conflicts[0].comparison.preferred_source, "b");
  assert.match(verification.conflicts[0].reason, /authority|recent|evidence/i);
});
