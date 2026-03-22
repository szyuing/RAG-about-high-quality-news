const fs = require("fs");
const os = require("os");
const path = require("path");

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_RESPONSES_URL",
  "OPENAI_PLANNER_MODEL",
  "OPENAI_SYNTHESIS_MODEL",
  "OPENAI_EVALUATOR_MODEL",
  "OPENAI_DOCUMENT_MODEL",
  "OPENAI_MULTIMODAL_DOCUMENT_MODEL",
  "OPENAI_LAYOUT_MODEL"
];

let initialized = false;

function stripWrappingQuotes(value) {
  const text = String(value || "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseEnvFile(content) {
  const parsed = {};
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    parsed[key] = stripWrappingQuotes(rawValue);
  }
  return parsed;
}

function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  return parseEnvFile(fs.readFileSync(filePath, "utf8"));
}

function parseSimpleToml(content) {
  const result = {};
  let currentSection = null;

  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    const keyValueMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyValueMatch) {
      continue;
    }

    const [, key, rawValue] = keyValueMatch;
    const value = stripWrappingQuotes(rawValue.replace(/\s+#.*$/, ""));
    const qualifiedKey = currentSection ? `${currentSection}.${key}` : key;
    result[qualifiedKey] = value;
  }

  return result;
}

function loadCodexConfig(filePath = path.join(os.homedir(), ".codex", "config.toml")) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  const parsed = parseSimpleToml(fs.readFileSync(filePath, "utf8"));
  const providerId = parsed.model_provider;
  const model = parsed.model;
  const baseUrl = providerId ? parsed[`model_providers.${providerId}.base_url`] : null;
  const wireApi = providerId ? parsed[`model_providers.${providerId}.wire_api`] : null;

  return {
    providerId: providerId || null,
    model: model || null,
    baseUrl: baseUrl || null,
    wireApi: wireApi || null,
    filePath
  };
}

function buildResponsesUrl(baseUrl, wireApi) {
  if (!baseUrl) {
    return null;
  }

  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
  if (wireApi && String(wireApi).toLowerCase() !== "responses") {
    return null;
  }
  if (/\/v1$/i.test(normalizedBaseUrl)) {
    return `${normalizedBaseUrl}/responses`;
  }
  return `${normalizedBaseUrl}/v1/responses`;
}

function applyIfMissing(key, value) {
  if (!value || process.env[key]) {
    return false;
  }
  process.env[key] = value;
  return true;
}

function initializeProjectEnv(options = {}) {
  if (initialized && !options.force) {
    return summarizeEnvState();
  }

  const projectRoot = options.projectRoot || path.join(__dirname, "..");
  const envCandidates = [
    path.join(projectRoot, ".env.local"),
    path.join(projectRoot, ".env")
  ];

  for (const envPath of envCandidates) {
    const loaded = loadEnvFile(envPath);
    for (const [key, value] of Object.entries(loaded)) {
      applyIfMissing(key, value);
    }
  }

  const codexConfig = loadCodexConfig(options.codexConfigPath);
  if (codexConfig) {
    applyIfMissing("OPENAI_RESPONSES_URL", buildResponsesUrl(codexConfig.baseUrl, codexConfig.wireApi));

    for (const key of [
      "OPENAI_PLANNER_MODEL",
      "OPENAI_SYNTHESIS_MODEL",
      "OPENAI_EVALUATOR_MODEL",
      "OPENAI_DOCUMENT_MODEL",
      "OPENAI_MULTIMODAL_DOCUMENT_MODEL",
      "OPENAI_LAYOUT_MODEL"
    ]) {
      applyIfMissing(key, codexConfig.model);
    }
  }

  initialized = true;
  return summarizeEnvState(codexConfig);
}

function summarizeEnvState(codexConfig = null) {
  return {
    openai_api_key_configured: Boolean(process.env.OPENAI_API_KEY),
    responses_url: process.env.OPENAI_RESPONSES_URL || null,
    planner_model: process.env.OPENAI_PLANNER_MODEL || null,
    synthesis_model: process.env.OPENAI_SYNTHESIS_MODEL || null,
    evaluator_model: process.env.OPENAI_EVALUATOR_MODEL || null,
    codex_config: codexConfig
  };
}

function resetProjectEnvForTests() {
  initialized = false;
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

module.exports = {
  initializeProjectEnv,
  __internal: {
    parseEnvFile,
    loadEnvFile,
    parseSimpleToml,
    loadCodexConfig,
    buildResponsesUrl,
    summarizeEnvState,
    resetProjectEnvForTests
  }
};
