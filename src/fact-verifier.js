const { normalizeText, toIsoTimestamp } = require("./evidence-model");
const { extractTextFromResponsePayload } = require("./openai-response");

const OPENAI_RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses";
const DEFAULT_VERIFIER_MODEL = process.env.OPENAI_VERIFIER_MODEL || "gpt-4o-mini";

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function toTimestamp(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function computeComparisonConfidence(preferred, others, status) {
  if (!preferred) {
    return 0;
  }

  const authorityGap = Math.max(
    0,
    (preferred.authority_score || 0) - Math.max(0, ...others.map((item) => item.authority_score || 0))
  );
  const freshnessGap = Math.max(
    0,
    toTimestamp(preferred.published_at) - Math.max(0, ...others.map((item) => toTimestamp(item.published_at)))
  );
  const evidenceBonus = preferred.evidence_span_ids?.length ? 0.08 : 0;
  const sourceCountBonus = Math.min(0.15, others.length * 0.05);
  const freshnessBonus = freshnessGap > 0 ? 0.08 : 0;

  const base = status === "confirmed"
    ? 0.72
    : status === "conflict"
      ? 0.48
      : 0.4;

  return Number(clamp01(base + Math.min(0.18, authorityGap * 0.4) + freshnessBonus + evidenceBonus + sourceCountBonus).toFixed(2));
}

function buildSuggestedQueries(items, status) {
  if (!items?.length) {
    return [];
  }

  const preferred = [...items].sort((left, right) => {
    const authorityDelta = (right.authority_score || 0) - (left.authority_score || 0);
    if (authorityDelta !== 0) {
      return authorityDelta;
    }
    return toTimestamp(right.published_at) - toTimestamp(left.published_at);
  })[0];

  const focus = preferred?.subject || preferred?.claim || "fact";
  if (status === "conflict") {
    return unique([
      `${focus} official source`,
      `${focus} latest update`,
      `${focus} corroboration`
    ]).slice(0, 3);
  }

  if (status === "single_source") {
    return unique([
      `${focus} corroboration`,
      `${focus} second source`,
      `${focus} official confirmation`
    ]).slice(0, 3);
  }

  return [];
}

function buildSuggestedSourceTypes(items, status) {
  const sourceTypes = new Set(items.map((item) => item.source_type).filter(Boolean));
  if (status !== "single_source") {
    return Array.from(sourceTypes);
  }

  if (sourceTypes.has("video")) {
    sourceTypes.add("web");
  } else if (sourceTypes.has("web")) {
    sourceTypes.add("document");
  } else {
    sourceTypes.add("web");
  }

  return Array.from(sourceTypes).slice(0, 3);
}

function describeVerificationReason(preferred, others) {
  const reasons = [];
  if (others.some((item) => (item.authority_score || 0) < (preferred.authority_score || 0))) {
    reasons.push("preferred source has higher authority");
  }

  const preferredDate = preferred.published_at ? new Date(preferred.published_at).getTime() : null;
  const newerCount = others.filter((item) => {
    const date = item.published_at ? new Date(item.published_at).getTime() : null;
    return Number.isFinite(preferredDate) && Number.isFinite(date) && preferredDate > date;
  }).length;
  if (newerCount) {
    reasons.push("preferred source is more recent");
  }

  const sourceTypes = new Set([preferred.source_type, ...others.map((item) => item.source_type)].filter(Boolean));
  if (sourceTypes.size > 1) {
    reasons.push("sources span different evidence types");
  }

  if (others.some((item) => item.evidence_span_ids?.length)) {
    reasons.push("decision is grounded in explicit evidence spans");
  }

  return reasons.join("; ") || "preferred source has the clearest available support";
}

function buildComparisonEntry(items, status) {
  const sorted = [...items].sort((left, right) => {
    const authorityDelta = (right.authority_score || 0) - (left.authority_score || 0);
    if (authorityDelta !== 0) {
      return authorityDelta;
    }

    const rightDate = right.published_at ? new Date(right.published_at).getTime() : 0;
    const leftDate = left.published_at ? new Date(left.published_at).getTime() : 0;
    return rightDate - leftDate;
  });

  const preferred = sorted[0];
  const others = sorted.slice(1);
  const explanation = describeVerificationReason(preferred, others);

  return {
    key: `${preferred.subject || "claim"}:${preferred.type || preferred.kind || "statement"}:${preferred.unit || ""}`,
    status,
    claim: preferred.claim || preferred.subject || "Unknown claim",
    sources: sorted.map((item) => item.source_id).filter(Boolean),
    confidence: computeComparisonConfidence(preferred, others, status),
    preferred_fact: preferred,
    supporting_facts: sorted,
    comparison: {
      preferred_source: preferred.source_id,
      preferred_published_at: preferred.published_at || null,
      preferred_authority_score: preferred.authority_score || 0,
      competing_sources: others.map((item) => ({
        source_id: item.source_id,
        authority_score: item.authority_score || 0,
        published_at: item.published_at || null,
        claim: item.claim
      })),
      verdict_reason: explanation
    },
    reason: explanation,
    explanation,
    suggested_queries: buildSuggestedQueries(sorted, status),
    suggested_sources: buildSuggestedSourceTypes(sorted, status)
  };
}

function groupClaimsForVerification(evidenceUnits) {
  const groups = new Map();

  for (const unit of evidenceUnits) {
    for (const claim of unit.claims || []) {
      const normalizedClaim = normalizeText(claim.claim);
      const key = claim.value !== null && claim.value !== undefined
        ? `${claim.subject || "claim"}:${claim.type || "statement"}:${claim.unit || ""}`
        : normalizedClaim.split(" ").slice(0, 8).join(" ");
      const items = groups.get(key) || [];
      items.push({
        ...claim,
        source_type: unit.source_type,
        evidence_span_ids: claim.evidence_span_ids || [],
        published_at: claim.published_at || toIsoTimestamp(unit.source_metadata?.published_at),
        authority_score: claim.authority_score || unit.source_metadata?.authority_score || 0.66
      });
      groups.set(key, items);
    }
  }

  return groups;
}

function verifyEvidenceUnitsHeuristic(evidenceUnits) {
  const confirmations = [];
  const conflicts = [];
  const coverageGaps = [];

  for (const [, items] of groupClaimsForVerification(evidenceUnits)) {
    if (items.length === 1) {
      coverageGaps.push(buildComparisonEntry(items, "single_source"));
      continue;
    }

    const values = Array.from(new Set(items.map((item) => JSON.stringify(item.value ?? item.claim))));
    if (values.length === 1) {
      confirmations.push(buildComparisonEntry(items, "confirmed"));
      continue;
    }

    conflicts.push(buildComparisonEntry(items, "conflict"));
  }

  return {
    confirmations,
    conflicts,
    coverage_gaps: coverageGaps,
    verifier_mode: "heuristic",
    follow_up_queries: unique([
      ...conflicts.flatMap((item) => item.suggested_queries || []),
      ...coverageGaps.flatMap((item) => item.suggested_queries || [])
    ]).slice(0, 5),
    suggested_source_types: unique([
      ...conflicts.flatMap((item) => item.suggested_sources || []),
      ...coverageGaps.flatMap((item) => item.suggested_sources || [])
    ]).slice(0, 4),
    review_summary: {
      overall_verdict: conflicts.length ? "conflicted" : coverageGaps.length ? "needs_more_evidence" : "sufficient",
      risk_level: conflicts.length ? "high" : coverageGaps.length ? "medium" : "low",
      explanation: conflicts.length
        ? "Some important claims still conflict across sources."
        : coverageGaps.length
          ? "Several claims still rely on a single source."
          : "The current evidence is internally consistent."
    },
    llm_review: null
  };
}

function buildVerificationReviewContext(evidenceUnits, heuristicVerification) {
  return {
    evidence_summary: evidenceUnits.slice(0, 8).map((item) => ({
      source_id: item.source_id,
      title: item.title,
      source_type: item.source_type,
      source_metadata: {
        connector: item.source_metadata?.connector || null,
        platform: item.source_metadata?.platform || null,
        published_at: item.source_metadata?.published_at || null,
        authority_score: item.source_metadata?.authority_score || null
      },
      claims: (item.claims || []).slice(0, 4).map((claim) => ({
        claim: claim.claim,
        subject: claim.subject,
        value: claim.value,
        unit: claim.unit,
        source_id: claim.source_id,
        authority_score: claim.authority_score,
        published_at: claim.published_at
      }))
    })),
    heuristic_verification: {
      confirmations: (heuristicVerification.confirmations || []).slice(0, 4).map((item) => ({
        key: item.key,
        claim: item.claim,
        preferred_source: item.comparison?.preferred_source,
        reason: item.reason
      })),
      conflicts: (heuristicVerification.conflicts || []).slice(0, 6).map((item) => ({
        key: item.key,
        claim: item.claim,
        preferred_source: item.comparison?.preferred_source,
        competing_sources: item.comparison?.competing_sources || [],
        reason: item.reason
      })),
      coverage_gaps: (heuristicVerification.coverage_gaps || []).slice(0, 6).map((item) => ({
        key: item.key,
        claim: item.claim,
        preferred_source: item.comparison?.preferred_source,
        suggested_sources: item.suggested_sources || []
      }))
    }
  };
}

async function requestVerificationReviewFromModel(evidenceUnits, heuristicVerification) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !evidenceUnits.length) {
    return null;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      overall_verdict: {
        type: "string",
        enum: ["sufficient", "needs_more_evidence", "conflicted"]
      },
      risk_level: {
        type: "string",
        enum: ["low", "medium", "high"]
      },
      explanation: { type: "string" },
      follow_up_queries: {
        type: "array",
        maxItems: 5,
        items: { type: "string" }
      },
      suggested_source_types: {
        type: "array",
        maxItems: 4,
        items: { type: "string" }
      },
      entry_reviews: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string" },
            verdict: {
              type: "string",
              enum: ["confirmed", "leans_preferred_source", "unresolved_conflict", "needs_more_sources"]
            },
            preferred_source: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            explanation: { type: "string" },
            missing_evidence: {
              type: "array",
              maxItems: 4,
              items: { type: "string" }
            },
            suggested_queries: {
              type: "array",
              maxItems: 3,
              items: { type: "string" }
            }
          },
          required: ["key", "verdict", "preferred_source", "confidence", "explanation", "missing_evidence", "suggested_queries"]
        }
      }
    },
    required: ["overall_verdict", "risk_level", "explanation", "follow_up_queries", "suggested_source_types", "entry_reviews"]
  };

  const prompt = [
    "You are a fact verification specialist for a research agent.",
    "Review the heuristic verification output and decide which conflicts are actually meaningful, which source currently looks more trustworthy, and what should be searched next.",
    "Prefer more authoritative, more recent, and more explicit evidence, but do not force certainty when evidence is thin.",
    "Return concise explanations that can be shown directly in a verifier report.",
    "",
    JSON.stringify(buildVerificationReviewContext(evidenceUnits, heuristicVerification), null, 2)
  ].join("\n");

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: DEFAULT_VERIFIER_MODEL,
      store: false,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "verification_review",
          strict: true,
          schema
        }
      }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI verifier failed with HTTP ${response.status}`);
  }

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI verifier returned no text output");
  }

  return JSON.parse(rawText);
}

function mergeVerificationEntry(entry, review) {
  if (!review) {
    return entry;
  }

  const supportingFacts = Array.isArray(entry.supporting_facts) ? entry.supporting_facts : [];
  const preferredOverride = supportingFacts.find((item) => item.source_id === review.preferred_source) || null;
  const preferredFact = preferredOverride || entry.preferred_fact;
  const competingSources = supportingFacts
    .filter((item) => item.source_id !== preferredFact?.source_id)
    .map((item) => ({
      source_id: item.source_id,
      authority_score: item.authority_score || 0,
      published_at: item.published_at || null,
      claim: item.claim
    }));

  return {
    ...entry,
    preferred_fact: preferredFact,
    confidence: Number(clamp01(review.confidence)).toFixed(2) * 1,
    reason: review.explanation || entry.reason,
    explanation: review.explanation || entry.explanation,
    suggested_queries: unique((review.suggested_queries || []).length ? review.suggested_queries : (entry.suggested_queries || [])).slice(0, 3),
    missing_evidence: unique(review.missing_evidence || []),
    llm_verdict: review.verdict,
    llm_confidence: Number(clamp01(review.confidence).toFixed(2)),
    comparison: {
      ...entry.comparison,
      preferred_source: preferredFact?.source_id || entry.comparison?.preferred_source,
      preferred_published_at: preferredFact?.published_at || entry.comparison?.preferred_published_at || null,
      preferred_authority_score: preferredFact?.authority_score || entry.comparison?.preferred_authority_score || 0,
      competing_sources: competingSources,
      verdict_reason: review.explanation || entry.comparison?.verdict_reason
    }
  };
}

function mergeVerificationWithModelReview(heuristicVerification, review) {
  if (!review) {
    return heuristicVerification;
  }

  const reviewMap = new Map((review.entry_reviews || []).map((item) => [item.key, item]));
  const confirmations = (heuristicVerification.confirmations || []).map((item) => mergeVerificationEntry(item, reviewMap.get(item.key)));
  const conflicts = (heuristicVerification.conflicts || []).map((item) => mergeVerificationEntry(item, reviewMap.get(item.key)));
  const coverageGaps = (heuristicVerification.coverage_gaps || []).map((item) => mergeVerificationEntry(item, reviewMap.get(item.key)));

  return {
    ...heuristicVerification,
    confirmations,
    conflicts,
    coverage_gaps: coverageGaps,
    verifier_mode: "llm",
    follow_up_queries: unique([
      ...(review.follow_up_queries || []),
      ...conflicts.flatMap((item) => item.suggested_queries || []),
      ...coverageGaps.flatMap((item) => item.suggested_queries || [])
    ]).slice(0, 5),
    suggested_source_types: unique([
      ...(review.suggested_source_types || []),
      ...(heuristicVerification.suggested_source_types || [])
    ]).slice(0, 4),
    review_summary: {
      overall_verdict: review.overall_verdict || heuristicVerification.review_summary?.overall_verdict || "needs_more_evidence",
      risk_level: review.risk_level || heuristicVerification.review_summary?.risk_level || "medium",
      explanation: review.explanation || heuristicVerification.review_summary?.explanation || ""
    },
    llm_review: review
  };
}

async function verifyEvidenceUnits(evidenceUnits) {
  const heuristicVerification = verifyEvidenceUnitsHeuristic(evidenceUnits);

  try {
    const review = await requestVerificationReviewFromModel(evidenceUnits, heuristicVerification);
    if (!review) {
      return heuristicVerification;
    }
    return mergeVerificationWithModelReview(heuristicVerification, review);
  } catch (error) {
    return {
      ...heuristicVerification,
      verifier_mode: "fallback",
      review_summary: {
        ...heuristicVerification.review_summary,
        explanation: `${heuristicVerification.review_summary?.explanation || ""} LLM verifier fallback: ${error.message}`.trim()
      }
    };
  }
}

module.exports = {
  verifyEvidenceUnits,
  verifyEvidenceUnitsHeuristic,
  requestVerificationReviewFromModel,
  mergeVerificationWithModelReview
};
