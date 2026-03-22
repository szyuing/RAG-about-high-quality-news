const test = require("node:test");
const assert = require("node:assert/strict");

const { __internal: researchInternal } = require("../src/research-engine");
const { createConnectorRuntime } = require("../src/source-connectors-runtime");
const { __internal: researchOpsInternal } = require("../src/research-ops");
const {
  buildBingSiteQueries,
  __internal: siteInternal
} = require("../src/site-hints");

test("planner should prioritize connectors and queries suggested by site hints", () => {
  const plan = researchInternal.planner(
    "Sora 教程视频",
    {
      entries: [],
      boosted_queries: [],
      boosted_source_types: [],
      avoided_patterns: []
    },
    {
      items: [
        {
          name: "Bilibili 教程",
          domain: "bilibili.com",
          connector_id: "bilibili",
          category: "视频教程",
          tags: ["视频", "教程"]
        }
      ],
      domains: ["bilibili.com"]
    }
  );

  assert.ok(plan.chosen_connector_ids.includes("bilibili"));
  assert.ok(plan.chosen_connector_ids.includes("bing_web"));
  assert.ok(plan.initial_queries.some((item) => /bilibili/i.test(item)));
  assert.equal(plan.search_site_hints.items[0].domain, "bilibili.com");
});

test("buildBingSiteQueries should generate site-filtered queries", () => {
  const queries = buildBingSiteQueries(
    ["OpenAI Sora current update"],
    {
      items: [
        { domain: "openai.com" },
        { domain: "news.ycombinator.com" }
      ]
    },
    3
  );

  assert.deepEqual(queries, [
    "OpenAI Sora current update site:openai.com",
    "OpenAI Sora current update site:news.ycombinator.com"
  ]);
});

test("normalizeModelSiteSearchStrategies should allow non-hinted domains", () => {
  const strategies = researchInternal.normalizeModelSiteSearchStrategies(
    [
      {
        site_name: "Example",
        domain: "example.com",
        connector_id: "bing_web",
        search_mode: "site_query",
        query_variants: ["example update"],
        rationale: "Useful supporting site"
      }
    ],
    {
      source_capabilities: [{ id: "bing_web" }, { id: "ithome" }],
      search_site_hints: {
        items: [{ domain: "openai.com" }],
        domains: ["openai.com"]
      }
    }
  );

  assert.equal(strategies.length, 1);
  assert.equal(strategies[0].domain, "example.com");
  assert.equal(strategies[0].search_mode, "site_query");
});

test("profilesFromTableRows should infer site metadata from spreadsheet-like rows", () => {
  const profiles = siteInternal.profilesFromTableRows([
    ["网站名称", "网址", "分类", "关键词"],
    ["OpenAI", "https://openai.com", "AI 官方", "Sora, API"],
    ["Bilibili", "www.bilibili.com", "视频教程", "教程, 视频"]
  ], "Sheet1");

  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].domain, "openai.com");
  assert.equal(profiles[0].sheet_name, "Sheet1");
  assert.equal(profiles[1].connector_id, "bilibili");
});

test("connector runtime should boost preferred domain matches during discover", async () => {
  const runtime = createConnectorRuntime({
    connectorRegistry: [
      {
        id: "bing_web",
        label: "Bing",
        description: "Web",
        capabilities: ["search"],
        async search() {
          return [
            {
              url: "https://example.com/sora",
              title: "Example Sora",
              summary: "Sora update overview",
              score: 0.6,
              metadata: {}
            },
            {
              url: "https://openai.com/sora",
              title: "OpenAI Sora",
              summary: "Official Sora update",
              score: 0.6,
              metadata: {}
            }
          ];
        }
      }
    ],
    buildQueryTokens(query) {
      return String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    },
    normalizeWhitespace(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    },
    normalizeCandidateMediaMetadata(candidate) {
      return candidate;
    }
  });

  const results = await runtime.invokeSourceTool({
    action: "discover",
    query: "sora update",
    connector_ids: ["bing_web"],
    preferred_domains: ["openai.com"]
  });

  assert.equal(results[0].url, "https://openai.com/sora");
  assert.equal(results[0].metadata.preferred_domain_match, true);
});

test("buildSiteStrategyTasks should turn llm site strategies into executable searches", () => {
  const tasks = researchOpsInternal.buildSiteStrategyTasks({
    chosen_connector_ids: ["bing_web", "douyin"],
    site_search_strategies: [
      {
        site_name: "Douyin",
        domain: "douyin.com",
        connector_id: "douyin",
        search_mode: "hybrid",
        query_variants: ["特朗普 演讲 抖音"],
        rationale: "Search inside Douyin and via site query."
      },
      {
        site_name: "OpenAI",
        domain: "openai.com",
        connector_id: "bing_web",
        search_mode: "site_query",
        query_variants: ["OpenAI Sora official update"],
        rationale: "Use official domain first."
      }
    ]
  }, ["Sora current update"]);

  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks[0].connector_ids, ["douyin"]);
  assert.equal(tasks[1].query, "特朗普 演讲 抖音 site:douyin.com");
  assert.equal(tasks[2].query, "OpenAI Sora official update site:openai.com");
});

test("buildSiteStrategyTasks should downgrade read-only generated connectors to site query plus generated read", () => {
  const tasks = researchOpsInternal.buildSiteStrategyTasks({
    chosen_connector_ids: ["bing_web"],
    site_search_strategies: [
      {
        site_name: "OpenAI",
        domain: "openai.com",
        connector_id: null,
        resolved_connector_id: "site_openai_com",
        search_mode: "hybrid",
        effective_search_mode: "site_query_with_generated_read",
        query_variants: ["OpenAI Sora official update"],
        rationale: "Read via generated connector, discover via site query."
      }
    ]
  }, ["Sora current update"]);

  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].connector_ids, ["bing_web"]);
  assert.equal(tasks[0].read_connector_id, "site_openai_com");
  assert.equal(tasks[0].query, "OpenAI Sora official update site:openai.com");
});


test("profilesFromTableRows should infer planetebook and google connector ids", () => {
  const profiles = siteInternal.profilesFromTableRows([
    ["Site", "Domain", "Category", "Tags"],
    ["Planet eBook", "https://www.planetebook.com", "Books", "classics, ebooks"],
    ["Google", "https://blog.google", "Official", "ai, docs"]
  ], "Sites");

  assert.equal(profiles[0].connector_id, "planetebook");
  assert.equal(profiles[1].connector_id, "google");
});
