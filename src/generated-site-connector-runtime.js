const crypto = require("crypto");

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function stripTags(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildQueryTokens(query) {
  const raw = String(query || "").toLowerCase();
  const english = raw.match(/[a-z0-9][a-z0-9._-]{1,}/g) || [];
  const chinese = raw.match(/[\u4e00-\u9fff]{2,8}/g) || [];
  return Array.from(new Set([...english, ...chinese])).slice(0, 20);
}

function makeId(prefix, value) {
  return `${prefix}:${crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12)}`;
}

function toReaderUrl(url) {
  const normalized = String(url || "").trim().replace(/^https?:\/\//i, "");
  return `https://r.jina.ai/http://${normalized}`;
}

function extractReaderMarkdown(value) {
  const marker = "Markdown Content:";
  const text = String(value || "");
  const index = text.indexOf(marker);
  const raw = index >= 0 ? text.slice(index + marker.length).trim() : text;
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .filter((line) => !/^\*\s+\[/.test(line.trim()))
    .filter((line) => !/^!\[/.test(line.trim()))
    .join("\n")
    .trim();
}

function buildKeyPoints(markdown) {
  return String(markdown || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line.length >= 24)
    .slice(0, 6);
}

async function fetchText(url, options = {}) {
  const { timeoutMs = 12000, headers = {}, retries = 0 } = options;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 OpenSearchGeneratedConnector/1.0",
          ...headers
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 160)}`);
      }
      return text;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function buildSearchUrl(searchConfig, query) {
  if (!searchConfig?.url_template) {
    throw new Error("Missing generated site search url template");
  }
  return String(searchConfig.url_template).replace("{query}", encodeURIComponent(String(query || "").trim()));
}

function normalizeAbsoluteUrl(rawUrl, baseUrl) {
  const href = String(rawUrl || "").trim();
  if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") || href === "#") {
    return "";
  }
  try {
    return new URL(href, baseUrl).toString();
  } catch (error) {
    return "";
  }
}

function extractSearchCandidatesFromHtml(html, options = {}) {
  const {
    query = "",
    connectorId,
    domain,
    siteName,
    searchUrl,
    authorityScore = 0.8,
    contentType = "web",
    sourceType = "web"
  } = options;
  const normalizedDomain = normalizeSiteDomain(domain);
  const queryTokens = buildQueryTokens(query);
  const candidates = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{1,500}?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(String(html || ""))) !== null && candidates.length < 12) {
    const url = normalizeAbsoluteUrl(match[1], searchUrl || `https://${normalizedDomain}/`);
    if (!url) {
      continue;
    }
    const host = normalizeSiteDomain(url);
    if (!host || !(host === normalizedDomain || host.endsWith(`.${normalizedDomain}`))) {
      continue;
    }
    if (url === searchUrl || /\/search([/?#]|$)/i.test(url) || /[?&](q|query|keyword|search|s)=/i.test(url)) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    const title = stripTags(match[2]);
    if (!title || title.length < 4) {
      continue;
    }
    const blob = `${title} ${url}`.toLowerCase();
    const hits = queryTokens.filter((token) => blob.includes(token)).length;
    if (queryTokens.length && hits === 0) {
      continue;
    }
    seen.add(url);
    candidates.push({
      id: makeId("generated_site", url),
      connector: connectorId,
      title,
      url,
      platform: siteName || normalizedDomain,
      content_type: contentType,
      source_type: sourceType,
      author: siteName || normalizedDomain,
      published_at: null,
      authority_score: authorityScore,
      summary: `${siteName || normalizedDomain} search result for ${query}`,
      matched_query: query,
      score: Number((0.62 + Math.min(0.26, hits * 0.08)).toFixed(4)),
      metadata: {
        generated_connector: true,
        search_url: searchUrl,
        query_hits: hits,
        preferred_domain_match: true
      }
    });
  }
  return candidates;
}

async function searchGeneratedSiteConnector(query, record) {
  if (!record?.supports_search || !record?.search_config) {
    throw new Error(`Generated connector does not support search: ${record?.id || "unknown"}`);
  }
  const searchUrl = buildSearchUrl(record.search_config, query);
  const html = await fetchText(searchUrl, { timeoutMs: 12000, retries: 0 });
  return extractSearchCandidatesFromHtml(html, {
    query,
    connectorId: record.id,
    domain: record.domain,
    siteName: record.label,
    searchUrl,
    authorityScore: 0.82
  });
}

async function readGeneratedSiteConnector(candidate, record = {}) {
  const targetUrl = String(candidate?.url || `https://${record?.domain || ""}`).trim();
  if (!targetUrl) {
    throw new Error("Generated site read requires candidate.url");
  }

  let markdown = "";
  try {
    markdown = extractReaderMarkdown(await fetchText(toReaderUrl(targetUrl), { timeoutMs: 15000, retries: 0 }));
  } catch (error) {
    const html = await fetchText(targetUrl, { timeoutMs: 12000, retries: 0 });
    markdown = stripTags(html);
  }

  return {
    source_id: candidate?.id || makeId("generated_read", targetUrl),
    content_type: candidate?.content_type || candidate?.source_type || "web",
    source_type: candidate?.source_type || candidate?.content_type || "web",
    tool: record?.tool_ids?.read || record?.tool_id || `generated_read_${record?.id || "site"}`,
    title: candidate?.title || record?.label || record?.domain || targetUrl,
    url: targetUrl,
    author: candidate?.author || record?.label || record?.domain || null,
    published_at: candidate?.published_at || null,
    markdown,
    key_points: buildKeyPoints(markdown),
    sections: [],
    facts: []
  };
}

module.exports = {
  normalizeSiteDomain,
  stripTags,
  fetchText,
  buildSearchUrl,
  extractSearchCandidatesFromHtml,
  searchGeneratedSiteConnector,
  readGeneratedSiteConnector
};
