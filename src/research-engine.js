const fs = require("fs");
const { samplePrompts, sourceCatalog, ToolRegistry, __internal } = require("./source-connectors");
const { createEvidenceUnit } = require("./evidence-model");
const { extractTextFromResponsePayload } = require("./openai-response");
const { resolveDataFile } = require("./data-paths");
const {
  getRelevantSearchSiteHints,
  inferConnectorIdsFromSiteHints,
  buildSiteSeedQueries
} = require("./site-hints");
const {
  createAgentRuntime,
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentRuntimeSnapshot,
  createAgentRegistry,
  runtimeCapabilities,
  synthesizeTool,
  runEphemeralTool,
  readToolMemory,
  readAuditLog,
  recordToolOutcome
} = require("./runtime");
const {
  AgentSystem,
  routeCandidate,
  collectorToolForCandidate,
  selectCandidates,
  runWebResearcher,
  runSpecialistReads,
  runFactVerifierReview,
  evaluateResearch
} = require("./agent-orchestrator");
const {
  buildEvaluationScorecard,
  buildStopDecisionContext,
  requestStopDecisionFromModel,
  mergeEvaluationWithStopDecision,
  deriveStopOutcome,
  runStopEvaluation,
  buildEmptyEvaluation
} = require("./stop-controller");
const { KnowledgeGraph } = require("./knowledge-graph");

const experiencePath = resolveDataFile("experience-memory.json", "OPENSEARCH_EXPERIENCE_MEMORY_PATH");
const knowledgeGraphPath = resolveDataFile("knowledge-graph.json", "OPENSEARCH_KNOWLEDGE_GRAPH_PATH");
const OPENAI_RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses";
const DEFAULT_PLANNER_MODEL = process.env.OPENAI_PLANNER_MODEL || "gpt-4o-mini";
const DEFAULT_SYNTHESIS_MODEL = process.env.OPENAI_SYNTHESIS_MODEL || DEFAULT_PLANNER_MODEL;
const DEFAULT_MEMORY_MODEL = process.env.OPENAI_MEMORY_MODEL || DEFAULT_PLANNER_MODEL;
const ROUTABLE_AGENT_IDS = ["long_text_collector", "video_parser", "chart_parser", "fact_verifier"];
const ROUTABLE_TOOL_IDS = ["deep_read_page", "extract_video_intel", "read_document_intel"];
const OPENAI_MAX_ATTEMPTS = Math.max(1, Number(process.env.OPENSEARCH_OPENAI_MAX_ATTEMPTS || 2));
const OPENAI_RETRY_BASE_MS = Math.max(100, Number(process.env.OPENSEARCH_OPENAI_RETRY_BASE_MS || 400));

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return Array.from(new Set(normalizeText(value).split(" ").filter((token) => token.length > 1)));
}

function buildIntentTokens(question) {
  return __internal.buildQueryTokens(question);
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    const current = map.get(key);
    if (!current || (item.score || 0) > (current.score || 0)) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

function logRecoverableError(scope, error) {
  const message = error?.message || String(error || "unknown error");
  console.warn(`[${scope}] ${message}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableOpenAIError(error, statusCode = null) {
  const resolvedStatusCode = typeof statusCode === "number"
    ? statusCode
    : Number(error?.statusCode);
  if (Number.isFinite(resolvedStatusCode)) {
    return resolvedStatusCode === 429 || resolvedStatusCode >= 500;
  }
  const message = String(error?.message || "");
  return /timed out|timeout|fetch failed|network|ECONNRESET|ENOTFOUND|EAI_AGAIN|AbortError/i.test(message);
}

async function fetchOpenAIJsonWithRetry(apiKey, body, { timeoutMs = 20000, operation = "openai_request", maxAttempts = OPENAI_MAX_ATTEMPTS } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(body)
      });
      let rawText = "";
      let payload = null;
      if (typeof response.text === "function") {
        rawText = await response.text();
        if (rawText) {
          try {
            payload = JSON.parse(rawText);
          } catch (_) {
            payload = null;
          }
        }
      } else if (typeof response.json === "function") {
        payload = await response.json();
        rawText = payload ? JSON.stringify(payload) : "";
      }
      if (!response.ok) {
        const error = new Error(payload?.error?.message || rawText.trim() || `${operation} failed with HTTP ${response.status}`);
        error.statusCode = response.status;
        if (attempt < maxAttempts && isRetriableOpenAIError(error, response.status)) {
          logRecoverableError(operation, new Error(`attempt ${attempt}/${maxAttempts} failed, retrying: ${error.message}`));
          await wait(OPENAI_RETRY_BASE_MS * attempt);
          continue;
        }
        throw error;
      }
      if (!payload) {
        const error = new Error(`${operation} returned a non-JSON response`);
        error.statusCode = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isRetriableOpenAIError(error)) {
        logRecoverableError(operation, new Error(`attempt ${attempt}/${maxAttempts} failed, retrying: ${error.message}`));
        await wait(OPENAI_RETRY_BASE_MS * attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error(`${operation} failed`);
}

function compactStringList(values, { minLength = 1, limit = 6 } = {}) {
  return Array.from(new Set((values || [])
    .map((item) => String(item || "").trim())
    .filter((item) => item.length >= minLength)))
    .slice(0, limit);
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampNumber(value, { min = 0, max = 1, fallback = 0 } = {}) {
  return Math.min(max, Math.max(min, toFiniteNumber(value, fallback)));
}

function normalizeIsoTimestamp(value, fallback = new Date().toISOString()) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function mergeWeightedAverage(leftValue, leftWeight, rightValue, rightWeight, digits = 2) {
  const totalWeight = Math.max(1, toFiniteNumber(leftWeight, 0) + toFiniteNumber(rightWeight, 0));
  const total = (toFiniteNumber(leftValue, 0) * toFiniteNumber(leftWeight, 0))
    + (toFiniteNumber(rightValue, 0) * toFiniteNumber(rightWeight, 0));
  return Number((total / totalWeight).toFixed(digits));
}

function normalizeConnectorIdList(values, { limit = 4 } = {}) {
  const validIds = new Set(sourceCatalog.map((item) => item.id));
  return compactStringList(values, { minLength: 2, limit: Math.max(limit * 2, 8) })
    .filter((item) => validIds.has(item))
    .slice(0, limit);
}

function collectRankedExperienceValues(entries, selector, { limit = 4, minLength = 2 } = {}) {
  const scores = new Map();
  for (const entry of entries || []) {
    const entryWeight = (entry.relevance || 0)
      + clampNumber(entry.metrics?.quality_score, { min: 0, max: 1, fallback: 0 })
      + Math.min(2, toFiniteNumber(entry.run_count, 1) * 0.25);
    for (const value of selector(entry) || []) {
      const normalized = String(value || "").trim();
      if (normalized.length < minLength) {
        continue;
      }
      scores.set(normalized, (scores.get(normalized) || 0) + entryWeight);
    }
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([value]) => value)
    .slice(0, limit);
}

function uniqueObjectList(items, getKey, limit = 6) {
  const map = new Map();
  for (const item of items || []) {
    if (!item) {
      continue;
    }
    const key = getKey(item);
    if (!key || map.has(key)) {
      continue;
    }
    map.set(key, item);
  }
  return [...map.values()].slice(0, limit);
}

function normalizeExperienceEntry(entry = {}) {
  const createdAt = normalizeIsoTimestamp(entry.created_at);
  const lastSeenAt = normalizeIsoTimestamp(entry.last_seen_at || createdAt, createdAt);
  const runCount = Math.max(1, Math.round(toFiniteNumber(entry.run_count, 1)));
  const successCount = Math.min(
    runCount,
    Math.max(
      0,
      Math.round(
        toFiniteNumber(
          entry.success_count,
          entry.metrics?.sufficiency || entry.is_sufficient ? 1 : 0
        )
      )
    )
  );
  const promotedSites = compactStringList([
    ...(entry.learned_patterns?.promoted_sites || []),
    ...((entry.ephemeral_tool_insights?.promote_candidates || []).map((item) => item.site))
  ], { minLength: 3, limit: 4 });

  return {
    ...entry,
    created_at: createdAt,
    last_seen_at: lastSeenAt,
    question: String(entry.question || "").trim(),
    question_key: normalizeText(entry.question_key || entry.question),
    pinned: Boolean(entry.pinned),
    pinned_at: entry.pinned ? normalizeIsoTimestamp(entry.pinned_at || entry.last_seen_at || createdAt, createdAt) : null,
    pin_note: String(entry.pin_note || "").trim(),
    run_count: runCount,
    success_count: successCount,
    useful_queries: compactStringList(entry.useful_queries, { minLength: 2, limit: 6 }),
    useful_source_types: compactStringList(entry.useful_source_types, { minLength: 2, limit: 6 }),
    useful_platforms: compactStringList(entry.useful_platforms, { minLength: 2, limit: 6 }),
    effective_search_terms: compactStringList(entry.effective_search_terms, { minLength: 2, limit: 6 }),
    primary_source_sites: compactStringList(entry.primary_source_sites, { minLength: 2, limit: 6 }),
    efficient_tool_combinations: compactStringList(entry.efficient_tool_combinations, { minLength: 2, limit: 6 }),
    learned_patterns: {
      boosted_connector_ids: normalizeConnectorIdList([
        ...(entry.learned_patterns?.boosted_connector_ids || []),
        ...(entry.preferred_connector_ids || [])
      ]),
      avoided_connector_ids: normalizeConnectorIdList([
        ...(entry.learned_patterns?.avoided_connector_ids || []),
        ...(entry.failed_connector_ids || [])
      ]),
      follow_up_queries: compactStringList(entry.learned_patterns?.follow_up_queries, { minLength: 2, limit: 4 }),
      promoted_sites: promotedSites
    },
    ephemeral_tool_insights: {
      attempts: Math.max(0, Math.round(toFiniteNumber(entry.ephemeral_tool_insights?.attempts, 0))),
      recovered_sources: compactStringList(entry.ephemeral_tool_insights?.recovered_sources, { minLength: 4, limit: 6 }),
      promote_candidates: (entry.ephemeral_tool_insights?.promote_candidates || [])
        .filter((item) => item && item.site && item.strategy)
        .slice(0, 4)
    },
    llm_memory: {
      model: entry.llm_memory?.model || null,
      mode: entry.llm_memory?.mode || null,
      fallback_reason: String(entry.llm_memory?.fallback_reason || "").trim(),
      reusable_insights: compactStringList(entry.llm_memory?.reusable_insights, { minLength: 4, limit: 5 }),
      retrieval_tags: compactStringList(entry.llm_memory?.retrieval_tags, { minLength: 2, limit: 6 }),
      merge_target_question_key: normalizeText(entry.llm_memory?.merge_target_question_key || ""),
      merge_rationale: String(entry.llm_memory?.merge_rationale || "").trim()
    },
    noisy_paths: compactStringList(entry.noisy_paths, { minLength: 3, limit: 6 }),
    metrics: {
      quality_score: clampNumber(entry.metrics?.quality_score ?? entry.quality_score, { min: 0, max: 1, fallback: 0 }),
      confidence: clampNumber(entry.metrics?.confidence ?? entry.confidence, { min: 0, max: 1, fallback: 0 }),
      sufficiency: Boolean(entry.metrics?.sufficiency ?? entry.is_sufficient),
      rounds_completed: Math.max(0, Math.round(toFiniteNumber(entry.metrics?.rounds_completed, 0))),
      sources_read: Math.max(0, Math.round(toFiniteNumber(entry.metrics?.sources_read, 0))),
      evidence_items: Math.max(0, Math.round(toFiniteNumber(entry.metrics?.evidence_items, 0))),
      confirmations: Math.max(0, Math.round(toFiniteNumber(entry.metrics?.confirmations, 0))),
      conflicts: Math.max(0, Math.round(toFiniteNumber(entry.metrics?.conflicts, 0))),
      coverage_gaps: Math.max(0, Math.round(toFiniteNumber(entry.metrics?.coverage_gaps, 0))),
      successful_ephemeral_tools: Math.max(0, Math.round(toFiniteNumber(entry.metrics?.successful_ephemeral_tools, 0))),
      failed_ephemeral_tools: Math.max(0, Math.round(toFiniteNumber(entry.metrics?.failed_ephemeral_tools, 0)))
    },
    note: String(entry.note || "").trim()
  };
}

function mergeExperienceEntries(currentEntry, incomingEntry) {
  const current = normalizeExperienceEntry(currentEntry);
  const incoming = normalizeExperienceEntry(incomingEntry);
  const runCount = current.run_count + incoming.run_count;
  const successCount = Math.min(runCount, current.success_count + incoming.success_count);

  return normalizeExperienceEntry({
    ...current,
    ...incoming,
    created_at: new Date(Math.min(Date.parse(current.created_at), Date.parse(incoming.created_at))).toISOString(),
    last_seen_at: new Date(Math.max(Date.parse(current.last_seen_at), Date.parse(incoming.last_seen_at))).toISOString(),
    question: incoming.question || current.question,
    run_count: runCount,
    success_count: successCount,
    useful_queries: [...incoming.useful_queries, ...current.useful_queries],
    useful_source_types: [...incoming.useful_source_types, ...current.useful_source_types],
    useful_platforms: [...incoming.useful_platforms, ...current.useful_platforms],
    effective_search_terms: [...incoming.effective_search_terms, ...current.effective_search_terms],
    primary_source_sites: [...incoming.primary_source_sites, ...current.primary_source_sites],
    efficient_tool_combinations: [...incoming.efficient_tool_combinations, ...current.efficient_tool_combinations],
    learned_patterns: {
      boosted_connector_ids: [...incoming.learned_patterns.boosted_connector_ids, ...current.learned_patterns.boosted_connector_ids],
      avoided_connector_ids: [...incoming.learned_patterns.avoided_connector_ids, ...current.learned_patterns.avoided_connector_ids],
      follow_up_queries: [...incoming.learned_patterns.follow_up_queries, ...current.learned_patterns.follow_up_queries],
      promoted_sites: [...incoming.learned_patterns.promoted_sites, ...current.learned_patterns.promoted_sites]
    },
    ephemeral_tool_insights: {
      attempts: current.ephemeral_tool_insights.attempts + incoming.ephemeral_tool_insights.attempts,
      recovered_sources: [...incoming.ephemeral_tool_insights.recovered_sources, ...current.ephemeral_tool_insights.recovered_sources],
      promote_candidates: [...incoming.ephemeral_tool_insights.promote_candidates, ...current.ephemeral_tool_insights.promote_candidates]
    },
    llm_memory: {
      model: incoming.llm_memory.model || current.llm_memory.model,
      mode: incoming.llm_memory.mode || current.llm_memory.mode,
      fallback_reason: incoming.llm_memory.fallback_reason || current.llm_memory.fallback_reason,
      reusable_insights: [...incoming.llm_memory.reusable_insights, ...current.llm_memory.reusable_insights],
      retrieval_tags: [...incoming.llm_memory.retrieval_tags, ...current.llm_memory.retrieval_tags],
      merge_target_question_key: incoming.llm_memory.merge_target_question_key || current.llm_memory.merge_target_question_key,
      merge_rationale: incoming.llm_memory.merge_rationale || current.llm_memory.merge_rationale
    },
    noisy_paths: [...incoming.noisy_paths, ...current.noisy_paths],
    metrics: {
      quality_score: mergeWeightedAverage(current.metrics.quality_score, current.run_count, incoming.metrics.quality_score, incoming.run_count),
      confidence: mergeWeightedAverage(current.metrics.confidence, current.run_count, incoming.metrics.confidence, incoming.run_count),
      sufficiency: incoming.metrics.sufficiency || current.metrics.sufficiency,
      rounds_completed: Math.max(current.metrics.rounds_completed, incoming.metrics.rounds_completed),
      sources_read: Math.max(current.metrics.sources_read, incoming.metrics.sources_read),
      evidence_items: Math.max(current.metrics.evidence_items, incoming.metrics.evidence_items),
      confirmations: Math.max(current.metrics.confirmations, incoming.metrics.confirmations),
      conflicts: Math.max(current.metrics.conflicts, incoming.metrics.conflicts),
      coverage_gaps: Math.max(current.metrics.coverage_gaps, incoming.metrics.coverage_gaps),
      successful_ephemeral_tools: Math.max(current.metrics.successful_ephemeral_tools, incoming.metrics.successful_ephemeral_tools),
      failed_ephemeral_tools: Math.max(current.metrics.failed_ephemeral_tools, incoming.metrics.failed_ephemeral_tools)
    },
    note: incoming.note || current.note
  });
}

function recordExperienceMemoryEntry(memory, incomingEntry, { limit = 30 } = {}) {
  const normalizedIncoming = normalizeExperienceEntry(incomingEntry);
  const grouped = new Map();

  for (const entry of memory || []) {
    const normalized = normalizeExperienceEntry(entry);
    const key = normalized.question_key || `${normalized.question}:${normalized.created_at}`;
    grouped.set(key, grouped.has(key) ? mergeExperienceEntries(grouped.get(key), normalized) : normalized);
  }

  const incomingKey = normalizedIncoming.question_key || `${normalizedIncoming.question}:${normalizedIncoming.created_at}`;
  grouped.set(
    incomingKey,
    grouped.has(incomingKey)
      ? mergeExperienceEntries(grouped.get(incomingKey), normalizedIncoming)
      : normalizedIncoming
  );

  return [...grouped.values()]
    .sort((left, right) => {
      if (Boolean(left.pinned) !== Boolean(right.pinned)) {
        return left.pinned ? -1 : 1;
      }
      const timeDiff = Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return (right.metrics?.quality_score || 0) - (left.metrics?.quality_score || 0);
    })
    .slice(0, limit);
}

function listExperienceMemory(filters = {}) {
  const query = normalizeText(filters.query || filters.q || "");
  const sourceType = normalizeText(filters.source_type || "");
  const connectorId = String(filters.connector_id || "").trim();
  const site = normalizeText(filters.site || "");
  const pinned = filters.pinned === undefined || filters.pinned === null || filters.pinned === ""
    ? null
    : Boolean(filters.pinned);
  const limit = Math.max(1, Math.min(200, Number(filters.limit || 50)));

  return readExperienceMemory()
    .filter((entry) => {
      if (pinned !== null && Boolean(entry.pinned) !== pinned) {
        return false;
      }
      if (query) {
        const blob = normalizeText([
          entry.question,
          ...(entry.useful_queries || []),
          ...(entry.useful_source_types || []),
          ...(entry.learned_patterns?.boosted_connector_ids || []),
          ...(entry.learned_patterns?.promoted_sites || [])
        ].join(" "));
        if (!blob.includes(query)) {
          return false;
        }
      }
      if (sourceType) {
        const matched = (entry.useful_source_types || []).some((item) => normalizeText(item) === sourceType);
        if (!matched) {
          return false;
        }
      }
      if (connectorId) {
        const matched = (entry.learned_patterns?.boosted_connector_ids || []).includes(connectorId)
          || (entry.learned_patterns?.avoided_connector_ids || []).includes(connectorId);
        if (!matched) {
          return false;
        }
      }
      if (site) {
        const matched = (entry.learned_patterns?.promoted_sites || []).some((item) => normalizeText(item).includes(site));
        if (!matched) {
          return false;
        }
      }
      return true;
    })
    .slice(0, limit);
}

function setExperiencePinned(questionKey, { pinned = true, pinNote = "" } = {}) {
  const normalizedKey = normalizeText(questionKey);
  if (!normalizedKey) {
    return null;
  }

  const memory = readExperienceMemory();
  const index = memory.findIndex((entry) => entry.question_key === normalizedKey);
  if (index === -1) {
    return null;
  }

  const current = normalizeExperienceEntry(memory[index]);
  const updated = normalizeExperienceEntry({
    ...current,
    pinned: Boolean(pinned),
    pinned_at: pinned ? new Date().toISOString() : null,
    pin_note: pinned ? String(pinNote || current.pin_note || "").trim() : ""
  });
  memory[index] = updated;
  writeExperienceMemory(memory);
  return updated;
}

function clearExperienceMemory({ questionKey = "", onlyUnpinned = false } = {}) {
  const normalizedKey = normalizeText(questionKey);
  const memory = readExperienceMemory();
  let next = memory;

  if (normalizedKey) {
    next = memory.filter((entry) => entry.question_key !== normalizedKey);
  } else if (onlyUnpinned) {
    next = memory.filter((entry) => entry.pinned);
  } else {
    next = [];
  }

  writeExperienceMemory(next);
  return {
    removed_count: Math.max(0, memory.length - next.length),
    remaining_count: next.length,
    entries: next
  };
}

function summarizeExperienceMemory(entries = readExperienceMemory()) {
  const normalizedEntries = (entries || []).map((entry) => normalizeExperienceEntry(entry));
  const pinnedCount = normalizedEntries.filter((entry) => entry.pinned).length;
  const successfulRuns = normalizedEntries.reduce((total, entry) => total + (entry.success_count || 0), 0);
  const totalRuns = normalizedEntries.reduce((total, entry) => total + (entry.run_count || 0), 0);

  return {
    schema_version: "experience-overview.v1",
    total_entries: normalizedEntries.length,
    pinned_entries: pinnedCount,
    run_success_rate: totalRuns > 0 ? Number((successfulRuns / totalRuns).toFixed(2)) : 0,
    top_queries: collectRankedExperienceValues(normalizedEntries, (entry) => entry.useful_queries || [], { limit: 5, minLength: 2 }),
    top_source_types: collectRankedExperienceValues(normalizedEntries, (entry) => entry.useful_source_types || [], { limit: 5, minLength: 2 }),
    top_connectors: collectRankedExperienceValues(normalizedEntries, (entry) => entry.learned_patterns?.boosted_connector_ids || [], { limit: 5, minLength: 2 }),
    top_sites: collectRankedExperienceValues(normalizedEntries, (entry) => entry.learned_patterns?.promoted_sites || [], { limit: 5, minLength: 3 }),
    recurring_gaps: collectRankedExperienceValues(normalizedEntries, (entry) => entry.noisy_paths || [], { limit: 5, minLength: 3 }),
    latest_questions: normalizedEntries.slice(0, 5).map((entry) => entry.question)
  };
}

async function requestExperienceMemoryFromModel(question, draftEntry, priorEntries = [], finalAnswer = null, evaluation = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !draftEntry?.question) {
    return null;
  }

  const priorDigest = priorEntries.slice(0, 4).map((entry) => ({
    question: entry.question,
    question_key: entry.question_key,
    relevance: entry.relevance || 0,
    useful_queries: (entry.useful_queries || []).slice(0, 4),
    useful_source_types: (entry.useful_source_types || []).slice(0, 4),
    learned_patterns: entry.learned_patterns || {},
    note: entry.note || "",
    metrics: entry.metrics || {}
  }));

  const finalAnswerDigest = finalAnswer ? {
    quick_answer: finalAnswer.quick_answer,
    conclusion: finalAnswer.deep_research_summary?.conclusion || "",
    uncertainty: finalAnswer.uncertainty || []
  } : null;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      canonical_question: { type: "string" },
      memory_summary: { type: "string" },
      reusable_insights: {
        type: "array",
        maxItems: 5,
        items: { type: "string" }
      },
      retrieval_tags: {
        type: "array",
        maxItems: 6,
        items: { type: "string" }
      },
      useful_queries: {
        type: "array",
        maxItems: 6,
        items: { type: "string" }
      },
      useful_source_types: {
        type: "array",
        maxItems: 6,
        items: { type: "string" }
      },
      boosted_connector_ids: {
        type: "array",
        maxItems: 4,
        items: { type: "string" }
      },
      avoided_connector_ids: {
        type: "array",
        maxItems: 4,
        items: { type: "string" }
      },
      follow_up_queries: {
        type: "array",
        maxItems: 4,
        items: { type: "string" }
      },
      promoted_sites: {
        type: "array",
        maxItems: 4,
        items: { type: "string" }
      },
      noisy_patterns: {
        type: "array",
        maxItems: 4,
        items: { type: "string" }
      },
      merge_target_question_key: { type: "string" },
      merge_rationale: { type: "string" }
    },
    required: [
      "canonical_question",
      "memory_summary",
      "reusable_insights",
      "retrieval_tags",
      "useful_queries",
      "useful_source_types",
      "boosted_connector_ids",
      "avoided_connector_ids",
      "follow_up_queries",
      "promoted_sites",
      "noisy_patterns",
      "merge_target_question_key",
      "merge_rationale"
    ]
  };

  const prompt = [
    "You are the memory curator for a deep research agent.",
    "Your job is to convert one finished research task into reusable memory.",
    "Do four things in one pass: create a concise reusable memory item, organize it, integrate it with similar past memory, and summarize what is worth retrieving later.",
    "Only use the supplied task record and prior memory candidates.",
    "If no prior memory should be merged, leave merge_target_question_key empty.",
    "Prefer canonical, reusable wording over one-off phrasing.",
    "Question:",
    question,
    "",
    "Draft memory:",
    JSON.stringify(draftEntry, null, 2),
    "",
    "Evaluation:",
    JSON.stringify(evaluation || {}, null, 2),
    "",
    "Final answer digest:",
    JSON.stringify(finalAnswerDigest || {}, null, 2),
    "",
    "Prior similar memory candidates:",
    JSON.stringify(priorDigest, null, 2)
  ].join("\n");

  const payload = await fetchOpenAIJsonWithRetry(apiKey, {
    model: DEFAULT_MEMORY_MODEL,
    store: false,
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "experience_memory",
        strict: true,
        schema
      }
    }
  }, {
    timeoutMs: 25000,
    operation: "openai_memory"
  });

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI memory returned no text output");
  }

  return JSON.parse(rawText);
}

function applyExperienceMemoryModelOutput(draftEntry, modelOutput = null, priorEntries = []) {
  if (!modelOutput) {
    return normalizeExperienceEntry({
      ...draftEntry,
      llm_memory: {
        model: null,
        mode: "heuristic",
        reusable_insights: [],
        retrieval_tags: [],
        merge_rationale: ""
      }
    });
  }

  const canonicalQuestion = String(modelOutput.canonical_question || draftEntry.question || "").trim() || draftEntry.question;
  const mergeTargetKey = String(modelOutput.merge_target_question_key || "").trim();
  const matchedPrior = mergeTargetKey
    ? priorEntries.find((entry) => entry.question_key === normalizeText(mergeTargetKey))
    : null;

  return normalizeExperienceEntry({
    ...draftEntry,
    question: canonicalQuestion,
    question_key: matchedPrior?.question_key || normalizeText(canonicalQuestion),
    useful_queries: [
      ...(draftEntry.useful_queries || []),
      ...(modelOutput.useful_queries || [])
    ],
    useful_source_types: [
      ...(draftEntry.useful_source_types || []),
      ...(modelOutput.useful_source_types || [])
    ],
    learned_patterns: {
      ...(draftEntry.learned_patterns || {}),
      boosted_connector_ids: [
        ...(draftEntry.learned_patterns?.boosted_connector_ids || []),
        ...(modelOutput.boosted_connector_ids || [])
      ],
      avoided_connector_ids: [
        ...(draftEntry.learned_patterns?.avoided_connector_ids || []),
        ...(modelOutput.avoided_connector_ids || [])
      ],
      follow_up_queries: [
        ...(draftEntry.learned_patterns?.follow_up_queries || []),
        ...(modelOutput.follow_up_queries || [])
      ],
      promoted_sites: [
        ...(draftEntry.learned_patterns?.promoted_sites || []),
        ...(modelOutput.promoted_sites || [])
      ]
    },
    noisy_paths: [
      ...(draftEntry.noisy_paths || []),
      ...(modelOutput.noisy_patterns || [])
    ],
    note: String(modelOutput.memory_summary || draftEntry.note || "").trim(),
    llm_memory: {
      model: DEFAULT_MEMORY_MODEL,
      mode: "llm",
      reusable_insights: compactStringList(modelOutput.reusable_insights, { minLength: 4, limit: 5 }),
      retrieval_tags: compactStringList(modelOutput.retrieval_tags, { minLength: 2, limit: 6 }),
      merge_target_question_key: matchedPrior?.question_key || normalizeText(mergeTargetKey),
      merge_rationale: String(modelOutput.merge_rationale || "").trim()
    }
  });
}

async function finalizeExperienceMemory(question, scratchpad, plan, evaluation, telemetry, verification, finalAnswer, existingMemory = readExperienceMemory()) {
  const draft = summarizeExperience(question, scratchpad, plan, evaluation, telemetry, verification);
  const priorEntries = [...(existingMemory || [])]
    .map((entry) => ({
      ...normalizeExperienceEntry(entry),
      relevance: scoreExperienceRelevance(question, entry)
    }))
    .filter((entry) => entry.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, 4);

  try {
    const modelOutput = await requestExperienceMemoryFromModel(question, draft, priorEntries, finalAnswer, evaluation);
    return applyExperienceMemoryModelOutput(draft, modelOutput, priorEntries);
  } catch (error) {
    return normalizeExperienceEntry({
      ...draft,
      llm_memory: {
        model: DEFAULT_MEMORY_MODEL,
        mode: "fallback",
        fallback_reason: error.message,
        reusable_insights: [],
        retrieval_tags: [],
        merge_rationale: ""
      }
    });
  }
}

function normalizeModelSelectedCandidateIds(candidateIds, fallbackIds = []) {
  const selected = [];

  for (const id of candidateIds || []) {
    if (!id || selected.includes(id)) {
      continue;
    }
    selected.push(id);
    if (selected.length >= 4) {
      break;
    }
  }

  for (const id of fallbackIds || []) {
    if (!id || selected.includes(id)) {
      continue;
    }
    selected.push(id);
    if (selected.length >= 4) {
      break;
    }
  }

  return selected.slice(0, 4);
}

function normalizeModelAgentId(agentId, fallbackAgent = "long_text_collector") {
  return ROUTABLE_AGENT_IDS.includes(agentId) ? agentId : fallbackAgent;
}

function normalizeModelToolId(toolId, fallbackTool = "deep_read_page") {
  return ROUTABLE_TOOL_IDS.includes(toolId) ? toolId : fallbackTool;
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

function normalizeModelSiteSearchStrategies(strategies, basePlan) {
  const validConnectorIds = new Set((basePlan?.source_capabilities || []).map((item) => item.id));
  const hintedDomains = new Set((basePlan?.search_site_hints?.items || [])
    .map((item) => normalizeSiteDomain(item.domain || item.url))
    .filter(Boolean));
  const allowedModes = new Set(["connector_search", "site_query", "hybrid", "verify_only"]);

  return (strategies || [])
    .map((item) => {
      const domain = normalizeSiteDomain(item?.domain || item?.site_domain || "");
      const connectorId = validConnectorIds.has(item?.connector_id) ? item.connector_id : null;
      const searchMode = allowedModes.has(item?.search_mode)
        ? item.search_mode
        : (domain ? "site_query" : "connector_search");
      const queryVariants = compactStringList(item?.query_variants, { minLength: 2, limit: 4 });
      const siteName = String(item?.site_name || item?.name || domain || "").trim();
      const rationale = String(item?.rationale || item?.reason || "").trim();

      if (!siteName && !domain) {
        return null;
      }
      if (!domain && (searchMode === "site_query" || searchMode === "hybrid")) {
        return null;
      }
      if (domain && hintedDomains.size && !hintedDomains.has(domain)) {
        return null;
      }

      return {
        site_name: siteName,
        domain,
        connector_id: connectorId,
        search_mode: searchMode,
        query_variants: queryVariants,
        rationale
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function readExperienceMemory() {
  try {
    const payload = JSON.parse(fs.readFileSync(experiencePath, "utf8"));
    return Array.isArray(payload) ? payload.map((entry) => normalizeExperienceEntry(entry)) : [];
  } catch (error) {
    logRecoverableError("readExperienceMemory", error);
    return [];
  }
}

function writeExperienceMemory(entries) {
  fs.writeFileSync(
    experiencePath,
    JSON.stringify((entries || []).map((entry) => normalizeExperienceEntry(entry)), null, 2)
  );
}

function readKnowledgeGraph() {
  try {
    const payload = JSON.parse(fs.readFileSync(knowledgeGraphPath, "utf8"));
    return KnowledgeGraph.fromExport(payload);
  } catch (error) {
    logRecoverableError("readKnowledgeGraph", error);
    return null;
  }
}

function writeKnowledgeGraph(graph) {
  fs.writeFileSync(knowledgeGraphPath, JSON.stringify(graph.export(), null, 2));
}

function getSamples() {
  return samplePrompts;
}

function getExperienceMemory() {
  return readExperienceMemory().slice(0, 8);
}

function getToolMemory() {
  return readToolMemory();
}

function getToolAuditLog(limit = 20) {
  return readAuditLog(limit);
}

function getSourceCapabilities() {
  return sourceCatalog;
}

function buildEnglishQueryHints(question) {
  const hints = [];
  if (/sora/i.test(question)) {
    hints.push("OpenAI Sora current update");
    hints.push("OpenAI Sora official");
    hints.push("OpenAI Sora launch difference");
  }
  if (/苹果|iphone|apple/i.test(question)) {
    hints.push("Apple iPhone 16 performance benchmark");
    hints.push("Apple iPhone 16 vs iPhone 15 official");
    hints.push("iPhone 16 performance review");
  }
  if (/为什么|原理|设计|workflow|planner|搜索/i.test(question)) {
    hints.push("planner first search workflow");
    hints.push("evidence based search workflow");
  }
  if (/论文|paper|research|研究/i.test(question)) {
    hints.push("research paper");
  }
  if (/视频|访谈|演讲|发布会|talk|video/i.test(question)) {
    hints.push("video talk interview");
  }
  return hints;
}

function scoreExperienceRelevance(question, entry) {
  const normalizedEntry = normalizeExperienceEntry(entry);
  const questionTokens = tokenize(question);
  const normalizedQuestion = normalizeText(question);
  const blob = normalizeText([
    normalizedEntry.question,
    ...(normalizedEntry.useful_queries || []),
    ...(normalizedEntry.useful_source_types || []),
    ...(normalizedEntry.useful_platforms || []),
    ...(normalizedEntry.effective_search_terms || []),
    ...(normalizedEntry.primary_source_sites || []),
    ...(normalizedEntry.learned_patterns?.boosted_connector_ids || []),
    ...(normalizedEntry.learned_patterns?.promoted_sites || []),
    ...(normalizedEntry.llm_memory?.retrieval_tags || []),
    ...(normalizedEntry.llm_memory?.reusable_insights || [])
  ].join(" "));

  const tokenScore = questionTokens.reduce((score, token) => score + (blob.includes(token) ? 1 : 0), 0);
  const exactMatchBoost = normalizeText(normalizedEntry.question) === normalizedQuestion ? 4 : 0;
  const partialMatchBoost = !exactMatchBoost
    && normalizedQuestion
    && (normalizeText(normalizedEntry.question).includes(normalizedQuestion)
      || normalizedQuestion.includes(normalizeText(normalizedEntry.question)))
    ? 2
    : 0;
  const qualityBoost = clampNumber(normalizedEntry.metrics?.quality_score, { min: 0, max: 1, fallback: 0 }) * 2;
  const successRateBoost = normalizedEntry.run_count > 0
    ? Number(((normalizedEntry.success_count / normalizedEntry.run_count) * 1.5).toFixed(2))
    : 0;
  const recencyBoost = (() => {
    const ageDays = (Date.now() - Date.parse(normalizedEntry.last_seen_at || normalizedEntry.created_at)) / (1000 * 60 * 60 * 24);
    if (!Number.isFinite(ageDays) || ageDays < 0) {
      return 0;
    }
    if (ageDays <= 7) {
      return 1.5;
    }
    if (ageDays <= 30) {
      return 1;
    }
    if (ageDays <= 90) {
      return 0.5;
    }
    return 0;
  })();

  if (tokenScore === 0 && exactMatchBoost === 0 && partialMatchBoost === 0) {
    return 0;
  }

  return Number((tokenScore + exactMatchBoost + partialMatchBoost + qualityBoost + successRateBoost + recencyBoost).toFixed(2));
}

function getRelevantExperienceHints(question, memory = readExperienceMemory()) {
  const entries = [...memory]
    .map((entry) => ({
      ...normalizeExperienceEntry(entry),
      relevance: scoreExperienceRelevance(question, entry)
    }))
    .filter((entry) => entry.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, 3);

  return {
    entries,
    boosted_queries: collectRankedExperienceValues(
      entries,
      (entry) => [...(entry.useful_queries || []), ...(entry.learned_patterns?.follow_up_queries || [])],
      { limit: 4, minLength: 2 }
    ),
    boosted_source_types: collectRankedExperienceValues(entries, (entry) => entry.useful_source_types || [], { limit: 4, minLength: 2 }),
    avoided_patterns: collectRankedExperienceValues(entries, (entry) => entry.noisy_paths || [], { limit: 4, minLength: 3 }),
    boosted_connector_ids: normalizeConnectorIdList(
      collectRankedExperienceValues(entries, (entry) => entry.learned_patterns?.boosted_connector_ids || [], { limit: 6, minLength: 2 })
    ),
    avoided_connector_ids: normalizeConnectorIdList(
      collectRankedExperienceValues(entries, (entry) => entry.learned_patterns?.avoided_connector_ids || [], { limit: 6, minLength: 2 })
    ),
    promoted_sites: collectRankedExperienceValues(entries, (entry) => entry.learned_patterns?.promoted_sites || [], { limit: 4, minLength: 3 })
  };
}

function buildSeedQueries(question, experienceHints = null, siteHints = null) {
  const hints = buildEnglishQueryHints(question);
  const boostedQueries = (experienceHints?.boosted_queries || [])
    .filter((item) => normalizeText(item) !== normalizeText(question));
  const siteQueries = buildSiteSeedQueries(question, siteHints, 2)
    .filter((item) => normalizeText(item) !== normalizeText(question));
  return Array.from(new Set([question, ...boostedQueries, ...siteQueries, ...hints])).slice(0, 6);
}

function scoreConnectorRelevance(question, connector) {
  const intentTokens = buildIntentTokens(question);
  const blob = normalizeText([
    connector.label,
    connector.description,
    ...(connector.capabilities || [])
  ].join(" "));

  let score = 0;
  for (const token of intentTokens) {
    if (blob.includes(normalizeText(token))) {
      score += 1;
    }
  }

  if (/[\u4e00-\u9fff]/.test(question) && /中文/.test((connector.capabilities || []).join(" "))) {
    score += 2;
  }
  if (/最新|当前|现在|发布|动态|消息|新闻/.test(question) && /(新闻|动态|官方网页)/.test((connector.capabilities || []).join(" "))) {
    score += 2;
  }
  if (/教程|上手|体验|测评|演示/.test(question) && /(教程|视频|社区)/.test((connector.capabilities || []).join(" "))) {
    score += 2;
  }
  if (/论文|研究|paper|research/i.test(question) && /(论文|研究)/.test((connector.capabilities || []).join(" "))) {
    score += 2;
  }

  return score;
}

function inferPreferredConnectors(question, experienceHints = null, siteHints = null) {
  const hintedConnectorIds = new Set(inferConnectorIdsFromSiteHints(siteHints));
  const boostedConnectorIds = new Set(experienceHints?.boosted_connector_ids || []);
  const avoidedConnectorIds = new Set(experienceHints?.avoided_connector_ids || []);
  return [...sourceCatalog]
    .map((connector) => ({
      id: connector.id,
      label: connector.label,
      reason: connector.description,
      score: scoreConnectorRelevance(question, connector)
        + ((experienceHints?.boosted_source_types || []).some((hint) => {
          const blob = normalizeText([connector.id, connector.label, connector.description, ...(connector.capabilities || [])].join(" "));
          return blob.includes(normalizeText(hint));
        }) ? 1.5 : 0)
        + (boostedConnectorIds.has(connector.id) ? 2 : 0)
        - (avoidedConnectorIds.has(connector.id) ? 1.5 : 0)
        + (hintedConnectorIds.has(connector.id) ? 2.5 : 0)
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(({ id, label, reason }) => ({ id, label, reason }));
}

function chooseConnectorsForQuestion(question, preferredConnectors, experienceHints = null, siteHints = null) {
  const preferred = preferredConnectors || inferPreferredConnectors(question, experienceHints, siteHints);
  const hintedConnectorIds = inferConnectorIdsFromSiteHints(siteHints).filter((id) => id && id !== "bing_web");
  const avoidedConnectorIds = new Set(experienceHints?.avoided_connector_ids || []);
  const chosen = [...hintedConnectorIds, ...preferred.map((item) => item.id)]
    .filter(Boolean)
    .filter((id) => id === "bing_web" || !avoidedConnectorIds.has(id));

  if (!chosen.includes("bing_web")) {
    chosen.push("bing_web");
  }
  if (chosen.length < 2 && sourceCatalog[0]?.id) {
    chosen.push(sourceCatalog[0].id);
  }

  return Array.from(new Set(chosen)).slice(0, 4);
}

function buildStopPolicy(question, subQuestions) {
  return {
    min_source_types: 2,
    min_evidence_items: 3,
    max_rounds: 2,
    overall_coverage_threshold: 0.18,
    sub_question_coverage_threshold: 0.18,
    fallback_sub_question_coverage_threshold: 0.12,
    max_relevant_conflicts: 1,
    require_all_sub_questions: true,
    prefer_video_evidence: /视频|访谈|演讲|发布会|talk|video/i.test(question),
    prefer_discussion_evidence: /(为什么|why|how)/i.test(question),
    expected_sub_questions: subQuestions.length
  };
}

function normalizeModelConnectorIds(candidateIds, fallbackIds = []) {
  const validIds = new Set(sourceCatalog.map((item) => item.id));
  const selected = [];

  for (const id of candidateIds || []) {
    if (!validIds.has(id) || selected.includes(id)) {
      continue;
    }
    selected.push(id);
    if (selected.length >= 4) {
      break;
    }
  }

  for (const id of fallbackIds || []) {
    if (!validIds.has(id) || selected.includes(id)) {
      continue;
    }
    selected.push(id);
    if (selected.length >= 4) {
      break;
    }
  }

  if (!selected.includes("bing_web") && validIds.has("bing_web") && selected.length < 4) {
    selected.push("bing_web");
  }

  return selected.slice(0, 4);
}

async function requestConnectorPlanFromModel(question, basePlan) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const connectors = (basePlan.source_capabilities || []).map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    capabilities: item.capabilities || []
  }));
  const connectorIds = connectors.map((item) => item.id);

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      sub_questions: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string" }
      },
      required_evidence: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: { type: "string" }
      },
      initial_queries: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: { type: "string" }
      },
      chosen_connector_ids: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
        items: { type: "string", enum: connectorIds }
      },
      rationale: { type: "string" },
      connector_reasons: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: connectorIds },
            reason: { type: "string" }
          },
          required: ["id", "reason"]
        }
      },
      site_search_strategies: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            site_name: { type: "string" },
            domain: { type: "string" },
            connector_id: { type: "string", enum: connectorIds },
            search_mode: {
              type: "string",
              enum: ["connector_search", "site_query", "hybrid", "verify_only"]
            },
            query_variants: {
              type: "array",
              maxItems: 4,
              items: { type: "string" }
            },
            rationale: { type: "string" }
          },
          required: ["site_name", "search_mode", "query_variants", "rationale"]
        }
      }
    },
    required: ["chosen_connector_ids", "rationale", "connector_reasons"]
  };

  const prompt = [
    "You are the planning controller for a research agent.",
    "Create a concise execution plan for the question.",
    "Choose only from the provided connectors.",
    "Pick 2 to 4 connectors that are most likely to produce strong evidence for the question.",
    "Prefer primary or official sources when relevant, but do not force diversity if the topic strongly points to a smaller set.",
    "If relevant site hints are provided, prefer those sites first: map known domains to their matching connector, or use bing_web for domain-specific discovery.",
    "For each relevant hinted site, decide how to search it: connector_search (use in-site connector), site_query (use bing_web with site:domain), hybrid (do both), or verify_only (read only if needed later).",
    "When returning site_search_strategies, write concrete query_variants that the agent can execute directly.",
    "Return 2 to 5 sub-questions and 2 to 6 concrete initial queries.",
    "Question:",
    question,
    "",
    "Heuristic base plan:",
    JSON.stringify({
      sub_questions: basePlan.sub_questions,
      required_evidence: basePlan.required_evidence,
      initial_queries: basePlan.initial_queries,
      preferred_connectors: basePlan.preferred_connectors,
      search_site_hints: (basePlan.search_site_hints?.items || []).map((item) => ({
        name: item.name,
        domain: item.domain,
        connector_id: item.connector_id,
        category: item.category,
        tags: item.tags
      })),
      stop_policy: basePlan.stop_policy
    }, null, 2),
    "",
    "Available connectors:",
    JSON.stringify(connectors, null, 2)
  ].join("\n");

  const payload = await fetchOpenAIJsonWithRetry(apiKey, {
      model: DEFAULT_PLANNER_MODEL,
      store: false,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "connector_plan",
          strict: true,
          schema
        }
      }
    }, {
    timeoutMs: 20000,
    operation: "openai_planner"
  });

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI planner returned no text output");
  }

  return JSON.parse(rawText);
}

function mergePlanWithModelSelection(basePlan, modelSelection) {
  const fallbackIds = basePlan.chosen_connector_ids || basePlan.preferred_connectors.map((item) => item.id);
  const siteSearchStrategies = normalizeModelSiteSearchStrategies(modelSelection?.site_search_strategies, basePlan);
  const strategyConnectorIds = siteSearchStrategies.map((item) => item.connector_id).filter(Boolean);
  const chosenConnectorIds = normalizeModelConnectorIds(
    [...(modelSelection?.chosen_connector_ids || []), ...strategyConnectorIds],
    fallbackIds
  );
  const reasonMap = new Map((modelSelection?.connector_reasons || []).map((item) => [item.id, item.reason]));
  const subQuestions = compactStringList(modelSelection?.sub_questions, { minLength: 6, limit: 5 });
  const requiredEvidence = compactStringList(modelSelection?.required_evidence, { minLength: 4, limit: 6 });
  const initialQueries = compactStringList(modelSelection?.initial_queries, { minLength: 2, limit: 6 });

  const preferredConnectors = chosenConnectorIds
    .map((id) => {
      const source = (basePlan.source_capabilities || []).find((item) => item.id === id);
      if (!source) {
        return null;
      }
      return {
        id,
        label: source.label,
        reason: reasonMap.get(id) || source.description
      };
    })
    .filter(Boolean);

  return {
    ...basePlan,
    sub_questions: subQuestions.length ? subQuestions : basePlan.sub_questions,
    required_evidence: requiredEvidence.length ? requiredEvidence : basePlan.required_evidence,
    initial_queries: initialQueries.length ? initialQueries : basePlan.initial_queries,
    stop_policy: buildStopPolicy(basePlan.task_goal, subQuestions.length ? subQuestions : basePlan.sub_questions),
    preferred_connectors: preferredConnectors.length ? preferredConnectors : basePlan.preferred_connectors,
    chosen_connector_ids: chosenConnectorIds,
    site_search_strategies: siteSearchStrategies,
    planner_mode: "llm",
    planner_rationale: modelSelection?.rationale || ""
  };
}

function planner(
  question,
  experienceHints = getRelevantExperienceHints(question),
  siteHints = getRelevantSearchSiteHints(question)
) {
  const comparisonQuery = /(相比|对比|差异|提升|versus|vs|update|更新)/i.test(question);
  const whyQuery = /(为什么|why|how)/i.test(question);
  const subQuestions = comparisonQuery
    ? [
        "当前版本或当前状态是什么？",
        "历史基线或对照版本是什么？",
        "两者差异体现在什么指标、能力或工作流上？"
      ]
    : [
        "核心问题的直接答案是什么？",
        "哪些证据足以支撑这个答案？"
      ];

  const requiredEvidence = [
    "至少 3 条高相关来源",
    "至少覆盖 2 种不同形态的证据"
  ];
  if (/视频|访谈|演讲|发布会|talk|video|sora|iphone/i.test(question)) {
    requiredEvidence.push("优先补充视频或多媒体证据");
  }
  if (whyQuery) {
    requiredEvidence.push("优先补充讨论或社区视角");
  }

  const preferredConnectors = inferPreferredConnectors(question, experienceHints, siteHints);
  const chosenConnectorIds = chooseConnectorsForQuestion(question, preferredConnectors, experienceHints, siteHints);

  return {
    task_goal: question,
    sub_questions: subQuestions,
    required_evidence: requiredEvidence,
    source_strategy: siteHints?.items?.length
      ? "LLM-Orchestrator first references curated site hints, then selects connectors and routes candidates to specialist agents."
      : "LLM-Orchestrator selects connectors first, then routes candidates to specialist agents.",
    preferred_connectors: preferredConnectors,
    chosen_connector_ids: chosenConnectorIds,
    experience_hints: experienceHints,
    search_site_hints: siteHints,
    site_search_strategies: [],
    source_capabilities: sourceCatalog,
    initial_queries: buildSeedQueries(question, experienceHints, siteHints),
    stop_policy: buildStopPolicy(question, subQuestions),
    stop_condition: "Stop when core questions are covered by evidence from at least two source types and conflicts are disclosed."
  };
}

async function buildPlan(question) {
  const experienceHints = getRelevantExperienceHints(question);
  const siteHints = getRelevantSearchSiteHints(question);
  const basePlan = planner(question, experienceHints, siteHints);
  try {
    const modelSelection = await requestConnectorPlanFromModel(question, basePlan);
    if (!modelSelection) {
      return {
        ...basePlan,
        planner_mode: "fallback",
        planner_rationale: "OPENAI_API_KEY not configured"
      };
    }
    return mergePlanWithModelSelection(basePlan, modelSelection);
  } catch (error) {
    return {
      ...basePlan,
      planner_mode: "fallback",
      planner_rationale: `fallback: ${error.message}`
    };
  }
}

async function requestCandidateRoutingFromModel(question, plan, candidates) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !candidates.length) {
    return null;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      selected_candidates: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: candidates.map((item) => item.id) },
            agent: { type: "string", enum: ROUTABLE_AGENT_IDS },
            tool: { type: "string", enum: ROUTABLE_TOOL_IDS },
            reason: { type: "string" }
          },
          required: ["id", "agent", "tool", "reason"]
        }
      },
      rationale: { type: "string" }
    },
    required: ["selected_candidates", "rationale"]
  };

  const prompt = [
    "You are the routing controller for a research agent.",
    "Select up to 4 best candidate sources for the current round.",
    "Assign exactly one agent and one tool to each selected source.",
    "Prefer video_parser for video, chart_parser for chart-heavy documents, fact_verifier for forum-like discussions, and long_text_collector otherwise.",
    "Question:",
    question,
    "",
    "Plan summary:",
    JSON.stringify({
      sub_questions: plan.sub_questions,
      required_evidence: plan.required_evidence,
      chosen_connector_ids: plan.chosen_connector_ids
    }, null, 2),
    "",
    "Available candidates:",
    JSON.stringify(candidates.map((item) => ({
      id: item.id,
      title: item.title,
      connector: item.connector,
      content_type: item.content_type || item.source_type,
      platform: item.platform,
      score: item.score,
      snippet: item.snippet,
      url: item.url
    })), null, 2)
  ].join("\n");

  const payload = await fetchOpenAIJsonWithRetry(apiKey, {
      model: DEFAULT_PLANNER_MODEL,
      store: false,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "candidate_routing",
          strict: true,
          schema
        }
      }
    }, {
    timeoutMs: 20000,
    operation: "openai_routing_planner"
  });

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI routing planner returned no text output");
  }

  return JSON.parse(rawText);
}

async function selectCandidatesWithRouting(candidates, question, plan) {
  const fallbackSelected = selectCandidates(candidates, question, plan);

  try {
    const routing = await requestCandidateRoutingFromModel(question, plan, candidates.slice(0, 10));
    if (!routing?.selected_candidates?.length) {
      return {
        selected: fallbackSelected,
        routing_mode: "heuristic",
        routing_rationale: routing?.rationale || ""
      };
    }

    const fallbackIds = fallbackSelected.map((item) => item.id);
    const selectedIds = normalizeModelSelectedCandidateIds(
      routing.selected_candidates.map((item) => item.id),
      fallbackIds
    );
    const routeMap = new Map((routing.selected_candidates || []).map((item) => [item.id, item]));
    const selected = selectedIds
      .map((id) => {
        const candidate = candidates.find((item) => item.id === id);
        if (!candidate) {
          return null;
        }
        const routed = routeMap.get(id);
        return {
          ...candidate,
          preferred_agent: normalizeModelAgentId(routed?.agent, routeCandidate(candidate)),
          preferred_tool: normalizeModelToolId(routed?.tool, collectorToolForCandidate(candidate)),
          routing_reason: routed?.reason || null
        };
      })
      .filter(Boolean);

    return {
      selected: selected.length ? selected : fallbackSelected,
      routing_mode: selected.length ? "llm" : "heuristic",
      routing_rationale: routing.rationale || ""
    };
  } catch (error) {
    return {
      selected: fallbackSelected,
      routing_mode: "fallback",
      routing_rationale: error.message
    };
  }
}

function createScratchpad(plan) {
  return {
    facts_collected: [],
    queries_tried: [],
    sources_read: [],
    conflicts_found: [],
    temporary_conclusions: [],
    resolved_questions: [],
    missing_questions: [...plan.sub_questions],
    failure_paths: [],
    agent_reports: [],
    workspace: {
      shared_notes: [],
      agent_workspaces: {},
      handoffs: [],
      decisions: [],
      timeline: [],
      knowledge_graph: null,
      question_status: plan.sub_questions.map((question) => ({
        question,
        status: "pending",
        updated_at: null
      }))
    },
    stop_reason: null
  };
}

function ensureAgentWorkspace(scratchpad, agentId) {
  if (!scratchpad.workspace.agent_workspaces[agentId]) {
    scratchpad.workspace.agent_workspaces[agentId] = {
      notes: [],
      artifacts: [],
      last_updated_at: null
    };
  }

  return scratchpad.workspace.agent_workspaces[agentId];
}

function appendTimelineEvent(scratchpad, event) {
  scratchpad.workspace.timeline.push({
    at: new Date().toISOString(),
    ...event
  });
}

function addSharedNote(scratchpad, note) {
  scratchpad.workspace.shared_notes.push({
    at: new Date().toISOString(),
    ...note
  });
}

function recordAgentArtifact(scratchpad, agentId, artifact) {
  const workspace = ensureAgentWorkspace(scratchpad, agentId);
  workspace.artifacts.push({
    at: new Date().toISOString(),
    ...artifact
  });
  workspace.last_updated_at = new Date().toISOString();
}

function recordAgentNote(scratchpad, agentId, note) {
  const workspace = ensureAgentWorkspace(scratchpad, agentId);
  workspace.notes.push({
    at: new Date().toISOString(),
    ...note
  });
  workspace.last_updated_at = new Date().toISOString();
}

function recordHandoff(scratchpad, handoff) {
  scratchpad.workspace.handoffs.push({
    at: new Date().toISOString(),
    ...handoff
  });
}

function recordDecision(scratchpad, decision) {
  scratchpad.workspace.decisions.push({
    at: new Date().toISOString(),
    ...decision
  });
}

function updateQuestionStatus(scratchpad, resolvedQuestions, missingQuestions) {
  const resolvedSet = new Set(resolvedQuestions || []);
  const missingSet = new Set(missingQuestions || []);
  scratchpad.workspace.question_status = scratchpad.workspace.question_status.map((item) => ({
    question: item.question,
    status: resolvedSet.has(item.question)
      ? "resolved"
      : missingSet.has(item.question)
        ? "missing"
        : item.status,
    updated_at: resolvedSet.has(item.question) || missingSet.has(item.question)
      ? new Date().toISOString()
      : item.updated_at
  }));
}

function recordVerificationReview(scratchpad, review) {
  for (const item of review?.tasks || []) {
    recordHandoff(scratchpad, {
      from: "llm_orchestrator",
      to: "fact_verifier",
      review_key: item.key,
      review_kind: item.kind,
      status: item.status
    });
    recordAgentArtifact(scratchpad, "fact_verifier", {
      type: "verification_follow_up",
      key: item.key,
      kind: item.kind,
      preferred_source: item.preferred_source,
      status: item.status
    });
    addSharedNote(scratchpad, {
      type: "verification_review",
      agent: "fact_verifier",
      content: `${item.kind} ${item.key}: ${item.reason}`
    });
  }
}

function buildEvidenceItems(reads, candidates = []) {
  const candidateMap = new Map(candidates.map((item) => [item.id, item]));
  return reads.map((item) => createEvidenceUnit(item, candidateMap.get(item.source_id)));
}

async function crossCheckFacts(input) {
  if (!input?.length) {
    return { confirmations: [], conflicts: [], coverage_gaps: [] };
  }

  const evidenceItems = input[0]?.claims || input[0]?.source_metadata
    ? input
    : [{
        source_id: "legacy",
        source_type: "web",
        claims: input.map((fact, index) => ({
          id: `legacy:${index}`,
          type: fact.kind,
          claim: fact.claim,
          subject: fact.subject,
          value: fact.value,
          unit: fact.unit,
          source_id: fact.source_id,
          published_at: fact.published_at || null,
          authority_score: fact.authority_score || 0.66,
          evidence_span_ids: []
        })),
        facts: input,
        source_metadata: { authority_score: 0.66 }
      }];

  const execution = await ToolRegistry.executeTool("cross_check_facts", { evidenceItems });
  if (!execution.success) {
    throw new Error(execution.error?.message || "cross_check_facts failed");
  }
  return execution.data;
}

function evaluator(plan, scratchpad, evidenceItems, verification, roundsCompleted) {
  return evaluateResearch(plan, scratchpad, evidenceItems, verification, roundsCompleted);
}

function formatFact(fact) {
  if (typeof fact.value === "number") {
    return `${fact.claim} (${fact.value} ${fact.unit || ""})`.trim();
  }
  return fact.claim;
}

function buildStandardSources(evidenceItems) {
  return (evidenceItems || []).slice(0, 8).map((item) => ({
    source_id: item.source_id || null,
    title: item.title || null,
    source_type: item.source_type || null,
    url: item.source_metadata?.url || null,
    connector: item.source_metadata?.connector || null,
    platform: item.source_metadata?.platform || null,
    published_at: item.source_metadata?.published_at || null,
    authority_score: item.source_metadata?.authority_score ?? null
  }));
}

function buildStandardClaims(evidenceItems) {
  return dedupeBy(
    (evidenceItems || []).flatMap((item) => (item.claims || []).map((claim) => ({
      source_id: claim.source_id || item.source_id || null,
      type: claim.type || null,
      claim: claim.claim || null,
      subject: claim.subject || null,
      value: claim.value ?? null,
      unit: claim.unit || null,
      confidence: claim.confidence ?? null
    }))),
    (item) => `${item.subject || "claim"}:${item.type || "statement"}:${item.claim || ""}:${item.source_id || ""}`
  ).slice(0, 12);
}

function buildEphemeralToolGoal(question, candidate, failure) {
  const contentType = candidate.content_type || candidate.source_type || "web";
  return `Extract usable ${contentType} evidence for the research question "${question}" after the built-in ${failure.agent} read path failed.`;
}

function buildEphemeralToolConstraints(candidate, failure) {
  return [
    "Use no third-party dependencies.",
    "Prefer direct extraction from the target page or embedded payloads.",
    "Return structured JSON with logs and extracted_data.",
    `Original failure: ${failure.error.message}`,
    `Target connector: ${candidate.connector || "unknown"}`
  ];
}

function createReadFromEphemeralAttempt(candidate, attempt) {
  const data = attempt.extracted_data || {};
  const contentType = candidate.content_type || candidate.source_type || "web";
  const paragraphs = data.paragraphs || [];
  const timeline = data.timeline || [];
  const keyPoints = data.key_points || paragraphs.slice(0, 4);
  const markdown = data.markdown || [
    `# ${data.title || candidate.title || "Ephemeral extraction"}`,
    data.description || "",
    ...paragraphs
  ].filter(Boolean).join("\n\n");

  return {
    source_id: candidate.id,
    content_type: contentType,
    source_type: contentType,
    tool: "run_ephemeral_tool",
    title: data.title || candidate.title,
    url: candidate.url,
    author: data.author || candidate.author,
    published_at: data.published_at || candidate.published_at || null,
    duration: data.duration || null,
    markdown,
    transcript: data.transcript || [],
    timeline,
    key_points: keyPoints,
    key_frames: data.key_frames || timeline.slice(0, 3).map((item) => item.summary || item.title),
    facts: []
  };
}

async function attemptEphemeralFallbacks(question, failures, telemetry, onProgress) {
  const attempts = [];
  const recoveredReads = [];
  const recoveredEvidence = [];

  for (const failure of failures.slice(0, 2)) {
    const tool = await synthesizeTool({
      goal: buildEphemeralToolGoal(question, failure.candidate, failure),
      target: {
        url: failure.candidate.url,
        title: failure.candidate.title,
        platform: failure.candidate.platform,
        connector: failure.candidate.connector,
        content_type: failure.candidate.content_type || failure.candidate.source_type
      },
      constraints: buildEphemeralToolConstraints(failure.candidate, failure)
    });

    const execution = await runEphemeralTool(tool, {
      timeout_ms: 15000,
      network: true
    });

    const attempt = {
      ...execution,
      target: tool.target,
      source_id: failure.candidate.id,
      original_failure: failure.error.message
    };
    attempts.push(attempt);
    telemetry.ephemeral_tools.push(attempt);
    if (!execution.success) {
      telemetry.failures.push({
        stage: "run_ephemeral_tool",
        query: tool.target?.url || tool.target?.title || tool.tool_id,
        connector: tool.target?.connector || null,
        reason: execution.error || "ephemeral tool failed"
      });
    }

    await emitProgress(onProgress, {
      type: "tool",
      tool_attempt: {
        tool_id: tool.tool_id,
        strategy: tool.strategy,
        target: tool.target,
        success: execution.success,
        worth_promoting: execution.worth_promoting,
        logs: execution.logs,
        error: execution.error
      }
    });

    if (!execution.success) {
      continue;
    }

    const read = createReadFromEphemeralAttempt(failure.candidate, execution);
    recoveredReads.push(read);
    recoveredEvidence.push(createEvidenceUnit(read, failure.candidate));
  }

  return {
    attempts,
    reads: recoveredReads,
    evidence_items: recoveredEvidence
  };
}

function buildHeuristicSynthesis(question, mode, candidates, reads, evidenceItems, verification, evaluation, telemetry) {
  const keyClaims = dedupeBy(
    evidenceItems.flatMap((item) => item.claims || []),
    (claim) => `${claim.subject || "claim"}:${claim.type || "statement"}:${claim.claim}`
  )
    .slice(0, 5)
    .map(formatFact);

  const conclusion = [
    `Question: ${question}`,
    `Collected ${reads.length} normalized reads from ${candidates.length} candidate sources.`,
    keyClaims.length ? `Top supported claims: ${keyClaims.join(" | ")}` : "Structured support is still thin; qualitative evidence dominates."
  ].join(" ");
  const uncertainty = evaluation.risk_notes.length
    ? evaluation.risk_notes
    : ["No major unresolved evidence gaps were detected."];
  const confidence = (() => {
    const baseScore = evaluation.is_sufficient ? 0.58 : 0.38;
    const diversityBonus = Math.min(0.15, ((evaluation.metrics?.source_types_covered || 0) / 4) * 0.15);
    const total = verification.confirmations.length + verification.conflicts.length + verification.coverage_gaps.length;
    const confirmationBonus = total > 0 ? (verification.confirmations.length / total) * 0.2 : 0;
    return Number(Math.min(0.94, baseScore + diversityBonus + confirmationBonus).toFixed(2));
  })();
  const sources = buildStandardSources(evidenceItems);
  const claims = buildStandardClaims(evidenceItems);

  return {
    schema_version: "final_answer.v1",
    mode,
    headline: `Research summary for "${question}"`,
    quick_answer: conclusion,
    sources,
    claims,
    confidence,
    uncertainty,
    deep_research_summary: {
      schema_version: "deep_research_summary.v1",
      headline: `Research summary for "${question}"`,
      conclusion,
      key_sources: evidenceItems.slice(0, 4).map((item) => ({
        source_id: item.source_id,
        title: item.title,
        source_type: item.source_type,
        source_metadata: item.source_metadata
      })),
      evidence_chain: evidenceItems.map((item) => ({
        source_id: item.source_id,
        title: item.title,
        source_type: item.source_type,
        why_it_matters: (item.key_points || [])[0] || item.quotes[0]?.text || "Provides direct evidence",
        quotes: item.quotes.slice(0, 2),
        evidence_spans: item.evidence_spans.slice(0, 3),
        source_metadata: item.source_metadata
      })),
      conflicts: verification.conflicts.map((item) => ({
        key: item.key,
        preferred_claim: item.preferred_fact?.claim,
        preferred_source: item.comparison?.preferred_source,
        reason: item.reason,
        competing_sources: item.comparison?.competing_sources || []
      })),
      uncertainty,
      evaluation_scorecard: evaluation.scorecard || null,
      stop_state: evaluation.stop_state || null,
      stop_decision: evaluation.llm_stop_decision || null,
      recommended_follow_ups: evaluation.follow_up_queries || [],
      suggested_connectors: evaluation.suggested_connector_ids || [],
      confidence,
      dynamic_tools: telemetry.ephemeral_tools.map((item) => ({
        tool_id: item.tool.tool_id,
        strategy: item.tool.strategy,
        runtime: item.tool.runtime,
        target: item.target,
        success: item.success,
        logs: item.logs,
        worth_promoting: item.worth_promoting,
        validation: item.validation || null,
        promotion: item.promotion || null,
        audit: item.audit || []
      })),
      task_observability: {
        stop_reason: telemetry.stop_reason,
        stop_controller: evaluation.stop_controller || "heuristic",
        evaluation_status: evaluation.scorecard?.status || null,
        readiness: evaluation.scorecard?.readiness ?? null,
        connector_health: telemetry.connector_health,
        failures: telemetry.failures.slice(0, 8)
      }
    }
  };
}

async function requestFinalSynthesisFromModel(question, mode, evidenceItems, verification, evaluation) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !evidenceItems.length) {
    return null;
  }

  const evidenceDigest = evidenceItems.slice(0, 6).map((item) => ({
    source_id: item.source_id,
    title: item.title,
    source_type: item.source_type,
    key_points: (item.key_points || []).slice(0, 3),
    claims: (item.claims || []).slice(0, 3).map((claim) => ({
      claim: claim.claim,
      subject: claim.subject,
      value: claim.value,
      unit: claim.unit
    })),
    quotes: (item.quotes || []).slice(0, 2).map((quote) => quote.text)
  }));

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      quick_answer: { type: "string" },
      conclusion: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      key_claims: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            claim: { type: "string" },
            source_id: { type: "string" }
          },
          required: ["claim", "source_id"]
        }
      },
      uncertainty: {
        type: "array",
        maxItems: 5,
        items: { type: "string" }
      }
    },
    required: ["quick_answer", "conclusion", "confidence", "key_claims", "uncertainty"]
  };

  const prompt = [
    "You are the answer-composer for a research agent.",
    "Write a grounded answer using only the supplied evidence digest.",
    "Keep the quick answer concise and actionable.",
    "If evidence is incomplete or conflicted, make the uncertainty explicit.",
    "Question:",
    question,
    "",
    "Mode:",
    mode,
    "",
    "Evidence digest:",
    JSON.stringify({
      evidence: evidenceDigest,
      verification: {
        confirmations: verification.confirmations,
        conflicts: verification.conflicts,
        coverage_gaps: verification.coverage_gaps
      },
      evaluation: {
        is_sufficient: evaluation.is_sufficient,
        risk_notes: evaluation.risk_notes,
        follow_up_queries: evaluation.follow_up_queries,
        metrics: evaluation.metrics
      }
    }, null, 2)
  ].join("\n");

  const payload = await fetchOpenAIJsonWithRetry(apiKey, {
      model: DEFAULT_SYNTHESIS_MODEL,
      store: false,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "final_synthesis",
          strict: true,
          schema
        }
      }
    }, {
    timeoutMs: 25000,
    operation: "openai_synthesis"
  });

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI synthesis returned no text output");
  }

  return JSON.parse(rawText);
}

async function synthesize(question, mode, candidates, reads, evidenceItems, verification, evaluation, telemetry) {
  const fallback = buildHeuristicSynthesis(question, mode, candidates, reads, evidenceItems, verification, evaluation, telemetry);

  try {
    const modelAnswer = await requestFinalSynthesisFromModel(question, mode, evidenceItems, verification, evaluation);
    if (!modelAnswer) {
      return fallback;
    }

    return {
      ...fallback,
      confidence: Number(modelAnswer.confidence.toFixed(2)),
      uncertainty: compactStringList(modelAnswer.uncertainty, { minLength: 4, limit: 5 }),
      quick_answer: modelAnswer.quick_answer,
      deep_research_summary: {
        ...fallback.deep_research_summary,
        conclusion: modelAnswer.conclusion,
        uncertainty: compactStringList(modelAnswer.uncertainty, { minLength: 4, limit: 5 }),
        confidence: Number(modelAnswer.confidence.toFixed(2)),
        llm_composer: {
          model: DEFAULT_SYNTHESIS_MODEL,
          key_claims: (modelAnswer.key_claims || []).map((item) => ({
            claim: item.claim,
            source_id: item.source_id
          }))
        }
      }
    };
  } catch (error) {
    return {
      ...fallback,
      deep_research_summary: {
        ...fallback.deep_research_summary,
        llm_composer: {
          model: DEFAULT_SYNTHESIS_MODEL,
          fallback_reason: error.message
        }
      }
    };
  }
}

function summarizeExperience(question, scratchpad, plan, evaluation, telemetry, verification = { confirmations: [], conflicts: [], coverage_gaps: [] }) {
  const usefulPlatforms = [];
  const effectiveSearchTerms = [];
  const primarySourceSites = [];
  const efficientToolCombinations = [];
  const noisyPaths = [];
  const successfulConnectorIds = compactStringList(
    scratchpad.sources_read.map((item) => item.connector).filter(Boolean),
    { minLength: 2, limit: 4 }
  );
  const failedConnectorIds = compactStringList(
    (telemetry?.failures || []).map((item) => item.connector).filter(Boolean),
    { minLength: 2, limit: 4 }
  );
  const promotedSites = compactStringList(
    (telemetry?.ephemeral_tools || [])
      .filter((item) => item.worth_promoting?.should_promote)
      .map((item) => item.worth_promoting.candidate_connector),
    { minLength: 3, limit: 4 }
  );
  const successfulEphemeralTools = (telemetry?.ephemeral_tools || []).filter((item) => item.success).length;
  const failedEphemeralTools = (telemetry?.ephemeral_tools || []).filter((item) => !item.success).length;
  const confidence = clampNumber(
    evaluation?.scorecard?.readiness ?? (evaluation?.is_sufficient ? 0.72 : 0.42),
    { min: 0, max: 1, fallback: 0.42 }
  );
  const qualityScore = Number(Math.max(0, Math.min(1,
    confidence
      + Math.min(0.12, ((evaluation?.metrics?.source_types_covered || 0) / 4) * 0.12)
      - Math.min(0.25, (verification?.conflicts?.length || 0) * 0.08)
      - Math.min(0.18, (verification?.coverage_gaps?.length || 0) * 0.04)
  )).toFixed(2));
  const roundsCompleted = scratchpad.workspace.timeline.filter((item) => item.type === "round_completed").length;

  // 分析平台适用性
  if (scratchpad.sources_read.length > 0) {
    const platformStats = {};
    scratchpad.sources_read.forEach(item => {
      const platform = item.source_type || item.content_type || 'unknown';
      platformStats[platform] = (platformStats[platform] || 0) + 1;
    });
    Object.entries(platformStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([platform, count]) => {
        usefulPlatforms.push(`${platform} (${count} sources)`);
      });
  }

  // 分析有效搜索词
  if (scratchpad.queries_tried.length > 0) {
    const queryStats = {};
    scratchpad.queries_tried.forEach(query => {
      queryStats[query] = (queryStats[query] || 0) + 1;
    });
    Object.entries(queryStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([query, count]) => {
        effectiveSearchTerms.push(`${query} (${count} times)`);
      });
  }

  // 分析一手资料站点
  if (scratchpad.sources_read.length > 0) {
    const siteStats = {};
    scratchpad.sources_read.forEach(item => {
      const site = item.source_id || item.title || 'unknown';
      siteStats[site] = (siteStats[site] || 0) + 1;
    });
    Object.entries(siteStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([site, count]) => {
        primarySourceSites.push(`${site} (${count} times)`);
      });
  }

  // 分析工具组合效率
  if (scratchpad.agent_reports.length > 0) {
    const toolStats = {};
    scratchpad.agent_reports.forEach(report => {
      if (report.tool) {
        toolStats[report.tool] = (toolStats[report.tool] || 0) + 1;
      }
    });
    Object.entries(toolStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([tool, count]) => {
        efficientToolCombinations.push(`${tool} (${count} times)`);
      });
  }

  // 分析噪音路径
  if (scratchpad.failure_paths.length > 0) {
    scratchpad.failure_paths.slice(0, 3).forEach(path => {
      noisyPaths.push(path.reason || path.message || 'Unknown failure');
    });
  }

  return {
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    question,
    question_key: normalizeText(question),
    run_count: 1,
    success_count: evaluation?.is_sufficient ? 1 : 0,
    useful_queries: scratchpad.queries_tried.slice(0, 5),
    useful_source_types: Array.from(new Set(scratchpad.sources_read.map((item) => item.content_type || item.source_type))),
    useful_platforms: usefulPlatforms,
    effective_search_terms: effectiveSearchTerms,
    primary_source_sites: primarySourceSites,
    efficient_tool_combinations: efficientToolCombinations,
    learned_patterns: {
      boosted_connector_ids: successfulConnectorIds.length ? successfulConnectorIds : compactStringList(plan?.chosen_connector_ids, { minLength: 2, limit: 4 }),
      avoided_connector_ids: failedConnectorIds,
      follow_up_queries: compactStringList(evaluation?.follow_up_queries || [], { minLength: 2, limit: 4 }),
      promoted_sites: promotedSites
    },
    ephemeral_tool_insights: {
      attempts: telemetry?.ephemeral_tools?.length || 0,
      recovered_sources: (telemetry?.ephemeral_tools || []).filter((item) => item.success).map((item) => item.target?.url).filter(Boolean),
      promote_candidates: (telemetry?.ephemeral_tools || [])
        .filter((item) => item.worth_promoting?.should_promote)
        .map((item) => ({
          site: item.worth_promoting.candidate_connector,
          strategy: item.tool.strategy,
          reason: item.worth_promoting.reason
        }))
    },
    noisy_paths: noisyPaths,
    metrics: {
      quality_score: qualityScore,
      confidence,
      sufficiency: Boolean(evaluation?.is_sufficient),
      rounds_completed: roundsCompleted,
      sources_read: scratchpad.sources_read.length,
      evidence_items: evaluation?.metrics?.evidence_items || 0,
      confirmations: verification?.confirmations?.length || 0,
      conflicts: verification?.conflicts?.length || 0,
      coverage_gaps: verification?.coverage_gaps?.length || 0,
      successful_ephemeral_tools: successfulEphemeralTools,
      failed_ephemeral_tools: failedEphemeralTools
    },
    note: evaluation.is_sufficient
      ? "This question is a good fit for the current llm-orchestrator-plus-specialists workflow."
      : "This question still exposes connector or evidence-model gaps that should be improved."
  };
}

function buildFollowUpQueries(question, evaluation, scratchpad, experienceHints = getRelevantExperienceHints(question)) {
  if (evaluation?.follow_up_queries?.length) {
    return evaluation.follow_up_queries
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index)
      .slice(0, 4);
  }

  if (!evaluation?.missing_questions?.length) {
    return [];
  }

  const failureCount = (scratchpad?.failure_paths || []).length;
  const triedCount = (scratchpad?.queries_tried || []).length;
  if (triedCount > 0 && failureCount / triedCount > 0.5) {
    return [...(experienceHints?.boosted_queries || []), ...buildEnglishQueryHints(question)]
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index)
      .slice(0, 3);
  }

  return evaluation.missing_questions
    .flatMap((item) => {
      const followUp = `${question} ${item}`;
      return [followUp, ...(experienceHints?.boosted_queries || []), ...buildEnglishQueryHints(followUp)];
    })
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 3);
}

function buildNextRoundConnectorIds(plan, currentConnectorIds, evaluation, connectorHealth = {}) {
  const fallbackIds = compactStringList(
    currentConnectorIds?.length ? currentConnectorIds : (plan?.chosen_connector_ids || []),
    { limit: 4 }
  );
  const suggestedIds = compactStringList(evaluation?.suggested_connector_ids || [], { limit: 4 });
  const mergedIds = normalizeModelConnectorIds(suggestedIds, fallbackIds);
  const healthyIds = mergedIds.filter((id) => connectorHealth?.[id]?.healthy !== false);
  const unhealthyIds = mergedIds.filter((id) => connectorHealth?.[id]?.healthy === false);
  const reserveIds = normalizeModelConnectorIds(
    (plan?.source_capabilities || []).map((item) => item.id),
    fallbackIds
  ).filter((id) => !healthyIds.includes(id) && !unhealthyIds.includes(id) && connectorHealth?.[id]?.healthy !== false);
  const filteredFallbackIds = (healthyIds.length || reserveIds.length)
    ? fallbackIds.filter((id) => connectorHealth?.[id]?.healthy !== false)
    : fallbackIds;

  return normalizeModelConnectorIds([...healthyIds, ...reserveIds], [...filteredFallbackIds, ...reserveIds]);
}

function updateConnectorHealthSnapshot(telemetry, connectorIds, roundsCompleted = 0) {
  const uniqueIds = Array.from(new Set((connectorIds || []).filter(Boolean)));
  const discoverFailures = telemetry.failures.filter((item) => item.stage === "discover");
  for (const connectorId of uniqueIds) {
    const failures = telemetry.failures.filter((item) => item.connector === connectorId);
    const failedEvents = failures.length + discoverFailures.length;
    telemetry.connector_health[connectorId] = {
      failed_events: failedEvents,
      healthy: failedEvents < Math.max(2, roundsCompleted + 1),
      rounds_observed: roundsCompleted,
      last_failure: failures.length ? failures[failures.length - 1].reason : (discoverFailures[discoverFailures.length - 1]?.reason || null),
      updated_at: new Date().toISOString()
    };
  }
}

async function emitProgress(onProgress, payload) {
  if (typeof onProgress !== "function") {
    return;
  }

  try {
    await onProgress(payload);
  } catch (error) {
    console.warn(`[runResearch] progress callback failed for "${payload?.type || "unknown"}":`, error.message);
  }
}

async function runRound(plan, question, queries, scratchpad, telemetry, onProgress) {
  scratchpad.queries_tried.push(...queries);
  const runtime = telemetry.agent_runtime || null;
  for (const query of queries) {
    addSharedNote(scratchpad, {
      type: "query",
      agent: "llm_orchestrator",
      content: query
    });
  }
  appendTimelineEvent(scratchpad, {
    type: "round_started",
    agent: "llm_orchestrator",
    queries
  });
  const orchestratorTask = runtime
    ? dispatchAgentTask(runtime, {
        from: "llm_orchestrator",
        agentId: "llm_orchestrator",
        taskType: "coordinate_round",
        input: { queries },
        metadata: {
          query_count: queries.length
        }
      })
    : null;

  const searchResult = await runWebResearcher(plan, queries, telemetry, runtime);
  const candidates = searchResult.candidates || [];
  const executedSearchTasks = searchResult.executed_search_tasks || [];
  if (executedSearchTasks.length) {
    appendTimelineEvent(scratchpad, {
      type: "site_search_strategy",
      agent: "web_researcher",
      search_tasks: executedSearchTasks
    });
  }
  if (!candidates.length) {
    for (const query of queries) {
      scratchpad.failure_paths.push({ query, reason: "no candidate returned" });
      recordAgentNote(scratchpad, "web_researcher", {
        type: "failure",
        content: `No candidate returned for query: ${query}`
      });
    }
  }

  const routedSelection = await selectCandidatesWithRouting(candidates, question, plan);
  const selected = routedSelection.selected;
  recordDecision(scratchpad, {
    type: "routing",
    mode: routedSelection.routing_mode,
    rationale: routedSelection.routing_rationale,
    selected_source_ids: selected.map((item) => item.id)
  });
  const specialistReads = await runSpecialistReads(selected, telemetry, runtime);
  const routedTasks = specialistReads.routed_tasks?.length
    ? specialistReads.routed_tasks
    : selected.map((candidate) => {
        const agent = candidate.preferred_agent || routeCandidate(candidate);
        const tool = candidate.preferred_tool || collectorToolForCandidate(candidate);
        return {
          source_id: candidate.id,
          segment_source_id: candidate.id,
          agent,
          tool,
          connector: candidate.connector,
          objective: candidate.routing_reason || null
        };
      });
  const reads = specialistReads.results.map((item) => item.read);
  const evidenceItems = specialistReads.results.map((item) => item.evidence_unit);
  const fallback = await attemptEphemeralFallbacks(question, specialistReads.failures, telemetry, onProgress);

  for (const task of routedTasks) {
    const candidate = selected.find((item) => item.id === task.source_id);
    recordHandoff(scratchpad, {
      from: "llm_orchestrator",
      to: task.agent,
      source_id: task.source_id,
      segment_source_id: task.segment_source_id || task.source_id,
      tool: task.tool,
      pages: task.pages || null,
      objective: task.objective || null
    });
    if (candidate) {
      addSharedNote(scratchpad, {
        type: "parser_task",
        agent: "llm_orchestrator",
        content: `${candidate.title}: ${task.agent} via ${task.tool}${task.pages ? ` pages ${task.pages.join("-")}` : ""}`
      });
    }
  }

  for (const item of specialistReads.results) {
    const candidate = item.candidate;
    const read = item.read;
    const contentType = read.content_type || read.source_type || candidate.content_type || candidate.source_type;
    const sourceRecord = {
      source_id: read.source_id,
      parent_source_id: candidate.id,
      title: read.title || candidate.title,
      content_type: contentType,
      source_type: contentType,
      connector: candidate.connector,
      parser_agent: read.parser_agent || candidate.preferred_agent || routeCandidate(candidate),
      tool: read.tool,
      pages: read.segment_pages || null
    };
    scratchpad.sources_read.push(sourceRecord);
    recordAgentArtifact(scratchpad, read.parser_agent || candidate.preferred_agent || routeCandidate(candidate), {
      type: "source_read",
      source_id: read.source_id,
      parent_source_id: candidate.id,
      title: read.title || candidate.title,
      content_type: contentType,
      connector: candidate.connector,
      tool: read.tool,
      pages: read.segment_pages || null
    });
  }

  appendTimelineEvent(scratchpad, {
    type: "round_completed",
    selected_sources: selected.map((item) => item.id),
    evidence_items: evidenceItems.length + fallback.evidence_items.length
  });
  if (orchestratorTask) {
    completeAgentTask(runtime, orchestratorTask.id, {
      candidate_count: candidates.length,
      selected_count: selected.length,
      routed_task_count: routedTasks.length
    });
  }

  return {
    candidates,
    executed_search_tasks: executedSearchTasks,
    selected,
    routed_tasks: routedTasks,
    reads: [...reads, ...fallback.reads],
    evidence_items: [...evidenceItems, ...fallback.evidence_items],
    tool_attempts: fallback.attempts
  };
}

async function runResearch({ question, mode, onProgress }) {
  const plan = await buildPlan(question);
  const experienceHints = plan.experience_hints || getRelevantExperienceHints(question);
  await emitProgress(onProgress, { type: "plan", plan });

  const scratchpad = createScratchpad(plan);
  const agents = createAgentRegistry();
  const agentRuntime = createAgentRuntime(agents);
  const knowledgeGraph = readKnowledgeGraph() || new KnowledgeGraph({
    question,
    task_goal: plan.task_goal
  });
  if (!knowledgeGraph.versions.length) {
    knowledgeGraph.createVersion("initialized", {
      sub_questions: plan.sub_questions
    });
  } else {
    knowledgeGraph.context = {
      ...knowledgeGraph.context,
      last_question: question,
      task_goal: plan.task_goal
    };
  }
  const telemetry = {
    agents,
    agent_system: new AgentSystem(),
    agent_runtime: agentRuntime,
    events: [],
    failures: [],
    ephemeral_tools: [],
    connector_health: {},
    stop_reason: null
  };

  const rounds = [];
  let combinedCandidates = [];
  let combinedReads = [];
  let combinedEvidence = [];
  let verification = { confirmations: [], conflicts: [], coverage_gaps: [] };
  let verifierReview = { tasks: [], summary: { conflicts: 0, coverage_gaps: 0, review_count: 0 } };
  let evaluation = null;
  let activeConnectorIds = normalizeModelConnectorIds(plan.chosen_connector_ids, plan.chosen_connector_ids);

  const maxRounds = Math.max(1, plan.stop_policy?.max_rounds || 2);
  for (let index = 0; index < maxRounds; index += 1) {
    const queries = index === 0 ? plan.initial_queries : buildFollowUpQueries(question, evaluation, scratchpad, experienceHints);
    if (!queries.length) {
      break;
    }

    const roundConnectorIds = [...activeConnectorIds];
    const roundPlan = {
      ...plan,
      chosen_connector_ids: roundConnectorIds
    };
    const round = await runRound(roundPlan, question, queries, scratchpad, telemetry, onProgress);
    combinedCandidates = dedupeBy([...combinedCandidates, ...round.candidates], (item) => item.url).sort((left, right) => right.score - left.score);
    combinedReads = dedupeBy([...combinedReads, ...round.reads], (item) => item.source_id);
    combinedEvidence = dedupeBy([...combinedEvidence, ...round.evidence_items], (item) => item.source_id);

    verification = await crossCheckFacts(combinedEvidence);
    verifierReview = await runFactVerifierReview(verification, telemetry, agentRuntime);
    recordVerificationReview(scratchpad, verifierReview);
    evaluation = await runStopEvaluation(plan, scratchpad, combinedEvidence, verification, index + 1);
    const graphVersion = await knowledgeGraph.updateFromNewEvidence(round.evidence_items, {
      label: `round_${index + 1}`,
      round: index + 1,
      question
    });
    updateQuestionStatus(scratchpad, evaluation.resolved_questions, evaluation.missing_questions);
    recordDecision(scratchpad, {
      type: "evaluation",
      round: index + 1,
      is_sufficient: evaluation.is_sufficient,
      next_best_action: evaluation.next_best_action,
      missing_questions: evaluation.missing_questions
    });
    scratchpad.workspace.knowledge_graph = {
      latest_version: graphVersion.version,
      counts: graphVersion.version.counts,
      evolution_summary: graphVersion.evolution_summary,
      stale_claims: graphVersion.stale_claims,
      hidden_links: graphVersion.hidden_links
    };

    const roundAgentReport = {
      round: index + 1,
      llm_orchestrator: {
        queries,
        dispatched_tasks: round.routed_tasks
      },
      collector_layer: {
        video_parser: round.routed_tasks.filter((item) => item.agent === "video_parser").length,
        long_text_collector: round.routed_tasks.filter((item) => item.agent === "long_text_collector").length,
        chart_parser: round.routed_tasks.filter((item) => item.agent === "chart_parser").length,
        table_parser: round.routed_tasks.filter((item) => item.agent === "table_parser").length
      },
      fact_verifier: {
        conflict_count: verification.conflicts.length,
        single_source_claims: verification.coverage_gaps.length,
        review_count: verifierReview.summary.review_count,
        follow_ups: verifierReview.tasks
      },
      ephemeral_tools: round.tool_attempts.map((item) => ({
        strategy: item.tool.strategy,
        success: item.success,
        target: item.target?.url || item.target?.title || "unknown target",
        validation: item.validation || null,
        promotion: item.promotion || null
      }))
    };
    scratchpad.agent_reports.push(roundAgentReport);
    recordAgentArtifact(scratchpad, "llm_orchestrator", {
      type: "round_report",
      round: index + 1,
      queries,
      dispatched_tasks: round.routed_tasks
    });
    recordAgentArtifact(scratchpad, "fact_verifier", {
      type: "verification_report",
      round: index + 1,
      conflict_count: verification.conflicts.length,
      single_source_claims: verification.coverage_gaps.length,
      review_count: verifierReview.summary.review_count
    });
    scratchpad.facts_collected = combinedEvidence.flatMap((item) => item.facts || []);

    const roundSummary = {
      round: index + 1,
      queries,
      chosen_connector_ids: roundConnectorIds,
      site_search_strategies: plan.site_search_strategies || [],
      executed_search_tasks: round.executed_search_tasks || [],
      candidates_returned: round.candidates.length,
      selected_sources: round.selected.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        content_type: item.content_type || item.source_type,
        source_type: item.content_type || item.source_type,
        connector: item.connector
      })),
      routed_tasks: round.routed_tasks,
      evaluation_snapshot: {
        is_sufficient: evaluation.is_sufficient,
        next_best_action: evaluation.next_best_action,
        missing_questions: evaluation.missing_questions
      },
      tool_attempts: round.tool_attempts.map((item) => ({
        strategy: item.tool.strategy,
        success: item.success,
        target: item.target?.url || item.target?.title || "unknown target",
        validation: item.validation || null,
        promotion: item.promotion || null,
        audit: item.audit || []
      })),
      agent_reports: roundAgentReport
    };
    rounds.push(roundSummary);
    updateConnectorHealthSnapshot(telemetry, roundConnectorIds, index + 1);

    await emitProgress(onProgress, {
      type: "round",
      round: roundSummary,
      totals: {
        candidates: combinedCandidates.length,
        reads: combinedReads.length
      }
    });
    await emitProgress(onProgress, {
      type: "evaluation",
      round: index + 1,
      evaluation
    });
    await emitProgress(onProgress, {
      type: "connector_health",
      round: index + 1,
      connector_health: telemetry.connector_health
    });

    if (evaluation.stop_state?.should_stop_now) {
      telemetry.stop_reason = evaluation.stop_state.reason;
      break;
    }

    if (evaluation.next_best_action === "run_follow_up_search") {
      const nextConnectorIds = buildNextRoundConnectorIds(plan, roundConnectorIds, evaluation, telemetry.connector_health);
      if (nextConnectorIds.join("|") !== roundConnectorIds.join("|")) {
        recordDecision(scratchpad, {
          type: "connector_selection",
          round: index + 1,
          chosen_connector_ids: nextConnectorIds,
          rationale: "merged with evaluator suggested_connector_ids"
        });
      }
      activeConnectorIds = nextConnectorIds;
    }
  }

  if (!evaluation) {
    evaluation = buildEmptyEvaluation(plan, rounds.length);
    telemetry.stop_reason = "no_usable_candidates";
    await emitProgress(onProgress, {
      type: "evaluation",
      round: rounds.length,
      evaluation
    });
  }

  if (!telemetry.stop_reason) {
    telemetry.stop_reason = evaluation.stop_state?.reason === "continue_search"
      ? "completed"
      : evaluation.stop_state?.reason || "completed";
  }

  scratchpad.stop_reason = telemetry.stop_reason;
  recordDecision(scratchpad, {
    type: "stop_reason",
    value: telemetry.stop_reason
  });
  const connectorIdsForHealth = Array.from(new Set([
    ...(plan.chosen_connector_ids || []),
    ...rounds.flatMap((item) => item.chosen_connector_ids || [])
  ]));
  updateConnectorHealthSnapshot(telemetry, connectorIdsForHealth, rounds.length);

  await emitProgress(onProgress, {
    type: "synthesizing",
    counts: {
      rounds: rounds.length,
      candidates: combinedCandidates.length,
      reads: combinedReads.length
    }
  });

  const synthesisTask = dispatchAgentTask(agentRuntime, {
    from: "llm_orchestrator",
    agentId: "llm_orchestrator",
    taskType: "synthesize_answer",
    input: {
      evidence_count: combinedEvidence.length,
      verification
    },
    metadata: {
      rounds: rounds.length
    }
  });
  const finalAnswer = await synthesize(question, mode, combinedCandidates, combinedReads, combinedEvidence, verification, evaluation, telemetry);
  completeAgentTask(agentRuntime, synthesisTask.id, {
    confidence: finalAnswer?.deep_research_summary?.confidence || null,
    answer_sections: Object.keys(finalAnswer || {})
  });
  const knowledgeGraphExport = knowledgeGraph.export();
  const toolMemory = recordToolOutcome(telemetry.ephemeral_tools);
  const memory = readExperienceMemory();
  const experience = await finalizeExperienceMemory(
    question,
    scratchpad,
    plan,
    evaluation,
    telemetry,
    verification,
    finalAnswer,
    memory
  );
  const nextMemory = recordExperienceMemoryEntry(memory, experience, { limit: 30 });
  writeExperienceMemory(nextMemory);
  writeKnowledgeGraph(knowledgeGraph);

  return {
    task_id: `task_${Date.now()}`,
    question,
    plan,
    rounds,
    candidates: combinedCandidates.slice(0, 12),
    reads: combinedReads,
    evidence: combinedEvidence,
    verification,
    evaluation,
    scratchpad,
    knowledge_graph: knowledgeGraphExport,
    runtime: {
      capabilities: runtimeCapabilities,
      tool_audit_recent: getToolAuditLog(20)
    },
    agent_runtime: getAgentRuntimeSnapshot(agentRuntime),
    telemetry,
    tool_memory: toolMemory,
    experience_overview: summarizeExperienceMemory(nextMemory),
    experience,
    final_answer: finalAnswer
  };
}

module.exports = {
  runResearch,
  getSamples,
  getExperienceMemory,
  summarizeExperienceMemory,
  listExperienceMemory,
  setExperiencePinned,
  clearExperienceMemory,
  getToolMemory,
  getToolAuditLog,
  getSourceCapabilities,
  synthesizeTool,
  runEphemeralTool,
  __internal: {
    inferPreferredConnectors,
    chooseConnectorsForQuestion,
    buildStopPolicy,
    extractTextFromResponsePayload,
    normalizeModelConnectorIds,
    normalizeModelSelectedCandidateIds,
    mergePlanWithModelSelection,
    buildPlan,
    planner,
    getRelevantExperienceHints,
    normalizeExperienceEntry,
    mergeExperienceEntries,
    recordExperienceMemoryEntry,
    summarizeExperience,
    requestExperienceMemoryFromModel,
    applyExperienceMemoryModelOutput,
    finalizeExperienceMemory,
    summarizeExperienceMemory,
    listExperienceMemory,
    setExperiencePinned,
    clearExperienceMemory,
    requestCandidateRoutingFromModel,
    selectCandidatesWithRouting,
    requestFinalSynthesisFromModel,
    synthesize,
    buildEvidenceItems,
    buildEvaluationScorecard,
    buildStopDecisionContext,
    requestStopDecisionFromModel,
    mergeEvaluationWithStopDecision,
    deriveStopOutcome,
    runStopEvaluation,
    buildEmptyEvaluation,
    crossCheckFacts,
    evaluator,
    buildFollowUpQueries,
    buildNextRoundConnectorIds,
    updateConnectorHealthSnapshot,
    fetchOpenAIJsonWithRetry,
    routeCandidate,
    createScratchpad,
    updateQuestionStatus,
    appendTimelineEvent
  }
};
