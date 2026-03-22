const test = require("node:test");
const assert = require("node:assert/strict");
const { __internal } = require("../src/source-connectors");
const { __internal: researchInternal } = require("../src/research-engine");

test("parseBingSearchMarkdown should extract title and decoded url", () => {
  const markdown = `
Title: Demo

URL Source: http://www.bing.com/search?q=Sora+OpenAI

Markdown Content:
1.   [Sora: Creating video from text | OpenAI](https://www.bing.com/ck/a?!&&p=test&u=a1aHR0cHM6Ly9vcGVuYWkuY29tL2luZGV4L3NvcmEv&ntb=1)
--------------------------------------------------------------------------------

Feb 15, 2024· Sora is able to generate complex scenes with multiple characters.
`;

  const results = __internal.parseBingSearchMarkdown(markdown, "Sora OpenAI");
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Sora: Creating video from text | OpenAI");
  assert.equal(results[0].url, "https://openai.com/index/sora/");
});

test("parseTedSearchHtml should extract TED talk candidates", () => {
  const html = `
  <article class='m1 search__result'>
    <h3 class='h7 m4'>
      <a class="ga-link" data-ga-context="search" href="/talks/victor_riparbelli_will_ai_make_us_the_last_generation_to_read_and_write">Victor Riparbelli: Will AI make us the last generation to read and write?</a>
    </h3>
    <div class='search__result__description m4'>
      Technology is changing our world and how we communicate.
    </div>
  </article>
  `;

  const results = __internal.parseTedSearchHtml(html, "artificial intelligence");
  assert.equal(results.length, 1);
  assert.equal(results[0].platform, "TED");
  assert.match(results[0].url, /ted\.com\/talks/);
});

test("parseSegmentFaultSearchHtml should extract Chinese article candidates", () => {
  const html = `
  <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        initialState: {
          search: {
            result: {
              rows: [
                {
                  type: "article",
                  contents: {
                    title: "Sora 何时开放使用",
                    excerpt: "根据提供的信息，Sora 目前还未对广大用户开放。",
                    created: 1708247935,
                    votes: 3,
                    comments: 2,
                    url: "/a/1190000044637173"
                  }
                }
              ]
            }
          }
        }
      }
    }
  })}</script>
  `;

  const results = __internal.parseSegmentFaultSearchHtml(html, "Sora");
  assert.equal(results.length, 1);
  assert.equal(results[0].platform, "SegmentFault");
  assert.match(results[0].url, /segmentfault\.com\/a\//);
});

test("parseBilibiliSearchHtml should extract video candidates", () => {
  const html = `
  <div class="bili-video-card">
    <a href="//www.bilibili.com/video/BV1Y2cXzREsm/" class="" target="_blank">
      <span class="bili-video-card__stats__duration">04:04</span>
    </a>
    <div class="bili-video-card__info">
      <a href="//www.bilibili.com/video/BV1Y2cXzREsm/" target="_blank">
        <h3 class="bili-video-card__info--tit" title="3月Sora2无限版 免费教程已更新！">3月Sora2无限版 免费教程已更新！</h3>
      </a>
      <div class="bili-video-card__info--bottom">
        <a class="bili-video-card__info--owner" href="//space.bilibili.com/12210083" target="_blank">
          <span class="bili-video-card__info--author">kubula</span>
        </a>
      </div>
    </div>
  </div>
  `;

  const results = __internal.parseBilibiliSearchHtml(html, "Sora");
  assert.equal(results.length, 1);
  assert.equal(results[0].platform, "Bilibili");
  assert.equal(results[0].duration, "04:04");
  assert.match(results[0].url, /bilibili\.com\/video\/BV1Y2cXzREsm/);
});

test("parseITHomeTagHtml should extract Chinese news candidates", () => {
  const html = `
  <ul class="bl">
    <li>
      <div class="c" data-ot="2026-03-11T13:19:23.1230000+08:00">
        <h2 class="">
          <a title="消息称 OpenAI 视频生成工具 Sora 将登陆 ChatGPT" target="_blank" href="https://www.ithome.com/0/927/929.htm" class="title">消息称 OpenAI 视频生成工具 Sora 将登陆 ChatGPT</a>
        </h2>
        <div class="m">此举是 OpenAI 扩大用户规模整体战略的一部分。</div>
      </div>
    </li>
  </ul>
  `;

  const results = __internal.parseITHomeTagHtml(html, "Sora 最新动态", "Sora");
  assert.equal(results.length, 1);
  assert.equal(results[0].platform, "IT之家");
  assert.match(results[0].url, /ithome\.com\/0\/927\/929\.htm/);
});

test("buildDouyinSearchUrl should generate search landing url", () => {
  const url = __internal.buildDouyinSearchUrl("美国总统特朗普 演讲视频");
  assert.equal(
    url,
    "https://www.douyin.com/search/%E7%BE%8E%E5%9B%BD%E6%80%BB%E7%BB%9F%E7%89%B9%E6%9C%97%E6%99%AE%20%E6%BC%94%E8%AE%B2%E8%A7%86%E9%A2%91"
  );
});


test("fetchOpenAIJsonWithRetry should retry retriable non-JSON responses", async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 502,
        text: async () => "Bad Gateway"
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "resp_1", output: [] })
    };
  };

  try {
    const payload = await researchInternal.fetchOpenAIJsonWithRetry("test-key", { input: "hello" }, { maxAttempts: 2, timeoutMs: 50, operation: "retry_test" });
    assert.equal(attempts, 2);
    assert.equal(payload.id, "resp_1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("createControlAction should stamp typed orchestration decisions", () => {
  const action = researchInternal.createControlAction(researchInternal.CONTROL_ACTION_TYPES.CONTINUE_SEARCH, {
    connector_ids: ["bing_web"],
    reason: "need more evidence"
  });

  assert.equal(action.type, "continue_search");
  assert.deepEqual(action.connector_ids, ["bing_web"]);
  assert.equal(action.reason, "need more evidence");
  assert.ok(action.issued_at);
});

test("buildSearchPolicy should degrade unhealthy connectors and preserve reserves", () => {
  const policy = researchInternal.buildSearchPolicy({
    chosen_connector_ids: ["bing_web", "ithome", "ted"],
    source_capabilities: [{ id: "segmentfault" }],
    execution_budget: {
      max_connectors: 3,
      max_queries: 5,
      max_site_hint_tasks: 2,
      degrade_after_connector_failures: 2
    }
  }, ["bing_web", "ithome", "ted"], null, {
    ithome: { failed_events: 3, healthy: false }
  });

  assert.equal(policy.search_mode, "degraded");
  assert.ok(policy.degraded_connector_ids.includes("ithome"));
  assert.ok(policy.connector_ids.includes("bing_web"));
  assert.ok(!policy.connector_ids.includes("ithome"));
  assert.equal(policy.query_limit, 5);
});

test("buildFollowUpQueries should respect execution budget and compacted context", () => {
  const scratchpad = researchInternal.createScratchpad({
    sub_questions: ["a"],
    execution_budget: { max_follow_up_queries: 2 }
  });
  scratchpad.workspace.compacted_context = {
    follow_up_queries: ["fallback 1", "fallback 2", "fallback 3"]
  };

  const queries = researchInternal.buildFollowUpQueries("demo", {
    follow_up_queries: ["q1", "q2", "q3"]
  }, scratchpad);

  assert.deepEqual(queries, ["q1", "q2"]);
});

test("compactScratchpadForNextRound should persist high-signal digest", () => {
  const scratchpad = researchInternal.createScratchpad({
    sub_questions: ["What changed?"],
    execution_budget: { max_follow_up_queries: 4 }
  });
  const digest = researchInternal.buildRoundDigest(1, {
    queries: ["OpenAI Sora update"],
    chosen_connector_ids: ["bing_web"],
    selected_sources: [{ id: "src-1" }]
  }, {
    resolved_questions: ["What changed?"],
    missing_questions: [],
    risk_notes: ["low evidence diversity"]
  }, {
    conflicts: [],
    coverage_gaps: [{ key: "gap-1" }]
  }, [{
    source_id: "src-1",
    title: "Update",
    source_type: "web",
    key_points: ["The release expanded availability."]
  }]);

  researchInternal.compactScratchpadForNextRound(scratchpad, digest, {
    resolved_questions: ["What changed?"],
    missing_questions: [],
    risk_notes: ["low evidence diversity"],
    follow_up_queries: ["Need official confirmation"]
  }, {
    conflicts: [],
    coverage_gaps: [{ key: "gap-1" }]
  });

  assert.equal(scratchpad.workspace.round_digests.length, 1);
  assert.equal(scratchpad.workspace.compacted_context.latest_round_digest.round, 1);
  assert.deepEqual(scratchpad.workspace.compacted_context.follow_up_queries, ["Need official confirmation"]);
});

test("deriveRoundControlAction should produce partial-stop and answer actions", () => {
  const partial = researchInternal.deriveRoundControlAction({
    chosen_connector_ids: ["bing_web"],
    execution_budget: { max_connectors: 2 }
  }, {
    next_best_action: "stop_with_partial_answer",
    reason: "round budget exhausted"
  }, ["bing_web"], {});
  const answer = researchInternal.deriveRoundControlAction({
    chosen_connector_ids: ["bing_web"],
    execution_budget: { max_connectors: 2 }
  }, {
    is_sufficient: true,
    next_best_action: "synthesize_answer",
    reason: "sufficient coverage"
  }, ["bing_web"], {});

  assert.equal(partial.type, "stop_partial");
  assert.equal(answer.type, "answer_now");
});
