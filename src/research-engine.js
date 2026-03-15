const fs = require("fs");
const path = require("path");
const { samplePrompts, sourceCatalog, searchRealSources, readCandidate, __internal } = require("./source-connectors");

const experiencePath = path.join(__dirname, "..", "data", "experience-memory.json");

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

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function readExperienceMemory() {
  try {
    return JSON.parse(fs.readFileSync(experiencePath, "utf8"));
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

function buildSeedQueries(question) {
  const hints = buildEnglishQueryHints(question);
  if (hints.length) {
    return Array.from(new Set(hints)).slice(0, 4);
  }
  return [question];
}

function planner(question) {
  const comparisonQuery = /(相比|对比|差异|提升|versus|vs|update|更新)/i.test(question);
  const whyQuery = /(为什么|why|how)/i.test(question);

  const subQuestions = comparisonQuery
    ? [
        "当前版本或当前状态是什么",
        "历史基线或对照版本是什么",
        "两者差异体现在哪些指标、能力或工作流上"
      ]
    : [
        "核心问题的直接答案是什么",
        "哪些证据足以支撑这个答案"
      ];

  const requiredEvidence = [
    "通用网页或官方页面",
    "结构化长文或文档来源"
  ];

  if (/视频|访谈|演讲|发布会|talk|video|sora|iphone/i.test(question)) {
    requiredEvidence.push("视频或多媒体转写");
  }
  if (whyQuery) {
    requiredEvidence.push("讨论或社区来源");
  }

  const initialQueries = buildSeedQueries(question);

  return {
    task_goal: question,
    sub_questions: subQuestions,
    required_evidence: requiredEvidence,
    source_priority: [
      { source_type: "web", reason: "优先找官方页、新闻页和权威长文。" },
      { source_type: "document", reason: "补充论文、研究摘要和结构化背景资料。" },
      { source_type: "video", reason: "补充 Talk、演讲或视频里的原始表述。" },
      { source_type: "forum", reason: "用讨论型来源发现争议点和补充视角。" }
    ],
    source_capabilities: sourceCatalog,
    initial_queries: initialQueries,
    stop_condition: "至少覆盖两类来源，并且核心子问题已经有证据支撑；若仍有冲突，需要明确标注不确定性。"
  };
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
    failure_paths: []
  };
}

function routeCandidate(candidate) {
  if (candidate.source_type === "video") {
    return "multimedia";
  }
  if (candidate.source_type === "forum") {
    return "fact_verifier";
  }
  return "deep_analyst";
}

function selectCandidates(candidates) {
  const sorted = [...candidates].sort((left, right) => right.score - left.score);
  const selected = [];
  const priorities = ["web", "video", "document", "forum"];

  for (const type of priorities) {
    const candidate = sorted.find((item) => item.source_type === type && !selected.some((picked) => picked.url === item.url));
    if (candidate) {
      selected.push(candidate);
    }
    if (selected.length >= 4) {
      return selected;
    }
  }

  for (const candidate of sorted) {
    if (selected.some((item) => item.url === candidate.url)) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= 4) {
      break;
    }
  }

  return selected;
}

function buildEvidenceItems(reads) {
  return reads.map((item) => ({
    source_id: item.source_id,
    title: item.title,
    source_type: item.source_type || (item.tool === "extract_video_intel" ? "video" : "web"),
    key_points: item.key_points || item.timeline?.map((entry) => entry.summary) || [],
    markdown: item.markdown || "",
    timeline: item.timeline || [],
    facts: (item.facts || []).map((fact) => ({ ...fact, source_id: item.source_id }))
  }));
}

function scoreQuestionCoverage(question, evidenceItems) {
  const tokens = buildIntentTokens(question);
  if (!tokens.length) {
    return 0;
  }

  let best = 0;
  for (const item of evidenceItems) {
    const blob = normalizeText([
      item.title,
      ...(item.key_points || []),
      item.markdown || "",
      ...((item.timeline || []).map((entry) => entry.summary)),
      ...(item.facts || []).map((fact) => fact.claim)
    ].join(" "));

    const hits = tokens.filter((token) => blob.includes(token)).length;
    best = Math.max(best, hits / tokens.length);
  }
  return best;
}

function crossCheckFacts(facts) {
  const grouped = new Map();
  for (const fact of facts) {
    const key = `${fact.subject}:${fact.kind}:${fact.unit || ""}`;
    const items = grouped.get(key) || [];
    items.push(fact);
    grouped.set(key, items);
  }

  const confirmations = [];
  const conflicts = [];

  for (const [key, items] of grouped.entries()) {
    if (items.length < 2) {
      confirmations.push({
        key,
        status: "single_source",
        preferred_fact: items[0],
        reason: "只有单一来源命中该数字事实。"
      });
      continue;
    }

    const uniqueValues = Array.from(new Set(items.map((item) => JSON.stringify(item.value))));
    const preferredFact = [...items].sort((left, right) => {
      const leftScore = left.authority_score || 0;
      const rightScore = right.authority_score || 0;
      return rightScore - leftScore;
    })[0];

    if (uniqueValues.length === 1) {
      confirmations.push({
        key,
        status: "confirmed",
        preferred_fact: preferredFact,
        reason: "多个来源给出了相同数字。"
      });
    } else {
      conflicts.push({
        key,
        status: "conflict",
        candidates: items,
        preferred_fact: preferredFact,
        reason: "多个来源给出了不同数字，需要保留争议和来源差异。"
      });
    }
  }

  return { confirmations, conflicts };
}

function evaluator(plan, scratchpad, evidenceItems, verification, roundsCompleted) {
  const sourceTypesCovered = new Set(scratchpad.sources_read.map((item) => item.source_type));
  const intentTokens = buildIntentTokens(plan.task_goal);
  const overallCoverage = scoreQuestionCoverage(plan.task_goal, evidenceItems);
  const hasEnoughDiversity = sourceTypesCovered.size >= 2;
  const hasEnoughEvidence = evidenceItems.length >= 3;
  const resolvedQuestions = [];
  const missingQuestions = [];

  if (overallCoverage >= 0.18 && hasEnoughDiversity && hasEnoughEvidence) {
    resolvedQuestions.push(...plan.sub_questions);
  } else {
    for (const question of plan.sub_questions) {
      const coverage = scoreQuestionCoverage(`${plan.task_goal} ${question}`, evidenceItems);
      if (coverage >= 0.18 || (hasEnoughEvidence && coverage >= 0.12)) {
        resolvedQuestions.push(question);
      } else {
        missingQuestions.push(question);
      }
    }
  }

  const relevantConflicts = verification.conflicts.filter((item) => {
    const blob = normalizeText(item.preferred_fact?.claim || item.key || "");
    if (!intentTokens.length) {
      return true;
    }
    return intentTokens.filter((token) => blob.includes(token)).length >= 1;
  });
  const hardConflict = relevantConflicts.length >= 2;
  const isSufficient = missingQuestions.length === 0 && hasEnoughDiversity && hasEnoughEvidence && !hardConflict;

  return {
    is_sufficient: isSufficient,
    resolved_questions: resolvedQuestions,
    missing_questions: missingQuestions,
    risk_notes: [
      ...(!hasEnoughDiversity ? ["来源类型仍不够丰富。"] : []),
      ...(relevantConflicts.length ? ["存在数字或版本冲突，需要在结论里明确标注。"] : [])
    ],
    next_best_action: isSufficient
      ? "synthesize_answer"
      : roundsCompleted >= 2
        ? "stop_with_partial_answer"
        : "run_follow_up_search",
    reason: isSufficient
      ? "核心子问题已经被两类以上来源覆盖。"
      : "仍有子问题证据不足，或者来源类型不够，或者存在尚未收敛的冲突。"
  };
}

function formatFact(fact) {
  if (typeof fact.value === "number") {
    return `${fact.claim}（${fact.value} ${fact.unit || ""}）`.trim();
  }
  return fact.claim;
}

function synthesize(question, mode, candidates, reads, verification, evaluation) {
  const evidenceItems = buildEvidenceItems(reads);
  const allFacts = evidenceItems.flatMap((item) => item.facts);
  const intentTokens = buildIntentTokens(question);
  const relevantConflicts = verification.conflicts.filter((item) => {
    const blob = normalizeText(item.preferred_fact?.claim || item.key || "");
    if (!intentTokens.length) {
      return true;
    }
    return intentTokens.filter((token) => blob.includes(token)).length >= 1;
  });
  const preferredFacts = [
    ...verification.confirmations.map((entry) => entry.preferred_fact),
    ...relevantConflicts.map((entry) => entry.preferred_fact)
  ].filter(Boolean);
  const factLines = dedupeBy(preferredFacts.length ? preferredFacts : allFacts, (fact) => `${fact.subject}:${fact.kind}:${fact.claim}`)
    .filter((fact) => {
      if (!intentTokens.length) {
        return true;
      }
      const blob = normalizeText(fact.claim);
      return intentTokens.filter((token) => blob.includes(token)).length >= 1;
    })
    .slice(0, 4)
    .map(formatFact);

  const evidenceHighlights = reads
    .slice(0, 4)
    .map((item) => {
      const highlights = item.key_points || item.timeline?.map((entry) => entry.summary) || [];
      return {
        title: item.title,
        source_type: item.tool === "extract_video_intel" ? "video" : "web",
        highlight: (highlights[0] || "该来源提供了与问题直接相关的正文或转写。").slice(0, 220)
      };
    });

  const quickAnswerParts = [
    `针对“${question}”，系统完成了 ${reads.length} 条深读/转写和 ${candidates.length} 条候选筛选。`,
    factLines.length
      ? `当前最强的结构化证据包括：${factLines.join("；")}`
      : `当前高价值来源的结论集中在：${evidenceHighlights.map((item) => `${item.title} 指向“${item.highlight}”`).join("；")}`
  ];

  if (relevantConflicts.length) {
    quickAnswerParts.push(`同时检测到 ${relevantConflicts.length} 处冲突，已在结论中保留不确定性。`);
  }

  return {
    mode,
    headline: `深度网页研究台对问题“${question}”的研究摘要`,
    quick_answer: quickAnswerParts.join(" "),
    deep_research_summary: {
      headline: `深度网页研究台对问题“${question}”的研究摘要`,
      conclusion: quickAnswerParts.join(" "),
      evidence_chain: reads.map((item) => ({
        source_id: item.source_id,
        title: item.title,
        source_type: item.tool === "extract_video_intel" ? "video" : "web",
        why_it_matters: (item.key_points || item.timeline?.map((entry) => entry.summary) || ["提供了直接证据。"])[0]
      })),
      conflicts: relevantConflicts.map((item) => ({
        key: item.key,
        preferred_claim: item.preferred_fact?.claim,
        reason: item.reason
      })),
      uncertainty: evaluation.risk_notes.length
        ? evaluation.risk_notes
        : ["当前结果已来自真实来源，但仍应继续扩展更多权威连接器。"],
      confidence: Number(Math.max(0.35, Math.min(0.92, average(candidates.map((item) => item.authority_score || 0.66)))).toFixed(2))
    }
  };
}

function summarizeExperience(question, scratchpad, plan, evaluation) {
  return {
    created_at: new Date().toISOString(),
    question,
    useful_queries: scratchpad.queries_tried.slice(0, 5),
    useful_source_types: Array.from(new Set(scratchpad.sources_read.map((item) => item.source_type))),
    note: evaluation.is_sufficient
      ? `该问题在当前版本中适合优先走 ${plan.source_priority.map((item) => item.source_type).slice(0, 3).join(" + ")} 的组合路径。`
      : "该问题在当前真实接入层里仍有缺口，后续应补更强的网页搜索、官方源解析和视频平台接入。"
  };
}

async function runRound(queries, scratchpad) {
  const pool = [];

  for (const query of queries) {
    scratchpad.queries_tried.push(query);
    try {
      const candidates = await searchRealSources(query);
      if (!candidates.length) {
        scratchpad.failure_paths.push({ query, reason: "没有从真实来源拿到候选结果。" });
      }
      pool.push(...candidates);
    } catch (error) {
      scratchpad.failure_paths.push({ query, reason: error.message });
    }
  }

  const uniqueCandidates = dedupeBy(pool, (item) => item.url).sort((left, right) => right.score - left.score);
  const selected = selectCandidates(uniqueCandidates);
  const reads = [];
  const routedTasks = [];

  for (const candidate of selected) {
    const agent = routeCandidate(candidate);
    const tool = candidate.source_type === "video" ? "extract_video_intel" : "deep_read_page";
    routedTasks.push({ source_id: candidate.id, agent, tool, connector: candidate.connector });

    try {
      const readResult = await readCandidate(candidate);
      reads.push(readResult);
      scratchpad.sources_read.push({
        source_id: candidate.id,
        title: candidate.title,
        source_type: candidate.source_type,
        connector: candidate.connector,
        tool
      });
    } catch (error) {
      scratchpad.failure_paths.push({
        query: candidate.url,
        reason: `${candidate.connector} read failed: ${error.message}`
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
  if (!evaluation?.missing_questions?.length) {
    return [];
  }
  return evaluation.missing_questions
    .flatMap((item) => buildEnglishQueryHints(`${question} ${item}`))
    .slice(0, 3);
}

async function runResearch({ question, mode }) {
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

    const round = await runRound(queries, scratchpad);
    combinedCandidates = dedupeBy([...combinedCandidates, ...round.candidates], (item) => item.url).sort((left, right) => right.score - left.score);
    combinedReads = dedupeBy([...combinedReads, ...round.reads], (item) => item.source_id);

    const evidenceItems = buildEvidenceItems(combinedReads);
    const facts = evidenceItems.flatMap((item) => item.facts);
    scratchpad.facts_collected = facts;
    verification = crossCheckFacts(facts);
    scratchpad.conflicts_found = verification.conflicts;
    evaluation = evaluator(plan, scratchpad, evidenceItems, verification, index + 1);
    scratchpad.resolved_questions = evaluation.resolved_questions;
    scratchpad.missing_questions = evaluation.missing_questions;

    rounds.push({
      round: index + 1,
      queries,
      candidates_returned: round.candidates.length,
      selected_sources: round.selected.map((item) => ({
        id: item.id,
        title: item.title,
        source_type: item.source_type,
        connector: item.connector
      })),
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

  if (!evaluation) {
    evaluation = {
      is_sufficient: false,
      resolved_questions: [],
      missing_questions: plan.sub_questions,
      risk_notes: ["当前未从真实来源拿到足够结果。"],
      next_best_action: "manual_review",
      reason: "搜索阶段没有成功返回可用候选。"
    };
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
    candidates: combinedCandidates.slice(0, 12),
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
  getExperienceMemory,
  getSourceCapabilities
};
