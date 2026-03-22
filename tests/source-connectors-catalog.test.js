const test = require("node:test");
const assert = require("node:assert/strict");
const { sourceCatalog, __internal } = require("../src/source-connectors");

test("sourceCatalog should expose newly added mainstream site connectors", () => {
  const ids = sourceCatalog.map((item) => item.id);

  assert.ok(ids.includes("planetebook"));
  assert.ok(ids.includes("google"));
  assert.ok(ids.includes("github"));
  assert.ok(ids.includes("reddit"));
  assert.ok(ids.includes("wikipedia"));
  assert.ok(ids.includes("youtube"));
  assert.ok(ids.includes("zhihu"));
  assert.ok(ids.includes("stack_overflow"));
  assert.ok(ids.includes("xinhua"));
  assert.ok(ids.includes("people"));
  assert.ok(ids.includes("cctv_news"));
  assert.ok(ids.includes("the_paper"));
  assert.ok(ids.includes("caixin"));
  assert.ok(ids.includes("jiemian"));
  assert.ok(ids.includes("reuters"));
  assert.ok(ids.includes("ap_news"));
  assert.ok(ids.includes("bbc_news"));
  assert.ok(ids.includes("bloomberg"));
  assert.ok(ids.includes("nytimes"));
  assert.ok(ids.includes("wsj"));
});

test("new mainstream site connectors should support search and read capabilities", () => {
  const connectorMap = new Map(sourceCatalog.map((item) => [item.id, item]));

  for (const id of [
    "planetebook", "google", "github", "reddit", "wikipedia", "youtube", "zhihu", "stack_overflow",
    "xinhua", "people", "cctv_news", "the_paper", "caixin", "jiemian",
    "reuters", "ap_news", "bbc_news", "bloomberg", "nytimes", "wsj"
  ]) {
    const connector = connectorMap.get(id);
    assert.ok(connector, `missing connector: ${id}`);
    assert.ok(connector.capabilities.includes("search"), `${id} should support search`);
    if (id === "youtube") {
      assert.ok(connector.capabilities.includes("video"), "youtube should support video");
      assert.ok(connector.capabilities.includes("transcripts"), "youtube should support transcripts");
    } else {
      assert.ok(connector.capabilities.includes("content extraction"), `${id} should support content extraction`);
    }
    assert.equal(connector.generated, false);
    assert.equal(connector.supports_search, true);
    assert.equal(connector.supports_read, true);
    assert.ok(Array.isArray(connector.domains));
  }
});

test("youtube URLs should infer the youtube connector and video content type", () => {
  assert.equal(__internal.inferConnectorIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube");
  assert.equal(__internal.inferConnectorIdFromUrl("https://youtu.be/dQw4w9WgXcQ"), "youtube");
  assert.equal(__internal.contentTypeForConnector("youtube"), "video");
});

test("planetebook and google URLs should infer their connectors", () => {
  assert.equal(__internal.inferConnectorIdFromUrl("https://www.planetebook.com/pride-and-prejudice/"), "planetebook");
  assert.equal(__internal.inferConnectorIdFromUrl("https://blog.google/technology/ai/gemini-updates/"), "google");
  assert.equal(__internal.inferConnectorIdFromUrl("https://developers.google.com/search/docs"), "google");
});
