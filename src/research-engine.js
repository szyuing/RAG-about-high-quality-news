const fs = require("fs");
require("./project-env").initializeProjectEnv();
const { samplePrompts, sourceCatalog, ToolRegistry, __internal } = require("./source-connectors");
const { createEvidenceUnit } = require("./evidence-model");
const { extractTextFromResponsePayload, normalizeResponsesRequestBody, readResponsesApiPayload } = require("./openai-response");
const { resolveDataFile } = require("./data-paths");
const {
  getAllSiteProfiles,
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
const { provisionSiteConnectorsForStrategies } = require("./site-connector-provisioner");
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
const OPENAI_REQUEST_TIMEOUT_MS = Math.max(20000, Number(process.env.OPENSEARCH_OPENAI_TIMEOUT_MS || 90000));
const ROUTABLE_AGENT_IDS = ["long_text_collector", "video_parser", "chart_parser", "fact_verifier"];
const ROUTABLE_TOOL_IDS = ["deep_read_page", "extract_video_intel", "read_document_intel"];
const OPENAI_MAX_ATTEMPTS = Math.max(1, Number(process.env.OPENSEARCH_OPENAI_MAX_ATTEMPTS || 2));
const OPENAI_RETRY_BASE_MS = Math.max(100, Number(process.env.OPENSEARCH_OPENAI_RETRY_BASE_MS || 400));
const DEEP_MAX_QUERIES = Math.max(4, Number(process.env.OPENSEARCH_DEEP_MAX_QUERIES || 6));
const DEEP_MAX_CONNECTORS = Math.max(4, Number(process.env.OPENSEARCH_DEEP_MAX_CONNECTORS || 6));
const DEEP_MAX_SELECTED_CANDIDATES = Number(process.env.OPENSEARCH_DEEP_MAX_SELECTED_CANDIDATES || 0);
const DEEP_MAX_SITE_HINT_TASKS = Math.max(4, Number(process.env.OPENSEARCH_DEEP_MAX_SITE_HINT_TASKS || 6));
const DEEP_MAX_ROUNDS = Math.max(2, Number(process.env.OPENSEARCH_DEEP_MAX_ROUNDS || 2));
const CONTROL_ACTION_TYPES = Object.freeze({
  ROUTE_READS: "route_reads",
  RUN_VERIFICATION: "run_verification",
  CONTINUE_SEARCH: "continue_search",
  ANSWER_NOW: "answer_now",
  STOP_PARTIAL: "stop_partial"
});

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

async function fetchOpenAIJsonWithRetry(apiKey, body, { timeoutMs = OPENAI_REQUEST_TIMEOUT_MS, operation = "openai_request", maxAttempts = OPENAI_MAX_ATTEMPTS } = {}) {
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
        body: JSON.stringify(normalizeResponsesRequestBody(body, { forceStream: true }))
      });
      const { rawText, payload } = await readResponsesApiPayload(response);
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
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
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

function normalizeModelSelectedCandidateIds(candidateIds, fallbackIds = [], maxSelected = 4) {
  const selected = [];

  for (const id of candidateIds || []) {
    if (!id || selected.includes(id)) {
      continue;
    }
    selected.push(id);
    if (selected.length >= maxSelected) {
      break;
    }
  }

  for (const id of fallbackIds || []) {
    if (!id || selected.includes(id)) {
      continue;
    }
    selected.push(id);
    if (selected.length >= maxSelected) {
      break;
    }
  }

  return selected.slice(0, maxSelected);
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
  const allowedModes = new Set(["connector_search", "site_query", "hybrid", "verify_only"]);
  const connectors = basePlan?.source_capabilities || [];

  function inferConnectorId(item, domain, siteName) {
    const explicitId = String(item?.connector_id || "").trim();
    if (validConnectorIds.has(explicitId)) {
      return explicitId;
    }
    if (domain) {
      const resolved = resolveConnectorIdForDomain(basePlan, domain);
      if (resolved.connector_id) {
        return resolved.connector_id;
      }
    }
    const normalizedSiteName = normalizeText(siteName || item?.site_name || item?.name || "");
    if (!normalizedSiteName) {
      return null;
    }
    const matched = connectors.find((connector) => {
      const idText = normalizeText(connector.id || "");
      const labelText = normalizeText(connector.label || "");
      return normalizedSiteName === idText || normalizedSiteName === labelText;
    });
    return matched?.id || null;
  }

  return (strategies || [])
    .map((item) => {
      const domain = normalizeSiteDomain(item?.domain || item?.site_domain || "");
      const siteName = String(item?.site_name || item?.name || domain || "").trim();
      const connectorId = inferConnectorId(item, domain, siteName);
      const searchMode = allowedModes.has(item?.search_mode)
        ? item.search_mode
        : (domain && !connectorId ? "site_query" : "connector_search");
      const queryVariants = compactStringList(item?.query_variants, { minLength: 2, limit: 4 });
      const rationale = String(item?.rationale || item?.reason || "").trim();

      if (!siteName && !domain) {
        return null;
      }
      if (!domain && (searchMode === "site_query" || searchMode === "hybrid")) {
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

function rootDomainFromHost(domain) {
  const normalized = normalizeSiteDomain(domain);
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(".");
  if (parts.length <= 2) {
    return normalized;
  }
  return parts.slice(-2).join(".");
}

function buildSiteFilterVariants(domain) {
  const normalizedDomain = normalizeSiteDomain(domain);
  if (!normalizedDomain) {
    return [];
  }
  return Array.from(new Set([
    normalizedDomain,
    `www.${normalizedDomain}`
  ])).filter(Boolean);
}

function stripSiteFilterFromQuery(query, domain) {
  let nextQuery = String(query || "");
  for (const variant of buildSiteFilterVariants(domain)) {
    nextQuery = nextQuery.replace(new RegExp(`\bsite:${variant.replace(/\./g, "\\.")}\b`, "ig"), " ");
  }
  return nextQuery.replace(/\s+/g, " ").trim();
}

function siteStrategyDomainKey(domain) {
  return normalizeSiteDomain(domain);
}

function scoreQueryIntentSiteCandidate(candidate) {
  return (
    (candidate.hintMatched ? 1000 : 0)
    + (candidate.tokenMatched ? 100 : 0)
    + (candidate.tokenMatched ? Math.max(0, 20 - ((candidate.bestTokenLabelIndex ?? 0) * 10)) : 0)
    + ((candidate.matchCount || 0) * 10)
    + ((candidate.distinctQueryCount || 0) * 5)
    + ((candidate.hostDepth || 0) * 2)
    - (candidate.firstQueryIndex || 0)
  );
}

function buildSiteNameFromDomain(domain) {
  const normalized = normalizeSiteDomain(domain);
  return normalized || "site";
}

const AUTO_SITE_STRATEGY_LIMIT = 3;
const SEARCH_ENTRY_ROOT_DOMAINS = new Set([
  "baidu.com",
  "bing.com",
  "google.com",
  "duckduckgo.com",
  "yahoo.com",
  "yandex.com",
  "sogou.com",
  "so.com"
]);

function buildEvidenceMatchFragments(values = []) {
  const fragments = new Set();
  for (const value of values) {
    const normalized = normalizeText(value).replace(/\s+/g, " ").trim();
    if (!normalized) {
      continue;
    }
    for (const token of normalized.split(" ").filter(Boolean)) {
      if (/^[a-z0-9._-]{3,}$/i.test(token)) {
        fragments.add(token);
        continue;
      }
      const compact = token.replace(/\s+/g, "");
      for (let size = 2; size <= Math.min(4, compact.length); size += 1) {
        for (let index = 0; index <= compact.length - size; index += 1) {
          fragments.add(compact.slice(index, index + size));
          if (fragments.size >= 240) {
            return Array.from(fragments);
          }
        }
      }
    }
  }
  return Array.from(fragments);
}

function scoreEvidenceShapeQueryMatch(query, evidenceFragments = []) {
  const normalizedQuery = normalizeText(String(query || "").replace(/\bsite:[^\s]+/ig, " "));
  if (!normalizedQuery || !evidenceFragments.length) {
    return 0;
  }
  let score = 0;
  for (const fragment of evidenceFragments) {
    if (!fragment || !normalizedQuery.includes(fragment)) {
      continue;
    }
    score += /^[a-z0-9._-]+$/i.test(fragment)
      ? 2
      : Math.max(1, Math.min(3, fragment.length - 1));
    if (score >= 18) {
      return score;
    }
  }
  return score;
}

function isLikelySearchEntryHost(domain) {
  const normalized = normalizeSiteDomain(domain);
  if (!normalized) {
    return false;
  }
  const rootDomain = rootDomainFromHost(normalized);
  if (SEARCH_ENTRY_ROOT_DOMAINS.has(rootDomain)) {
    return true;
  }
  const firstLabel = normalized.split(".")[0] || "";
  return ["search", "query", "sou", "sousuo", "so"].includes(firstLabel);
}

function connectorSupportsDomain(connector, domain) {
  const normalizedDomain = normalizeSiteDomain(domain);
  const connectorDomains = Array.isArray(connector?.domains) ? connector.domains : [];
  return connectorDomains.some((item) => {
    const normalizedItem = normalizeSiteDomain(item);
    return normalizedItem && (normalizedDomain === normalizedItem || normalizedDomain.endsWith(`.${normalizedItem}`));
  });
}

function resolveConnectorIdForDomain(basePlan, domain) {
  const connectors = basePlan?.source_capabilities || [];
  const searchCapable = connectors.find((item) => item?.supports_search === true && connectorSupportsDomain(item, domain));
  if (searchCapable) {
    return { connector_id: searchCapable.id, search_mode: "connector_search" };
  }
  const readOnly = connectors.find((item) => item?.supports_read === true && connectorSupportsDomain(item, domain));
  if (readOnly) {
    return { connector_id: readOnly.id, search_mode: "site_query" };
  }
  return { connector_id: null, search_mode: "site_query" };
}

function extractOfficialSiteCandidates(basePlan, initialQueries, siteSearchStrategies, requiredEvidence = []) {
  const existingDomains = new Set((siteSearchStrategies || []).map((item) => siteStrategyDomainKey(item.domain)).filter(Boolean));
  const results = [];
  const seenDomains = new Set();
  const officialHints = (basePlan?.search_site_hints?.items || [])
    .filter((item) => normalizeSiteDomain(item?.domain))
    .filter((item) => String(item?.category || "").toLowerCase() === "official");

  for (const hint of officialHints) {
    const domain = siteStrategyDomainKey(hint.domain);
    if (!domain || existingDomains.has(domain) || seenDomains.has(domain)) {
      continue;
    }
    results.push({
      domain,
      site_name: String(hint.name || buildSiteNameFromDomain(domain)).trim() || buildSiteNameFromDomain(domain),
      query_variants: compactStringList((initialQueries || []).map((query) => stripSiteFilterFromQuery(query, domain)), { minLength: 2, limit: 4 }),
      rationale: "auto-added official site strategy from official site hint",
      score: 5000
    });
    seenDomains.add(domain);
    if (results.length >= AUTO_SITE_STRATEGY_LIMIT) {
      return results;
    }
  }

  const questionTokens = tokenize([
    basePlan?.task_goal || "",
    ...((initialQueries || []).map((query) => String(query || "").replace(/\bsite:[^\s]+/ig, " ")))
  ].join(" "))
    .filter((token) => /^[a-z0-9._-]{3,}$/i.test(token));
  const evidenceFragments = buildEvidenceMatchFragments([
    basePlan?.task_goal || "",
    ...(requiredEvidence || [])
  ]);
  const rootQueryMap = new Map();
  const candidateMap = new Map();

  for (const [queryIndex, query] of (initialQueries || []).entries()) {
    const queryText = String(query || "");
    const matches = queryText.match(/\bsite:([a-z0-9.-]+\.[a-z]{2,})\b/ig) || [];
    for (const rawMatch of matches) {
      const rawDomain = rawMatch.replace(/^site:/i, "");
      const domain = siteStrategyDomainKey(rawDomain);
      if (!domain || existingDomains.has(domain) || seenDomains.has(domain)) {
        continue;
      }
      const rootDomain = rootDomainFromHost(domain);
      if (!rootQueryMap.has(rootDomain)) {
        rootQueryMap.set(rootDomain, new Set());
      }
      rootQueryMap.get(rootDomain).add(queryText);

      const hostLabels = domain.split(".").filter(Boolean);
      const bestTokenLabelIndex = hostLabels.findIndex((label) => questionTokens.some((token) => label.includes(token) || token.includes(label)));
      const tokenMatched = bestTokenLabelIndex !== -1;
      const evidenceScoreForQuery = scoreEvidenceShapeQueryMatch(queryText, evidenceFragments);
      const current = candidateMap.get(domain) || {
        domain,
        rootDomain,
        site_name: buildSiteNameFromDomain(domain),
        tokenMatched: false,
        bestTokenLabelIndex: hostLabels.length,
        matchCount: 0,
        evidenceMatchedQueryCount: 0,
        evidenceScore: 0,
        distinctQueries: new Set(),
        matchedQueries: [],
        firstQueryIndex: queryIndex,
        hostDepth: Math.max(0, hostLabels.length - 2)
      };
      current.tokenMatched = current.tokenMatched || tokenMatched;
      current.bestTokenLabelIndex = Math.min(current.bestTokenLabelIndex, tokenMatched ? bestTokenLabelIndex : hostLabels.length);
      current.matchCount += 1;
      current.evidenceScore += evidenceScoreForQuery;
      current.evidenceMatchedQueryCount += evidenceScoreForQuery > 0 ? 1 : 0;
      current.distinctQueries.add(queryText);
      if (!current.matchedQueries.includes(queryText)) {
        current.matchedQueries.push(queryText);
      }
      current.firstQueryIndex = Math.min(current.firstQueryIndex, queryIndex);
      candidateMap.set(domain, current);
    }
  }

  const ranked = Array.from(candidateMap.values())
    .map((item) => {
      const distinctQueryCount = item.distinctQueries.size;
      const rootDistinctQueryCount = rootQueryMap.get(item.rootDomain)?.size || 0;
      const searchEntry = isLikelySearchEntryHost(item.domain);
      const evidenceCompatible = item.evidenceMatchedQueryCount > 0 || item.evidenceScore > 0;
      const confidenceEligible = !searchEntry
        && evidenceCompatible
        && (distinctQueryCount >= 2 || rootDistinctQueryCount >= 2);
      const score = scoreQueryIntentSiteCandidate({
        ...item,
        distinctQueryCount,
        hintMatched: false
      }) + item.evidenceScore + (evidenceCompatible ? 30 : 0) + (searchEntry ? -1000 : 0);
      return {
        domain: item.domain,
        site_name: item.site_name,
        query_variants: compactStringList([
          ...item.matchedQueries.map((query) => stripSiteFilterFromQuery(query, item.domain)),
          basePlan?.task_goal || ""
        ], { minLength: 2, limit: 4 }),
        rationale: "auto-added site strategy from high-confidence query intent",
        distinctQueryCount,
        rootDistinctQueryCount,
        evidenceMatchedQueryCount: item.evidenceMatchedQueryCount,
        searchEntry,
        confidenceEligible,
        score
      };
    })
    .filter((item) => item.confidenceEligible)
    .sort((left, right) => right.score - left.score)
    .slice(0, AUTO_SITE_STRATEGY_LIMIT - results.length);

  for (const candidate of ranked) {
    if (seenDomains.has(candidate.domain)) {
      continue;
    }
    results.push(candidate);
    seenDomains.add(candidate.domain);
  }

  return results.slice(0, AUTO_SITE_STRATEGY_LIMIT);
}

function ensureOfficialSiteStrategy(basePlan, initialQueries, siteSearchStrategies, requiredEvidence = []) {
  const candidates = extractOfficialSiteCandidates(basePlan, initialQueries, siteSearchStrategies, requiredEvidence);
  if (!candidates.length) {
    return siteSearchStrategies;
  }

  const additions = candidates.map((candidate) => {
    const resolved = resolveConnectorIdForDomain(basePlan, candidate.domain);
    const fallbackQueries = compactStringList([
      ...((candidate.query_variants || []).map((query) => stripSiteFilterFromQuery(query, candidate.domain))),
      stripSiteFilterFromQuery(initialQueries?.[0] || "", candidate.domain),
      basePlan?.task_goal || ""
    ], { minLength: 2, limit: 4 });

    return {
      site_name: candidate.site_name,
      domain: candidate.domain,
      connector_id: resolved.connector_id,
      search_mode: resolved.search_mode,
      query_variants: candidate.query_variants?.length ? candidate.query_variants : fallbackQueries,
      rationale: candidate.rationale
    };
  });

  return [
    ...additions,
    ...(siteSearchStrategies || [])
  ].slice(0, 6);
}

function deriveChosenConnectorIds(basePlan, modelSelection) {
  void basePlan;
  return normalizeModelConnectorIds(
    [
      ...(modelSelection?.chosen_connector_ids || modelSelection?.connectors || []),
      ...((modelSelection?.connector_reasons || []).map((item) => item.id).filter(Boolean))
    ],
    []
  );
}

const SEARCH_LANE_DEFINITIONS = Object.freeze([
  {
    id: "general_breadth",
    agent_id: "web_researcher",
    label: "General Breadth",
    connector_priority: ["bing_web"],
    query_modifiers: [],
    score_boost: 0.01
  },
  {
    id: "official_surface",
    agent_id: "long_text_collector",
    label: "Official Surface",
    connector_priority: ["google", "bing_web"],
    query_modifiers: ["official", "announcement", "blog", "docs", "官方 公告"],
    score_boost: 0.06
  },
  {
    id: "developer_surface",
    agent_id: "table_parser",
    label: "Developer Surface",
    connector_priority: ["github", "stack_overflow", "hacker_news", "segmentfault", "bing_web"],
    query_modifiers: ["github", "repo", "release", "readme", "api", "docs"],
    score_boost: 0.04
  },
  {
    id: "news_verification",
    agent_id: "fact_verifier",
    label: "News Verification",
    connector_priority: ["reuters", "ap_news", "bbc_news", "bloomberg", "nytimes", "wsj", "xinhua", "people", "cctv_news", "the_paper", "caixin", "jiemian", "bing_web"],
    query_modifiers: ["news", "report", "official statement", "报道", "声明"],
    score_boost: 0.05
  },
  {
    id: "community_signal",
    agent_id: "chart_parser",
    label: "Community Signal",
    connector_priority: ["zhihu", "reddit", "wikipedia", "hacker_news", "segmentfault", "bing_web"],
    query_modifiers: ["discussion", "analysis", "rumor", "知乎", "Reddit"],
    score_boost: 0.02
  }
]);

function buildLaneDomainGroups() {
  return {
    developer: new Set(["github.com", "stackoverflow.com", "news.ycombinator.com", "segmentfault.com"]),
    news: new Set(["reuters.com", "apnews.com", "bbc.com", "bloomberg.com", "nytimes.com", "wsj.com", "xinhua.net", "people.com.cn", "cctv.com", "thepaper.cn", "caixin.com", "jiemian.com"]),
    community: new Set(["zhihu.com", "reddit.com", "wikipedia.org", "news.ycombinator.com", "segmentfault.com"])
  };
}

function buildSearchLaneConnectorIds(plan, lane) {
  const availableIds = new Set((plan?.source_capabilities || []).map((item) => item.id));
  const generatedIds = (plan?.source_capabilities || [])
    .map((item) => item.id)
    .filter((id) => /^site_/i.test(id));
  const laneSpecific = compactStringList([
    ...lane.connector_priority,
    ...(lane.id === "official_surface" ? generatedIds : []),
    ...(plan?.chosen_connector_ids || [])
  ], { minLength: 2, limit: 12 })
    .filter((id) => availableIds.has(id));

  if (lane.id === "general_breadth") {
    return normalizeModelConnectorIds([
      ...(plan?.chosen_connector_ids || []),
      "bing_web"
    ], ["bing_web"], 8);
  }

  return normalizeModelConnectorIds(laneSpecific, ["bing_web"], 8);
}

function matchesLaneDomain(domain, domainSet) {
  const normalizedDomain = normalizeSiteDomain(domain);
  if (!normalizedDomain || !domainSet?.size) {
    return false;
  }
  if (domainSet.has(normalizedDomain)) {
    return true;
  }
  for (const item of domainSet) {
    if (normalizedDomain.endsWith(`.${item}`)) {
      return true;
    }
  }
  return false;
}

function filterSiteStrategiesForLane(plan, lane) {
  const strategies = plan?.site_search_strategies || [];
  if (!strategies.length || lane.id === "general_breadth") {
    return strategies;
  }

  const groups = buildLaneDomainGroups();
  return strategies.filter((strategy) => {
    const domain = normalizeSiteDomain(strategy?.domain || "");
    const resolvedConnectorId = strategy?.resolved_connector_id
      || strategy?.connector_id
      || (domain ? resolveConnectorIdForDomain(plan, domain).connector_id : null);

    if (lane.id === "official_surface") {
      if (resolvedConnectorId && /^site_/i.test(resolvedConnectorId)) {
        return true;
      }
      if (!domain) {
        return Boolean(strategy?.search_mode === "verify_only");
      }
      return !matchesLaneDomain(domain, groups.developer)
        && !matchesLaneDomain(domain, groups.news)
        && !matchesLaneDomain(domain, groups.community);
    }

    if (lane.id === "developer_surface") {
      return resolvedConnectorId === "github"
        || resolvedConnectorId === "stack_overflow"
        || resolvedConnectorId === "hacker_news"
        || resolvedConnectorId === "segmentfault"
        || matchesLaneDomain(domain, groups.developer);
    }

    if (lane.id === "news_verification") {
      return lane.connector_priority.includes(resolvedConnectorId)
        || matchesLaneDomain(domain, groups.news);
    }

    if (lane.id === "community_signal") {
      return lane.connector_priority.includes(resolvedConnectorId)
        || matchesLaneDomain(domain, groups.community);
    }

    return false;
  });
}

function buildLaneQueries(question, queries, lane, laneSiteStrategies = []) {
  return compactStringList([
    ...(queries || []),
    ...lane.query_modifiers.map((modifier) => `${question} ${modifier}`),
    ...laneSiteStrategies.flatMap((strategy) => strategy?.query_variants || [])
  ], { minLength: 2, limit: 12 });
}

function buildParallelSearchLanes(plan, question, queries) {
  const lanes = SEARCH_LANE_DEFINITIONS.map((lane) => {
    const connectorIds = buildSearchLaneConnectorIds(plan, lane);
    const siteStrategies = filterSiteStrategiesForLane(plan, lane);
    const laneQueries = buildLaneQueries(question || plan?.task_goal || "", queries, lane, siteStrategies);
    const active = connectorIds.length > 0 && laneQueries.length > 0;
    if (!active) {
      return null;
    }

    return {
      ...lane,
      connector_ids: connectorIds,
      queries: laneQueries,
      site_search_strategies: siteStrategies,
      plan: {
        ...plan,
        chosen_connector_ids: connectorIds,
        site_search_strategies: siteStrategies,
        execution_budget: {
          ...(plan?.execution_budget || {}),
          max_queries: Math.max(laneQueries.length, Number(plan?.execution_budget?.max_queries || 0)),
          max_site_hint_tasks: Math.max(
            (siteStrategies || []).length * 3,
            Number(plan?.execution_budget?.max_site_hint_tasks || 0)
          )
        }
      }
    };
  }).filter(Boolean);

  return lanes.length
    ? lanes
    : [{
        id: "general_breadth",
        agent_id: "web_researcher",
        label: "General Breadth",
        connector_ids: normalizeModelConnectorIds(plan?.chosen_connector_ids || [], ["bing_web"], 8),
        queries: compactStringList(queries, { minLength: 2, limit: 12 }),
        site_search_strategies: plan?.site_search_strategies || [],
        score_boost: 0.01,
        plan
      }];
}

function annotateLaneCandidate(candidate, lane) {
  return {
    ...candidate,
    score: Number((toFiniteNumber(candidate?.score, 0) + toFiniteNumber(lane?.score_boost, 0)).toFixed(4)),
    metadata: {
      ...(candidate?.metadata || {}),
      search_lane: lane?.id || null,
      search_agent: lane?.agent_id || null,
      search_lane_label: lane?.label || null
    }
  };
}

function deriveRuntimeConnectorCandidates(basePlan, siteSearchStrategies, fallbackConnectorIds = []) {
  const strategyConnectorIds = compactStringList(
    (siteSearchStrategies || []).flatMap((item) => [item?.resolved_connector_id, item?.connector_id]).filter(Boolean),
    { minLength: 1, limit: 6 }
  );

  const inferredConnectorIds = compactStringList(
    (siteSearchStrategies || []).map((item) => resolveConnectorIdForDomain(basePlan, item?.domain || "").connector_id).filter(Boolean),
    { minLength: 1, limit: 6 }
  );

  const needsBingWeb = (siteSearchStrategies || []).some((item) => {
    const effectiveSearchMode = item?.effective_search_mode || item?.search_mode;
    return ["site_query", "hybrid", "verify_only", "site_query_with_generated_read"].includes(effectiveSearchMode)
      || (!item?.resolved_connector_id && !item?.connector_id);
  }) || strategyConnectorIds.length === 0;

  return normalizeModelConnectorIds(
    [
      ...strategyConnectorIds,
      ...inferredConnectorIds,
      ...(needsBingWeb ? ["bing_web"] : []),
      ...(fallbackConnectorIds || [])
    ],
    needsBingWeb ? ["bing_web"] : []
  );
}

function buildPreferredConnectors(basePlan, chosenConnectorIds, connectorReasons = []) {
  const reasonMap = new Map((connectorReasons || []).map((item) => [item.id, item.reason]));
  return (chosenConnectorIds || [])
    .map((id) => {
      const source = (basePlan?.source_capabilities || []).find((item) => item.id === id);
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
}

function normalizeConnectorSelectionModelOutput(modelOutput, connectors = []) {
  const normalizedInput = modelOutput && typeof modelOutput === "object" ? modelOutput : {};
  const rawConnectorReasons = Array.isArray(normalizedInput.connector_reasons)
    ? normalizedInput.connector_reasons
    : [];
  const explanationEntries = normalizedInput.explanations && typeof normalizedInput.explanations === "object"
    ? Object.entries(normalizedInput.explanations)
    : [];
  const availableConnectorIds = normalizeModelConnectorIds((connectors || []).map((item) => item.id), []);
  const chosenConnectorIds = normalizeModelConnectorIds(
    [
      ...(Array.isArray(normalizedInput.chosen_connector_ids) ? normalizedInput.chosen_connector_ids : []),
      ...(Array.isArray(normalizedInput.connectors) ? normalizedInput.connectors : []),
      ...rawConnectorReasons.map((item) => item?.id).filter(Boolean),
      ...explanationEntries.map(([id]) => id).filter(Boolean)
    ],
    []
  ).filter((id) => availableConnectorIds.includes(id));

  const connectorReasons = uniqueObjectList([
    ...(rawConnectorReasons.map((item) => ({
      id: String(item?.id || "").trim(),
      reason: String(item?.reason || "").trim()
    }))),
    ...explanationEntries.map(([id, reason]) => ({
      id: String(id || "").trim(),
      reason: String(reason || "").trim()
    })),
    ...chosenConnectorIds.map((id) => {
      const source = (connectors || []).find((item) => item.id === id);
      return {
        id,
        reason: String(source?.description || "").trim()
      };
    })
  ].filter((item) => chosenConnectorIds.includes(item.id) && item.reason), (item) => item.id, 4);

  return {
    chosen_connector_ids: chosenConnectorIds,
    connector_reasons: connectorReasons,
    rationale: String(
      normalizedInput.rationale
      || normalizedInput.reason
      || (connectorReasons.length ? "normalized connector selection output" : "")
    ).trim()
  };
}

function enrichConnectorSelectionWithPlannedSiteCoverage(selection, basePlan, planningDraft) {
  const normalizedSelection = selection && typeof selection === "object"
    ? selection
    : { chosen_connector_ids: [], connector_reasons: [], rationale: "" };
  const strategies = normalizeModelSiteSearchStrategies(planningDraft?.site_search_strategies, basePlan);
  const coveredStrategies = strategies
    .map((item) => {
      const resolved = item?.connector_id
        ? { connector_id: item.connector_id, search_mode: item.search_mode }
        : resolveConnectorIdForDomain(basePlan, item?.domain || "");
      if (!resolved.connector_id) {
        return null;
      }
      return {
        connector_id: resolved.connector_id,
        site_name: item.site_name,
        domain: item.domain,
        search_mode: item.search_mode || resolved.search_mode
      };
    })
    .filter(Boolean);

  const chosenConnectorIds = normalizeModelConnectorIds([
    ...(normalizedSelection.chosen_connector_ids || []),
    ...coveredStrategies.map((item) => item.connector_id)
  ], normalizedSelection.chosen_connector_ids || [], 4);

  const connectorReasons = uniqueObjectList([
    ...(normalizedSelection.connector_reasons || []),
    ...coveredStrategies.map((item) => ({
      id: item.connector_id,
      reason: `auto-added from planned site coverage for ${item.site_name || item.domain}`
    }))
  ].filter((item) => chosenConnectorIds.includes(item.id)), (item) => item.id, 4);

  return {
    ...normalizedSelection,
    chosen_connector_ids: chosenConnectorIds,
    connector_reasons: connectorReasons
  };
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
  if (/鑻规灉|iphone|apple/i.test(question)) {
    hints.push("Apple iPhone 16 performance benchmark");
    hints.push("Apple iPhone 16 vs iPhone 15 official");
    hints.push("iPhone 16 performance review");
  }
  if (/涓轰粈涔坾鍘熺悊|璁捐|workflow|planner|鎼滅储/i.test(question)) {
    hints.push("planner first search workflow");
    hints.push("evidence based search workflow");
  }
  if (/鏂囩尞|paper|research|鐮旂┒/i.test(question)) {
    hints.push("research paper");
  }
  if (/瑙嗛|鐩存挱|璁插骇|鍙戝竷浼氱殑|talk|video/i.test(question)) {
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

  if (/[\u4e00-\u9fff]/.test(question) && /涓枃/.test((connector.capabilities || []).join(" "))) {
    score += 2;
  }
  if (/鏈€鏂皘褰撳墠|鐜板湪|鍙戝竷|鍔ㄦ€亅鏂伴椈/.test(question) && /(鏂伴椈|鍔ㄦ€亅瀹樻柟缃戠珯)/.test((connector.capabilities || []).join(" "))) {
    score += 2;
  }
  if (/鏁欑▼|涓婃墜|浣撻獙|璇勬祴|婕旂ず/.test(question) && /(鏁欑▼|瑙嗛|绀惧尯)/.test((connector.capabilities || []).join(" "))) {
    score += 2;
  }
  if (/鏂囩尞|鐮旂┒|paper|research/i.test(question) && /(鏂囩尞|鐮旂┒)/.test((connector.capabilities || []).join(" "))) {
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
  const avoidedConnectorIds = new Set(experienceHints?.avoided_connector_ids || []);
  const chosen = preferred.map((item) => item.id)
    .filter(Boolean)
    .filter((id) => id === "bing_web" || !avoidedConnectorIds.has(id));

  if (!chosen.includes("bing_web")) {
    chosen.push("bing_web");
  }
  if (chosen.length < 2 && sourceCatalog[0]?.id) {
    chosen.push(sourceCatalog[0].id);
  }

  return Array.from(new Set(chosen)).slice(0, DEEP_MAX_CONNECTORS);
}

function buildStopPolicy(question, subQuestions) {
  void question;
  return {
    min_source_types: 2,
    min_evidence_items: 3,
    max_rounds: DEEP_MAX_ROUNDS,
    overall_coverage_threshold: 0.18,
    sub_question_coverage_threshold: 0.18,
    fallback_sub_question_coverage_threshold: 0.12,
    max_relevant_conflicts: 1,
    require_all_sub_questions: true,
    expected_sub_questions: subQuestions.length
  };
}

function applyExecutionModeToPlan(plan, mode) {
  void mode;
  const normalizedMode = "deep";
  const unlimitedSelectedCandidates = DEEP_MAX_SELECTED_CANDIDATES <= 0;
  const baseBudget = {
    mode: normalizedMode,
    max_queries: DEEP_MAX_QUERIES,
    max_connectors: DEEP_MAX_CONNECTORS,
    max_selected_candidates: unlimitedSelectedCandidates ? null : DEEP_MAX_SELECTED_CANDIDATES,
    max_site_hint_tasks: DEEP_MAX_SITE_HINT_TASKS,
    max_follow_up_queries: 4,
    max_specialist_reads: unlimitedSelectedCandidates ? null : Math.max(1, DEEP_MAX_SELECTED_CANDIDATES),
    max_tool_attempts_per_round: 2,
    degrade_after_connector_failures: 2,
    allow_ephemeral_fallbacks: true
  };

  return {
    ...plan,
    execution_budget: {
      ...baseBudget,
      ...(plan.execution_budget || {})
    }
  };
}

function normalizeModelConnectorIds(candidateIds, fallbackIds = [], maxCount = DEEP_MAX_CONNECTORS) {
  const validIds = new Set(sourceCatalog.map((item) => item.id));
  const selected = [];

  for (const id of candidateIds || []) {
    if (!validIds.has(id) || selected.includes(id)) {
      continue;
    }
    selected.push(id);
    if (selected.length >= maxCount) {
      break;
    }
  }

  for (const id of fallbackIds || []) {
    if (!validIds.has(id) || selected.includes(id)) {
      continue;
    }
    selected.push(id);
    if (selected.length >= maxCount) {
      break;
    }
  }

  return selected.slice(0, maxCount);
}

function buildPlannerConnectorDigest(connectors = []) {
  return (connectors || []).map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    capabilities: item.capabilities || [],
    generated: item.generated === true,
    domains: Array.isArray(item.domains) ? item.domains : [],
    supports_search: item.supports_search !== false,
    supports_read: item.supports_read !== false
  }));
}

function buildPlannerPrompt(question, basePlan, connectors = buildPlannerConnectorDigest(basePlan?.source_capabilities || [])) {
  void connectors;
  return [
    "你是一位高级证据获取规划师（Evidence Acquisition Strategist）。你的核心能力是：面对任何信息需求，通过结构化推理链，规划出最短路径、最高可信度的证据获取方案，并输出可直接执行的搜索行动清单。",
    "核心原则：永远不猜测，只规划获取路径。必须严格按 Step 1 到 Step 8 的顺序推理，但不要输出隐藏思考过程；请把每一步的结论显式填写到结构化 schema 对应字段中。",
    "Step 1｜拆解问题 — 到底在问什么：在 problem_breakdown 中明确原始意图、核心实体、目标信息、隐含约束与歧义处理。",
    "如果问题不完整、缺词、引号为空、对象省略、范围残缺或表达截断，不要停在澄清状态；应基于实体、上下文和最可能的搜索意图先自动补全成一个可搜索的完整问题，再继续规划。",
    "当存在多种可能补全时，选择最可能命中目标信息、最容易验证、最符合证据形态的那一种作为主规划方向，并在 problem_breakdown.ambiguity_resolution、sub_questions 或 required_evidence 中保留必要的歧义说明。",
    "自动补全时，优先补全会直接改变答案定位方式的缺失约束，例如作品形态、版本、时间范围、章节/集数范围、结尾/开头/全文等局部范围，而不是只做表面改写。",
    "如果问题是在问精确措辞、最后一句、某段对话、某一结尾内容，而提问里没有写清具体载体或局部范围，应主动把问题补全到可执行粒度，例如补到电视剧/电影/原著、最后一集/最后一章、结尾片段/最终页面这一层级。",
    "如果问题过于宽泛，仍需先给出暂行规划；同时把 problem_breakdown.clarification_needed 设为 true，并在 problem_breakdown.clarifying_question 中写出最关键的澄清问题。",
    "Step 2｜认知实体 — 这个东西是什么：对每个核心实体在 entity_profiles 中建立认知卡片，包含类别/领域、存在形态、归属方/出品方、生命周期状态、关联实体、别名/英文名/缩写，以及认知置信度。",
    "若对实体认知不确定，必须将 cognition_confidence 标为 低，并在 Step 4 与 Step 7 中增加验证性搜索和交叉验证。",
    "Step 3｜判断信息载体 — 答案藏在哪种内容里：在 evidence_strategy 中判断最可能的证据载体、所需粒度、需要原始数据还是加工结论、以及是否必须多源交叉验证。",
    "Step 4｜定位信息渠道 — 去哪里找：先按官方源、权威第三方、社区与 UGC、搜索引擎兜底的层级展开，再决定优先去哪几个网站与渠道。先决定去哪些网站，再决定如何搜索。",
    "Step 5｜筛选最优路径 — 走哪条路最快最准：在 recommended_paths 中按权威性、精确性、可及性、时效性排序，输出 Top 3 推荐路径，并写明选择理由与预期命中率。",
    "Step 6｜构建搜索行动方案 — 具体怎么搜：在 action_cards 中为每条推荐路径给出可执行行动卡片，包括入口 URL、主关键词、辅助关键词、搜索语法、筛选条件、站内导航、提取目标与注意事项。搜索关键词应尽量同时给出中英文版本；若不适用可留空。",
    "Step 7｜验证与兜底 — 结果靠谱吗：在 verification_and_fallback 中给出交叉验证策略、置信度、降级方案、终极兜底与时效标记。",
    "Step 8｜结构化输出 — 最终交付：由于运行时要求 JSON schema，最终不要输出 Markdown，而是用 schema 字段表达完整报告；recommended_paths 对应推荐获取路径表，action_cards 对应详细行动方案，verification_and_fallback 对应验证建议与兜底方案。",
    "规划时必须遵守：先判断证据形态，再决定网站与渠道，再决定搜索动作；不要从 connector availability 出发做规划。",
    "对于发布、版本、模型、产品更新、发布说明、API 变更、公告类问题，优先考虑官网、官方博客、API 文档、GitHub release、官方仓库说明页。",
    "对于精确引语、最后一句话、措辞、对话、字幕、剧本、章节结尾、原文类问题，优先考虑字幕、剧本、原文页、书籍、可直接检查结尾的视频等可核对文本载体。",
    "对于改编相关问题，必须先区分电视剧、电影、原著、配音版、字幕版、删减版、平台版等不同存在形态。",
    "不要把热度、流量、社区声量当作可信度代理，不要机械假设媒体一定排第二、社区一定排第三。",
    "site_search_strategies 只返回那些真正能提升召回、精度、验证质量或证据质量的网站。",
    "site_search_strategies 对应 Step 4 + Step 5，required_evidence 对应 Step 3 + Step 5，sub_questions 对应 Step 1 + Step 2，initial_queries 对应 Step 4 + Step 6。",
    "如果某个网站对答案很关键，即使当前没有 connector 覆盖，也可以把它写入 site_search_strategies。",
    "chosen_connector_ids 只是轻量运行提示；在已经决定网站和搜索策略之后再考虑它；如果不确定，可以留空。",
    "如果已有 connector 明确覆盖某域名且支持搜索，可以填写 connector_id 并使用 connector_search 或 hybrid。",
    "如果某域名有价值但 connector 覆盖不明确或暂不可用，请保留该网站，并将 connector_id 留空，使用 site_query 或 verify_only。",
    "runtime 后续可能会为高价值未覆盖域名 provision generated site connector，所以不要因为当前没有 connector 就放弃规划重要网站。",
    "如果官方域名明显相关，应显式写入 site_search_strategies，而不是只隐藏在普通查询词里。",
    "如果官方域名已经出现在查询意图里，仍应尽量把它提升到 site_search_strategies，除非已经存在等价策略。",
    "不要因为已经选择了 GitHub、API 文档或媒体站点，就省略官方主站；官网证据与仓库证据可能都需要。",
    "Choose search_mode carefully: connector_search means use an in-site connector; site_query means use bing_web with site:domain; hybrid means both; verify_only means keep the site for later reading or fact-checking if needed.",
    "Use hybrid only when connector-native search and domain-filtered web search are likely complementary.",
    "Use verify_only for sites that are mainly for later confirmation, policy verification, release-note checking, or reading a specific likely page.",
    "When returning site_search_strategies, write concrete query_variants that the agent can execute directly; avoid placeholders, vague labels, or duplicated phrasings.",
    "connector_reasons 应解释排序依据，例如官方公告、第一手发布页、高可信验证、低优先级补充来源等。",
    "site_search_strategies 的顺序代表推荐站点搜索优先级，从高价值/高可信到低。",
    "initial_queries 的顺序代表推荐查询优先级，应先写最可能直接命中目标信息的查询。",
    "Return 3 to 5 sub-questions and 4 to 6 concrete initial queries.",
    "Question:",
    question,
    "",
    "Planning context:",
    JSON.stringify({
      task_goal: basePlan.task_goal,
      search_site_hints: (basePlan.search_site_hints?.items || []).map((item) => ({
        name: item.name,
        domain: item.domain,
        connector_id: item.connector_id,
        category: item.category,
        tags: item.tags
      })),
      stop_policy: basePlan.stop_policy,
      execution_semantics: {
        generated_site_connector_rule: "Only provisioned later when planner selected a site and no existing connector covers that domain.",
        read_only_connector_rule: "If generated connector only supports read, runtime degrades connector_search to site_query and uses generated read later.",
        fallback_rule: "If provisioning fails, runtime falls back to bing_web with site:domain."
      }
    }, null, 2),
  ].join("\n");
}

async function requestConnectorSelectionFromModel(question, basePlan, planningDraft, connectors = buildPlannerConnectorDigest(basePlan?.source_capabilities || [])) {
  if (!Array.isArray(connectors) || !connectors.length) {
    return {
      chosen_connector_ids: [],
      connector_reasons: [],
      rationale: "No runtime connectors available for the planned sites."
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for llm-only connector selection");
  }

  const connectorIds = connectors.map((item) => item.id);
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      chosen_connector_ids: {
        type: "array",
        minItems: 1,
        maxItems: Math.min(4, connectorIds.length),
        items: {
          type: "string",
          enum: connectorIds
        }
      },
      connector_reasons: {
        type: "array",
        maxItems: Math.min(4, connectorIds.length),
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              enum: connectorIds
            },
            reason: { type: "string" }
          },
          required: ["id", "reason"]
        }
      },
      rationale: { type: "string" }
    },
    required: ["chosen_connector_ids", "connector_reasons", "rationale"]
  };

  const prompt = [
    "You are the connector-selection controller for a research agent.",
    "Your input plan already decided the evidence shapes, websites, and search strategies.",
    "Now choose 1 to 4 runtime connectors that best execute that already-planned website strategy.",
    "Choose connectors only from the candidate runtime connectors that directly cover the planned sites or generic web fallback.",
    "Do not redesign the plan, introduce unrelated sites, or prefer a connector just because it is generally popular.",
    "Prioritize connectors that directly support the planned sites, evidence shapes, and verification needs.",
    "If the plan depends mainly on domain-filtered web search, uncovered sites, or verification-only sites, include bing_web.",
    "Return chosen_connector_ids in execution priority order and explain each choice briefly.",
    "Return explanations only in connector_reasons plus a top-level rationale; do not use an explanations object or any non-schema fields.",
    "Question:",
    question,
    "",
    "Planning draft:",
    JSON.stringify({
      task_goal: planningDraft?.task_goal || question,
      sub_questions: planningDraft?.sub_questions || [],
      required_evidence: planningDraft?.required_evidence || [],
      initial_queries: planningDraft?.initial_queries || [],
      site_search_strategies: planningDraft?.site_search_strategies || []
    }, null, 2),
    "",
    "Available runtime connectors:",
    JSON.stringify(connectors, null, 2)
  ].join("\n");

  const payload = await fetchOpenAIJsonWithRetry(apiKey, {
    model: DEFAULT_PLANNER_MODEL,
    store: false,
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "connector_selection",
        strict: true,
        schema
      }
    }
  }, {
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    operation: "openai_connector_selector"
  });

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI connector selector returned no text output");
  }
  return enrichConnectorSelectionWithPlannedSiteCoverage(
    normalizeConnectorSelectionModelOutput(JSON.parse(rawText), connectors),
    basePlan,
    planningDraft
  );
}

async function requestConnectorPlanFromModel(question, basePlan) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for llm-only planning");
  }

  const connectors = buildPlannerConnectorDigest(basePlan.source_capabilities || []);

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      problem_breakdown: {
        type: "object",
        additionalProperties: false,
        properties: {
          intent_rewrite: { type: "string" },
          core_entities: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: { type: "string" }
          },
          target_information: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: { type: "string" }
          },
          implicit_constraints: {
            type: "array",
            maxItems: 6,
            items: { type: "string" }
          },
          ambiguity_resolution: { type: "string" },
          clarification_needed: { type: "boolean" },
          clarifying_question: { type: "string" }
        },
        required: ["intent_rewrite", "core_entities", "target_information", "implicit_constraints", "ambiguity_resolution", "clarification_needed", "clarifying_question"]
      },
      entity_profiles: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            entity_name: { type: "string" },
            category_domain: { type: "string" },
            manifestation: { type: "string" },
            owner: { type: "string" },
            lifecycle_status: { type: "string" },
            related_entities: {
              type: "array",
              maxItems: 6,
              items: { type: "string" }
            },
            aliases: {
              type: "array",
              maxItems: 8,
              items: { type: "string" }
            },
            cognition_confidence: {
              type: "string",
              enum: ["高", "中", "低"]
            }
          },
          required: ["entity_name", "category_domain", "manifestation", "owner", "lifecycle_status", "related_entities", "aliases", "cognition_confidence"]
        }
      },
      evidence_strategy: {
        type: "object",
        additionalProperties: false,
        properties: {
          likely_carriers: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: { type: "string" }
          },
          granularity_requirements: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: { type: "string" }
          },
          source_requirements: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: { type: "string" }
          },
          extraction_focus: { type: "string" }
        },
        required: ["likely_carriers", "granularity_requirements", "source_requirements", "extraction_focus"]
      },
      sub_questions: {
        type: "array",
        minItems: 3,
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
        minItems: 4,
        maxItems: 6,
        items: { type: "string" }
      },
      rationale: { type: "string" },
      recommended_paths: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            priority: { type: "string" },
            channel: { type: "string" },
            url: { type: "string" },
            search_keywords: { type: "string" },
            expected_hit_rate: {
              type: "string",
              enum: ["高", "中", "低"]
            },
            reason: { type: "string" }
          },
          required: ["priority", "channel", "url", "search_keywords", "expected_hit_rate", "reason"]
        }
      },
      action_cards: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path_label: { type: "string" },
            channel_name: { type: "string" },
            entry_url: { type: "string" },
            primary_keywords_zh: {
              type: "array",
              maxItems: 4,
              items: { type: "string" }
            },
            primary_keywords_en: {
              type: "array",
              maxItems: 4,
              items: { type: "string" }
            },
            supporting_keywords_zh: {
              type: "array",
              maxItems: 4,
              items: { type: "string" }
            },
            supporting_keywords_en: {
              type: "array",
              maxItems: 4,
              items: { type: "string" }
            },
            search_syntax: { type: "string" },
            filters: { type: "string" },
            navigation_path: { type: "string" },
            extraction_target: { type: "string" },
            caveats: { type: "string" }
          },
          required: ["path_label", "channel_name", "entry_url", "primary_keywords_zh", "primary_keywords_en", "supporting_keywords_zh", "supporting_keywords_en", "search_syntax", "filters", "navigation_path", "extraction_target", "caveats"]
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
            connector_id: { type: "string" },
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
      },
      verification_and_fallback: {
        type: "object",
        additionalProperties: false,
        properties: {
          cross_verification: { type: "string" },
          confidence: {
            type: "string",
            enum: ["高", "中", "低"]
          },
          fallback_path_a: { type: "string" },
          fallback_path_b: { type: "string" },
          ultimate_fallback: { type: "string" },
          freshness_window: { type: "string" }
        },
        required: ["cross_verification", "confidence", "fallback_path_a", "fallback_path_b", "ultimate_fallback", "freshness_window"]
      }
    },
    required: ["problem_breakdown", "entity_profiles", "evidence_strategy", "sub_questions", "required_evidence", "initial_queries", "rationale", "recommended_paths", "action_cards", "verification_and_fallback"]
  };

  const prompt = buildPlannerPrompt(question, basePlan, connectors);

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
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    operation: "openai_planner"
  });

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI planner returned no text output");
  }
  if (process.env.OPENSEARCH_DEBUG_PLAN === "1") {
    console.log("[openai_planner.raw]", rawText);
  }
  const parsed = JSON.parse(rawText);
  if (Array.isArray(parsed.site_search_strategies)) {
    parsed.site_search_strategies = parsed.site_search_strategies.map((item) => ({
      site_name: item.site_name || item.domain || item.connector_id || "site",
      domain: item.domain || "",
      connector_id: item.connector_id || null,
      search_mode: item.search_mode || item.strategy || "connector_search",
      query_variants: item.query_variants || [],
      rationale: item.rationale || item.notes || "selected by llm"
    }));
  }

  return parsed;
}

function mergePlanWithModelSelection(basePlan, modelSelection) {
  const initialQueries = compactStringList(modelSelection?.initial_queries, { minLength: 1, limit: 6 });
  const subQuestions = compactStringList(modelSelection?.sub_questions, { minLength: 1, limit: 5 });
  const requiredEvidence = compactStringList(modelSelection?.required_evidence, { minLength: 1, limit: 6 });
  const normalizedSiteSearchStrategies = normalizeModelSiteSearchStrategies(modelSelection?.site_search_strategies, basePlan);
  const siteSearchStrategies = ensureOfficialSiteStrategy(basePlan, initialQueries, normalizedSiteSearchStrategies, requiredEvidence);
  const chosenConnectorIds = deriveChosenConnectorIds(basePlan, modelSelection);
  if (!subQuestions.length) {
    throw new Error("LLM planner did not return usable sub_questions");
  }
  if (!initialQueries.length) {
    throw new Error("LLM planner did not return usable initial_queries");
  }

  return {
    ...basePlan,
    sub_questions: subQuestions,
    required_evidence: requiredEvidence,
    initial_queries: initialQueries,
    stop_policy: buildStopPolicy(basePlan.task_goal, subQuestions),
    preferred_connectors: buildPreferredConnectors(basePlan, chosenConnectorIds, modelSelection?.connector_reasons || []),
    chosen_connector_ids: chosenConnectorIds,
    site_search_strategies: siteSearchStrategies,
    problem_breakdown: modelSelection?.problem_breakdown || null,
    entity_profiles: Array.isArray(modelSelection?.entity_profiles) ? modelSelection.entity_profiles : [],
    evidence_strategy: modelSelection?.evidence_strategy || null,
    recommended_paths: Array.isArray(modelSelection?.recommended_paths) ? modelSelection.recommended_paths : [],
    action_cards: Array.isArray(modelSelection?.action_cards) ? modelSelection.action_cards : [],
    verification_and_fallback: modelSelection?.verification_and_fallback || null,
    planner_mode: "llm",
    planner_rationale: modelSelection?.rationale || ""
  };
}

function buildLlmPlanningContext(question) {
  const relevantSiteHints = getRelevantSearchSiteHints(question, { limit: 20 });
  const siteDataset = getAllSiteProfiles();
  const siteItems = (relevantSiteHints.items?.length ? relevantSiteHints.items : (siteDataset.profiles || []))
    .filter((item) => item?.name || item?.domain)
    .slice(0, 20)
    .map((item) => ({
      name: item.name || "",
      domain: item.domain || "",
      connector_id: item.connector_id || "bing_web",
      category: item.category || "",
      tags: item.tags || []
    }));
  return {
    task_goal: question,
    sub_questions: [],
    required_evidence: [],
    source_strategy: "LLM-only planning; connector choice and queries come from model output.",
    preferred_connectors: [],
    chosen_connector_ids: [],
    experience_hints: null,
    search_site_hints: {
      file_path: relevantSiteHints.file_path || siteDataset.file_path,
      error: relevantSiteHints.error || siteDataset.error,
      items: siteItems,
      domains: Array.from(new Set(siteItems.map((item) => item.domain).filter(Boolean)))
    },
    site_search_strategies: [],
    source_capabilities: sourceCatalog,
    initial_queries: [],
    stop_policy: buildStopPolicy(question, []),
    stop_condition: "Stop policy is decided by the LLM evaluator output."
  };
}

function planner(
  question,
  experienceHints = getRelevantExperienceHints(question),
  siteHints = getRelevantSearchSiteHints(question)
) {
  const preferredConnectors = inferPreferredConnectors(question, experienceHints, siteHints);
  const chosenConnectorIds = chooseConnectorsForQuestion(question, preferredConnectors, experienceHints, siteHints);

  return {
    task_goal: question,
    sub_questions: [
      "What is the direct answer to the question?",
      "What evidence supports the answer?"
    ],
    required_evidence: [
      "At least 3 high-relevance sources",
      "At least 2 different evidence formats"
    ],
    source_strategy: "Legacy heuristic planner output.",
    preferred_connectors: preferredConnectors,
    chosen_connector_ids: chosenConnectorIds,
    experience_hints: experienceHints,
    search_site_hints: siteHints,
    site_search_strategies: [],
    source_capabilities: sourceCatalog,
    initial_queries: buildSeedQueries(question, experienceHints, siteHints),
    stop_policy: buildStopPolicy(question, [
      "What is the direct answer to the question?",
      "What evidence supports the answer?"
    ]),
    stop_condition: "Stop when key questions are covered and conflicts are disclosed."
  };
}

async function buildPlan(question) {
  const basePlan = buildLlmPlanningContext(question);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const modelSelection = await requestConnectorPlanFromModel(question, basePlan);
    try {
      return mergePlanWithModelSelection(basePlan, modelSelection);
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        throw error;
      }
    }
  }
  throw lastError || new Error("LLM planner did not produce a valid plan");
}

async function requestCandidateRoutingFromModel(question, plan, candidates) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for llm-only candidate routing");
  }
  if (!candidates.length) {
    return {
      selected_candidates: [],
      rejection_summary: [],
      rationale: "No candidates available for routing."
    };
  }
  const configuredMaxSelectedCandidates = Number(plan?.execution_budget?.max_selected_candidates);
  const maxSelectedCandidates = Number.isFinite(configuredMaxSelectedCandidates) && configuredMaxSelectedCandidates > 0
    ? Math.max(1, Math.min(candidates.length, configuredMaxSelectedCandidates))
    : Math.max(1, candidates.length);

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      selected_candidates: {
        type: "array",
        minItems: 0,
        maxItems: maxSelectedCandidates,
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
      rejection_summary: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            reason: { type: "string" },
            count: { type: "number", minimum: 0 },
            example_candidate_ids: {
              type: "array",
              maxItems: 3,
              items: { type: "string", enum: candidates.map((item) => item.id) }
            }
          },
          required: ["reason", "count", "example_candidate_ids"]
        }
      },
      rationale: { type: "string" }
    },
    required: ["selected_candidates", "rejection_summary", "rationale"]
  };

  const prompt = [
    "You are the routing controller for a research agent.",
    `Select up to ${maxSelectedCandidates} candidate sources that are worth deep reading for the current round.`,
    "Your core decision is whether each candidate is worth deep reading now.",
    "The candidate list below is the merged output from multiple parallel search lanes across different agents and websites.",
    "You must consider the full candidate set provided here; do not assume it is a small pre-filtered shortlist.",
    "Judge usefulness primarily from title, snippet, URL, connector/site, content type, and whether the source is likely to contain direct evidence for the plan.",
    "Prefer sources that are most likely to directly answer missing sub-questions or provide first-hand / highly credible evidence.",
    "Do not select candidates just because they are on-topic; select only those worth spending deep-read budget on.",
    "Avoid login pages, generic homepages, navigation pages, thin index pages, noisy forum chatter, and duplicate or low-information results unless the plan explicitly needs them.",
    "If no candidate appears worth deep reading, return an empty selected_candidates array and explain why.",
    "Also summarize the main rejection reasons for non-selected candidates in rejection_summary.",
    "Group similar rejections together, count how many candidates were rejected for each reason, and provide up to 3 example candidate ids for each group.",
    "Assign exactly one agent and one tool to each selected source.",
    "The agent is an execution worker slot, not a content-type classifier; assign any single agent per selected source regardless of content type.",
    "Choose the tool based on what is most suitable for the source.",
    "Question:",
    question,
    "",
    "Plan summary:",
    JSON.stringify({
      sub_questions: plan.sub_questions,
      required_evidence: plan.required_evidence,
      chosen_connector_ids: plan.chosen_connector_ids,
      evidence_strategy: plan.evidence_strategy || null,
      recommended_paths: plan.recommended_paths || [],
      verification_and_fallback: plan.verification_and_fallback || null,
      candidate_count: candidates.length,
      lane_distribution: candidates.reduce((accumulator, item) => {
        const lane = item.metadata?.search_lane || "unknown";
        accumulator[lane] = (accumulator[lane] || 0) + 1;
        return accumulator;
      }, {})
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
      url: item.url,
      search_lane: item.metadata?.search_lane || null,
      search_agent: item.metadata?.search_agent || null,
      search_lane_label: item.metadata?.search_lane_label || null
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
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    operation: "openai_routing_planner"
  });

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI routing planner returned no text output");
  }
  try {
    return JSON.parse(rawText);
  } catch (_) {
    return {
      selected_candidates: [],
      rejection_summary: [],
      rationale: rawText.trim().slice(0, 400)
    };
  }
}

async function selectCandidatesWithRouting(candidates, question, plan) {
  if (!candidates.length) {
    return {
      selected: [],
      routing_mode: "llm",
      routing_rationale: "No candidates available.",
      routing_rejection_summary: []
    };
  }
  const configuredMaxSelectedCandidates = Number(plan?.execution_budget?.max_selected_candidates);
  const maxSelectedCandidates = Number.isFinite(configuredMaxSelectedCandidates) && configuredMaxSelectedCandidates > 0
    ? Math.max(1, Math.min(candidates.length, configuredMaxSelectedCandidates))
    : Math.max(1, candidates.length);

  let routing = null;
  try {
    routing = await requestCandidateRoutingFromModel(question, plan, candidates);
  } catch (error) {
    const fallbackSelected = selectCandidates(candidates, question, plan).slice(0, maxSelectedCandidates);
    return {
      selected: fallbackSelected.map((candidate) => ({
        ...candidate,
        preferred_agent: candidate.preferred_agent || routeCandidate(candidate),
        preferred_tool: candidate.preferred_tool || collectorToolForCandidate(candidate),
        routing_reason: "heuristic fallback after llm routing unavailable"
      })),
      routing_mode: "heuristic_fallback",
      routing_rationale: error?.message || "LLM routing unavailable; used heuristic candidate selection",
      routing_rejection_summary: []
    };
  }
  if (!routing?.selected_candidates?.length) {
    return {
      selected: [],
      routing_mode: "llm",
      routing_rationale: routing?.rationale || "LLM routing returned no selected candidates",
      routing_rejection_summary: Array.isArray(routing?.rejection_summary) ? routing.rejection_summary : []
    };
  }
  const selectedIds = normalizeModelSelectedCandidateIds(
    routing.selected_candidates.map((item) => item.id),
    [],
    maxSelectedCandidates
  );
  if (!selectedIds.length) {
    throw new Error("LLM routing returned no valid candidate ids");
  }

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
  if (!selected.length) {
    return {
      selected: [],
      routing_mode: "llm",
      routing_rationale: "LLM routing selected only unknown candidates"
    };
  }

  return {
    selected,
    routing_mode: "llm",
    routing_rationale: routing.rationale || "",
    routing_rejection_summary: Array.isArray(routing?.rejection_summary) ? routing.rejection_summary : []
  };
}

function buildRoutingDecisionSummary(candidates, routedSelection) {
  const safeCandidates = Array.isArray(candidates) ? candidates : [];
  const safeSelected = Array.isArray(routedSelection?.selected) ? routedSelection.selected : [];
  const rejectionSummary = Array.isArray(routedSelection?.routing_rejection_summary)
    ? routedSelection.routing_rejection_summary
    : [];
  const candidateMap = new Map(safeCandidates.map((item) => [item.id, item]));

  return {
    total_candidates: safeCandidates.length,
    selected_count: safeSelected.length,
    selected_sources: safeSelected.map((item) => ({
      id: item.id,
      title: item.title,
      connector: item.connector,
      content_type: item.content_type || item.source_type,
      search_lane: item.metadata?.search_lane || null,
      search_agent: item.metadata?.search_agent || null,
      reason: item.routing_reason || null,
      url: item.url
    })),
    rejection_summary: rejectionSummary.map((item) => ({
      reason: item.reason,
      count: item.count,
      examples: (item.example_candidate_ids || []).map((id) => {
        const candidate = candidateMap.get(id);
        return candidate
          ? {
              id,
              title: candidate.title,
              connector: candidate.connector,
              search_lane: candidate.metadata?.search_lane || null,
              url: candidate.url
            }
          : { id };
      })
    }))
  };
}

function formatRoutingDecisionSummary(summary) {
  if (!summary) {
    return "Routing summary unavailable.";
  }

  const selectedLine = summary.selected_sources?.length
    ? summary.selected_sources
      .map((item) => `${item.title || item.id} [${item.search_lane || item.connector || "unknown"}]`)
      .join("; ")
    : "none";

  const rejectionLine = summary.rejection_summary?.length
    ? summary.rejection_summary
      .slice(0, 5)
      .map((item) => `${item.reason} (${item.count})`)
      .join("; ")
    : "none";

  return [
    `Selected ${summary.selected_count}/${summary.total_candidates}: ${selectedLine}`,
    `Top rejection reasons: ${rejectionLine}`
  ].join(" | ");
}

function createScratchpad(plan) {
  return {
    plan,
    execution_budget: plan.execution_budget || {},
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
      round_digests: [],
      compacted_context: null,
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

function createControlAction(type, payload = {}) {
  return {
    type,
    issued_at: new Date().toISOString(),
    ...payload
  };
}

function buildSearchPolicy(plan, currentConnectorIds, evaluation = null, connectorHealth = {}) {
  const executionBudget = plan?.execution_budget || {};
  const threshold = Math.max(1, Number(executionBudget.degrade_after_connector_failures || 2));
  const reserveIds = compactStringList([
    ...(plan?.chosen_connector_ids || []),
    ...((plan?.source_capabilities || []).map((item) => item?.id).filter(Boolean))
  ], { limit: 8 });
  const degradedConnectorIds = compactStringList((currentConnectorIds || []).filter((connectorId) => {
    const failedEvents = Number(connectorHealth?.[connectorId]?.failed_events || 0);
    return failedEvents >= threshold || connectorHealth?.[connectorId]?.healthy === false;
  }), { limit: 4 });
  const preferredConnectorIds = compactStringList((currentConnectorIds || []).filter((connectorId) => !degradedConnectorIds.includes(connectorId)), {
    limit: executionBudget.max_connectors || DEEP_MAX_CONNECTORS
  });
  const activeConnectorIds = [...preferredConnectorIds];

  for (const connectorId of reserveIds) {
    if (activeConnectorIds.length >= Math.max(1, Number(executionBudget.max_connectors || DEEP_MAX_CONNECTORS))) {
      break;
    }
    if (activeConnectorIds.includes(connectorId) || degradedConnectorIds.includes(connectorId)) {
      continue;
    }
    activeConnectorIds.push(connectorId);
  }

  const nextConnectorIds = evaluation?.next_best_action === "run_follow_up_search"
    ? buildNextRoundConnectorIds(plan, activeConnectorIds, evaluation, connectorHealth)
    : activeConnectorIds;

  return {
    connector_ids: normalizeModelConnectorIds(
      nextConnectorIds,
      activeConnectorIds,
      Math.max(1, Number(executionBudget.max_connectors || DEEP_MAX_CONNECTORS))
    ),
    degraded_connector_ids: degradedConnectorIds,
    query_limit: Math.max(1, Number(executionBudget.max_queries || DEEP_MAX_QUERIES)),
    max_site_hint_tasks: Math.max(0, Number(executionBudget.max_site_hint_tasks ?? DEEP_MAX_SITE_HINT_TASKS)),
    search_mode: degradedConnectorIds.length ? "degraded" : "standard",
    site_search_strategies: plan?.site_search_strategies || []
  };
}

function buildRoundDigest(roundNumber, roundSummary, evaluation, verification, evidenceItems) {
  const compactedEvidence = (evidenceItems || []).slice(0, 4).map((item) => ({
    source_id: item.source_id,
    title: item.title,
    source_type: item.source_type,
    key_point: item.key_points?.[0] || item.quotes?.[0]?.text || null
  }));
  return {
    round: roundNumber,
    created_at: new Date().toISOString(),
    queries: compactStringList(roundSummary?.queries || [], { minLength: 1, limit: 4 }),
    chosen_connector_ids: compactStringList(roundSummary?.chosen_connector_ids || [], { minLength: 2, limit: 4 }),
    selected_source_ids: compactStringList((roundSummary?.selected_sources || []).map((item) => item.id), { minLength: 2, limit: 6 }),
    resolved_questions: compactStringList(evaluation?.resolved_questions || [], { minLength: 1, limit: 5 }),
    missing_questions: compactStringList(evaluation?.missing_questions || [], { minLength: 1, limit: 5 }),
    conflict_count: Number(verification?.conflicts?.length || 0),
    coverage_gap_count: Number(verification?.coverage_gaps?.length || 0),
    evidence_digest: compactedEvidence
  };
}

function compactScratchpadForNextRound(scratchpad, roundDigest, evaluation, verification) {
  scratchpad.workspace.round_digests.push(roundDigest);
  scratchpad.workspace.round_digests = scratchpad.workspace.round_digests.slice(-4);
  scratchpad.workspace.compacted_context = {
    updated_at: new Date().toISOString(),
    resolved_questions: compactStringList(evaluation?.resolved_questions || [], { minLength: 1, limit: 5 }),
    missing_questions: compactStringList(evaluation?.missing_questions || [], { minLength: 1, limit: 5 }),
    risk_notes: compactStringList(evaluation?.risk_notes || [], { minLength: 1, limit: 6 }),
    follow_up_queries: compactStringList(evaluation?.follow_up_queries || [], { minLength: 1, limit: 4 }),
    conflict_count: Number(verification?.conflicts?.length || 0),
    coverage_gap_count: Number(verification?.coverage_gaps?.length || 0),
    latest_round_digest: roundDigest
  };
}

function deriveRoundControlAction(plan, evaluation, roundConnectorIds, connectorHealth = {}) {
  const searchPolicy = buildSearchPolicy(plan, roundConnectorIds, evaluation, connectorHealth);
  if (evaluation?.is_sufficient || evaluation?.next_best_action === "synthesize_answer") {
    return createControlAction(CONTROL_ACTION_TYPES.ANSWER_NOW, {
      connector_ids: searchPolicy.connector_ids,
      reason: evaluation?.stop_state?.reason || evaluation?.reason || "evidence_sufficient"
    });
  }
  if (evaluation?.next_best_action === "stop_with_partial_answer") {
    return createControlAction(CONTROL_ACTION_TYPES.STOP_PARTIAL, {
      connector_ids: searchPolicy.connector_ids,
      reason: evaluation?.stop_state?.reason || evaluation?.reason || "partial_answer_ready"
    });
  }
  return createControlAction(CONTROL_ACTION_TYPES.CONTINUE_SEARCH, {
    connector_ids: searchPolicy.connector_ids,
    degraded_connector_ids: searchPolicy.degraded_connector_ids,
    reason: evaluation?.reason || "follow_up_search_required"
  });
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
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for llm-only synthesis");
  }
  if (!evidenceItems.length) {
    throw new Error("LLM-only synthesis requires evidence items");
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
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    operation: "openai_synthesis"
  });

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI synthesis returned no text output");
  }

  return JSON.parse(rawText);
}

async function synthesize(question, mode, candidates, reads, evidenceItems, verification, evaluation, telemetry) {
  void candidates;
  void reads;
  const modelAnswer = await requestFinalSynthesisFromModel(question, mode, evidenceItems, verification, evaluation);
  const uncertainty = compactStringList(modelAnswer.uncertainty, { minLength: 4, limit: 5 });
  const confidence = Number(modelAnswer.confidence.toFixed(2));
  const sources = buildStandardSources(evidenceItems);
  const claims = buildStandardClaims(evidenceItems);

  return {
    schema_version: "final_answer.v1",
    mode,
    headline: `Research summary for "${question}"`,
    quick_answer: modelAnswer.quick_answer,
    sources,
    claims,
    confidence,
    uncertainty,
    deep_research_summary: {
      schema_version: "deep_research_summary.v1",
      headline: `Research summary for "${question}"`,
      conclusion: modelAnswer.conclusion,
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
        stop_controller: evaluation.stop_controller || "llm",
        evaluation_status: evaluation.scorecard?.status || null,
        readiness: evaluation.scorecard?.readiness ?? null,
        connector_health: telemetry.connector_health,
        failures: telemetry.failures.slice(0, 8)
      },
      llm_composer: {
        model: DEFAULT_SYNTHESIS_MODEL,
        key_claims: (modelAnswer.key_claims || []).map((item) => ({
          claim: item.claim,
          source_id: item.source_id
        }))
      }
    }
  };
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

  // 鍒嗘瀽宸ュ叿缁勫悎鏁堢巼
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

  // 鍒嗘瀽澶辫触璺緞
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
  void question;
  void experienceHints;
  const maxFollowUpQueries = Math.max(1, Number(
    scratchpad?.execution_budget?.max_follow_up_queries
    || scratchpad?.plan?.execution_budget?.max_follow_up_queries
    || 4
  ));
  if (evaluation?.follow_up_queries?.length) {
    return evaluation.follow_up_queries
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index)
      .slice(0, maxFollowUpQueries);
  }
  if (scratchpad?.workspace?.compacted_context?.follow_up_queries?.length) {
    return scratchpad.workspace.compacted_context.follow_up_queries.slice(0, maxFollowUpQueries);
  }
  return [];
}

function buildNextRoundConnectorIds(plan, currentConnectorIds, evaluation, connectorHealth = {}) {
  const fallbackIds = compactStringList(
    currentConnectorIds?.length ? currentConnectorIds : (plan?.chosen_connector_ids || []),
    { limit: 4 }
  );
  const suggestedIds = compactStringList(evaluation?.suggested_connector_ids || [], { limit: 4 });
  const reserveIds = compactStringList([
    ...(plan?.chosen_connector_ids || []),
    ...((plan?.source_capabilities || []).map((item) => item?.id).filter(Boolean))
  ], { limit: 8 });

  const isHealthy = (connectorId) => connectorHealth?.[connectorId]?.healthy !== false;
  const targetCount = Math.max(
    fallbackIds.length,
    Array.from(new Set([...suggestedIds, ...fallbackIds])).length
  );

  const selected = normalizeModelConnectorIds(
    suggestedIds.filter(isHealthy),
    fallbackIds.filter(isHealthy),
    Math.max(1, targetCount)
  );

  for (const connectorId of reserveIds) {
    if (selected.length >= targetCount) {
      break;
    }
    if (!isHealthy(connectorId) || selected.includes(connectorId)) {
      continue;
    }
    selected.push(connectorId);
  }

  return selected.slice(0, targetCount);
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
  const executionBudget = plan.execution_budget || {};
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
        },
        priority: "high",
        budgetTag: "research_round"
      })
    : null;

  const searchLanes = buildParallelSearchLanes(plan, question, queries);
  appendTimelineEvent(scratchpad, {
    type: "parallel_search_started",
    agent: "llm_orchestrator",
    lanes: searchLanes.map((lane) => ({
      lane: lane.id,
      agent: lane.agent_id,
      connector_ids: lane.connector_ids,
      query_count: lane.queries.length
    }))
  });

  const laneResults = await Promise.all(searchLanes.map(async (lane) => {
    const laneTask = runtime
      ? dispatchAgentTask(runtime, {
          from: "llm_orchestrator",
          agentId: lane.agent_id,
          taskType: "discover_sources",
          input: {
            queries: lane.queries,
            connector_ids: lane.connector_ids,
            lane: lane.id
          },
          metadata: {
            lane: lane.id,
            query_count: lane.queries.length,
            connector_ids: lane.connector_ids
          }
        })
      : null;
    try {
      const result = await runWebResearcher(lane.plan, lane.queries, telemetry, null);
      if (laneTask) {
        completeAgentTask(runtime, laneTask.id, {
          lane: lane.id,
          query_count: lane.queries.length,
          candidate_count: result.candidates?.length || 0,
          executed_search_tasks: result.executed_search_tasks?.length || 0
        });
      }
      return {
        lane,
        candidates: (result.candidates || []).map((candidate) => annotateLaneCandidate(candidate, lane)),
        executed_search_tasks: (result.executed_search_tasks || []).map((task) => ({
          ...task,
          search_lane: lane.id,
          search_agent: lane.agent_id,
          lane_label: lane.label
        }))
      };
    } catch (error) {
      if (laneTask) {
        failAgentTask(runtime, laneTask.id, error, {
          lane: lane.id,
          query_count: lane.queries.length
        });
      }
      telemetry.failures.push({
        stage: "parallel_discover",
        query: lane.queries.join(" | "),
        connector: lane.connector_ids.join(","),
        reason: error.message
      });
      return {
        lane,
        candidates: [],
        executed_search_tasks: []
      };
    }
  }));

  const candidates = dedupeBy(laneResults.flatMap((item) => item.candidates || []), (item) => item.url)
    .sort((left, right) => right.score - left.score);
  const executedSearchTasks = laneResults.flatMap((item) => item.executed_search_tasks || []);
  if (executedSearchTasks.length) {
    appendTimelineEvent(scratchpad, {
      type: "site_search_strategy",
      agent: "parallel_search",
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
  const configuredMaxSpecialistReads = Number(executionBudget.max_specialist_reads);
  const maxSpecialistReads = Number.isFinite(configuredMaxSpecialistReads) && configuredMaxSpecialistReads > 0
    ? configuredMaxSpecialistReads
    : Math.max(1, routedSelection.selected.length || candidates.length || 1);
  const selected = routedSelection.routing_mode === "llm"
    ? [...(routedSelection.selected || [])]
    : routedSelection.selected.slice(0, maxSpecialistReads);
  const routingDecisionSummary = buildRoutingDecisionSummary(candidates, {
    ...routedSelection,
    selected
  });
  recordDecision(scratchpad, {
    type: "routing",
    mode: routedSelection.routing_mode,
    rationale: routedSelection.routing_rationale,
    rejection_summary: routedSelection.routing_rejection_summary || [],
    routing_summary: routingDecisionSummary,
    routing_summary_text: formatRoutingDecisionSummary(routingDecisionSummary),
    selected_source_ids: selected.map((item) => item.id)
  });
  recordDecision(scratchpad, createControlAction(CONTROL_ACTION_TYPES.ROUTE_READS, {
    candidate_count: candidates.length,
    selected_source_ids: selected.map((item) => item.id),
    max_specialist_reads: maxSpecialistReads,
    read_all_llm_selected: routedSelection.routing_mode === "llm"
  }));
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
  recordDecision(scratchpad, createControlAction(CONTROL_ACTION_TYPES.RUN_VERIFICATION, {
    selected_source_ids: selected.map((item) => item.id),
    evidence_candidate_count: evidenceItems.length
  }));
  const fallback = plan.execution_budget?.allow_ephemeral_fallbacks === false
    ? { attempts: [], reads: [], evidence_items: [] }
    : await attemptEphemeralFallbacks(
        question,
        specialistReads.failures.slice(0, Math.max(0, Number(executionBudget.max_tool_attempts_per_round || 2))),
        telemetry,
        onProgress
      );

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
    routing_mode: routedSelection.routing_mode,
    routing_rationale: routedSelection.routing_rationale,
    routing_rejection_summary: routedSelection.routing_rejection_summary || [],
    routing_summary: routingDecisionSummary,
    routed_tasks: routedTasks,
    reads: [...reads, ...fallback.reads],
    evidence_items: [...evidenceItems, ...fallback.evidence_items],
    tool_attempts: fallback.attempts
  };
}

async function createResearchSession(question, mode) {
  const plan = applyExecutionModeToPlan(await buildPlan(question), mode);
  const experienceHints = plan.experience_hints ?? null;
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

  return {
    question,
    mode,
    plan,
    experienceHints,
    scratchpad,
    agents,
    agentRuntime,
    knowledgeGraph,
    telemetry: {
      agents,
      agent_system: new AgentSystem(),
      agent_runtime: agentRuntime,
      events: [],
      failures: [],
      ephemeral_tools: [],
      connector_health: {},
      stop_reason: null
    },
    rounds: [],
    combinedCandidates: [],
    combinedReads: [],
    combinedEvidence: [],
    verification: { confirmations: [], conflicts: [], coverage_gaps: [] },
    verifierReview: { tasks: [], summary: { conflicts: 0, coverage_gaps: 0, review_count: 0 } },
    evaluation: null,
    activeConnectorIds: normalizeModelConnectorIds(plan.chosen_connector_ids, plan.chosen_connector_ids)
  };
}

async function preparePlanPhase(session, onProgress) {
  const { plan, telemetry, question } = session;
  if (Array.isArray(plan.site_search_strategies) && plan.site_search_strategies.length) {
    plan.site_search_strategies = await provisionSiteConnectorsForStrategies(plan.site_search_strategies, telemetry);
    plan.source_capabilities = getSourceCapabilities();
  }

  const runtimeConnectorCandidates = deriveRuntimeConnectorCandidates(
    plan,
    plan.site_search_strategies,
    plan.chosen_connector_ids || []
  );
  const runtimeConnectors = buildPlannerConnectorDigest(plan.source_capabilities || [])
    .filter((item) => runtimeConnectorCandidates.includes(item.id));

  let connectorSelection = null;
  if (runtimeConnectors.length > 1 && process.env.OPENAI_API_KEY) {
    try {
      connectorSelection = await requestConnectorSelectionFromModel(
        question || plan.task_goal,
        plan,
        {
          task_goal: plan.task_goal,
          sub_questions: plan.sub_questions || [],
          required_evidence: plan.required_evidence || [],
          initial_queries: plan.initial_queries || [],
          site_search_strategies: plan.site_search_strategies || []
        },
        runtimeConnectors
      );
    } catch (error) {
      logRecoverableError("requestConnectorSelectionFromModel", error);
    }
  }

  const llmChosenConnectorIds = normalizeModelConnectorIds(
    connectorSelection?.chosen_connector_ids || [],
    []
  );
  plan.chosen_connector_ids = llmChosenConnectorIds.length
    ? llmChosenConnectorIds
    : runtimeConnectorCandidates;
  plan.preferred_connectors = buildPreferredConnectors(
    plan,
    plan.chosen_connector_ids,
    connectorSelection?.connector_reasons || []
  );

  session.activeConnectorIds = normalizeModelConnectorIds(plan.chosen_connector_ids, runtimeConnectorCandidates);
  await emitProgress(onProgress, { type: "plan", plan });
  return session;
}

async function executeRoundsPhase(session, onProgress) {
  const { plan, question, scratchpad, telemetry, knowledgeGraph, agentRuntime, rounds, experienceHints } = session;
  const maxRounds = Math.max(1, plan.stop_policy?.max_rounds || 2);

  for (let index = 0; index < maxRounds; index += 1) {
    const queries = index === 0
      ? plan.initial_queries
      : buildFollowUpQueries(question, session.evaluation, scratchpad, experienceHints);
    if (!queries.length) {
      break;
    }

    const searchPolicy = buildSearchPolicy(plan, session.activeConnectorIds, session.evaluation, telemetry.connector_health);
    const roundConnectorIds = [...searchPolicy.connector_ids];
    const roundPlan = {
      ...plan,
      chosen_connector_ids: roundConnectorIds,
      search_policy: searchPolicy,
      execution_budget: {
        ...(plan.execution_budget || {}),
        max_queries: searchPolicy.query_limit,
        max_site_hint_tasks: searchPolicy.max_site_hint_tasks
      }
    };

    recordDecision(scratchpad, {
      type: "search_policy",
      round: index + 1,
      search_mode: searchPolicy.search_mode,
      connector_ids: roundConnectorIds,
      degraded_connector_ids: searchPolicy.degraded_connector_ids
    });

    const round = await runRound(roundPlan, question, queries, scratchpad, telemetry, onProgress);
    session.combinedCandidates = dedupeBy([...session.combinedCandidates, ...round.candidates], (item) => item.url)
      .sort((left, right) => right.score - left.score);
    session.combinedReads = dedupeBy([...session.combinedReads, ...round.reads], (item) => item.source_id);
    session.combinedEvidence = dedupeBy([...session.combinedEvidence, ...round.evidence_items], (item) => item.source_id);

    session.verification = await crossCheckFacts(session.combinedEvidence);
    session.verifierReview = await runFactVerifierReview(session.verification, telemetry, agentRuntime);
    recordVerificationReview(scratchpad, session.verifierReview);
    session.evaluation = await runStopEvaluation(plan, scratchpad, session.combinedEvidence, session.verification, index + 1);
    const graphVersion = await knowledgeGraph.updateFromNewEvidence(round.evidence_items, {
      label: `round_${index + 1}`,
      round: index + 1,
      question
    });

    updateQuestionStatus(scratchpad, session.evaluation.resolved_questions, session.evaluation.missing_questions);
    recordDecision(scratchpad, {
      type: "evaluation",
      round: index + 1,
      is_sufficient: session.evaluation.is_sufficient,
      next_best_action: session.evaluation.next_best_action,
      missing_questions: session.evaluation.missing_questions
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
        conflict_count: session.verification.conflicts.length,
        single_source_claims: session.verification.coverage_gaps.length,
        review_count: session.verifierReview.summary.review_count,
        follow_ups: session.verifierReview.tasks
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
      conflict_count: session.verification.conflicts.length,
      single_source_claims: session.verification.coverage_gaps.length,
      review_count: session.verifierReview.summary.review_count
    });
    scratchpad.facts_collected = session.combinedEvidence.flatMap((item) => item.facts || []);

    const roundSummary = {
      round: index + 1,
      queries,
      chosen_connector_ids: roundConnectorIds,
      routing_mode: round.routing_mode || null,
      routing_rationale: round.routing_rationale || "",
      routing_rejection_summary: round.routing_rejection_summary || [],
      routing_summary: round.routing_summary || null,
      routing_summary_text: formatRoutingDecisionSummary(round.routing_summary || null),
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
        is_sufficient: session.evaluation.is_sufficient,
        next_best_action: session.evaluation.next_best_action,
        missing_questions: session.evaluation.missing_questions
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

    const roundDigest = buildRoundDigest(index + 1, roundSummary, session.evaluation, session.verification, round.evidence_items);
    compactScratchpadForNextRound(scratchpad, roundDigest, session.evaluation, session.verification);

    await emitProgress(onProgress, {
      type: "round",
      round: roundSummary,
      totals: {
        candidates: session.combinedCandidates.length,
        reads: session.combinedReads.length
      }
    });
    await emitProgress(onProgress, {
      type: "evaluation",
      round: index + 1,
      evaluation: session.evaluation
    });
    await emitProgress(onProgress, {
      type: "connector_health",
      round: index + 1,
      connector_health: telemetry.connector_health
    });

    const controlAction = deriveRoundControlAction(plan, session.evaluation, roundConnectorIds, telemetry.connector_health);
    recordDecision(scratchpad, controlAction);

    if (controlAction.type === CONTROL_ACTION_TYPES.ANSWER_NOW) {
      telemetry.stop_reason = controlAction.reason;
      break;
    }
    if (controlAction.type === CONTROL_ACTION_TYPES.STOP_PARTIAL) {
      telemetry.stop_reason = controlAction.reason;
      break;
    }

    if (controlAction.type === CONTROL_ACTION_TYPES.CONTINUE_SEARCH) {
      if (controlAction.connector_ids.join("|") !== roundConnectorIds.join("|")) {
        recordDecision(scratchpad, {
          type: "connector_selection",
          round: index + 1,
          chosen_connector_ids: controlAction.connector_ids,
          degraded_connector_ids: controlAction.degraded_connector_ids || [],
          rationale: "applied search policy and evaluator suggestions"
        });
      }
      session.activeConnectorIds = controlAction.connector_ids;
    }
  }

  if (!session.evaluation) {
    session.evaluation = await runStopEvaluation(plan, scratchpad, session.combinedEvidence, session.verification, rounds.length);
    telemetry.stop_reason = session.evaluation.stop_state?.reason || "no_usable_candidates";
    await emitProgress(onProgress, {
      type: "evaluation",
      round: rounds.length,
      evaluation: session.evaluation
    });
  }

  if (!telemetry.stop_reason) {
    telemetry.stop_reason = session.evaluation.stop_state?.reason === "continue_search"
      ? "completed"
      : session.evaluation.stop_state?.reason || "completed";
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

  return session;
}

async function finalizeResearchSession(session, onProgress) {
  const {
    question,
    mode,
    plan,
    scratchpad,
    telemetry,
    agentRuntime,
    knowledgeGraph,
    rounds,
    combinedCandidates,
    combinedReads,
    combinedEvidence,
    verification,
    evaluation
  } = session;

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
    },
    priority: "high",
    budgetTag: "final_synthesis"
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

async function runResearch({ question, mode, onProgress }) {
  const session = await createResearchSession(question, mode);
  await preparePlanPhase(session, onProgress);
  await executeRoundsPhase(session, onProgress);
  return finalizeResearchSession(session, onProgress);
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
    normalizeModelSiteSearchStrategies,
    buildStopPolicy,
    extractTextFromResponsePayload,
    normalizeModelConnectorIds,
    normalizeConnectorSelectionModelOutput,
    enrichConnectorSelectionWithPlannedSiteCoverage,
    buildParallelSearchLanes,
    buildRoutingDecisionSummary,
    formatRoutingDecisionSummary,
    normalizeModelSelectedCandidateIds,
    mergePlanWithModelSelection,
    buildPlannerConnectorDigest,
    buildPlannerPrompt,
    buildLlmPlanningContext,
    buildPlan,
    planner,
    getRelevantExperienceHints,
    normalizeExperienceEntry,
    mergeExperienceEntries,
    recordExperienceMemoryEntry,
    summarizeExperience,
    requestConnectorSelectionFromModel,
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
    CONTROL_ACTION_TYPES,
    createControlAction,
    buildSearchPolicy,
    buildRoundDigest,
    compactScratchpadForNextRound,
    deriveRoundControlAction,
    createResearchSession,
    preparePlanPhase,
    executeRoundsPhase,
    finalizeResearchSession,
    updateQuestionStatus,
    appendTimelineEvent
  }
};









