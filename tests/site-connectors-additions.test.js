const test = require("node:test");
const assert = require("node:assert/strict");

const { invokeSourceTool } = require("../src/source-connectors");

test("planetebook and google connectors should return native-search candidates", async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("planetebook.com/?s=")) {
      return {
        ok: true,
        text: async () => `
          <html><body>
            <a href="https://www.planetebook.com/pride-and-prejudice/">Pride and Prejudice</a>
          </body></html>
        `
      };
    }
    if (value.includes("google.com/search?")) {
      return {
        ok: true,
        text: async () => `
          <html><body>
            <a href="https://blog.google/technology/ai/gemini-updates/">Gemini updates</a>
            <a href="https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers">Google crawler docs</a>
          </body></html>
        `
      };
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  try {
    const results = await invokeSourceTool({
      action: "discover",
      query: "gemini",
      connector_ids: ["planetebook", "google"]
    });

    const byConnector = new Map(results.map((item) => [item.connector, item]));
    assert.ok(byConnector.has("planetebook"));
    assert.ok(byConnector.has("google"));
    assert.equal(byConnector.get("planetebook").metadata.native_search, true);
    assert.equal(byConnector.get("google").metadata.native_search, true);
    assert.equal(byConnector.get("google").metadata.search_backend, "google_search_html");
    assert.match(byConnector.get("planetebook").url, /^https:\/\/www\.planetebook\.com\//);
    assert.match(byConnector.get("google").url, /^https:\/\/(blog\.google|developers\.google\.com)\//);
  } finally {
    global.fetch = originalFetch;
  }
});
