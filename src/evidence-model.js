function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIntoSentences(value) {
  return String(value || "")
    .split(/(?<=[.!?。！？])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokenize(value) {
  return Array.from(new Set(normalizeText(value).split(" ").filter((token) => token.length > 1)));
}

function toIsoTimestamp(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stableAuthorityScore(item) {
  if (Number.isFinite(Number(item?.authority_score))) {
    return Number(item.authority_score);
  }
  return Number(item?.metadata?.authority_score || item?.source_metadata?.authority_score || 0.66);
}

function buildQuoteCandidates(read) {
  const timelineQuotes = (read.timeline || [])
    .map((entry, index) => ({
      id: `${read.source_id}:timeline:${index + 1}`,
      text: entry.summary || entry.title || "",
      locator: entry.start || null,
      kind: "timeline"
    }))
    .filter((item) => item.text);

  const sectionQuotes = splitIntoSentences(read.markdown || "")
    .filter((sentence) => sentence.length >= 40)
    .slice(0, 4)
    .map((sentence, index) => ({
      id: `${read.source_id}:quote:${index + 1}`,
      text: sentence.slice(0, 260),
      locator: `quote_${index + 1}`,
      kind: "quote"
    }));

  return [...timelineQuotes, ...sectionQuotes].slice(0, 6);
}

function buildEvidenceSpans(read, quotes) {
  const sectionSpans = (read.sections || []).map((section, index) => ({
    id: `${read.source_id}:section:${index + 1}`,
    kind: "section",
    label: section.heading || `Section ${index + 1}`,
    text: section.excerpt || "",
    locator: section.heading || null
  }));

  const transcriptSpans = (read.transcript || []).slice(0, 6).map((cue, index) => ({
    id: `${read.source_id}:transcript:${index + 1}`,
    kind: "transcript",
    label: cue.start || `Transcript ${index + 1}`,
    text: cue.text || "",
    locator: cue.start || null
  }));

  const quoteSpans = quotes.map((quote) => ({
    id: `${quote.id}:span`,
    kind: quote.kind,
    label: quote.locator || quote.kind,
    text: quote.text,
    locator: quote.locator
  }));

  return [...sectionSpans, ...transcriptSpans, ...quoteSpans].filter((item) => item.text);
}

function buildClaimRecords(read, evidenceSpans) {
  const evidenceSpanIds = evidenceSpans.slice(0, 3).map((item) => item.id);
  const factClaims = (read.facts || []).map((fact, index) => ({
    id: `${read.source_id}:claim:fact:${index + 1}`,
    type: fact.kind || "fact",
    claim: fact.claim,
    subject: fact.subject,
    value: fact.value,
    unit: fact.unit || null,
    evidence_span_ids: evidenceSpanIds,
    source_id: read.source_id,
    published_at: toIsoTimestamp(read.published_at),
    authority_score: stableAuthorityScore(read)
  }));

  const keyPointClaims = (read.key_points || [])
    .filter(Boolean)
    .slice(0, 3)
    .map((claim, index) => ({
      id: `${read.source_id}:claim:keypoint:${index + 1}`,
      type: "key_point",
      claim,
      subject: read.title || read.source_id,
      value: null,
      unit: null,
      evidence_span_ids: evidenceSpanIds,
      source_id: read.source_id,
      published_at: toIsoTimestamp(read.published_at),
      authority_score: stableAuthorityScore(read)
    }));

  return [...factClaims, ...keyPointClaims];
}

function createEvidenceUnit(read, candidate = {}) {
  const quotes = buildQuoteCandidates(read);
  const evidenceSpans = buildEvidenceSpans(read, quotes);
  const claims = buildClaimRecords(read, evidenceSpans);
  const sourceType = read.content_type || read.source_type || (read.tool === "extract_video_intel" ? "video" : "web");

  return {
    source_id: read.source_id,
    title: read.title,
    content_type: sourceType,
    source_type: sourceType,
    tool: read.tool,
    markdown: read.markdown || "",
    timeline: read.timeline || [],
    transcript: read.transcript || [],
    key_points: read.key_points || [],
    key_frames: read.key_frames || [],
    facts: (read.facts || []).map((fact) => ({ ...fact, source_id: read.source_id })),
    quotes,
    evidence_spans: evidenceSpans,
    claims,
    source_metadata: {
      connector: candidate.connector || read.connector || null,
      platform: candidate.platform || read.platform || null,
      url: read.url || candidate.url || null,
      author: read.author || candidate.author || null,
      published_at: toIsoTimestamp(read.published_at || candidate.published_at),
      source_type: sourceType,
      authority_score: stableAuthorityScore({
        authority_score: candidate.score,
        metadata: candidate.metadata,
        source_metadata: read.source_metadata
      }),
      query: candidate.query || null
    }
  };
}

function scoreQuestionCoverage(question, evidenceUnits) {
  const tokens = tokenize(question);
  if (!tokens.length) {
    return 0;
  }

  let best = 0;
  for (const item of evidenceUnits) {
    const blob = normalizeText([
      item.title,
      item.markdown,
      ...(item.key_points || []),
      ...(item.timeline || []).map((entry) => entry.summary || entry.title),
      ...(item.claims || []).map((claim) => claim.claim)
    ].join(" "));

    const hits = tokens.filter((token) => blob.includes(token)).length;
    best = Math.max(best, hits / tokens.length);
  }
  return best;
}

module.exports = {
  normalizeText,
  tokenize,
  toIsoTimestamp,
  createEvidenceUnit,
  scoreQuestionCoverage
};
