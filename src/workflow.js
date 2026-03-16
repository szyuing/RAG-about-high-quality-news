const { AgentType } = require("./agents");

const NODE_CONTRACT_KEYS = new Set([
  "state",
  "state_patch",
  "node_result",
  "handoff",
  "handoffs",
  "stop_signal"
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeContractOutput(value) {
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.keys(value).some((key) => NODE_CONTRACT_KEYS.has(key));
}

function normalizeNodeHandoffs(output) {
  const items = [];
  if (isPlainObject(output?.handoff)) {
    items.push(output.handoff);
  }
  if (Array.isArray(output?.handoffs)) {
    items.push(...output.handoffs.filter(isPlainObject));
  }

  return items.map((item) => ({
    from: item.from || null,
    to: item.to || null,
    reason: item.reason || null,
    artifact: item.artifact || null,
    metadata: isPlainObject(item.metadata) ? item.metadata : {}
  }));
}

function normalizeStopSignal(stopSignal) {
  if (!isPlainObject(stopSignal)) {
    return null;
  }

  return {
    should_stop: Boolean(stopSignal.should_stop),
    reason: stopSignal.reason || null,
    answer_ready: Boolean(stopSignal.answer_ready),
    metadata: isPlainObject(stopSignal.metadata) ? stopSignal.metadata : {}
  };
}

function normalizeNodeResult(nodeId, nodeResult, durationMs) {
  if (!isPlainObject(nodeResult)) {
    return null;
  }

  return {
    node: nodeId,
    agent: nodeResult.agent || null,
    status: nodeResult.status || "completed",
    type: nodeResult.type || null,
    summary: nodeResult.summary || null,
    outputs: isPlainObject(nodeResult.outputs) ? nodeResult.outputs : {},
    duration_ms: durationMs
  };
}

function createInitialWorkflowRuntime(currentNode) {
  return {
    currentNode,
    executionHistory: [],
    errors: [],
    node_results: {},
    handoffs: [],
    stop_signal: null,
    stop_reason: null,
    terminated_by: null,
    startTime: Date.now()
  };
}

function applyNodeOutput(state, currentNode, rawOutput, durationMs) {
  const contract = isNodeContractOutput(rawOutput)
    ? rawOutput
    : { state: rawOutput };

  const nextState = isPlainObject(contract.state)
    ? { ...contract.state }
    : { ...state };

  if (isPlainObject(contract.state_patch)) {
    Object.assign(nextState, contract.state_patch);
  }

  nextState.workflowState = {
    ...state.workflowState,
    ...(isPlainObject(nextState.workflowState) ? nextState.workflowState : {})
  };
  nextState.workflowState.stop_signal = null;

  const nodeResult = normalizeNodeResult(currentNode, contract.node_result, durationMs);
  if (nodeResult) {
    nextState.workflowState.node_results[currentNode] = {
      ...nodeResult,
      timestamp: Date.now()
    };
  }

  const handoffs = normalizeNodeHandoffs(contract);
  if (handoffs.length) {
    nextState.workflowState.handoffs.push(...handoffs.map((item) => ({
      ...item,
      node: currentNode,
      timestamp: Date.now()
    })));
  }

  const stopSignal = normalizeStopSignal(contract.stop_signal);
  if (stopSignal) {
    nextState.workflowState.stop_signal = {
      ...stopSignal,
      node: currentNode,
      timestamp: Date.now()
    };
    if (stopSignal.should_stop) {
      nextState.workflowState.stop_reason = stopSignal.reason || "stop_signal";
      nextState.workflowState.terminated_by = currentNode;
    }
  }

  return {
    state: nextState,
    nodeResult,
    handoffs,
    stopSignal
  };
}

class StateGraph {
  constructor(stateSchema) {
    this.stateSchema = stateSchema;
    this.nodes = new Map();
    this.edges = new Map();
    this.startNode = null;
  }

  addNode(id, handler) {
    this.nodes.set(id, handler);
  }

  addEdge(source, target, condition = null) {
    if (!this.edges.has(source)) {
      this.edges.set(source, []);
    }
    this.edges.get(source).push({ target, condition });
  }

  setStartNode(id) {
    this.startNode = id;
  }

  async run(initialState) {
    let currentNode = this.startNode;
    let state = {
      ...initialState,
      workflowState: createInitialWorkflowRuntime(currentNode)
    };

    while (currentNode) {
      const handler = this.nodes.get(currentNode);
      if (!handler) {
        const error = new Error(`Node ${currentNode} not found`);
        state.workflowState.errors.push({
          node: currentNode,
          error: error.message,
          timestamp: Date.now()
        });
        throw error;
      }

      const nodeStartTime = Date.now();
      try {
        const output = await handler(state);
        const applied = applyNodeOutput(state, currentNode, output, Date.now() - nodeStartTime);
        state = applied.state;

        state.workflowState.executionHistory.push({
          node: currentNode,
          status: "success",
          duration: Date.now() - nodeStartTime,
          timestamp: Date.now(),
          node_result: applied.nodeResult,
          handoffs_count: applied.handoffs.length,
          stop_signal: applied.stopSignal
        });
      } catch (error) {
        console.error(`Error in node ${currentNode}:`, error);

        state.workflowState.errors.push({
          node: currentNode,
          error: error.message,
          timestamp: Date.now()
        });

        if (this.recoveryStrategy) {
          const recoveryResult = await this.recoveryStrategy(currentNode, error, state);
          if (recoveryResult.success) {
            state = recoveryResult.state;
            state.workflowState.executionHistory.push({
              node: currentNode,
              status: "recovered",
              duration: Date.now() - nodeStartTime,
              timestamp: Date.now(),
              node_result: null,
              handoffs_count: 0,
              stop_signal: null
            });
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }

      if (state.workflowState.stop_signal?.should_stop) {
        break;
      }

      const nodeEdges = this.edges.get(currentNode) || [];
      let nextNode = null;

      for (const edge of nodeEdges) {
        if (!edge.condition || edge.condition(state)) {
          nextNode = edge.target;
          break;
        }
      }

      currentNode = nextNode;
      if (currentNode) {
        state.workflowState.currentNode = currentNode;
      }
    }

    state.workflowState.endTime = Date.now();
    state.workflowState.totalDuration = state.workflowState.endTime - state.workflowState.startTime;

    return state;
  }

  setRecoveryStrategy(strategy) {
    this.recoveryStrategy = strategy;
  }
}

function createResearchWorkflow() {
  const workflow = new StateGraph();

  workflow.addNode("plan", async (state) => {
    const orchestrator = state.agentSystem.getAgent(AgentType.LLM_ORCHESTRATOR);
    const plan = await orchestrator.planTask(state.question, state.context);
    return {
      state_patch: { plan },
      node_result: {
        agent: AgentType.LLM_ORCHESTRATOR,
        type: "planning",
        summary: `Planned ${plan?.sub_questions?.length || 0} sub-questions.`,
        outputs: {
          sub_question_count: plan?.sub_questions?.length || 0,
          needed_agents: plan?.needed_agents || plan?.agents_needed || []
        }
      },
      handoff: {
        from: AgentType.LLM_ORCHESTRATOR,
        to: AgentType.WEB_RESEARCHER,
        reason: "Research plan is ready for discovery.",
        artifact: "plan"
      }
    };
  });

  workflow.addNode("search", async (state) => {
    const webResearcher = state.agentSystem.getAgent(AgentType.WEB_RESEARCHER);
    const searchResult = await webResearcher.execute({
      query: state.question,
      connectorIds: state.plan?.source_strategy || ["web"]
    });
    const candidateCount = searchResult?.result?.candidates?.length || 0;
    return {
      state_patch: { searchResult },
      node_result: {
        agent: AgentType.WEB_RESEARCHER,
        type: "discovery",
        summary: `Discovered ${candidateCount} candidate sources.`,
        outputs: {
          candidate_count: candidateCount
        }
      },
      handoff: {
        from: AgentType.WEB_RESEARCHER,
        to: AgentType.LONG_TEXT_COLLECTOR,
        reason: "Candidates are ready for analysis.",
        artifact: "searchResult"
      }
    };
  });

  workflow.addNode("analyze", async (state) => {
    const longTextCollector = state.agentSystem.getAgent(AgentType.LONG_TEXT_COLLECTOR);
    const analysisResult = await longTextCollector.execute({
      candidates: state.searchResult?.result?.candidates || []
    });
    const readCount = analysisResult?.result?.reads?.length || 0;
    return {
      state_patch: { analysisResult },
      node_result: {
        agent: AgentType.LONG_TEXT_COLLECTOR,
        type: "analysis",
        summary: `Produced ${readCount} normalized reads.`,
        outputs: {
          read_count: readCount
        }
      },
      handoff: {
        from: AgentType.LONG_TEXT_COLLECTOR,
        to: AgentType.FACT_VERIFIER,
        reason: "Evidence is ready for verification.",
        artifact: "analysisResult"
      }
    };
  });

  workflow.addNode("verify", async (state) => {
    const factVerifier = state.agentSystem.getAgent(AgentType.FACT_VERIFIER);
    const verificationResult = await factVerifier.execute({
      evidenceItems: state.analysisResult?.result?.reads || []
    });
    return {
      state_patch: { verificationResult },
      node_result: {
        agent: AgentType.FACT_VERIFIER,
        type: "verification",
        summary: `Verification found ${verificationResult?.result?.conflicts?.length || 0} conflicts.`,
        outputs: {
          conflict_count: verificationResult?.result?.conflicts?.length || 0,
          gap_count: verificationResult?.result?.coverage_gaps?.length || 0
        }
      },
      handoff: {
        from: AgentType.FACT_VERIFIER,
        to: AgentType.LLM_ORCHESTRATOR,
        reason: "Verified evidence is ready for synthesis.",
        artifact: "verificationResult"
      }
    };
  });

  workflow.addNode("synthesize", async (state) => {
    const orchestrator = state.agentSystem.getAgent(AgentType.LLM_ORCHESTRATOR);
    const synthesisResult = await orchestrator.synthesizeAnswer({
      question: state.question,
      evidenceItems: state.analysisResult?.result?.reads || [],
      verification: state.verificationResult?.result,
      evaluation: { is_sufficient: true, risk_notes: [] },
      agentReports: {
        web_researcher: state.searchResult?.result?.markdown_report || "",
        long_text_collector: state.analysisResult?.result?.markdown_report || "",
        fact_verifier: state.verificationResult?.result?.markdown_report || ""
      }
    });
    return {
      state_patch: { synthesisResult },
      node_result: {
        agent: AgentType.LLM_ORCHESTRATOR,
        type: "synthesis",
        summary: "LLM-Orchestrator assembled the final answer from verified evidence.",
        outputs: {
          headline: synthesisResult?.result?.headline || null
        }
      },
      stop_signal: {
        should_stop: true,
        reason: "workflow_completed",
        answer_ready: true,
        metadata: {
          final_node: true
        }
      }
    };
  });

  workflow.addEdge("plan", "search");
  workflow.addEdge("search", "analyze");
  workflow.addEdge("analyze", "verify");
  workflow.addEdge("verify", "synthesize");
  workflow.setStartNode("plan");

  return workflow;
}

module.exports = {
  StateGraph,
  createResearchWorkflow
};
