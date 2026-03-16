const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  synthesizeTool,
  runEphemeralTool,
  readToolMemory,
  recordToolExperience,
  __internal
} = require("../src/ephemeral-tooling");

test("synthesizeTool should choose html extractor for web pages", async () => {
  const tool = await synthesizeTool({
    goal: "Extract the article body",
    target: {
      url: "https://example.com/article",
      content_type: "web",
      title: "Example article"
    },
    constraints: ["no third-party dependencies"]
  });

  assert.equal(tool.strategy, "html_extractor");
  assert.equal(tool.runtime, "node");
  assert.match(tool.description, /HTML|paragraphs|web pages/i);
  assert.match(tool.code, /readStdin/);
});

test("runEphemeralTool should extract structured data from inline html", async () => {
  const tool = await synthesizeTool({
    goal: "Extract article body",
    target: {
      title: "Inline page",
      content_type: "web",
      html: `
        <html>
          <head>
            <title>Inline Demo</title>
            <meta name="description" content="A small inline page for testing.">
          </head>
          <body>
            <article>
              <p>This paragraph is intentionally long enough to pass the extraction filter and become a key point for the test harness.</p>
              <p>This second paragraph is also long enough to be retained by the synthesized extractor and converted into normalized markdown.</p>
            </article>
            <script type="application/json">{"score":42,"label":"demo"}</script>
          </body>
        </html>
      `
    },
    constraints: []
  });

  const result = await runEphemeralTool(tool, { timeout_ms: 10000 });
  assert.equal(result.success, true);
  assert.equal(result.extracted_data.title, "Inline Demo");
  assert.ok(result.extracted_data.markdown.includes("# Inline Demo"));
  assert.ok(result.extracted_data.paragraphs.length >= 1);
  assert.ok(Array.isArray(result.logs));
  assert.ok(result.worth_promoting);
});

test("recordToolExperience should aggregate site and promotion hints", () => {
  const memoryPath = path.join(os.tmpdir(), `ephemeral-tool-memory-${Date.now()}.json`);
  try {
    const memory = recordToolExperience([
      {
        success: true,
        target: { url: "https://example.com/article" },
        tool: { strategy: "json_payload_extractor" },
        worth_promoting: {
          should_promote: true,
          reason: "Reusable site-specific extraction",
          candidate_connector: "example.com"
        }
      },
      {
        success: false,
        target: { url: "https://example.com/article" },
        tool: { strategy: "interactive_probe" },
        error: "render blocked"
      }
    ], { memoryPath });

    assert.equal(memory.site_patterns[0].site_key, "example.com");
    assert.equal(memory.site_patterns[0].attempts, 2);
    assert.equal(memory.site_patterns[0].success_count, 1);
    assert.equal(memory.reusable_patterns[0].strategy, "json_payload_extractor");
    assert.equal(memory.avoid_patterns[0].failure_mode, "render blocked");

    const reloaded = readToolMemory(memoryPath);
    assert.equal(reloaded.site_patterns[0].attempts, 2);
  } finally {
    if (fs.existsSync(memoryPath)) {
      fs.unlinkSync(memoryPath);
    }
  }
});

test("chooseStrategy should recognize interactive and video hints", () => {
  assert.equal(
    __internal.chooseStrategy("click through tabs and extract data", { url: "https://example.com" }, []),
    "interactive_probe"
  );
  assert.equal(
    __internal.chooseStrategy("extract video timeline", { url: "https://www.ted.com/talks/demo", content_type: "video" }, []),
    "video_metadata_extractor"
  );
});
