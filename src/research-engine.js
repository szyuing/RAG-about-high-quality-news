const fs = require("fs");
const path = require("path");
const { sources, samplePrompts } = require("./source-pack");

const experiencePath = path.join(__dirname, "..", "data", "experience-memory.json");

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return Array.from(new Set(normalized.split(" ").filter((token) => token.length > 1)));
}

function buildSearchBlob(source) {
  return normalizeText([
    source.title,
    source.summary,
    source.platform,
    source.author,
    ...(source.tags || []),
    source.content?.markdown || "",
    ...(source.content?.keyPoints || []),
    ...((source.transcript || []).map((entry) => entry.text))
  ].join(" "));
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

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function readExperienceMemory() {
  try {
    const raw = fs.readFileSync(experiencePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return [];
  }
}

function writeExperienceMemory(entries) {
  fs.writeFileSync(experiencePath, JSON.stringify(entries, null, 2));
}

function getSamples() {
  return samplePrompts;
}

function getExperienceMemory() {
  return readExperienceMemory().slice(0, 8);
}

function planner(question) {
  const lower = question.toLowerCase();
  const subQuestions = [];
  const requiredEvidence = [];

  if (/(相比|对比|差异|提升|update|更新|versus|vs)/i.test(question)) {
    subQuestions.push("当前状态或最新版本是什么");
    subQuestions.push("历史基线或对照版本是什么");
    subQuestions.push("两者差异体现在哪些指标或能力上");
  } else {
    subQuestions.push("核心问题的直接答案是什么");
    subQuestions.push("哪些证据可以支撑这个答案");
  }

  if (/(视频|访谈|发布会|youtube|b站|bilibili)/i.test(question) || /(sora|iphone|发布)/i.test(question)) {
    requiredEvidence.push("视频或多媒体转写");
  }
  requiredEvidence.push("官方或高权威网页");
  requiredEvidence.push("结构化事实或关键数字");

  if (/(为什么|how|why)/i.test(question)) {
    requiredEvidence.push("设计说明或长文分析");
  }

  const sourcePriority = [
    { source_type: "web", reason: "优先拿官方和高权威来源确认主事实" },
    { source_type: "document", reason: "补充长文、报告和正式说明" },
    { source_type: "video", reason: "补充发布会、评测、访谈等多媒体证据" },
    { source_type: "forum", reason: "只用于发现冲突和边缘线索，不作为主结论基础" }
  ];

  const baseQueries = [
    question,
    `${question} 官方`,
    `${question} 评测 视频`
  ];

  if (lower.includes("sora")) {
    baseQueries.push("Sora current duration official update");
  }
  if (lower.includes("苹果") || lower.includes("iphone") || lower.includes("apple")) {
    baseQueries.push("iPhone 16 vs iPhone 15 benchmark");
  }
  if (lower.includes("规划") || lower.includes("搜索")) {
    baseQueries.push("planner first search workflow");
  }

  return {
    task_goal: question,
    sub_questions: Array.from(new Set(subQuestions)),
    required_evidence: Array.from(new Set(requiredEvidence)),
    source_priority: sourcePriority,
    initial_queries: Array.from(new Set(baseQueries)).slice(0, 4),
    stop_condition: "至少覆盖 2 类来源、回答全部子问题、关键冲突已有解释或降级处理。"
  };
}

function toCandidateCard(source, score, query) {
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    platform: source.platform,
    source_type: source.sourceType,
    author: source.author,
    published_at: source.publishedAt,
    duration: source.duration,
    engagement: source.engagement,
    authority_score: source.authorityScore,
    summary: source.summary,
    matched_query: query,
    score: Number(score.toFixed(4))
  };
}

function enhancedSearch(query) {
  const tokens = tokenize(query);
  const results = [];

  for (const source of sources) {
    const blob = buildSearchBlob(source);
    let tokenHits = 0;
    let weightedHits = 0;

    for (const token of tokens) {
      if (blob.includes(token)) {
        tokenHits += 1;
        weightedHits += token.length >= 5 ? 1.2 : 1;
      }
    }

    if (!tokens.length || tokenHits === 0) {
      continue;
    }

    const relevance = weightedHits / tokens.length;
    const freshnessBias = source.publishedAt >= "2025-01-01" ? 0.08 : 0;
    const score = relevance * 0.72 + source.authorityScore * 0.2 + freshnessBias;
    results.push(toCandidateCard(source, score, query));
  }

  return dedupeBy(results, (item) => item.url)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
}

function deepReadPage(sourceId) {
  const source = sources.find((item) => item.id === sourceId);
  if (!source || !source.content) {
    return null;
  }

  return {
    source_id: source.id,
    tool: "deep_read_page",
    title: source.title,
    url: source.url,
    author: source.author,
    published_at: source.publishedAt,
    markdown: source.content.markdown,
    key_points: source.content.keyPoints,
    sections: source.content.sections,
    facts: source.facts || []
  };
}

function extractVideoIntel(sourceId) {
  const source = sources.find((item) => item.id === sourceId);
  if (!source || !source.transcript) {
    return null;
  }

  return {
    source_id: source.id,
    tool: "extract_video_intel",
    title: source.title,
    url: source.url,
    author: source.author,
    published_at: source.publishedAt,
    duration: source.duration,
    transcript: source.transcript,
    timeline: source.timeline,
    key_frames: source.keyFrames,
    facts: source.facts || []
  };
}

function routeCandidate(candidate) {
  if (candidate.source_type === "video") {
    return "multimedia";
  }
  return "deep_analyst";
}

function createScratchpad(plan) {
  return {
    facts_collected: [],
    queries_tried: [],
    sources_read: [],
    conflict_found: [],
    temporary_conclusions: [],
    resolved_questions: [],
    missing_questions: [...plan.sub_questions],
    failure_paths: []
  };
}

function scoreQuestionCoverage(question, evidenceItems) {
  const questionTokens = tokenize(question);
  if (!questionTokens.length) {
    return 0;
  }

  let best = 0;
  for (const item of evidenceItems) {
    const blob = normalizeText([
      item.title,
      ...(item.key_points || []),
      item.markdown || "",
      ...((item.timeline || []).map((entry) => entry.summary)),
      ...(item.facts || []).map((fact) => `${fact.claim} ${fact.value}`)
    ].join(" "));

    let hits = 0;
    for (const token of questionTokens) {
      if (blob.includes(token)) {
        hits += 1;
      }
    }
    best = Math.max(best, hits / questionTokens.length);
  }
  return best;
}

function crossCheckFacts(facts) {
  const grouped = new Map();
  for (const fact of facts) {
    const key = `${fact.subject}:${fact.kind}`;
    const list = grouped.get(key) || [];
    list.push(fact);
    grouped.set(key, list);
  }

  const confirmations = [];
  const conflicts = [];

  for (const [key, entries] of grouped.entries()) {
    if (entries.length < 2) {
      confirmations.push({
        key,
        status: "single_source",
        preferred_fact: entries[0],
        reason: "只有单一来源，暂不构成冲突。"
      });
      continue;
    }

    const distinctValues = Array.from(new Set(entries.map((entry) => JSON.stringify(entry.value))));
    const [subject, kind] = key.split(":");
    const preferredFact = [...entries].sort((left, right) => {
      const leftSource = sources.find((source) => source.id === left.source_id) || {};
      const rightSource = sources.find((source) => source.id === right.source_id) || {};
      return (rightSource.authorityScore || 0) - (leftSource.authorityScore || 0);
    })[0];

    const isComplementaryTextFact =
      kind && /(architecture_update|architecture_focus|efficiency_focus|core_workflow)/.test(kind) && entries.every((entry) => typeof entry.value === "string");

    if (distinctValues.length === 1 || isComplementaryTextFact) {
      confirmations.push({
        key,
        status: isComplementaryTextFact ? "complementary" : "confirmed",
        preferred_fact: preferredFact,
        reason: isComplementaryTextFact
          ? `同一主题 ${subject} 的多个来源提供互补更新，不视为直接冲突。`
          : "多个来源一致。"
      });
    } else {
      conflicts.push({
        key,
        status: "conflict",
        candidates: entries,
        preferred_fact: preferredFact,
        reason: "多个来源给出不同值，优先保留权威度更高来源，同时标记不确定性。"
      });
    }
  }

  return { confirmations, conflicts };
}

function evaluator(plan, scratchpad, evidenceItems, verification, roundsCompleted) {
  const facts = evidenceItems.flatMap((item) => item.facts || []);
  const factKinds = new Set(facts.map((fact) => fact.kind));
  const subjects = new Set(facts.map((fact) => fact.subject));
  const resolvedQuestions = [];
  const missingQuestions = [];

  for (const question of plan.sub_questions) {
    let resolved = false;

    if (question.includes("当前状态")) {
      resolved = factKinds.has("duration_limit_seconds") || factKinds.has("cpu_uplift_percent");
    } else if (question.includes("历史基线")) {
      resolved = factKinds.has("launch_duration_seconds") || subjects.size >= 2 || evidenceItems.length >= 2;
    } else if (question.includes("差异体现")) {
      resolved = factKinds.has("architecture_update") || factKinds.has("gpu_uplift_percent") || factKinds.has("efficiency_focus");
    } else if (question.includes("直接答案")) {
      resolved = facts.length >= 1;
    } else if (question.includes("证据")) {
      resolved = evidenceItems.length >= 2;
    }

    if (!resolved) {
      const coverage = scoreQuestionCoverage(question, evidenceItems);
      resolved = coverage >= 0.3;
    }

    if (resolved) {
      resolvedQuestions.push(question);
    } else {
      missingQuestions.push(question);
    }
  }

  const sourceTypesCovered = new Set(scratchpad.sources_read.map((item) => item.source_type));
  const hasEnoughDiversity = sourceTypesCovered.size >= 2 || evidenceItems.length >= 3;
  const severeConflicts = verification.conflicts.length > 1;
  const isSufficient = missingQuestions.length === 0 && hasEnoughDiversity && !severeConflicts;

  return {
    is_sufficient: isSufficient,
    resolved_questions: resolvedQuestions,
    missing_questions: missingQuestions,
    risk_notes: severeConflicts
      ? ["仍存在多项关键事实冲突，结论需保留不确定性。"]
      : verification.conflicts.length
        ? ["存在轻度冲突，已按权威度优先处理。"]
        : [],
    next_best_action: isSufficient
      ? "synthesize_answer"
      : roundsCompleted >= 2
        ? "stop_with_partial_answer"
        : "run_follow_up_search",
    reason: isSufficient
      ? "子问题已覆盖，且来源类型达到最低多样性要求。"
      : "仍有子问题未覆盖或关键信息冲突未收敛。"
  };
}

function buildEvidenceItems(reads) {
  return reads.filter(Boolean).map((item) => ({
    source_id: item.source_id,
    title: item.title,
    source_type: item.tool === "extract_video_intel" ? "video" : "web",
    key_points: item.key_points || item.timeline?.map((entry) => entry.summary) || [],
    markdown: item.markdown || "",
    timeline: item.timeline || [],
    facts: (item.facts || []).map((fact) => ({ ...fact, source_id: item.source_id }))
  }));
}

function formatFact(fact) {
  if (typeof fact.value === "number") {
    return `${fact.claim}（${fact.value}${fact.unit ? ` ${fact.unit}` : ""}）`;
  }
  return fact.claim;
}

function synthesize(question, mode, candidates, reads, verification, evaluation) {
  const evidenceItems = buildEvidenceItems(reads);
  const allFacts = evidenceItems.flatMap((item) => item.facts);
  const preferredFacts = [
    ...verification.confirmations.map((entry) => entry.preferred_fact),
    ...verification.conflicts.map((entry) => entry.preferred_fact)
  ].filter(Boolean);
  const factPriority = {
    duration_limit_seconds: 1,
    launch_duration_seconds: 2,
    cpu_uplift_percent: 3,
    gpu_uplift_percent: 4,
    architecture_focus: 5,
    architecture_update: 6,
    efficiency_focus: 7,
    core_workflow: 8
  };
  const topFacts = dedupeBy(preferredFacts.length ? preferredFacts : allFacts, (fact) => `${fact.subject}:${fact.kind}`)
    .sort((left, right) => (factPriority[left.kind] || 99) - (factPriority[right.kind] || 99))
    .slice(0, 5);

  const quickAnswerLines = [];
  if (topFacts.length) {
    quickAnswerLines.push(`针对“${question}”，当前版本已经拿到 ${reads.length} 条深读结果和 ${candidates.length} 条候选来源。`);
    quickAnswerLines.push(topFacts.map(formatFact).join("；"));
  } else {
    quickAnswerLines.push(`针对“${question}”，当前版本已完成规划和候选筛选，但证据仍偏弱。`);
  }

  if (verification.conflicts.length) {
    quickAnswerLines.push(`系统检测到 ${verification.conflicts.length} 个事实冲突，已按来源权威度和发布时间做降级处理。`);
  }

  const evidenceChain = reads.map((item) => {
    const source = sources.find((entry) => entry.id === item.source_id);
    return {
      source_id: item.source_id,
      title: item.title,
      platform: source?.platform,
      source_type: source?.sourceType,
      why_it_matters: item.tool === "extract_video_intel"
        ? "提供视频转写、时间轴和关键观点时间点"
        : "提供正文、关键段落和结构化事实"
    };
  });

  const deepResearchSummary = {
    headline: `Deep Web Search 对问题“${question}”的研究摘要`,
    conclusion: quickAnswerLines.join(" "),
    evidence_chain: evidenceChain,
    conflicts: verification.conflicts.map((entry) => ({
      key: entry.key,
      preferred_claim: entry.preferred_fact?.claim,
      reason: entry.reason
    })),
    uncertainty: evaluation.risk_notes.length
      ? evaluation.risk_notes
      : verification.conflicts.length
        ? ["存在少量来源冲突，需在真实联网接入后进一步核实。"]
        : ["当前结论基于本地演示语料，不代表实时互联网结果。"],
    confidence: Number(Math.max(0.35, Math.min(0.92, average(candidates.map((item) => item.authority_score)))).toFixed(2))
  };

  return {
    mode,
    headline: deepResearchSummary.headline,
    quick_answer: quickAnswerLines.join(" "),
    deep_research_summary: deepResearchSummary
  };
}

function summarizeExperience(question, scratchpad, plan, evaluation) {
  return {
    created_at: new Date().toISOString(),
    question,
    useful_queries: scratchpad.queries_tried.slice(0, 4),
    useful_source_types: Array.from(new Set(scratchpad.sources_read.map((item) => item.source_type))),
    note: evaluation.is_sufficient
      ? `该问题可通过 ${plan.source_priority.slice(0, 3).map((item) => item.source_type).join(" + ")} 组合完成首轮闭环。`
      : "该问题在当前语料内仍有缺口，真实接入时应补官方来源或更强核验。"
  };
}

function selectCandidates(candidates) {
  const chosen = [];
  const perTypeCount = new Map();

  for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
    const typeCount = perTypeCount.get(candidate.source_type) || 0;
    if (typeCount >= 2 && chosen.length >= 4) {
      continue;
    }

    chosen.push(candidate);
    perTypeCount.set(candidate.source_type, typeCount + 1);
    if (chosen.length >= 6) {
      break;
    }
  }

  return chosen;
}

function runRound(queries, scratchpad) {
  const candidatePool = [];
  for (const query of queries) {
    scratchpad.queries_tried.push(query);
    const results = enhancedSearch(query);
    if (!results.length) {
      scratchpad.failure_paths.push({
        query,
        reason: "No relevant candidates in local source pack."
      });
    }
    candidatePool.push(...results);
  }

  const uniqueCandidates = dedupeBy(candidatePool, (item) => item.id).sort((left, right) => right.score - left.score);
  const selected = selectCandidates(uniqueCandidates);
  const routedTasks = [];
  const reads = [];

  for (const candidate of selected) {
    const route = routeCandidate(candidate);
    routedTasks.push({
      source_id: candidate.id,
      tool: route === "multimedia" ? "extract_video_intel" : "deep_read_page",
      agent: route
    });

    const output = route === "multimedia" ? extractVideoIntel(candidate.id) : deepReadPage(candidate.id);
    if (output) {
      reads.push(output);
      scratchpad.sources_read.push({
        source_id: candidate.id,
        title: candidate.title,
        source_type: candidate.source_type,
        tool: routedTasks[routedTasks.length - 1].tool
      });
    }
  }

  return {
    candidates: uniqueCandidates,
    selected,
    routed_tasks: routedTasks,
    reads
  };
}

function buildFollowUpQueries(question, evaluation) {
  if (!evaluation.missing_questions.length) {
    return [];
  }
  return evaluation.missing_questions.map((item) => `${question} ${item}`).slice(0, 2);
}

function runResearch({ question, mode }) {
  const plan = planner(question);
  const scratchpad = createScratchpad(plan);
  const rounds = [];
  let combinedCandidates = [];
  let combinedReads = [];
  let verification = { confirmations: [], conflicts: [] };
  let evaluation = null;

  for (let index = 0; index < 2; index += 1) {
    const queries = index === 0 ? plan.initial_queries : buildFollowUpQueries(question, evaluation);
    if (!queries.length) {
      break;
    }

    const round = runRound(queries, scratchpad);
    combinedCandidates = dedupeBy([...combinedCandidates, ...round.candidates], (item) => item.id).sort((left, right) => right.score - left.score);
    combinedReads = dedupeBy([...combinedReads, ...round.reads], (item) => item.source_id);

    const facts = buildEvidenceItems(combinedReads).flatMap((item) => item.facts);
    scratchpad.facts_collected = facts;
    verification = crossCheckFacts(facts);
    scratchpad.conflict_found = verification.conflicts;
    evaluation = evaluator(plan, scratchpad, buildEvidenceItems(combinedReads), verification, index + 1);
    scratchpad.resolved_questions = evaluation.resolved_questions;
    scratchpad.missing_questions = evaluation.missing_questions;

    rounds.push({
      round: index + 1,
      queries,
      candidates_returned: round.candidates.length,
      selected_sources: round.selected.map((item) => item.id),
      routed_tasks: round.routed_tasks,
      evaluation_snapshot: {
        is_sufficient: evaluation.is_sufficient,
        next_best_action: evaluation.next_best_action,
        missing_questions: evaluation.missing_questions
      }
    });

    if (evaluation.is_sufficient) {
      break;
    }
  }

  const finalAnswer = synthesize(question, mode, combinedCandidates, combinedReads, verification, evaluation);
  const experience = summarizeExperience(question, scratchpad, plan, evaluation);
  const memory = readExperienceMemory();
  writeExperienceMemory([experience, ...memory].slice(0, 30));

  return {
    task_id: `task_${Date.now()}`,
    question,
    plan,
    rounds,
    candidates: combinedCandidates.slice(0, 10),
    reads: combinedReads,
    verification,
    evaluation,
    scratchpad,
    experience,
    final_answer: finalAnswer
  };
}

module.exports = {
  runResearch,
  getSamples,
  getExperienceMemory
};
