const fs = require("fs");
const path = require("path");
const { samplePrompts, sourceCatalog, ToolRegistry, __internal } = require("./source-connectors");
const { createEvidenceUnit } = require("./evidence-model");
const { extractTextFromResponsePayload } = require("./openai-response");
const {
  synthesizeTool,
  runEphemeralTool,
  readToolMemory,
  recordToolExperience
} = require("./ephemeral-tooling");
const {
  createAgentRuntime,
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentRuntimeSnapshot,
  createAgentRegistry,
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

const experiencePath = path.join(__dirname, "..", "data", "experience-memory.json");
const knowledgeGraphPath = path.join(__dirname, "..", "data", "knowledge-graph.json");
const OPENAI_RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses";
const DEFAULT_PLANNER_MODEL = process.env.OPENAI_PLANNER_MODEL || "gpt-4o-mini";

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

function readExperienceMemory() {
  try {
    return JSON.parse(fs.readFileSync(experiencePath, "utf8"));
  } catch (_) {
    return [];
  }
}

function writeExperienceMemory(entries) {
  fs.writeFileSync(experiencePath, JSON.stringify(entries, null, 2));
}

function readKnowledgeGraph() {
  try {
    const payload = JSON.parse(fs.readFileSync(knowledgeGraphPath, "utf8"));
    return KnowledgeGraph.fromExport(payload);
  } catch (_) {
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
  const questionTokens = tokenize(question);
  const blob = normalizeText([
    entry.question,
    ...(entry.useful_queries || []),
    ...(entry.useful_source_types || []),
    ...(entry.useful_platforms || []),
    ...(entry.effective_search_terms || [])
  ].join(" "));

  return questionTokens.reduce((score, token) => score + (blob.includes(token) ? 1 : 0), 0);
}

function getRelevantExperienceHints(question, memory = readExperienceMemory()) {
  const entries = [...memory]
    .map((entry) => ({
      ...entry,
      relevance: scoreExperienceRelevance(question, entry)
    }))
    .filter((entry) => entry.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, 3);

  return {
    entries,
    boosted_queries: Array.from(new Set(entries.flatMap((entry) => entry.useful_queries || []))).slice(0, 4),
    boosted_source_types: Array.from(new Set(entries.flatMap((entry) => entry.useful_source_types || []))).slice(0, 4),
    avoided_patterns: Array.from(new Set(entries.flatMap((entry) => entry.noisy_paths || []))).slice(0, 4)
  };
}

function buildSeedQueries(question, experienceHints = null) {
  const hints = buildEnglishQueryHints(question);
  const boostedQueries = (experienceHints?.boosted_queries || [])
    .filter((item) => normalizeText(item) !== normalizeText(question));
  return Array.from(new Set([question, ...boostedQueries, ...hints])).slice(0, 4);
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

function inferPreferredConnectors(question, experienceHints = null) {
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
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(({ id, label, reason }) => ({ id, label, reason }));
}

function chooseConnectorsForQuestion(question, preferredConnectors, experienceHints = null) {
  const preferred = preferredConnectors || inferPreferredConnectors(question, experienceHints);
  const chosen = preferred.map((item) => item.id).filter(Boolean);

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
      }
    },
    required: ["chosen_connector_ids", "rationale", "connector_reasons"]
  };

  const prompt = [
    "Select the best information source connectors for a research question.",
    "Choose only from the provided connectors.",
    "Pick 2 to 4 connectors that are most likely to produce strong evidence for the question.",
    "Prefer primary or official sources when relevant, but do not force diversity if the topic strongly points to a smaller set.",
    "Question:",
    question,
    "",
    "Available connectors:",
    JSON.stringify(connectors, null, 2)
  ].join("\n");

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
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
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI planner failed with HTTP ${response.status}`);
  }

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI planner returned no text output");
  }

  return JSON.parse(rawText);
}

function mergePlanWithModelSelection(basePlan, modelSelection) {
  const fallbackIds = basePlan.chosen_connector_ids || basePlan.preferred_connectors.map((item) => item.id);
  const chosenConnectorIds = normalizeModelConnectorIds(modelSelection?.chosen_connector_ids, fallbackIds);
  const reasonMap = new Map((modelSelection?.connector_reasons || []).map((item) => [item.id, item.reason]));

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
    preferred_connectors: preferredConnectors.length ? preferredConnectors : basePlan.preferred_connectors,
    chosen_connector_ids: chosenConnectorIds,
    planner_mode: "llm",
    planner_rationale: modelSelection?.rationale || ""
  };
}

function planner(question, experienceHints = getRelevantExperienceHints(question)) {
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

  const preferredConnectors = inferPreferredConnectors(question, experienceHints);
  const chosenConnectorIds = chooseConnectorsForQuestion(question, preferredConnectors, experienceHints);

  return {
    task_goal: question,
    sub_questions: subQuestions,
    required_evidence: requiredEvidence,
    source_strategy: "Supervisor selects connectors first, then dispatches candidates to specialist agents.",
    preferred_connectors: preferredConnectors,
    chosen_connector_ids: chosenConnectorIds,
    experience_hints: experienceHints,
    source_capabilities: sourceCatalog,
    initial_queries: buildSeedQueries(question, experienceHints),
    stop_policy: buildStopPolicy(question, subQuestions),
    stop_condition: "Stop when core questions are covered by evidence from at least two source types and conflicts are disclosed."
  };
}

async function buildPlan(question) {
  const experienceHints = getRelevantExperienceHints(question);
  const basePlan = planner(question, experienceHints);
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
      from: "supervisor",
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

function synthesize(question, mode, candidates, reads, evidenceItems, verification, evaluation, telemetry) {
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

  return {
    mode,
    headline: `Research summary for "${question}"`,
    quick_answer: conclusion,
    deep_research_summary: {
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
      uncertainty: evaluation.risk_notes.length
        ? evaluation.risk_notes
        : ["No major unresolved evidence gaps were detected."],
      evaluation_scorecard: evaluation.scorecard || null,
      stop_state: evaluation.stop_state || null,
      stop_decision: evaluation.llm_stop_decision || null,
      confidence: (() => {
        const baseScore = evaluation.is_sufficient ? 0.58 : 0.38;
        const diversityBonus = Math.min(0.15, ((evaluation.metrics?.source_types_covered || 0) / 4) * 0.15);
        const total = verification.confirmations.length + verification.conflicts.length + verification.coverage_gaps.length;
        const confirmationBonus = total > 0 ? (verification.confirmations.length / total) * 0.2 : 0;
        return Number(Math.min(0.94, baseScore + diversityBonus + confirmationBonus).toFixed(2));
      })(),
      dynamic_tools: telemetry.ephemeral_tools.map((item) => ({
        tool_id: item.tool.tool_id,
        strategy: item.tool.strategy,
        target: item.target,
        success: item.success,
        logs: item.logs,
        worth_promoting: item.worth_promoting
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

function summarizeExperience(question, scratchpad, plan, evaluation, telemetry) {
  const usefulPlatforms = [];
  const effectiveSearchTerms = [];
  const primarySourceSites = [];
  const efficientToolCombinations = [];
  const noisyPaths = [];

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
    question,
    useful_queries: scratchpad.queries_tried.slice(0, 5),
    useful_source_types: Array.from(new Set(scratchpad.sources_read.map((item) => item.content_type || item.source_type))),
    useful_platforms: usefulPlatforms,
    effective_search_terms: effectiveSearchTerms,
    primary_source_sites: primarySourceSites,
    efficient_tool_combinations: efficientToolCombinations,
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
    note: evaluation.is_sufficient
      ? "This question is a good fit for the current supervisor-plus-specialists workflow."
      : "This question still exposes connector or evidence-model gaps that should be improved."
  };
}

function buildFollowUpQueries(question, evaluation, scratchpad, experienceHints = getRelevantExperienceHints(question)) {
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
      agent: "supervisor",
      content: query
    });
  }
  appendTimelineEvent(scratchpad, {
    type: "round_started",
    agent: "supervisor",
    queries
  });
  const supervisorTask = runtime
    ? dispatchAgentTask(runtime, {
        from: "supervisor",
        agentId: "supervisor",
        taskType: "coordinate_round",
        input: { queries },
        metadata: {
          query_count: queries.length
        }
      })
    : null;

  const candidates = await runWebResearcher(plan, queries, telemetry, runtime);
  if (!candidates.length) {
    for (const query of queries) {
      scratchpad.failure_paths.push({ query, reason: "no candidate returned" });
      recordAgentNote(scratchpad, "web_researcher", {
        type: "failure",
        content: `No candidate returned for query: ${query}`
      });
    }
  }

  const selected = selectCandidates(candidates, question, plan);
  const specialistReads = await runSpecialistReads(selected, telemetry, runtime);
  const routedTasks = specialistReads.routed_tasks?.length
    ? specialistReads.routed_tasks
    : selected.map((candidate) => {
        const agent = routeCandidate(candidate);
        const tool = collectorToolForCandidate(candidate);
        return {
          source_id: candidate.id,
          segment_source_id: candidate.id,
          agent,
          tool,
          connector: candidate.connector
        };
      });
  const reads = specialistReads.results.map((item) => item.read);
  const evidenceItems = specialistReads.results.map((item) => item.evidence_unit);
  const fallback = await attemptEphemeralFallbacks(question, specialistReads.failures, telemetry, onProgress);

  for (const task of routedTasks) {
    const candidate = selected.find((item) => item.id === task.source_id);
    recordHandoff(scratchpad, {
      from: "supervisor",
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
        agent: "supervisor",
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
      parser_agent: read.parser_agent || routeCandidate(candidate),
      tool: read.tool,
      pages: read.segment_pages || null
    };
    scratchpad.sources_read.push(sourceRecord);
    recordAgentArtifact(scratchpad, read.parser_agent || routeCandidate(candidate), {
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
  if (supervisorTask) {
    completeAgentTask(runtime, supervisorTask.id, {
      candidate_count: candidates.length,
      selected_count: selected.length,
      routed_task_count: routedTasks.length
    });
  }

  return {
    candidates,
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

  const maxRounds = Math.max(1, plan.stop_policy?.max_rounds || 2);
  for (let index = 0; index < maxRounds; index += 1) {
    const queries = index === 0 ? plan.initial_queries : buildFollowUpQueries(question, evaluation, scratchpad, experienceHints);
    if (!queries.length) {
      break;
    }

    const round = await runRound(plan, question, queries, scratchpad, telemetry, onProgress);
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
      supervisor: {
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
        target: item.target?.url || item.target?.title || "unknown target"
      }))
    };
    scratchpad.agent_reports.push(roundAgentReport);
    recordAgentArtifact(scratchpad, "supervisor", {
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
      chosen_connector_ids: plan.chosen_connector_ids,
      candidates_returned: round.candidates.length,
      selected_sources: round.selected.map((item) => ({
        id: item.id,
        title: item.title,
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
        target: item.target?.url || item.target?.title || "unknown target"
      })),
      agent_reports: roundAgentReport
    };
    rounds.push(roundSummary);

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

    if (evaluation.stop_state?.should_stop_now) {
      telemetry.stop_reason = evaluation.stop_state.reason;
      break;
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
  for (const connectorId of plan.chosen_connector_ids) {
    const failures = telemetry.failures.filter((item) => item.connector === connectorId || item.stage === "discover");
    telemetry.connector_health[connectorId] = {
      failed_events: failures.length,
      healthy: failures.length < Math.max(2, rounds.length + 1)
    };
  }

  await emitProgress(onProgress, {
    type: "synthesizing",
    counts: {
      rounds: rounds.length,
      candidates: combinedCandidates.length,
      reads: combinedReads.length
    }
  });

  const synthesizerTask = dispatchAgentTask(agentRuntime, {
    from: "supervisor",
    agentId: "synthesizer",
    taskType: "synthesize_answer",
    input: {
      evidence_count: combinedEvidence.length,
      verification
    },
    metadata: {
      rounds: rounds.length
    }
  });
  const finalAnswer = synthesize(question, mode, combinedCandidates, combinedReads, combinedEvidence, verification, evaluation, telemetry);
  completeAgentTask(agentRuntime, synthesizerTask.id, {
    confidence: finalAnswer?.summary?.confidence || null,
    answer_sections: Object.keys(finalAnswer || {})
  });
  const knowledgeGraphExport = knowledgeGraph.export();
  const experience = summarizeExperience(question, scratchpad, plan, evaluation, telemetry);
  const toolMemory = recordToolExperience(telemetry.ephemeral_tools);
  const memory = readExperienceMemory();
  writeExperienceMemory([experience, ...memory].slice(0, 30));
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
    agent_runtime: getAgentRuntimeSnapshot(agentRuntime),
    telemetry,
    tool_memory: toolMemory,
    experience,
    final_answer: finalAnswer
  };
}

module.exports = {
  runResearch,
  getSamples,
  getExperienceMemory,
  getToolMemory,
  getSourceCapabilities,
  synthesizeTool,
  runEphemeralTool,
  __internal: {
    inferPreferredConnectors,
    chooseConnectorsForQuestion,
    buildStopPolicy,
    extractTextFromResponsePayload,
    normalizeModelConnectorIds,
    mergePlanWithModelSelection,
    buildPlan,
    planner,
    getRelevantExperienceHints,
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
    routeCandidate,
    createScratchpad,
    updateQuestionStatus
  }
};
