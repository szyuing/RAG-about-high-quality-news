const { normalizeText, toIsoTimestamp } = require("./evidence-model");

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

  return {
    key: `${preferred.subject || "claim"}:${preferred.type || preferred.kind || "statement"}:${preferred.unit || ""}`,
    status,
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
      verdict_reason: describeVerificationReason(preferred, others)
    },
    reason: describeVerificationReason(preferred, others)
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

function verifyEvidenceUnits(evidenceUnits) {
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
    coverage_gaps: coverageGaps
  };
}

module.exports = {
  verifyEvidenceUnits
};
