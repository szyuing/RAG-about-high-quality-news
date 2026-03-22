const fs = require("fs");
const { resolveDataFile } = require("./data-paths");

const GENERATED_SITE_CONNECTORS_SCHEMA_VERSION = "generated-site-connectors.v1";

function getGeneratedSiteConnectorsPath() {
  return resolveDataFile("generated-site-connectors.json", "OPENSEARCH_GENERATED_CONNECTORS_PATH");
}

function normalizeSiteDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const url = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch (error) {
    const match = raw.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
    return match ? match[1].toLowerCase().replace(/^www\./, "") : "";
  }
}

function buildGeneratedConnectorId(domain) {
  const normalized = normalizeSiteDomain(domain);
  if (!normalized) {
    return "generated_site_connector";
  }
  return `site_${normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function buildGeneratedConnectorLabel(domain) {
  const normalized = normalizeSiteDomain(domain);
  if (!normalized) {
    return "Generated Site Connector";
  }
  return `${normalized} (Generated)`;
}

function normalizeGeneratedConnectorRecord(record = {}) {
  const domain = normalizeSiteDomain(record.domain || (Array.isArray(record.domains) ? record.domains[0] : ""));
  const domains = Array.from(new Set([
    domain,
    ...((record.domains || []).map((item) => normalizeSiteDomain(item)))
  ].filter(Boolean)));
  const supportsSearch = record.supports_search === true;
  const supportsRead = record.supports_read !== false;
  const capabilities = Array.from(new Set([
    ...(Array.isArray(record.capabilities) ? record.capabilities : []),
    ...(supportsSearch ? ["search"] : []),
    ...(supportsRead ? ["content extraction"] : [])
  ].filter(Boolean)));
  return {
    id: String(record.id || buildGeneratedConnectorId(domain)).trim(),
    label: String(record.label || buildGeneratedConnectorLabel(domain)).trim(),
    domain,
    domains,
    description: String(record.description || `Generated site connector for ${domain || "custom site"}.`).trim(),
    capabilities,
    generated: true,
    supports_search: supportsSearch,
    supports_read: supportsRead,
    tool_id: record.tool_id || record.tool_ids?.read || record.tool_ids?.search || null,
    tool_ids: {
      read: record.tool_ids?.read || null,
      search: record.tool_ids?.search || null
    },
    status: String(record.status || "active").trim(),
    search_config: record.search_config && typeof record.search_config === "object"
      ? { ...record.search_config }
      : null,
    last_verification: record.last_verification && typeof record.last_verification === "object"
      ? JSON.parse(JSON.stringify(record.last_verification))
      : null,
    created_at: record.created_at || new Date().toISOString(),
    updated_at: record.updated_at || new Date().toISOString(),
    last_verified_at: record.last_verified_at || null
  };
}

function readGeneratedConnectorStore(storePath = getGeneratedSiteConnectorsPath()) {
  try {
    const payload = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return {
      schema_version: payload.schema_version || GENERATED_SITE_CONNECTORS_SCHEMA_VERSION,
      connectors: Array.isArray(payload.connectors)
        ? payload.connectors.map((item) => normalizeGeneratedConnectorRecord(item))
        : []
    };
  } catch (_) {
    return {
      schema_version: GENERATED_SITE_CONNECTORS_SCHEMA_VERSION,
      connectors: []
    };
  }
}

function writeGeneratedConnectorStore(store, storePath = getGeneratedSiteConnectorsPath()) {
  const normalized = {
    schema_version: GENERATED_SITE_CONNECTORS_SCHEMA_VERSION,
    connectors: Array.isArray(store?.connectors)
      ? store.connectors.map((item) => normalizeGeneratedConnectorRecord(item))
      : []
  };
  fs.writeFileSync(storePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function upsertGeneratedConnectorRecord(record, options = {}) {
  const storePath = options.storePath || getGeneratedSiteConnectorsPath();
  const store = readGeneratedConnectorStore(storePath);
  const normalized = normalizeGeneratedConnectorRecord(record);
  const index = store.connectors.findIndex((item) => item.id === normalized.id || item.domain === normalized.domain);
  if (index >= 0) {
    store.connectors[index] = normalizeGeneratedConnectorRecord({
      ...store.connectors[index],
      ...normalized,
      created_at: store.connectors[index].created_at || normalized.created_at,
      updated_at: new Date().toISOString()
    });
  } else {
    store.connectors.push(normalizeGeneratedConnectorRecord({
      ...normalized,
      created_at: normalized.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));
  }
  return writeGeneratedConnectorStore(store, storePath);
}

function findGeneratedConnectorRecordByDomain(domain, options = {}) {
  const normalizedDomain = normalizeSiteDomain(domain);
  if (!normalizedDomain) {
    return null;
  }
  const store = readGeneratedConnectorStore(options.storePath || getGeneratedSiteConnectorsPath());
  return store.connectors.find((item) =>
    item.domain === normalizedDomain
    || (item.domains || []).includes(normalizedDomain)
  ) || null;
}

module.exports = {
  GENERATED_SITE_CONNECTORS_SCHEMA_VERSION,
  getGeneratedSiteConnectorsPath,
  normalizeSiteDomain,
  buildGeneratedConnectorId,
  buildGeneratedConnectorLabel,
  normalizeGeneratedConnectorRecord,
  readGeneratedConnectorStore,
  writeGeneratedConnectorStore,
  upsertGeneratedConnectorRecord,
  findGeneratedConnectorRecordByDomain
};
