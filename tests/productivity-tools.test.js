const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registerProductivityTools } = require("../src/productivity-tools");

function createRegistry() {
  return {
    tools: new Map(),
    registerTool(tool) { this.tools.set(tool.id, tool); },
    getToolCapabilities() { return Array.from(this.tools.values()).map((tool) => ({ id: tool.id })); },
    async executeTool(id, input) {
      const tool = this.tools.get(id);
      if (!tool) {
        throw new Error(`Tool not found: ${id}`);
      }
      if (typeof tool.validate === "function") {
        tool.validate(input);
      }
      return { success: true, data: await tool.execute(input) };
    }
  };
}

const SAMPLE_HTML = `<!doctype html>
<html>
  <head>
    <title>Demo Article</title>
    <meta name="description" content="Short summary for readers" />
    <meta property="og:site_name" content="Example Site" />
    <meta name="author" content="Alice" />
    <meta property="article:published_time" content="2026-03-17" />
    <script type="application/ld+json">{"headline":"Demo Article","author":{"name":"Alice"}}</script>
  </head>
  <body>
    <main>
      <h1>Demo Article</h1>
      <p>OpenSearch now extracts readable article bodies from regular pages.</p>
      <p>This paragraph contains enough detail to become a key point for tests.</p>
      <a href="/docs">Docs</a>
    </main>
  </body>
</html>`;

test("registerProductivityTools should register all new tool ids", () => {
  const registry = createRegistry();
  registerProductivityTools(registry, {});
  const ids = registry.getToolCapabilities().map((item) => item.id);
  for (const id of [
    "extract_readable_article",
    "extract_web_page_bundle",
    "extract_structured_web_data",
    "url_to_pdf",
    "html_to_pdf",
    "markdown_to_pdf",
    "template_to_pdf",
    "compose_pdf_packet",
    "file_to_markdown"
  ]) {
    assert.ok(ids.includes(id));
  }
});

test("extract_readable_article should return readable fields", async () => {
  const registry = createRegistry();
  const originalFetch = global.fetch;
  registerProductivityTools(registry, {});
  global.fetch = async () => ({ ok: true, url: "https://example.com/demo", text: async () => SAMPLE_HTML });
  try {
    const result = await registry.executeTool("extract_readable_article", { url: "https://example.com/demo" });
    assert.equal(result.data.title, "Demo Article");
    assert.equal(result.data.byline, "Alice");
    assert.equal(result.data.site_name, "Example Site");
    assert.match(result.data.text, /OpenSearch now extracts/);
    assert.equal(result.data.links[0].href, "https://example.com/docs");
  } finally {
    global.fetch = originalFetch;
  }
});

test("extract_structured_web_data should infer requested fields", async () => {
  const registry = createRegistry();
  const originalFetch = global.fetch;
  registerProductivityTools(registry, {});
  global.fetch = async () => ({ ok: true, url: "https://example.com/demo", text: async () => SAMPLE_HTML });
  try {
    const result = await registry.executeTool("extract_structured_web_data", {
      url: "https://example.com/demo",
      fields: ["title", "author", "published_at", "site_name"]
    });
    assert.equal(result.data.structured_data.title, "Demo Article");
    assert.equal(result.data.structured_data.author, "Alice");
    assert.equal(result.data.structured_data.published_at, "2026-03-17");
    assert.equal(result.data.structured_data.site_name, "Example Site");
  } finally {
    global.fetch = originalFetch;
  }
});

test("file_to_markdown should convert HTML and persist output", async () => {
  const registry = createRegistry();
  registerProductivityTools(registry, {});
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opensearch-productivity-"));
  const inputPath = path.join(tempRoot, "demo.html");
  const outputPath = path.join(tempRoot, "demo.md");
  fs.writeFileSync(inputPath, SAMPLE_HTML, "utf8");
  try {
    const result = await registry.executeTool("file_to_markdown", { inputPath, outputPath });
    assert.match(result.data.markdown, /Demo Article/);
    assert.equal(fs.existsSync(outputPath), true);
    assert.match(fs.readFileSync(outputPath, "utf8"), /Demo Article/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
