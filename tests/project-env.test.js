const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { initializeProjectEnv, __internal } = require("../src/project-env");

test.afterEach(() => {
  __internal.resetProjectEnvForTests();
});

test("initializeProjectEnv loads OpenAI key from .env.local and derives models from Codex config", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opensearch-env-"));
  const codexDir = path.join(tempRoot, ".codex");

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, ".env.local"), [
    "OPENAI_API_KEY=test-key",
    "",
    "# comment"
  ].join("\n"));
  fs.writeFileSync(path.join(codexDir, "config.toml"), [
    'model_provider = "crs"',
    'model = "gpt-5.4"',
    '',
    '[model_providers.crs]',
    'base_url = "https://apikey.soxio.me/openai"',
    'wire_api = "responses"'
  ].join("\n"));

  const summary = initializeProjectEnv({
    force: true,
    projectRoot: tempRoot,
    codexConfigPath: path.join(codexDir, "config.toml")
  });

  assert.equal(process.env.OPENAI_API_KEY, "test-key");
  assert.equal(process.env.OPENAI_RESPONSES_URL, "https://apikey.soxio.me/openai/v1/responses");
  assert.equal(process.env.OPENAI_PLANNER_MODEL, "gpt-5.4");
  assert.equal(process.env.OPENAI_SYNTHESIS_MODEL, "gpt-5.4");
  assert.equal(process.env.OPENAI_EVALUATOR_MODEL, "gpt-5.4");
  assert.equal(summary.openai_api_key_configured, true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("initializeProjectEnv keeps explicit environment values over inferred defaults", () => {
  process.env.OPENAI_RESPONSES_URL = "https://custom.example/v1/responses";
  process.env.OPENAI_PLANNER_MODEL = "manual-model";

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opensearch-env-"));
  const codexDir = path.join(tempRoot, ".codex");

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), [
    'model_provider = "crs"',
    'model = "gpt-5.4"',
    '',
    '[model_providers.crs]',
    'base_url = "https://apikey.soxio.me/openai"',
    'wire_api = "responses"'
  ].join("\n"));

  initializeProjectEnv({
    force: true,
    projectRoot: tempRoot,
    codexConfigPath: path.join(codexDir, "config.toml")
  });

  assert.equal(process.env.OPENAI_RESPONSES_URL, "https://custom.example/v1/responses");
  assert.equal(process.env.OPENAI_PLANNER_MODEL, "manual-model");
  assert.equal(process.env.OPENAI_SYNTHESIS_MODEL, "gpt-5.4");

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
