require('./project-env').initializeProjectEnv();
const { extractTextFromResponsePayload, normalizeResponsesRequestBody, readResponsesApiPayload } = require('./openai-response');
const { evaluateResearch } = require('./research-ops');

const OPENAI_RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || 'https://api.openai.com/v1/responses';
const DEFAULT_EVALUATOR_MODEL = process.env.OPENAI_EVALUATOR_MODEL || 'gpt-4o-mini';
const OPENAI_REQUEST_TIMEOUT_MS = Math.max(20000, Number(process.env.OPENSEARCH_OPENAI_TIMEOUT_MS || 90000));
const OPENAI_MAX_ATTEMPTS = Math.max(1, Number(process.env.OPENSEARCH_OPENAI_MAX_ATTEMPTS || 2));
const OPENAI_RETRY_BASE_MS = Math.max(100, Number(process.env.OPENSEARCH_OPENAI_RETRY_BASE_MS || 400));

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0));
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableOpenAIError(error, statusCode = null) {
  if (typeof statusCode === 'number') {
    return statusCode === 429 || statusCode >= 500;
  }
  const message = String(error?.message || '');
  return /timed out|timeout|fetch failed|network|ECONNRESET|ENOTFOUND|EAI_AGAIN|AbortError/i.test(message);
}

async function fetchOpenAIJsonWithRetry(apiKey, body, { timeoutMs = OPENAI_REQUEST_TIMEOUT_MS, operation = 'openai_stop_evaluator', maxAttempts = OPENAI_MAX_ATTEMPTS } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(normalizeResponsesRequestBody(body, { forceStream: true }))
      });

      const { rawText, payload } = await readResponsesApiPayload(response);
      if (!response.ok) {
        const error = new Error(payload?.error?.message || rawText.trim() || `${operation} failed with HTTP ${response.status}`);
        if (attempt < maxAttempts && isRetriableOpenAIError(error, response.status)) {
          console.warn(`[${operation}] attempt ${attempt}/${maxAttempts} failed, retrying: ${error.message}`);
          await wait(OPENAI_RETRY_BASE_MS * attempt);
          continue;
        }
        throw error;
      }

      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isRetriableOpenAIError(error)) {
        console.warn(`[${operation}] attempt ${attempt}/${maxAttempts} failed, retrying: ${error.message}`);
        await wait(OPENAI_RETRY_BASE_MS * attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error(`${operation} failed`);
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
    ? 'ready'
    : (metrics.conflict_count || 0) > conflictBudget
      ? 'blocked_by_conflicts'
      : 'needs_more_evidence';

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

function buildStopDecisionContext(plan, evidenceItems, verification, roundsCompleted = 1, scratchpad = null) {
  return {
    question: plan.task_goal,
    sub_questions: plan.sub_questions,
    rounds_completed: roundsCompleted,
    stop_policy: plan.stop_policy,
    available_connectors: (plan.source_capabilities || []).map((item) => ({
      id: item.id,
      label: item.label,
      capabilities: item.capabilities || []
    })),
    evidence_summary: evidenceItems.slice(0, 8).map((item) => ({
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
      confirmations: (verification?.confirmations || []).slice(0, 4).map((entry) => ({
        key: entry.key,
        preferred_claim: entry.preferred_fact?.claim,
        reason: entry.reason
      })),
      conflicts: (verification?.conflicts || []).slice(0, 4).map((entry) => ({
        key: entry.key,
        preferred_claim: entry.preferred_fact?.claim,
        competing_sources: entry.comparison?.competing_sources || [],
        reason: entry.reason
      })),
      coverage_gaps: (verification?.coverage_gaps || []).slice(0, 4).map((entry) => ({
        key: entry.key,
        preferred_claim: entry.preferred_fact?.claim
      }))
    },
    scratchpad_snapshot: {
      queries_tried: (scratchpad?.queries_tried || []).slice(0, 8),
      sources_read: (scratchpad?.sources_read || []).length,
      failure_paths: (scratchpad?.failure_paths || []).slice(0, 6)
    }
  };
}

async function requestStopDecisionFromModel(plan, evidenceItems, verification, roundsCompleted = 1, scratchpad = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for llm-only evaluation');
  }

  const connectorIds = (plan?.source_capabilities || []).map((item) => item.id);
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      is_sufficient: { type: 'boolean' },
      can_answer_accurately: { type: 'boolean' },
      answerability: {
        type: 'string',
        enum: ['sufficient', 'partial', 'insufficient']
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1
      },
      resolved_questions: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string' }
      },
      missing_questions: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string' }
      },
      risk_notes: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string' }
      },
      follow_up_queries: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string' }
      },
      suggested_connector_ids: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'string',
          enum: connectorIds
        }
      },
      next_best_action: {
        type: 'string',
        enum: ['synthesize_answer', 'run_follow_up_search', 'stop_with_partial_answer']
      },
      reason: { type: 'string' },
      metrics: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source_types_covered: { type: 'number', minimum: 0 },
          evidence_units: { type: 'number', minimum: 0 },
          overall_coverage: { type: 'number', minimum: 0, maximum: 1 },
          conflict_count: { type: 'number', minimum: 0 },
          single_source_claims: { type: 'number', minimum: 0 }
        },
        required: ['source_types_covered', 'evidence_units', 'overall_coverage', 'conflict_count', 'single_source_claims']
      }
    },
    required: [
      'is_sufficient',
      'can_answer_accurately',
      'answerability',
      'confidence',
      'resolved_questions',
      'missing_questions',
      'risk_notes',
      'follow_up_queries',
      'suggested_connector_ids',
      'next_best_action',
      'reason',
      'metrics'
    ]
  };

  const prompt = [
    'You are the stop-policy evaluator for a research agent in strict LLM-only mode.',
    'Decide the stop state directly from evidence and verification; do not rely on heuristics.',
    'Use only the provided context.',
    '',
    JSON.stringify(buildStopDecisionContext(plan, evidenceItems, verification, roundsCompleted, scratchpad), null, 2)
  ].join('\n');

  const payload = await fetchOpenAIJsonWithRetry(apiKey, {
    model: DEFAULT_EVALUATOR_MODEL,
    store: false,
    input: prompt,
    text: {
      format: {
        type: 'json_schema',
        name: 'stop_decision',
        strict: true,
        schema
      }
    }
  }, {
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    operation: 'openai_stop_evaluator'
  });

  const rawText = extractTextFromResponsePayload(payload);
  if (!rawText) {
    throw new Error('OpenAI evaluator returned no text output');
  }

  return JSON.parse(rawText);
}

function mergeEvaluationWithStopDecision(baseEvaluation, stopDecision, roundsCompleted, maxRounds) {
  const resolvedQuestions = unique(stopDecision?.resolved_questions || baseEvaluation?.resolved_questions || []);
  const missingQuestions = unique(stopDecision?.missing_questions || baseEvaluation?.missing_questions || []);
  const riskNotes = unique(stopDecision?.risk_notes || baseEvaluation?.risk_notes || []);

  let nextBestAction = stopDecision?.next_best_action || baseEvaluation?.next_best_action || 'run_follow_up_search';
  if (roundsCompleted >= maxRounds && nextBestAction === 'run_follow_up_search') {
    nextBestAction = 'stop_with_partial_answer';
  }

  return {
    ...(baseEvaluation || {}),
    is_sufficient: Boolean(stopDecision?.is_sufficient && stopDecision?.can_answer_accurately),
    resolved_questions: resolvedQuestions,
    missing_questions: missingQuestions,
    risk_notes: riskNotes,
    follow_up_queries: unique(stopDecision?.follow_up_queries || []),
    suggested_connector_ids: unique(stopDecision?.suggested_connector_ids || []).slice(0, 4),
    next_best_action: nextBestAction,
    reason: stopDecision?.reason || baseEvaluation?.reason || null,
    metrics: {
      source_types_covered: Number(stopDecision?.metrics?.source_types_covered || 0),
      evidence_units: Number(stopDecision?.metrics?.evidence_units || 0),
      overall_coverage: clamp01(stopDecision?.metrics?.overall_coverage || 0),
      conflict_count: Number(stopDecision?.metrics?.conflict_count || 0),
      single_source_claims: Number(stopDecision?.metrics?.single_source_claims || 0)
    },
    evaluator_mode: 'llm',
    stop_controller: 'llm',
    llm_stop_decision: stopDecision,
    answerability: stopDecision?.answerability || null,
    llm_confidence: clamp01(stopDecision?.confidence || 0)
  };
}

function deriveStopOutcome(evaluation) {
  if (!evaluation) {
    return {
      should_stop_now: false,
      should_answer_now: false,
      controller: 'llm',
      reason: null
    };
  }

  if (evaluation.is_sufficient || evaluation.next_best_action === 'synthesize_answer') {
    return {
      should_stop_now: true,
      should_answer_now: true,
      controller: 'llm',
      reason: 'llm_sufficient'
    };
  }

  if (evaluation.next_best_action === 'stop_with_partial_answer') {
    return {
      should_stop_now: false,
      should_answer_now: true,
      controller: 'llm',
      reason: 'max_rounds_reached'
    };
  }

  return {
    should_stop_now: false,
    should_answer_now: false,
    controller: 'llm',
    reason: 'continue_search'
  };
}

function finalizeEvaluation(plan, evaluation, verification, roundsCompleted, stopDecision = null) {
  const stopState = deriveStopOutcome(evaluation);
  return {
    schema_version: 'evaluation.v1',
    ...evaluation,
    scorecard: buildEvaluationScorecard(plan, evaluation, verification, roundsCompleted, stopDecision),
    stop_state: stopState
  };
}

async function runStopEvaluation(plan, scratchpad, evidenceItems, verification, roundsCompleted) {
  const maxRounds = Math.max(1, plan?.stop_policy?.max_rounds || 2);
  let stopDecision = null;
  try {
    stopDecision = await requestStopDecisionFromModel(plan, evidenceItems, verification, roundsCompleted, scratchpad);
  } catch (error) {
    const fallbackEvaluation = evaluateResearch(plan, scratchpad, evidenceItems, verification, roundsCompleted);
    return finalizeEvaluation(plan, {
      ...fallbackEvaluation,
      follow_up_queries: fallbackEvaluation.follow_up_queries || [],
      suggested_connector_ids: [],
      evaluator_mode: 'heuristic',
      stop_controller: 'heuristic',
      llm_stop_decision: null,
      answerability: fallbackEvaluation.is_sufficient
        ? 'sufficient'
        : (fallbackEvaluation.next_best_action === 'stop_with_partial_answer' ? 'partial' : 'insufficient'),
      llm_confidence: null,
      fallback_reason: error?.message || 'llm evaluation unavailable'
    }, verification, roundsCompleted, null);
  }

  const baseEvaluation = {
    is_sufficient: false,
    resolved_questions: [],
    missing_questions: plan?.sub_questions || [],
    risk_notes: [],
    follow_up_queries: [],
    suggested_connector_ids: [],
    next_best_action: 'run_follow_up_search',
    reason: null,
    metrics: {
      source_types_covered: 0,
      evidence_units: 0,
      overall_coverage: 0,
      conflict_count: 0,
      single_source_claims: 0
    },
    evaluator_mode: 'llm',
    stop_controller: 'llm',
    llm_stop_decision: stopDecision,
    answerability: stopDecision.answerability || null,
    llm_confidence: clamp01(stopDecision.confidence || 0)
  };

  const merged = mergeEvaluationWithStopDecision(baseEvaluation, stopDecision, roundsCompleted, maxRounds);
  return finalizeEvaluation(plan, merged, verification, roundsCompleted, stopDecision);
}

function buildEmptyEvaluation(plan, roundsCompleted = 0) {
  const evaluation = {
    is_sufficient: false,
    resolved_questions: [],
    missing_questions: plan?.sub_questions || [],
    risk_notes: ['No evidence items were collected.'],
    follow_up_queries: [],
    suggested_connector_ids: [],
    next_best_action: 'run_follow_up_search',
    reason: 'no_evidence_items',
    metrics: {
      source_types_covered: 0,
      evidence_units: 0,
      overall_coverage: 0,
      conflict_count: 0,
      single_source_claims: 0
    },
    evaluator_mode: 'llm',
    stop_controller: 'llm',
    llm_stop_decision: null,
    answerability: 'insufficient',
    llm_confidence: 0
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
