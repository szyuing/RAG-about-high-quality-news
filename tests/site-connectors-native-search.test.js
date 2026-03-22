const test = require("node:test");
const assert = require("node:assert/strict");

const { invokeSourceTool } = require("../src/source-connectors");

test("site connectors should prefer native or public in-site search over Bing fallback", async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const value = String(url);

    if (value.includes("api.github.com/search/repositories")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          items: [{
            full_name: "openai/openai-cookbook",
            html_url: "https://github.com/openai/openai-cookbook",
            owner: { login: "openai" },
            description: "OpenAI examples and guides.",
            stargazers_count: 12345,
            forks_count: 2100,
            language: "Python",
            updated_at: "2026-03-19T00:00:00Z",
            topics: ["openai", "cookbook"]
          }]
        })
      };
    }

    if (value.includes("reddit.com/search.json")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: {
            children: [{
              data: {
                permalink: "/r/OpenAI/comments/demo123/openai_release_thread/",
                title: "OpenAI release thread",
                author: "demo_user",
                created_utc: 1773878400,
                selftext: "OpenAI discussion and user reports.",
                subreddit: "OpenAI",
                score: 520,
                num_comments: 88,
                is_self: true
              }
            }]
          }
        })
      };
    }

    if (value.includes("wikipedia.org/w/api.php")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          query: {
            search: [{
              title: "OpenAI",
              snippet: "OpenAI is an artificial intelligence research organization.",
              pageid: 12345,
              wordcount: 3200
            }]
          }
        })
      };
    }

    if (value.includes("zhihu.com/search?type=content")) {
      return {
        ok: true,
        text: async () => `
          <html>
            <body>
              <a href="https://www.zhihu.com/question/123456789">OpenAI 如何工作？</a>
              <a href="https://www.zhihu.com/p/987654321">OpenAI 产品体验总结</a>
            </body>
          </html>
        `
      };
    }

    if (value.includes("api.stackexchange.com/2.3/search/excerpts")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          items: [{
            link: "https://stackoverflow.com/questions/12345678/how-to-call-openai-api",
            title: "How to call OpenAI API?",
            excerpt: "Example OpenAI API request and response handling.",
            creation_date: 1773878400,
            score: 42,
            answer_count: 3,
            is_answered: true,
            tags: ["openai-api", "node.js"],
            owner: { display_name: "Stack Overflow User" }
          }]
        })
      };
    }

    throw new Error(`Unexpected URL: ${value}`);
  };

  try {
    const results = await invokeSourceTool({
      action: "discover",
      query: "openai",
      connector_ids: ["github", "reddit", "wikipedia", "zhihu", "stack_overflow"]
    });

    const byConnector = new Map(results.map((item) => [item.connector, item]));
    for (const connectorId of ["github", "reddit", "wikipedia", "zhihu", "stack_overflow"]) {
      assert.ok(byConnector.has(connectorId), `missing result for ${connectorId}`);
      assert.equal(byConnector.get(connectorId).metadata.native_search, true);
    }

    assert.equal(byConnector.get("github").metadata.search_backend, "github_public_api");
    assert.equal(byConnector.get("reddit").metadata.search_backend, "reddit_public_json");
    assert.equal(byConnector.get("wikipedia").metadata.search_backend, "mediawiki_api");
    assert.equal(byConnector.get("stack_overflow").metadata.search_backend, "stackexchange_api");
    assert.equal(byConnector.get("zhihu").metadata.search_backend, "zhihu_html");
    assert.match(byConnector.get("github").url, /^https:\/\/github\.com\//);
    assert.match(byConnector.get("reddit").url, /^https:\/\/www\.reddit\.com\//);
    assert.match(byConnector.get("wikipedia").url, /^https:\/\/(en|zh)\.wikipedia\.org\//);
    assert.match(byConnector.get("zhihu").url, /^https:\/\/www\.zhihu\.com\//);
    assert.match(byConnector.get("stack_overflow").url, /^https:\/\/stackoverflow\.com\//);
  } finally {
    global.fetch = originalFetch;
  }
});
