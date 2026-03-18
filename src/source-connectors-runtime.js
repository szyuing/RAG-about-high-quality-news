function dedupeCandidates(candidates) {
  const map = new Map();
  for (const candidate of candidates) {
    const key = candidate.url;
    const current = map.get(key);
    if (!current || candidate.score > current.score) {
      map.set(key, candidate);
    }
  }
  return Array.from(map.values());
}

function hostFromUrl(value) {
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

function normalizeDomainList(items) {
  return Array.from(new Set((items || []).map((item) => hostFromUrl(item)).filter(Boolean)));
}

function matchesPreferredDomain(candidate, preferredDomains) {
  if (!preferredDomains.length) {
    return false;
  }
  const hostname = hostFromUrl(candidate?.url || candidate?.metadata?.resolved_url || "");
  if (!hostname) {
    return false;
  }
  return preferredDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function createConnectorRuntime(config = {}) {
  const {
    connectorRegistry = [],
    buildQueryTokens,
    normalizeWhitespace,
    normalizeCandidateMediaMetadata
  } = config;

  if (typeof buildQueryTokens !== "function") {
    throw new Error("createConnectorRuntime requires buildQueryTokens");
  }
  if (typeof normalizeWhitespace !== "function") {
    throw new Error("createConnectorRuntime requires normalizeWhitespace");
  }
  if (typeof normalizeCandidateMediaMetadata !== "function") {
    throw new Error("createConnectorRuntime requires normalizeCandidateMediaMetadata");
  }

  const connectorMap = new Map(connectorRegistry.map((item) => [item.id, item]));
  const sourceCatalog = connectorRegistry.map(({ search, read, ...item }) => item);

  function resolveDiscoverConnectors(connectorIds) {
    const ids = Array.isArray(connectorIds) ? connectorIds.filter(Boolean) : [];
    if (!ids.length) {
      return connectorRegistry;
    }
    const idSet = new Set(ids);
    return connectorRegistry.filter((connector) => idSet.has(connector.id));
  }

  async function invokeSourceTool(input) {
    const action = input?.action || "discover";

    if (action === "discover") {
      const query = String(input?.query || "").trim();
      const discoverConnectors = resolveDiscoverConnectors(input?.connector_ids);
      const preferredDomains = normalizeDomainList(input?.preferred_domains);
      const settled = await Promise.allSettled(discoverConnectors.map((connector) => connector.search(query)));

      const queryTokens = buildQueryTokens(query);
      const results = settled.flatMap((item) => (item.status === "fulfilled" ? item.value : []))
        .map((candidate) => {
          const blob = normalizeWhitespace(`${candidate.title} ${candidate.summary} ${candidate.url}`).toLowerCase();
          const hits = queryTokens.filter((token) => blob.includes(token)).length;
          const relevanceBoost = queryTokens.length ? hits / queryTokens.length : 0.2;
          const preferredDomainMatch = matchesPreferredDomain(candidate, preferredDomains);
          const preferredDomainBoost = preferredDomainMatch ? 0.18 : 0;
          return normalizeCandidateMediaMetadata({
            ...candidate,
            score: Number((candidate.score + relevanceBoost * 0.35 + preferredDomainBoost).toFixed(4)),
            metadata: {
              ...(candidate.metadata || {}),
              query_hits: hits,
              preferred_domain_match: preferredDomainMatch
            }
          });
        })
        .filter((candidate) => {
          if (!queryTokens.length) {
            return true;
          }
          return candidate.metadata.query_hits >= 1;
        });

      return dedupeCandidates(results).sort((left, right) => right.score - left.score);
    }

    if (action === "read") {
      const candidate = input?.candidate;
      const connector = connectorMap.get(candidate?.connector);
      if (!connector?.read) {
        throw new Error(`Unsupported connector: ${candidate?.connector}`);
      }
      return connector.read(candidate);
    }

    throw new Error(`Unsupported source tool action: ${action}`);
  }

  async function searchRealSources(query) {
    return invokeSourceTool({ action: "discover", query });
  }

  async function readCandidate(candidate) {
    return invokeSourceTool({ action: "read", candidate });
  }

  return {
    connectorRegistry,
    connectorMap,
    sourceCatalog,
    resolveDiscoverConnectors,
    invokeSourceTool,
    searchRealSources,
    readCandidate
  };
}

module.exports = {
  createConnectorRuntime
};
