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

test("getRelevantExperienceHints should extract boosted queries and source types from similar history", () => {
  const hints = researchInternal.getRelevantExperienceHints(
    "Sora current update",
    [
      {
        question: "OpenAI Sora current update",
        useful_queries: ["OpenAI Sora official", "OpenAI Sora current update"],
        useful_source_types: ["video", "web"],
        noisy_paths: ["no candidate returned"]
      },
      {
        question: "Apple benchmark",
        useful_queries: ["iPhone benchmark"],
        useful_source_types: ["document"]
      }
    ]
  );

  assert.equal(hints.entries.length, 1);
  assert.deepEqual(hints.boosted_source_types, ["video", "web"]);
  assert.ok(hints.boosted_queries.includes("OpenAI Sora official"));
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

test("buildPlan should merge llm-generated sub-questions and queries", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";

  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                sub_questions: ["What changed?", "Why does it matter?"],
                required_evidence: ["Official update", "Independent confirmation"],
                initial_queries: ["OpenAI Sora official update", "Sora independent review"],
                chosen_connector_ids: ["bing_web", "ithome"],
                rationale: "Prioritize official and current reporting.",
                connector_reasons: [
                  { id: "bing_web", reason: "broad discovery" },
                  { id: "ithome", reason: "current Chinese tech reporting" }
                ]
              })
            }
          ]
        }
      ]
    })
  });

  try {
    const plan = await researchInternal.buildPlan("Sora current update");
    assert.equal(plan.planner_mode, "llm");
    assert.deepEqual(plan.sub_questions, ["What changed?", "Why does it matter?"]);
    assert.deepEqual(plan.initial_queries, ["OpenAI Sora official update", "Sora independent review"]);
    assert.equal(plan.stop_policy.expected_sub_questions, 2);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
});

test("selectCandidatesWithRouting should honor llm-selected agent and tool", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";

  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                selected_candidates: [
                  {
                    id: "c2",
                    agent: "video_parser",
                    tool: "extract_video_intel",
                    reason: "Video source is directly relevant"
                  }
                ],
                rationale: "Prefer direct video evidence first."
              })
            }
          ]
        }
      ]
    })
  });

  try {
    const plan = researchInternal.planner("Sora talk video");
    const result = await researchInternal.selectCandidatesWithRouting([
      {
        id: "c1",
        title: "Article",
        connector: "bing_web",
        content_type: "web",
        source_type: "web",
        platform: "Web",
        score: 0.5,
        snippet: "Article summary",
        url: "https://example.com/article"
      },
      {
        id: "c2",
        title: "Video",
        connector: "ted",
        content_type: "video",
        source_type: "video",
        platform: "TED",
        score: 0.7,
        snippet: "Video summary",
        url: "https://example.com/video"
      }
    ], "Sora talk video", plan);

    assert.equal(result.routing_mode, "llm");
    assert.equal(result.selected[0].id, "c2");
    assert.equal(result.selected[0].preferred_agent, "video_parser");
    assert.equal(result.selected[0].preferred_tool, "extract_video_intel");
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
});

test("synthesize should use llm-composed answer when available", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";

  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                quick_answer: "Sora improved, but evidence is still partly mixed.",
                conclusion: "Available evidence suggests the update expanded capability, with some uncertainty remaining.",
                confidence: 0.73,
                key_claims: [
                  { claim: "Capability expanded", source_id: "src1" }
                ],
                uncertainty: ["Independent confirmation is still limited"]
              })
            }
          ]
        }
      ]
    })
  });

  try {
    const answer = await researchInternal.synthesize(
      "Sora current update",
      "deep",
      [{ id: "src1", title: "Source 1", score: 0.9 }],
      [{ source_id: "src1" }],
      [{
        source_id: "src1",
        title: "Source 1",
        source_type: "web",
        key_points: ["Capability expanded"],
        claims: [{ claim: "Capability expanded", subject: "capability" }],
        quotes: [],
        evidence_spans: [],
        source_metadata: {}
      }],
      { confirmations: [{ key: "capability" }], conflicts: [], coverage_gaps: [] },
      {
        is_sufficient: true,
        risk_notes: [],
        follow_up_queries: [],
        suggested_connector_ids: [],
        metrics: { source_types_covered: 1 },
        scorecard: null,
        stop_state: null
      },
      { ephemeral_tools: [], stop_reason: "completed", connector_health: {}, failures: [] }
    );

    assert.equal(answer.quick_answer, "Sora improved, but evidence is still partly mixed.");
    assert.equal(answer.schema_version, "final_answer.v1");
    assert.ok(Array.isArray(answer.sources));
    assert.ok(Array.isArray(answer.claims));
    assert.equal(typeof answer.confidence, "number");
    assert.ok(Array.isArray(answer.uncertainty));
    assert.equal(answer.deep_research_summary.schema_version, "deep_research_summary.v1");
    assert.equal(answer.deep_research_summary.conclusion, "Available evidence suggests the update expanded capability, with some uncertainty remaining.");
    assert.equal(answer.deep_research_summary.confidence, 0.73);
    assert.equal(answer.deep_research_summary.llm_composer.key_claims[0].source_id, "src1");
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
});

test("planner should include experience hints in connector and query planning", () => {
  const plan = researchInternal.planner("Sora current update", {
    entries: [{ question: "OpenAI Sora current update", relevance: 3 }],
    boosted_queries: ["OpenAI Sora official"],
    boosted_source_types: ["video"],
    avoided_patterns: ["no candidate returned"]
  });

  assert.ok(plan.initial_queries.includes("OpenAI Sora official"));
  assert.ok(plan.experience_hints);
  assert.ok(Array.isArray(plan.experience_hints.boosted_source_types));
});

test("requestStopDecisionFromModel should return null when OPENAI_API_KEY is absent", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const decision = await researchInternal.requestStopDecisionFromModel(
      {
        task_goal: "test question",
        sub_questions: ["one"],
        stop_policy: { max_rounds: 2 }
      },
      [
        {
          source_id: "source-1",
          title: "Demo source",
          source_type: "web",
          source_metadata: { connector: "bing_web", authority_score: 0.8 },
          key_points: ["one"],
          quotes: [],
          claims: []
        }
      ],
      { confirmations: [], conflicts: [], coverage_gaps: [] },
      {
        is_sufficient: false,
        resolved_questions: [],
        missing_questions: ["one"],
        risk_notes: [],
        metrics: {}
      }
    );

    assert.equal(decision, null);
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

test("buildEvaluationScorecard should expose stop checkpoints for the custom controller", () => {
  const scorecard = researchInternal.buildEvaluationScorecard(
    {
      task_goal: "test question",
      sub_questions: ["one"],
      stop_policy: {
        min_source_types: 2,
        min_evidence_items: 3,
        max_rounds: 2,
        overall_coverage_threshold: 0.2,
        max_relevant_conflicts: 1
      }
    },
    {
      is_sufficient: false,
      metrics: {
        source_types_covered: 1,
        evidence_units: 2,
        overall_coverage: 0.15,
        conflict_count: 0
      }
    },
    { confirmations: [], conflicts: [], coverage_gaps: [] },
    1,
    null
  );

  assert.equal(scorecard.status, "needs_more_evidence");
  assert.equal(scorecard.checkpoints.evidence_depth.target, 3);
  assert.equal(scorecard.checkpoints.rounds.remaining, 1);
});

test("createScratchpad should expose a shared workspace for agents", () => {
  const scratchpad = researchInternal.createScratchpad({
    sub_questions: ["one", "two"]
  });

  assert.ok(scratchpad.workspace);
  assert.deepEqual(Object.keys(scratchpad.workspace.agent_workspaces), []);
  assert.deepEqual(
    scratchpad.workspace.question_status,
    [
      { question: "one", status: "pending", updated_at: null },
      { question: "two", status: "pending", updated_at: null }
    ]
  );
  assert.deepEqual(scratchpad.workspace.shared_notes, []);
  assert.deepEqual(scratchpad.workspace.handoffs, []);
  assert.deepEqual(scratchpad.workspace.decisions, []);
  assert.deepEqual(scratchpad.workspace.timeline, []);
});

test("updateQuestionStatus should sync evaluation coverage into the shared workspace", () => {
  const scratchpad = researchInternal.createScratchpad({
    sub_questions: ["covered", "missing"]
  });

  researchInternal.updateQuestionStatus(scratchpad, ["covered"], ["missing"]);

  const covered = scratchpad.workspace.question_status.find((item) => item.question === "covered");
  const missing = scratchpad.workspace.question_status.find((item) => item.question === "missing");

  assert.equal(covered.status, "resolved");
  assert.match(covered.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(missing.status, "missing");
  assert.match(missing.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("mergeEvaluationWithStopDecision should let llm stop the loop when evidence is sufficient", () => {
  const merged = researchInternal.mergeEvaluationWithStopDecision(
    {
      is_sufficient: false,
      resolved_questions: [],
      missing_questions: ["one"],
      risk_notes: ["thin evidence"],
      next_best_action: "run_follow_up_search",
      reason: "heuristic fallback",
      metrics: {
        evidence_units: 3,
        source_types_covered: 2,
        overall_coverage: 0.4,
        conflict_count: 0
      }
    },
    {
      should_stop: true,
      can_answer_accurately: true,
      answerability: "sufficient",
      confidence: 0.87,
      stop_reason: "evidence_sufficient",
      missing_information: [],
      risk_notes: [],
      follow_up_queries: [],
      suggested_connector_ids: [],
      reasoning: "The evidence is enough for an accurate answer.",
      recommended_action: "synthesize_answer"
    },
    1,
    2
  );

  assert.equal(merged.is_sufficient, true);
  assert.equal(merged.next_best_action, "synthesize_answer");
  assert.equal(merged.evaluator_mode, "llm");
  assert.equal(merged.stop_controller, "llm");
});

test("mergeEvaluationWithStopDecision should preserve llm follow-up guidance when evidence is still insufficient", () => {
  const merged = researchInternal.mergeEvaluationWithStopDecision(
    {
      is_sufficient: false,
      resolved_questions: ["what changed"],
      missing_questions: ["official confirmation"],
      risk_notes: ["thin evidence"],
      next_best_action: "run_follow_up_search",
      reason: "heuristic fallback",
      metrics: {
        evidence_units: 2,
        source_types_covered: 1,
        overall_coverage: 0.12,
        conflict_count: 1
      }
    },
    {
      should_stop: false,
      can_answer_accurately: false,
      answerability: "partial",
      confidence: 0.44,
      stop_reason: "need_official_corroboration",
      missing_information: ["official confirmation", "more recent benchmark"],
      risk_notes: ["sources disagree on the benchmark number"],
      follow_up_queries: ["latency official benchmark", "latency latest official update"],
      suggested_connector_ids: ["bing_web", "arxiv"],
      reasoning: "The current evidence is useful but still too thin for a final answer.",
      recommended_action: "run_follow_up_search"
    },
    1,
    2
  );

  assert.equal(merged.is_sufficient, false);
  assert.equal(merged.next_best_action, "run_follow_up_search");
  assert.deepEqual(merged.missing_questions, ["official confirmation", "more recent benchmark"]);
  assert.deepEqual(merged.follow_up_queries, ["latency official benchmark", "latency latest official update"]);
  assert.deepEqual(merged.suggested_connector_ids, ["bing_web", "arxiv"]);
  assert.equal(merged.reason, "need_official_corroboration");
  assert.equal(merged.evaluator_mode, "llm");
});

test("deriveStopOutcome should normalize stop reason for the custom controller", () => {
  const stopState = researchInternal.deriveStopOutcome({
    is_sufficient: false,
    next_best_action: "stop_with_partial_answer",
    stop_controller: "heuristic",
    llm_stop_decision: null
  });

  assert.equal(stopState.should_stop_now, false);
  assert.equal(stopState.should_answer_now, true);
  assert.equal(stopState.reason, "max_rounds_reached");
});

test("buildEmptyEvaluation should include evaluation schema version", () => {
  const evaluation = researchInternal.buildEmptyEvaluation({
    sub_questions: ["one"],
    stop_policy: { max_rounds: 2 }
  }, 0);

  assert.equal(evaluation.schema_version, "evaluation.v1");
});

test("buildFollowUpQueries should prefer llm supplied search suggestions", () => {
  const queries = researchInternal.buildFollowUpQueries(
    "What is the current latency?",
    {
      missing_questions: ["official confirmation"],
      follow_up_queries: ["latency official benchmark", "latency latest official update"]
    },
    {
      failure_paths: [],
      queries_tried: []
    }
  );

  assert.deepEqual(queries, ["latency official benchmark", "latency latest official update"]);
});

test("buildNextRoundConnectorIds should merge suggested connectors into follow-up round selection", () => {
  const connectorIds = researchInternal.buildNextRoundConnectorIds(
    { chosen_connector_ids: ["douyin", "ted", "bing_web"] },
    ["douyin", "ted", "bing_web"],
    {
      suggested_connector_ids: ["arxiv", "bing_web", "missing", "arxiv"]
    }
  );

  assert.deepEqual(connectorIds, ["arxiv", "bing_web", "douyin", "ted"]);
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
      visual_observations: ["A line chart shows the benchmark trend rising across two tasks."],
      page_images: ["https://example.com/chart.png"],
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
  assert.equal(evidence[0].source_metadata.page_images[0], "https://example.com/chart.png");
  assert.ok(evidence[0].claims.some((item) => item.type === "visual_observation"));
  assert.ok(evidence[0].evidence_spans.some((item) => item.kind === "visual_observation"));
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

test("crossCheckFacts should merge llm verifier review when the model is available", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";

  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                overall_verdict: "conflicted",
                risk_level: "high",
                explanation: "The evidence still needs one more official source.",
                follow_up_queries: ["latency official benchmark"],
                suggested_source_types: ["web", "document"],
                entry_reviews: [
                  {
                    key: "latency:numeric_statement:ms",
                    verdict: "leans_preferred_source",
                    preferred_source: "b",
                    confidence: 0.84,
                    explanation: "Source b is newer and more authoritative than source a.",
                    missing_evidence: ["official benchmark"],
                    suggested_queries: ["latency official benchmark"]
                  }
                ]
              })
            }
          ]
        }
      ]
    })
  });

  try {
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

    assert.equal(verification.verifier_mode, "llm");
    assert.equal(verification.review_summary.overall_verdict, "conflicted");
    assert.equal(verification.conflicts[0].comparison.preferred_source, "b");
    assert.match(verification.conflicts[0].reason, /newer and more authoritative/i);
    assert.deepEqual(verification.follow_up_queries, ["latency official benchmark"]);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
});
