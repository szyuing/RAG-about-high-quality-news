const test = require("node:test");
const assert = require("node:assert/strict");
const { __internal: researchInternal } = require("../src/research-engine");
const { __internal: sourceInternal } = require("../src/source-connectors");

test("planner should choose a bounded connector set before discovery", () => {
  const plan = researchInternal.planner("缂囧骸娴楅幀鑽ょ埠閻楄婀曢弲?濠曟棁顔夌憴鍡涱暥");

  assert.ok(Array.isArray(plan.preferred_connectors));
  assert.ok(Array.isArray(plan.chosen_connector_ids));
  assert.ok(plan.chosen_connector_ids.length >= 2);
  assert.ok(plan.chosen_connector_ids.length <= 4);
  assert.ok(plan.chosen_connector_ids.includes("bing_web"));
  assert.deepEqual(
    plan.chosen_connector_ids,
    researchInternal.chooseConnectorsForQuestion("缂囧骸娴楅幀鑽ょ埠閻楄婀曢弲?濠曟棁顔夌憴鍡涱暥", plan.preferred_connectors)
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

test("buildNextRoundConnectorIds should replace unhealthy connectors with healthy reserves", () => {
  const ids = researchInternal.buildNextRoundConnectorIds(
    {
      chosen_connector_ids: ["douyin", "bing_web"],
      source_capabilities: [
        { id: "douyin" },
        { id: "bilibili" },
        { id: "bing_web" },
        { id: "ted" }
      ]
    },
    ["douyin", "bing_web"],
    { suggested_connector_ids: ["douyin"] },
    {
      douyin: { healthy: false },
      bing_web: { healthy: true },
      bilibili: { healthy: true }
    }
  );

  assert.ok(ids.includes("bing_web"));
  assert.ok(ids.includes("bilibili"));
  assert.ok(!ids.includes("douyin"));
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

  assert.ok(hints.entries.length >= 1);
  assert.equal(hints.entries[0].question, "OpenAI Sora current update");
  assert.ok(hints.boosted_source_types.includes("video"));
  assert.ok(hints.boosted_source_types.includes("web"));
  assert.ok(hints.boosted_queries.includes("OpenAI Sora official"));
});

test("getRelevantExperienceHints should prioritize learned connector patterns from strong history", () => {
  const now = new Date().toISOString();
  const hints = researchInternal.getRelevantExperienceHints(
    "Sora update official video",
    [
      {
        question: "OpenAI Sora current update",
        created_at: now,
        last_seen_at: now,
        run_count: 3,
        success_count: 3,
        useful_queries: ["OpenAI Sora official", "OpenAI Sora launch video"],
        useful_source_types: ["video", "web"],
        learned_patterns: {
          boosted_connector_ids: ["bilibili", "bing_web"],
          avoided_connector_ids: ["hacker_news"],
          follow_up_queries: ["OpenAI Sora release notes"],
          promoted_sites: ["openai.com"]
        },
        metrics: {
          quality_score: 0.92,
          confidence: 0.88,
          sufficiency: true
        },
        noisy_paths: ["duplicate clip results"]
      },
      {
        question: "Apple benchmark",
        useful_queries: ["iPhone benchmark"],
        useful_source_types: ["document"],
        learned_patterns: {
          boosted_connector_ids: ["arxiv"]
        },
        metrics: {
          quality_score: 0.2,
          confidence: 0.2,
          sufficiency: false
        }
      }
    ]
  );

  assert.deepEqual(hints.boosted_connector_ids.slice(0, 2), ["bilibili", "bing_web"]);
  assert.ok(hints.avoided_connector_ids.includes("hacker_news"));
  assert.ok(hints.boosted_queries.includes("OpenAI Sora release notes"));
  assert.ok(hints.promoted_sites.includes("openai.com"));
});

test("recordExperienceMemoryEntry should merge repeated questions instead of appending duplicates", () => {
  const merged = researchInternal.recordExperienceMemoryEntry(
    [
      {
        question: "OpenAI Sora update",
        created_at: "2026-03-16T00:00:00.000Z",
        last_seen_at: "2026-03-16T00:00:00.000Z",
        run_count: 2,
        success_count: 1,
        useful_queries: ["OpenAI Sora official"],
        useful_source_types: ["video"],
        learned_patterns: {
          boosted_connector_ids: ["bilibili"]
        },
        metrics: {
          quality_score: 0.5,
          confidence: 0.6,
          sufficiency: true
        },
        noisy_paths: ["no candidate returned"]
      }
    ],
    {
      question: "OpenAI Sora update",
      created_at: "2026-03-18T00:00:00.000Z",
      last_seen_at: "2026-03-18T00:00:00.000Z",
      run_count: 1,
      success_count: 1,
      useful_queries: ["OpenAI Sora current update"],
      useful_source_types: ["web"],
      learned_patterns: {
        boosted_connector_ids: ["bing_web"],
        follow_up_queries: ["OpenAI Sora release notes"]
      },
      metrics: {
        quality_score: 0.9,
        confidence: 0.8,
        sufficiency: true
      }
    },
    { limit: 30 }
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].run_count, 3);
  assert.equal(merged[0].success_count, 2);
  assert.equal(merged[0].last_seen_at, "2026-03-18T00:00:00.000Z");
  assert.ok(merged[0].useful_queries.includes("OpenAI Sora official"));
  assert.ok(merged[0].useful_queries.includes("OpenAI Sora current update"));
  assert.ok(merged[0].learned_patterns.boosted_connector_ids.includes("bilibili"));
  assert.ok(merged[0].learned_patterns.boosted_connector_ids.includes("bing_web"));
});

test("buildPlannerPrompt should keep six-step guidance and omit planner connector output fields", () => {
  const basePlan = researchInternal.buildLlmPlanningContext("DeepSeek 发布 v4 模型");
  const prompt = researchInternal.buildPlannerPrompt("DeepSeek 发布 v4 模型", basePlan);

  assert.match(prompt, /Step 1｜拆解问题/);
  assert.match(prompt, /Step 6｜获取并提取答案/);
  assert.match(prompt, /不要从 connector availability 出发做规划/);
  assert.match(prompt, /自动补全时，优先补全会直接改变答案定位方式的缺失约束/);
  assert.match(prompt, /如果问题是在问精确措辞、最后一句、某段对话、某一结尾内容/);
  assert.ok(prompt.includes("site_search_strategies 对应 Step 4 + Step 5"));
  assert.match(prompt, /runtime 后续可能会为高价值未覆盖域名 provision generated site connector/);
  assert.doesNotMatch(prompt, /chosen_connector_ids 只是轻量运行提示/);
  assert.doesNotMatch(prompt, /chosen_connector_ids 的顺序代表推荐执行优先级/);
  assert.doesNotMatch(prompt, /connector_reasons 应解释排序依据/);
});

test("mergePlanWithModelSelection should accept planner outputs without connector picks", () => {
  const basePlan = researchInternal.buildLlmPlanningContext("DeepSeek 发布 v4 模型");
  const merged = researchInternal.mergePlanWithModelSelection(basePlan, {
    sub_questions: ["是否真的发布了 V4？", "官方证据在哪里？"],
    required_evidence: ["官网或官方博客公告", "仓库或文档中的一手说明"],
    initial_queries: [
      "site:deepseek.com DeepSeek V4 发布",
      "site:api-docs.deepseek.com DeepSeek V4",
      "DeepSeek V4 官方公告"
    ],
    site_search_strategies: [
      {
        site_name: "DeepSeek",
        domain: "deepseek.com",
        search_mode: "site_query",
        query_variants: ["DeepSeek V4 发布", "DeepSeek 官方公告"],
        rationale: "官方主站是一手证据。"
      }
    ],
    rationale: "official-first"
  });

  assert.deepEqual(merged.chosen_connector_ids, []);
  assert.deepEqual(merged.preferred_connectors, []);
  assert.equal(merged.planner_rationale, "official-first");
  assert.equal(merged.site_search_strategies[0].domain, "deepseek.com");
  assert.ok(merged.initial_queries[0].includes("DeepSeek"));
});

test("preparePlanPhase should choose runtime connectors after planner phase", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  const calls = [];
  process.env.OPENAI_API_KEY = "test-key";

  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(JSON.stringify(payload.input));
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
                  chosen_connector_ids: ["github", "bing_web"],
                  connector_reasons: [
                    { id: "github", reason: "repo evidence" },
                    { id: "bing_web", reason: "generic site-query fallback" }
                  ],
                  rationale: "site-driven runtime selection"
                })
              }
            ]
          }
        ]
      })
    };
  };

  try {
    const session = {
      question: "OpenAI update",
      telemetry: { events: [] },
      plan: {
        ...researchInternal.buildLlmPlanningContext("OpenAI update"),
        sub_questions: ["Q1"],
        required_evidence: ["official text"],
        initial_queries: ["OpenAI official update"],
        chosen_connector_ids: [],
        preferred_connectors: [],
        site_search_strategies: [
          {
            site_name: "GitHub",
            domain: "github.com",
            search_mode: "connector_search",
            query_variants: ["openai release notes"],
            rationale: "repo evidence"
          },
          {
            site_name: "Wikipedia",
            domain: "wikipedia.org",
            search_mode: "site_query",
            query_variants: ["OpenAI background"],
            rationale: "domain-filtered verification"
          }
        ]
      }
    };

    await researchInternal.preparePlanPhase(session);
    assert.deepEqual(session.plan.chosen_connector_ids, ["github", "bing_web"]);
    assert.deepEqual(session.plan.preferred_connectors.map((item) => item.id), ["github", "bing_web"]);
    assert.equal(session.plan.site_search_strategies[0].resolved_connector_id, "github");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Available runtime connectors:/i);
    assert.match(calls[0], /github/i);
    assert.match(calls[0], /bing_web/i);
    assert.match(calls[0], /wikipedia/i);
    assert.doesNotMatch(calls[0], /zhihu/i);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
});

test("chooseConnectorsForQuestion should treat hinted site connectors as optional", () => {
  const chosen = researchInternal.chooseConnectorsForQuestion(
    "OpenAI Sora official update",
    [
      { id: "bing_web", label: "Bing Web", reason: "broad discovery" },
      { id: "ithome", label: "IT Home", reason: "tech reporting" }
    ],
    null,
    {
      items: [
        {
          name: "Douyin",
          domain: "douyin.com",
          connector_id: "douyin"
        }
      ],
      domains: ["douyin.com"]
    }
  );

  assert.deepEqual(chosen, ["bing_web", "ithome"]);
  assert.ok(!chosen.includes("douyin"));
});

test("buildPlan should fail fast when OPENAI_API_KEY is absent in strict llm-only mode", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    await assert.rejects(
      () => researchInternal.buildPlan("缂囧骸娴楅幀鑽ょ埠閻楄婀曢弲?濠曟棁顔夌憴鍡涱暥"),
      /OPENAI_API_KEY is required for llm-only planning/
    );
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
                site_search_strategies: [
                  {
                    site_name: "OpenAI",
                    domain: "openai.com",
                    connector_id: "bing_web",
                    search_mode: "site_query",
                    query_variants: ["OpenAI Sora official update", "Sora release notes"],
                    rationale: "Official updates should be searched on the primary domain first."
                  }
                ],
                rationale: "Prioritize official and current reporting."
              })
            }
          ]
        }
      ]
    })
  });

  try {
    const plan = await researchInternal.buildPlan("OpenAI Sora update");

    assert.deepEqual(plan.sub_questions, ["What changed?", "Why does it matter?"]);
    assert.deepEqual(plan.required_evidence, ["Official update", "Independent confirmation"]);
    assert.deepEqual(plan.initial_queries, ["OpenAI Sora official update", "Sora independent review"]);
    assert.equal(plan.site_search_strategies[0].domain, "openai.com");
    assert.equal(plan.planner_rationale, "Prioritize official and current reporting.");
    assert.deepEqual(plan.chosen_connector_ids, []);
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

test("requestExperienceMemoryFromModel should return null when OPENAI_API_KEY is absent", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const result = await researchInternal.requestExperienceMemoryFromModel(
      "Sora current update",
      { question: "Sora current update" },
      [],
      null,
      null
    );
    assert.equal(result, null);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});

test("finalizeExperienceMemory should apply llm-curated memory output when available", async () => {
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
                canonical_question: "OpenAI Sora release update",
                memory_summary: "Prefer official release notes plus short-form video recaps for Sora updates.",
                reusable_insights: ["Official release notes establish the baseline before secondary commentary."],
                retrieval_tags: ["sora", "release", "official"],
                useful_queries: ["OpenAI Sora release notes"],
                useful_source_types: ["web", "video"],
                boosted_connector_ids: ["bing_web", "bilibili"],
                avoided_connector_ids: ["hacker_news"],
                follow_up_queries: ["Sora launch recap video"],
                promoted_sites: ["openai.com"],
                noisy_patterns: ["duplicate clip results"],
                merge_target_question_key: "openai sora current update",
                merge_rationale: "Same recurring update-tracking task."
              })
            }
          ]
        }
      ]
    })
  });

  try {
    const memory = await researchInternal.finalizeExperienceMemory(
      "Sora current update",
      {
        sources_read: [{ connector: "bing_web", source_type: "web" }],
        queries_tried: ["Sora current update"],
        failure_paths: [],
        agent_reports: [],
        workspace: { timeline: [{ type: "round_completed" }] }
      },
      { chosen_connector_ids: ["bing_web"], sub_questions: [] },
      {
        is_sufficient: true,
        follow_up_queries: [],
        metrics: { source_types_covered: 1, evidence_items: 2 },
        scorecard: { readiness: 0.8 }
      },
      { ephemeral_tools: [], failures: [] },
      { confirmations: [{ key: "capability" }], conflicts: [], coverage_gaps: [] },
      {
        quick_answer: "Sora updated",
        uncertainty: [],
        deep_research_summary: { conclusion: "Capability expanded." }
      },
      [
        {
          question: "OpenAI Sora current update",
          question_key: "openai sora current update",
          useful_queries: ["OpenAI Sora official"],
          useful_source_types: ["web"]
        }
      ]
    );

    assert.equal(memory.question, "OpenAI Sora release update");
    assert.equal(memory.question_key, "openai sora current update");
    assert.equal(memory.note, "Prefer official release notes plus short-form video recaps for Sora updates.");
    assert.ok(memory.useful_queries.includes("OpenAI Sora release notes"));
    assert.ok(memory.learned_patterns.boosted_connector_ids.includes("bilibili"));
    assert.ok(memory.learned_patterns.avoided_connector_ids.includes("hacker_news"));
    assert.ok(memory.llm_memory.retrieval_tags.includes("official"));
    assert.equal(memory.llm_memory.mode, "llm");
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
  }
});

test("summarizeExperienceMemory should aggregate reusable overview fields", () => {
  const summary = researchInternal.summarizeExperienceMemory([
    {
      question: "OpenAI Sora update",
      run_count: 2,
      success_count: 2,
      useful_queries: ["OpenAI Sora official"],
      useful_source_types: ["web", "video"],
      learned_patterns: {
        boosted_connector_ids: ["bing_web", "bilibili"],
        promoted_sites: ["openai.com"]
      },
      noisy_paths: ["duplicate clip results"]
    },
    {
      question: "Apple benchmark",
      run_count: 1,
      success_count: 0,
      useful_queries: ["iPhone benchmark"],
      useful_source_types: ["web"],
      learned_patterns: {
        boosted_connector_ids: ["bing_web"]
      },
      noisy_paths: ["paywalled benchmark table"]
    }
  ]);

  assert.equal(summary.schema_version, "experience-overview.v1");
  assert.equal(summary.total_entries, 2);
  assert.deepEqual(summary.top_connectors.slice(0, 2), ["bing_web", "bilibili"]);
  assert.ok(summary.recurring_gaps.includes("duplicate clip results"));
});

test("planner should include experience hints in connector and query planning", () => {
  const plan = researchInternal.planner("Sora current update", {
    entries: [{ question: "OpenAI Sora current update", relevance: 3 }],
    boosted_queries: ["OpenAI Sora official"],
    boosted_source_types: ["video"],
    avoided_patterns: ["no candidate returned"],
    boosted_connector_ids: ["bilibili"],
    avoided_connector_ids: ["hacker_news"]
  });

  assert.ok(plan.initial_queries.includes("OpenAI Sora official"));
  assert.ok(plan.experience_hints);
  assert.ok(Array.isArray(plan.experience_hints.boosted_source_types));
  assert.ok(plan.preferred_connectors.some((item) => item.id === "bilibili"));
  assert.ok(!plan.chosen_connector_ids.includes("hacker_news"));
});

test("requestStopDecisionFromModel should fail fast when OPENAI_API_KEY is absent in strict llm-only mode", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    await assert.rejects(
      () => researchInternal.requestStopDecisionFromModel(
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
      ),
      /OPENAI_API_KEY is required for llm-only evaluation/
    );
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

test("appendTimelineEvent should preserve site-search task details in scratchpad timeline", () => {
  const scratchpad = researchInternal.createScratchpad({
    sub_questions: []
  });

  researchInternal.appendTimelineEvent(scratchpad, {
    type: "site_search_strategy",
    agent: "web_researcher",
    search_tasks: [
      {
        site_name: "OpenAI",
        search_mode: "site_query",
        query: "OpenAI Sora official update site:openai.com",
        connector_ids: ["bing_web"]
      }
    ]
  });

  assert.equal(scratchpad.workspace.timeline.length, 1);
  assert.equal(scratchpad.workspace.timeline[0].type, "site_search_strategy");
  assert.equal(scratchpad.workspace.timeline[0].search_tasks[0].site_name, "OpenAI");
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
      is_sufficient: true,
      can_answer_accurately: true,
      answerability: "sufficient",
      confidence: 0.87,
      resolved_questions: ["one"],
      missing_questions: [],
      risk_notes: [],
      follow_up_queries: [],
      suggested_connector_ids: [],
      next_best_action: "synthesize_answer",
      reason: "evidence_sufficient",
      metrics: {
        source_types_covered: 2,
        evidence_units: 3,
        overall_coverage: 0.91,
        conflict_count: 0,
        single_source_claims: 0
      }
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
      is_sufficient: false,
      can_answer_accurately: false,
      answerability: "partial",
      confidence: 0.44,
      resolved_questions: ["what changed"],
      missing_questions: ["official confirmation", "more recent benchmark"],
      risk_notes: ["sources disagree on the benchmark number"],
      follow_up_queries: ["latency official benchmark", "latency latest official update"],
      suggested_connector_ids: ["bing_web", "arxiv"],
      next_best_action: "run_follow_up_search",
      reason: "need_official_corroboration",
      metrics: {
        source_types_covered: 1,
        evidence_units: 2,
        overall_coverage: 0.44,
        conflict_count: 1,
        single_source_claims: 1
      }
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

test("updateConnectorHealthSnapshot should refresh health status per round", () => {
  const telemetry = {
    failures: [
      { stage: "discover", reason: "search timeout" },
      { stage: "collect", connector: "douyin", reason: "read failed" }
    ],
    connector_health: {}
  };

  researchInternal.updateConnectorHealthSnapshot(telemetry, ["douyin", "bing_web"], 2);

  assert.equal(telemetry.connector_health.douyin.rounds_observed, 2);
  assert.equal(telemetry.connector_health.douyin.failed_events, 2);
  assert.equal(telemetry.connector_health.douyin.last_failure, "read failed");
  assert.equal(telemetry.connector_health["bing_web"].failed_events, 1);
  assert.equal(typeof telemetry.connector_health.douyin.updated_at, "string");
});

test("fetchOpenAIJsonWithRetry should retry after transient failures", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("fetch failed");
    }
    return {
      ok: true,
      json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] })
    };
  };

  try {
    const payload = await researchInternal.fetchOpenAIJsonWithRetry(
      "test-key",
      { model: "gpt-4o-mini", input: "hello" },
      { operation: "test_retry", timeoutMs: 1000, maxAttempts: 2 }
    );
    assert.equal(calls, 2);
    assert.ok(payload.output);
  } finally {
    global.fetch = originalFetch;
  }
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




