const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test("generated connector id should stay stable across www and protocol variants", () => {
  const store = require("../src/generated-site-connectors-store");
  assert.equal(store.buildGeneratedConnectorId("https://www.openai.com"), "site_openai_com");
  assert.equal(store.buildGeneratedConnectorId("openai.com"), "site_openai_com");
  assert.equal(store.buildGeneratedConnectorId("http://openai.com/path?q=1"), "site_openai_com");
});

test("persisted generated connectors should load into source capabilities with metadata", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opensearch-generated-"));
  const connectorsPath = path.join(tempRoot, "generated-site-connectors.json");
  process.env.OPENSEARCH_GENERATED_CONNECTORS_PATH = connectorsPath;

  fs.writeFileSync(connectorsPath, JSON.stringify({
    schema_version: "generated-site-connectors.v1",
    connectors: [
      {
        id: "site_openai_com",
        label: "openai.com (Generated)",
        domain: "openai.com",
        domains: ["openai.com"],
        description: "Generated connector for openai.com.",
        capabilities: ["content extraction"],
        generated: true,
        supports_search: false,
        supports_read: true,
        tool_ids: { read: "generated_read_site_openai_com", search: null },
        status: "active"
      }
    ]
  }, null, 2));

  const sourceConnectors = freshRequire("../src/source-connectors");
  const connector = sourceConnectors.sourceCatalog.find((item) => item.id === "site_openai_com");

  assert.ok(connector);
  assert.equal(connector.generated, true);
  assert.deepEqual(connector.domains, ["openai.com"]);
  assert.equal(connector.supports_search, false);
  assert.equal(connector.supports_read, true);

  delete process.env.OPENSEARCH_GENERATED_CONNECTORS_PATH;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("provisioner should reuse existing native connector coverage without generating a new one", async () => {
  const { provisionSiteConnectorsForStrategies } = require("../src/site-connector-provisioner");
  const telemetry = { events: [] };
  const results = await provisionSiteConnectorsForStrategies([
    {
      site_name: "GitHub",
      domain: "https://www.github.com",
      connector_id: null,
      search_mode: "connector_search",
      query_variants: ["OpenAI responses api"],
      rationale: "Prefer GitHub docs and repos"
    }
  ], telemetry);

  assert.equal(results[0].resolved_connector_id, "github");
  assert.equal(results[0].provisioning_status, "existing");
  assert.equal(results[0].effective_search_mode, "connector_search");
  assert.ok(telemetry.events.some((item) => item.type === "reused" || item.type === "existing"));
});
