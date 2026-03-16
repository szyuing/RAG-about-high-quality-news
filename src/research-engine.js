const fs = require("fs");
const path = require("path");
const { samplePrompts, sourceCatalog, ToolRegistry, __internal } = require("./source-connectors");
const { createEvidenceUnit } = require("./evidence-model");
const {
  synthesizeTool,
  runEphemeralTool,
  readToolMemory,
  recordToolExperience
} = require("./ephemeral-tooling");
const {
  createAgentRegistry,
  routeCandidate,
  selectCandidates,
  runWebResearcher,
  runSpecialistReads,
  verifyEvidenceUnits,
  evaluateResearch
} = require("./agent-orchestrator");

const experiencePath = path.join(__dirname, "..", "data", "experience-memory.json");
const OPENAI_RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses";
const DEFAULT_PLANNER_MODEL = process.env.OPENAI_PLANNER_MODEL || "gpt-4o-mini";
const DEFAULT_EVALUATOR_MODEL = process.env.OPENAI_EVALUATOR_MODEL || "gpt-4o-mini";

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

function buildSeedQueries(question) {
  const hints = buildEnglishQueryHints(question);
  return Array.from(new Set([question, ...hints])).slice(0, 4);
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

function inferPreferredConnectors(question) {
  return [...sourceCatalog]
    .map((connector) => ({
      id: connector.id,
      label: connector.label,
      reason: connector.description,
      score: scoreConnectorRelevance(question, connector)
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(({ id, label, reason }) => ({ id, label, reason }));
}

function chooseConnectorsForQuestion(question, preferredConnectors) {
  const preferred = preferredConnectors || inferPreferredConnectors(question);
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

function extractTextFromResponsePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  for (const item of payload.output || []) {
    if (item?.type !== "message") {
      continue;
    }
    for (const content of item.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        chunks.push(content.text.trim());
      }
    }
  }
  return chunks.join("\n").trim();
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

function planner(question) {
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

  const preferredConnectors = inferPreferredConnectors(question);
  const chosenConnectorIds = chooseConnectorsForQuestion(question, preferredConnectors);

  return {
    task_goal: question,
    sub_questions: subQuestions,
    required_evidence: requiredEvidence,
    source_strategy: "Supervisor selects connectors first, then dispatches candidates to specialist agents.",
    preferred_connectors: preferredConnectors,
    chosen_connector_ids: chosenConnectorIds,
    source_capabilities: sourceCatalog,
    initial_queries: buildSeedQueries(question),
    stop_policy: buildStopPolicy(question, subQuestions),
    stop_condition: "Stop when core questions are covered by evidence from at least two source types and conflicts are disclosed."
  };
}

async function buildPlan(question) {
  const basePlan = planner(question);
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

function buildStopDecisionContext(plan, evidenceItems, verification, heuristicEvaluation) {
  return {
    question: plan.task_goal,
    sub_questions: plan.sub_questions,
    stop_policy: plan.stop_policy,
    heuristic_evaluation: {
      is_sufficient: heuristicEvaluation.is_sufficient,
      resolved_questions: heuristicEvaluation.resolved_questions,
      missing_questions: heuristicEvaluation.missing_questions,
      risk_notes: heuristicEvaluation.risk_notes,
      metrics: heuristicEvaluation.metrics
    },
    evidence_summary: evidenceItems.slice(0, 6).map((item) => ({
      source_id: item.source_id,
      title: item.title,
      source_type: item.source_type,
      source_metadata: {
        connector: item.source_metadata?.connector || null,
        platform: item.source_metadata?.platform || null,
        published_at: item.source_metadata?.published_at || null,
        authority_score: item.source_metadata?.authority_score || null
      },
      key_points: (item.key_points || []).slice(0, 3),
      quotes: (item.quotes || []).slice(0, 2).map((quote) => quote.text),
      claims: (item.claims || []).slice(0, 3).map((claim) => ({
        claim: claim.claim,
        subject: claim.subject,
        value: claim.value,
        unit: claim.unit
      }))
    })),
    verification_summary: {
      confirmations: (verification.confirmations || []).slice(0, 4).map((entry) => ({
        key: entry.key,
        preferred_claim: entry.preferred_fact?.claim,
        reason: entry.reason
      })),
      conflicts: (verification.conflicts || []).slice(0, 4).map((entry) => ({
        key: entry.key,
        preferred_claim: entry.preferred_fact?.claim,
        competing_sources: entry.comparison?.competing_sources || [],
        reason: entry.reason
      })),
      coverage_gaps: (verification.coverage_gaps || []).slice(0, 4).map((entry) => ({
        key: entry.key,
        preferred_claim: entry.preferred_fact?.claim
      }))
    }
  };
}

async function requestStopDecisionFromModel(plan, evidenceItems, verification, heuristicEvaluation) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !evidenceItems.length) {
    return null;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      should_stop: { type: "boolean" },
      can_answer_accurately: { type: "boolean" },
      answerability: {
        type: "string",
        enum: ["sufficient", "partial", "insufficient"]
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      missing_information: {
        type: "array",
        maxItems: 5,
        items: { type: "string" }
      },
      reasoning: { type: "string" },
      recommended_action: {
        type: "string",
        enum: ["synthesize_answer", "run_follow_up_search", "stop_with_partial_answer"]
      }
    },
    required: [
      "should_stop",
      "can_answer_accurately",
      "answerability",
      "confidence",
      "missing_information",
      "reasoning",
      "recommended_action"
    ]
  };

  const prompt = [
    "You are the final stop-policy evaluator for a research agent.",
    "Decide whether the current evidence is enough to answer the user's question accurately right now.",
    "Only set should_stop=true when the available evidence is already sufficient for an accurate answer.",
    "If material is still missing, conflicting, or too thin, recommend continued search unless the system should stop with a partial answer.",
    "",
    JSON.stringify(buildStopDecisionContext(plan, evidenceItems, verification, heuristicEvaluation), null, 2)
  ].join("\n");

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: DEFAULT_EVALUATOR_MODEL,
      store: false,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "stop_decision",
          strict: true,
          schema
        }
      }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI evaluator failed with HTTP ${response.status}`);
  }

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error("OpenAI evaluator returned no text output");
  }

  return JSON.parse(rawText);
}

function mergeEvaluationWithStopDecision(heuristicEvaluation, stopDecision, roundsCompleted, maxRounds) {
  if (!stopDecision) {
    return {
      ...heuristicEvaluation,
      evaluator_mode: "fallback",
      stop_controller: "heuristic",
      llm_stop_decision: null
    };
  }

  const llmSaysAccurate = Boolean(stopDecision.should_stop && stopDecision.can_answer_accurately);
  const atMaxRounds = roundsCompleted >= maxRounds;
  const shouldStopPartially = Boolean(
    stopDecision.should_stop
    && !stopDecision.can_answer_accurately
    && stopDecision.recommended_action === "stop_with_partial_answer"
  );

  const nextBestAction = llmSaysAccurate
    ? "synthesize_answer"
    : shouldStopPartially
      ? "stop_with_partial_answer"
      : atMaxRounds
        ? "stop_with_partial_answer"
        : "run_follow_up_search";

  return {
    ...heuristicEvaluation,
    is_sufficient: llmSaysAccurate,
    missing_questions: stopDecision.missing_information.length
      ? stopDecision.missing_information
      : heuristicEvaluation.missing_questions,
    risk_notes: Array.from(new Set([
      ...heuristicEvaluation.risk_notes,
      ...(!stopDecision.can_answer_accurately ? [`LLM evaluator: ${stopDecision.reasoning}`] : [])
    ])),
    next_best_action: nextBestAction,
    reason: stopDecision.reasoning,
    evaluator_mode: "llm",
    stop_controller: "llm",
    llm_stop_decision: stopDecision
  };
}

async function runStopEvaluation(plan, scratchpad, evidenceItems, verification, roundsCompleted) {
  const heuristicEvaluation = evaluator(plan, scratchpad, evidenceItems, verification, roundsCompleted);
  const maxRounds = Math.max(1, plan.stop_policy?.max_rounds || 2);

  try {
    const stopDecision = await requestStopDecisionFromModel(plan, evidenceItems, verification, heuristicEvaluation);
    return mergeEvaluationWithStopDecision(heuristicEvaluation, stopDecision, roundsCompleted, maxRounds);
  } catch (error) {
    return {
      ...heuristicEvaluation,
      evaluator_mode: "fallback",
      stop_controller: "heuristic",
      llm_stop_decision: null,
      risk_notes: [...heuristicEvaluation.risk_notes, `LLM evaluator fallback: ${error.message}`]
    };
  }
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

function buildFollowUpQueries(question, evaluation, scratchpad) {
  if (!evaluation?.missing_questions?.length) {
    return [];
  }

  const failureCount = (scratchpad?.failure_paths || []).length;
  const triedCount = (scratchpad?.queries_tried || []).length;
  if (triedCount > 0 && failureCount / triedCount > 0.5) {
    return buildEnglishQueryHints(question)
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index)
      .slice(0, 3);
  }

  return evaluation.missing_questions
    .flatMap((item) => {
      const followUp = `${question} ${item}`;
      return [followUp, ...buildEnglishQueryHints(followUp)];
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
  const candidates = await runWebResearcher(plan, queries, telemetry);
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
  const routedTasks = selected.map((candidate) => {
    const agent = routeCandidate(candidate);
    const contentType = candidate.content_type || candidate.source_type;
    recordHandoff(scratchpad, {
      from: "supervisor",
      to: agent,
      source_id: candidate.id,
      tool: contentType === "video" ? "extract_video_intel" : "deep_read_page"
    });
    return {
      source_id: candidate.id,
      agent,
      tool: contentType === "video" ? "extract_video_intel" : "deep_read_page",
      connector: candidate.connector
    };
  });

  const specialistReads = await runSpecialistReads(selected, telemetry);
  const reads = specialistReads.results.map((item) => item.read);
  const evidenceItems = specialistReads.results.map((item) => item.evidence_unit);
  const fallback = await attemptEphemeralFallbacks(question, specialistReads.failures, telemetry, onProgress);

  for (const candidate of selected) {
    const contentType = candidate.content_type || candidate.source_type;
    const sourceRecord = {
      source_id: candidate.id,
      title: candidate.title,
      content_type: contentType,
      source_type: contentType,
      connector: candidate.connector
    };
    scratchpad.sources_read.push(sourceRecord);
    recordAgentArtifact(scratchpad, routeCandidate(candidate), {
      type: "source_read",
      source_id: candidate.id,
      title: candidate.title,
      content_type: contentType,
      connector: candidate.connector
    });
  }

  appendTimelineEvent(scratchpad, {
    type: "round_completed",
    selected_sources: selected.map((item) => item.id),
    evidence_items: evidenceItems.length + fallback.evidence_items.length
  });

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
  await emitProgress(onProgress, { type: "plan", plan });

  const scratchpad = createScratchpad(plan);
  const telemetry = {
    agents: createAgentRegistry(),
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
  let evaluation = null;

  const maxRounds = Math.max(1, plan.stop_policy?.max_rounds || 2);
  for (let index = 0; index < maxRounds; index += 1) {
    const queries = index === 0 ? plan.initial_queries : buildFollowUpQueries(question, evaluation, scratchpad);
    if (!queries.length) {
      break;
    }

    const round = await runRound(plan, question, queries, scratchpad, telemetry, onProgress);
    combinedCandidates = dedupeBy([...combinedCandidates, ...round.candidates], (item) => item.url).sort((left, right) => right.score - left.score);
    combinedReads = dedupeBy([...combinedReads, ...round.reads], (item) => item.source_id);
    combinedEvidence = dedupeBy([...combinedEvidence, ...round.evidence_items], (item) => item.source_id);

    verification = await crossCheckFacts(combinedEvidence);
    evaluation = await runStopEvaluation(plan, scratchpad, combinedEvidence, verification, index + 1);
    updateQuestionStatus(scratchpad, evaluation.resolved_questions, evaluation.missing_questions);
    recordDecision(scratchpad, {
      type: "evaluation",
      round: index + 1,
      is_sufficient: evaluation.is_sufficient,
      next_best_action: evaluation.next_best_action,
      missing_questions: evaluation.missing_questions
    });

    const roundAgentReport = {
      round: index + 1,
      supervisor: {
        queries,
        dispatched_tasks: round.routed_tasks
      },
      fact_verifier: {
        conflict_count: verification.conflicts.length,
        single_source_claims: verification.coverage_gaps.length
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
      single_source_claims: verification.coverage_gaps.length
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

    if (evaluation.is_sufficient) {
      telemetry.stop_reason = evaluation.stop_controller === "llm"
        ? "llm_stop_decision"
        : "stop_policy_satisfied";
      break;
    }
  }

  if (!evaluation) {
    evaluation = {
      is_sufficient: false,
      resolved_questions: [],
      missing_questions: plan.sub_questions,
      risk_notes: ["No usable evidence was returned from the configured source connectors."],
      next_best_action: "manual_review",
      reason: "discovery returned no usable candidates",
      metrics: {
        source_types_covered: 0,
        evidence_units: 0,
        overall_coverage: 0,
        conflict_count: 0,
        single_source_claims: 0
      }
    };
    telemetry.stop_reason = "no_usable_candidates";
    await emitProgress(onProgress, {
      type: "evaluation",
      round: rounds.length,
      evaluation
    });
  }

  if (!telemetry.stop_reason) {
    telemetry.stop_reason = evaluation.next_best_action === "stop_with_partial_answer"
      ? "max_rounds_reached"
      : "completed";
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

  const finalAnswer = synthesize(question, mode, combinedCandidates, combinedReads, combinedEvidence, verification, evaluation, telemetry);
  const experience = summarizeExperience(question, scratchpad, plan, evaluation, telemetry);
  const toolMemory = recordToolExperience(telemetry.ephemeral_tools);
  const memory = readExperienceMemory();
  writeExperienceMemory([experience, ...memory].slice(0, 30));

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
    buildEvidenceItems,
    buildStopDecisionContext,
    requestStopDecisionFromModel,
    mergeEvaluationWithStopDecision,
    runStopEvaluation,
    crossCheckFacts,
    evaluator,
    routeCandidate,
    createScratchpad,
    updateQuestionStatus
  }
};
