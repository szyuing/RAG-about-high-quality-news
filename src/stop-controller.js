const { evaluateResearch } = require("./agent-orchestrator");
const { extractTextFromResponsePayload } = require("./openai-response");

const OPENAI_RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses";
const DEFAULT_EVALUATOR_MODEL = process.env.OPENAI_EVALUATOR_MODEL || "gpt-4o-mini";

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function buildEvaluationScorecard(plan, evaluation, verification, roundsCompleted, stopDecision = null) {
  const stopPolicy = plan?.stop_policy || {};
  const metrics = evaluation?.metrics || {};
  const evidenceTarget = Math.max(1, stopPolicy.min_evidence_items || 3);
  const diversityTarget = Math.max(1, stopPolicy.min_source_types || 2);
  const coverageTarget = Number(stopPolicy.overall_coverage_threshold || 0.18);
  const conflictBudget = Math.max(0, stopPolicy.max_relevant_conflicts ?? 1);
  const maxRounds = Math.max(1, stopPolicy.max_rounds || 2);

  const evidenceRatio = clamp01((metrics.evidence_units || 0) / evidenceTarget);
  const diversityRatio = clamp01((metrics.source_types_covered || 0) / diversityTarget);
  const coverageRatio = coverageTarget > 0
    ? clamp01((metrics.overall_coverage || 0) / coverageTarget)
    : 1;
  const conflictRatio = conflictBudget > 0
    ? clamp01(1 - ((metrics.conflict_count || 0) / (conflictBudget + 1)))
    : (metrics.conflict_count || 0) === 0 ? 1 : 0;

  const readiness = Number(clamp01(
    (evidenceRatio * 0.3)
    + (diversityRatio * 0.25)
    + (coverageRatio * 0.25)
    + (conflictRatio * 0.2)
  ).toFixed(2));

  const status = evaluation?.is_sufficient
    ? "ready"
    : (metrics.conflict_count || 0) > conflictBudget
      ? "blocked_by_conflicts"
      : "needs_more_evidence";

  return {
    readiness,
    status,
    answerability: stopDecision?.answerability || null,
    llm_confidence: stopDecision?.confidence ?? null,
    checkpoints: {
      evidence_depth: {
        actual: metrics.evidence_units || 0,
        target: evidenceTarget,
        met: (metrics.evidence_units || 0) >= evidenceTarget
      },
      source_diversity: {
        actual: metrics.source_types_covered || 0,
        target: diversityTarget,
        met: (metrics.source_types_covered || 0) >= diversityTarget
      },
      question_coverage: {
        actual: Number((metrics.overall_coverage || 0).toFixed(2)),
        target: Number(coverageTarget.toFixed(2)),
        met: (metrics.overall_coverage || 0) >= coverageTarget
      },
      conflict_budget: {
        actual: metrics.conflict_count || 0,
        target: conflictBudget,
        met: (metrics.conflict_count || 0) <= conflictBudget
      },
      rounds: {
        actual: roundsCompleted,
        budget: maxRounds,
        remaining: Math.max(0, maxRounds - roundsCompleted)
      }
    },
    verification_snapshot: {
      confirmations: verification?.confirmations?.length || 0,
      conflicts: verification?.conflicts?.length || 0,
      single_source_claims: verification?.coverage_gaps?.length || 0
    }
  };
}

function buildStopDecisionContext(plan, evidenceItems, verification, heuristicEvaluation, roundsCompleted = 1) {
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
    evaluation_scorecard: buildEvaluationScorecard(
      plan,
      heuristicEvaluation,
      verification,
      roundsCompleted,
      null
    ),
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

async function requestStopDecisionFromModel(plan, evidenceItems, verification, heuristicEvaluation, roundsCompleted = 1) {
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
    JSON.stringify(buildStopDecisionContext(plan, evidenceItems, verification, heuristicEvaluation, roundsCompleted), null, 2)
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
    : shouldStopPartially || atMaxRounds
      ? "stop_with_partial_answer"
      : "run_follow_up_search";

  return {
    ...heuristicEvaluation,
    is_sufficient: llmSaysAccurate,
    next_best_action: nextBestAction,
    reason: llmSaysAccurate
      ? "llm evaluator confirmed the evidence is sufficient"
      : heuristicEvaluation.reason,
    risk_notes: [
      ...new Set([
        ...(heuristicEvaluation.risk_notes || []),
        ...(!llmSaysAccurate && stopDecision.reasoning ? [`LLM evaluator: ${stopDecision.reasoning}`] : [])
      ])
    ],
    evaluator_mode: "llm",
    stop_controller: "llm",
    llm_stop_decision: stopDecision
  };
}

function deriveStopOutcome(evaluation) {
  if (!evaluation) {
    return {
      should_stop_now: false,
      should_answer_now: false,
      controller: "heuristic",
      reason: null
    };
  }

  if (evaluation.stop_controller === "llm" && evaluation.llm_stop_decision?.should_stop && evaluation.llm_stop_decision?.can_answer_accurately) {
    return {
      should_stop_now: true,
      should_answer_now: true,
      controller: "llm",
      reason: "llm_stop_decision"
    };
  }

  if (evaluation.is_sufficient) {
    return {
      should_stop_now: true,
      should_answer_now: true,
      controller: evaluation.stop_controller || "heuristic",
      reason: "stop_policy_satisfied"
    };
  }

  if (evaluation.next_best_action === "stop_with_partial_answer") {
    return {
      should_stop_now: false,
      should_answer_now: true,
      controller: evaluation.stop_controller || "heuristic",
      reason: "max_rounds_reached"
    };
  }

  return {
    should_stop_now: false,
    should_answer_now: false,
    controller: evaluation.stop_controller || "heuristic",
    reason: "continue_search"
  };
}

function finalizeEvaluation(plan, evaluation, verification, roundsCompleted, stopDecision = null) {
  const stopState = deriveStopOutcome(evaluation);
  return {
    ...evaluation,
    scorecard: buildEvaluationScorecard(plan, evaluation, verification, roundsCompleted, stopDecision),
    stop_state: stopState
  };
}

async function runStopEvaluation(plan, scratchpad, evidenceItems, verification, roundsCompleted) {
  const maxRounds = Math.max(1, plan.stop_policy?.max_rounds || 2);
  const heuristicEvaluation = evaluateResearch(plan, scratchpad, evidenceItems, verification, roundsCompleted);

  try {
    const stopDecision = await requestStopDecisionFromModel(plan, evidenceItems, verification, heuristicEvaluation, roundsCompleted);
    const merged = mergeEvaluationWithStopDecision(heuristicEvaluation, stopDecision, roundsCompleted, maxRounds);
    return finalizeEvaluation(plan, merged, verification, roundsCompleted, stopDecision);
  } catch (error) {
    const fallback = {
      ...heuristicEvaluation,
      evaluator_mode: "fallback",
      stop_controller: "heuristic",
      llm_stop_decision: null,
      risk_notes: [...heuristicEvaluation.risk_notes, `LLM evaluator fallback: ${error.message}`]
    };
    return finalizeEvaluation(plan, fallback, verification, roundsCompleted, null);
  }
}

function buildEmptyEvaluation(plan, roundsCompleted = 0) {
  const evaluation = {
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
    },
    evaluator_mode: "fallback",
    stop_controller: "heuristic",
    llm_stop_decision: null
  };

  return finalizeEvaluation(plan, evaluation, { confirmations: [], conflicts: [], coverage_gaps: [] }, roundsCompleted, null);
}

module.exports = {
  buildEvaluationScorecard,
  buildStopDecisionContext,
  requestStopDecisionFromModel,
  mergeEvaluationWithStopDecision,
  deriveStopOutcome,
  runStopEvaluation,
  buildEmptyEvaluation
};
