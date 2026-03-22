const {
  requestToolCreation,
  appendAuditEvent
} = require("./tool-platform");
const {
  findConnectorByDomain,
  registerGeneratedSiteConnector,
  getConnectorById,
  __internal: sourceInternal
} = require("./source-connectors");
const {
  normalizeSiteDomain,
  buildGeneratedConnectorId,
  buildGeneratedConnectorLabel,
  normalizeGeneratedConnectorRecord,
  upsertGeneratedConnectorRecord
} = require("./generated-site-connectors-store");
const {
  fetchText,
  searchGeneratedSiteConnector,
  readGeneratedSiteConnector
} = require("./generated-site-connector-runtime");

function recordProvisioningEvent(telemetry, type, payload = {}) {
  telemetry.events = telemetry.events || [];
  telemetry.events.push({
    stage: "site_connector_provisioning",
    type,
    at: new Date().toISOString(),
    ...payload
  });
  appendAuditEvent(`site_connector_${type}`, payload);
}

function buildVerificationQuery(siteName, domain) {
  const normalizedDomain = normalizeSiteDomain(domain);
  const root = normalizedDomain.split(".")[0] || normalizedDomain;
  const trimmedSiteName = String(siteName || "").trim();
  return trimmedSiteName || root || normalizedDomain;
}

function buildHomepageUrl(domain) {
  return `https://${normalizeSiteDomain(domain)}`;
}

function parseSearchForms(html, domain) {
  const baseUrl = buildHomepageUrl(domain);
  const forms = [];
  const formPattern = /<form\b([^>]*)>([\s\S]{0,4000}?)<\/form>/gi;
  let match;
  while ((match = formPattern.exec(String(html || ""))) !== null) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    if (!/search|query|keyword|role\s*=\s*["']search["']/i.test(`${attrs} ${body}`)) {
      continue;
    }
    const actionMatch = attrs.match(/action\s*=\s*["']([^"']+)["']/i);
    const inputMatch = body.match(/<input\b[^>]*name\s*=\s*["'](q|query|keyword|search|s|term|wd|k)["'][^>]*>/i);
    if (!inputMatch) {
      continue;
    }
    const actionValue = actionMatch ? actionMatch[1] : "/search";
    let actionUrl;
    try {
      actionUrl = new URL(actionValue, baseUrl).toString();
    } catch (error) {
      continue;
    }
    forms.push({
      type: "url_template",
      detected_from: "search_form",
      query_parameter: inputMatch[1],
      url_template: `${actionUrl}${actionUrl.includes("?") ? "&" : "?"}${inputMatch[1]}={query}`
    });
  }
  return forms;
}

function buildCommonSearchConfigs(domain) {
  const baseUrl = buildHomepageUrl(domain);
  return [
    { type: "url_template", detected_from: "common_path", query_parameter: "q", url_template: `${baseUrl}/search?q={query}` },
    { type: "url_template", detected_from: "common_path", query_parameter: "query", url_template: `${baseUrl}/search?query={query}` },
    { type: "url_template", detected_from: "common_path", query_parameter: "keyword", url_template: `${baseUrl}/search?keyword={query}` },
    { type: "url_template", detected_from: "common_path", query_parameter: "s", url_template: `${baseUrl}/?s={query}` },
    { type: "url_template", detected_from: "common_path", query_parameter: "q", url_template: `${baseUrl}/search/?q={query}` },
    { type: "url_template", detected_from: "common_path", query_parameter: "q", url_template: `${baseUrl}/search.html?q={query}` }
  ];
}

async function detectSearchConfig(domain, siteName, queryVariants = []) {
  const normalizedDomain = normalizeSiteDomain(domain);
  if (!normalizedDomain) {
    return null;
  }
  let homepage = "";
  try {
    homepage = await fetchText(buildHomepageUrl(normalizedDomain), { timeoutMs: 8000, retries: 0 });
  } catch (_) {
    homepage = "";
  }
  const probeQuery = String(queryVariants[0] || buildVerificationQuery(siteName, normalizedDomain)).trim();
  const candidates = [
    ...parseSearchForms(homepage, normalizedDomain),
    ...buildCommonSearchConfigs(normalizedDomain)
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate?.url_template || seen.has(candidate.url_template)) {
      continue;
    }
    seen.add(candidate.url_template);
    try {
      const results = await searchGeneratedSiteConnector(probeQuery, {
        id: buildGeneratedConnectorId(normalizedDomain),
        label: buildGeneratedConnectorLabel(normalizedDomain),
        domain: normalizedDomain,
        supports_search: true,
        search_config: candidate
      });
      if (results.length > 0) {
        return candidate;
      }
    } catch (_) {
    }
  }
  return null;
}

function buildReadToolSpec(record) {
  const toolId = `generated_read_${record.id}`;
  return {
    tool_id: toolId,
    id: toolId,
    base_tool_id: toolId,
    name: `${record.label} Read`,
    description: `Read public pages from ${record.domain}.`,
    runtime: "node",
    source: "dynamic",
    lifecycle_state: "registered",
    site_scope: record.domain,
    goal: `Read public content from ${record.domain}`,
    parameters: [{ name: "candidate", type: "object", required: true, description: "Candidate to read" }],
    output_schema: {
      type: "object",
      kind: "normalized_read",
      required: ["source_id", "title", "content_type"]
    },
    implementation: async ({ candidate }) => readGeneratedSiteConnector(candidate, {
      ...record,
      tool_ids: { ...(record.tool_ids || {}), read: toolId }
    })
  };
}

function buildSearchToolSpec(record) {
  const toolId = `generated_search_${record.id}`;
  return {
    tool_id: toolId,
    id: toolId,
    base_tool_id: toolId,
    name: `${record.label} Search`,
    description: `Search ${record.domain} with a generated in-site search connector.`,
    runtime: "node",
    source: "dynamic",
    lifecycle_state: "registered",
    site_scope: record.domain,
    goal: `Search ${record.domain}`,
    parameters: [{ name: "query", type: "string", required: true, description: "Query to search" }],
    output_schema: {
      type: "object",
      kind: "tool_result",
      required: ["results"]
    },
    implementation: async ({ query }) => ({
      results: await searchGeneratedSiteConnector(query, {
        ...record,
        tool_ids: { ...(record.tool_ids || {}), search: toolId }
      })
    })
  };
}

async function validateGeneratedConnector(record, siteName, queryVariants = []) {
  const verificationQuery = String(queryVariants[0] || buildVerificationQuery(siteName, record.domain)).trim();
  const homepageCandidate = {
    id: `generated_homepage:${record.domain}`,
    title: siteName || record.label || record.domain,
    url: buildHomepageUrl(record.domain),
    content_type: "web",
    source_type: "web",
    connector: record.id,
    author: siteName || record.domain
  };

  let readValidation;
  try {
    const read = await readGeneratedSiteConnector(homepageCandidate, record);
    readValidation = {
      success: String(read.markdown || "").trim().length >= 40,
      sample_length: String(read.markdown || "").trim().length,
      verified_at: new Date().toISOString()
    };
  } catch (error) {
    readValidation = {
      success: false,
      error: error.message,
      verified_at: new Date().toISOString()
    };
  }

  let searchValidation = null;
  if (record.supports_search && record.search_config) {
    try {
      const results = await searchGeneratedSiteConnector(verificationQuery, record);
      searchValidation = {
        success: results.length > 0,
        result_count: results.length,
        verified_at: new Date().toISOString()
      };
    } catch (error) {
      searchValidation = {
        success: false,
        error: error.message,
        verified_at: new Date().toISOString()
      };
    }
  }

  return {
    read: readValidation,
    search: searchValidation,
    success: readValidation.success === true
  };
}

async function provisionConnectorForStrategy(strategy, telemetry = { events: [] }) {
  const normalizedDomain = normalizeSiteDomain(strategy?.domain || "");
  if (!normalizedDomain) {
    return {
      ...strategy,
      domain: "",
      provisioning_status: "skipped",
      effective_search_mode: strategy?.search_mode || "connector_search",
      resolved_connector_id: strategy?.connector_id || null
    };
  }

  const matchingConnector = findConnectorByDomain(normalizedDomain);
  if (matchingConnector) {
    recordProvisioningEvent(telemetry, "reused", {
      domain: normalizedDomain,
      connector_id: matchingConnector.id,
      generated: matchingConnector.generated === true
    });
    return {
      ...strategy,
      domain: normalizedDomain,
      resolved_connector_id: matchingConnector.id,
      provisioning_status: matchingConnector.generated === true ? "reused" : "existing",
      effective_search_mode: strategy.search_mode || "connector_search"
    };
  }

  if (strategy?.connector_id) {
    const hintedConnector = getConnectorById(strategy.connector_id);
    if (hintedConnector && sourceInternal.connectorSupportsDomain(hintedConnector, normalizedDomain)) {
      recordProvisioningEvent(telemetry, "existing", {
        domain: normalizedDomain,
        connector_id: hintedConnector.id,
        generated: hintedConnector.generated === true
      });
      return {
        ...strategy,
        domain: normalizedDomain,
        resolved_connector_id: hintedConnector.id,
        provisioning_status: "existing",
        effective_search_mode: strategy.search_mode || "connector_search"
      };
    }
  }

  const generatedId = buildGeneratedConnectorId(normalizedDomain);
  const label = buildGeneratedConnectorLabel(normalizedDomain);
  const searchConfig = await detectSearchConfig(normalizedDomain, strategy.site_name, strategy.query_variants || []);
  const draftRecord = normalizeGeneratedConnectorRecord({
    id: generatedId,
    label,
    domain: normalizedDomain,
    domains: [normalizedDomain],
    description: `Generated connector for ${normalizedDomain}.`,
    capabilities: searchConfig
      ? ["search", "content extraction", "site-specific"]
      : ["content extraction", "site-specific"],
    generated: true,
    supports_search: Boolean(searchConfig),
    supports_read: true,
    status: "active",
    search_config: searchConfig,
    tool_ids: {
      read: `generated_read_${generatedId}`,
      search: searchConfig ? `generated_search_${generatedId}` : null
    }
  });

  try {
    const toolSpecs = [buildReadToolSpec(draftRecord)];
    if (searchConfig) {
      toolSpecs.push(buildSearchToolSpec(draftRecord));
    }
    const created = await requestToolCreation({
      requester: "llm_orchestrator",
      metadata: {
        request_type: "site_connector_generation",
        connector_id: generatedId,
        domain: normalizedDomain
      },
      tool_specs: toolSpecs
    });
    const toolMap = new Map((created.tools || []).map((item) => [item.base_tool_id || item.tool_id || item.id, item]));
    const validation = await validateGeneratedConnector(draftRecord, strategy.site_name, strategy.query_variants || []);
    if (!validation.read?.success) {
      throw new Error(validation.read?.error || `Generated read validation failed for ${normalizedDomain}`);
    }
    const finalRecord = normalizeGeneratedConnectorRecord({
      ...draftRecord,
      supports_search: validation.search?.success === true,
      capabilities: validation.search?.success === true
        ? draftRecord.capabilities
        : draftRecord.capabilities.filter((item) => item !== "search"),
      tool_id: toolMap.get(draftRecord.tool_ids.read)?.tool_id || draftRecord.tool_ids.read,
      tool_ids: {
        read: toolMap.get(draftRecord.tool_ids.read)?.tool_id || draftRecord.tool_ids.read,
        search: validation.search?.success === true
          ? (toolMap.get(draftRecord.tool_ids.search)?.tool_id || draftRecord.tool_ids.search)
          : null
      },
      last_verification: validation,
      last_verified_at: validation.search?.verified_at || validation.read?.verified_at || new Date().toISOString()
    });
    registerGeneratedSiteConnector(finalRecord);
    upsertGeneratedConnectorRecord(finalRecord);
    const effectiveSearchMode = finalRecord.supports_search
      ? (strategy.search_mode || "connector_search")
      : ((strategy.search_mode || "connector_search") === "verify_only"
          ? "verify_only"
          : "site_query_with_generated_read");
    recordProvisioningEvent(telemetry, finalRecord.supports_search ? "generated" : "generated_read_only", {
      domain: normalizedDomain,
      connector_id: finalRecord.id,
      tool_ids: finalRecord.tool_ids,
      effective_search_mode: effectiveSearchMode
    });
    return {
      ...strategy,
      domain: normalizedDomain,
      resolved_connector_id: finalRecord.id,
      provisioning_status: finalRecord.supports_search ? "generated" : "generated_read_only",
      effective_search_mode: effectiveSearchMode
    };
  } catch (error) {
    recordProvisioningEvent(telemetry, "failed", {
      domain: normalizedDomain,
      connector_id: generatedId,
      reason: error.message,
      fallback: "bing_web_site_query"
    });
    return {
      ...strategy,
      domain: normalizedDomain,
      resolved_connector_id: null,
      provisioning_status: "failed",
      effective_search_mode: strategy.search_mode === "verify_only" ? "verify_only" : "site_query"
    };
  }
}

async function provisionSiteConnectorsForStrategies(strategies, telemetry = { events: [] }) {
  const items = Array.isArray(strategies) ? strategies : [];
  const results = [];
  for (const strategy of items) {
    results.push(await provisionConnectorForStrategy(strategy, telemetry));
  }
  return results;
}

module.exports = {
  provisionSiteConnectorsForStrategies,
  __internal: {
    parseSearchForms,
    buildCommonSearchConfigs,
    detectSearchConfig,
    validateGeneratedConnector,
    provisionConnectorForStrategy
  }
};
