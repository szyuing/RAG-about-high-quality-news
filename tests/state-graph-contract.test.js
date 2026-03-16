const test = require("node:test");
const assert = require("node:assert/strict");
const { StateGraph, createResearchWorkflow, AgentType } = require("../src/agent-orchestrator");

test("StateGraph should normalize node_result, handoff, and stop_signal contracts", async () => {
  const workflow = new StateGraph();

  workflow.addNode("start", async () => ({
    state_patch: { count: 1 },
    node_result: {
      agent: "llm_orchestrator",
      type: "planning",
      summary: "Seeded the workflow."
    },
    handoff: {
      from: "llm_orchestrator",
      to: "long_text_collector",
      reason: "Initial context is ready.",
      artifact: "plan"
    }
  }));

  workflow.addNode("stop", async (state) => ({
    state_patch: { count: state.count + 1 },
    node_result: {
      agent: "long_text_collector",
      type: "analysis",
      summary: "Evidence is sufficient."
    },
    stop_signal: {
      should_stop: true,
      reason: "evidence_sufficient",
      answer_ready: true
    }
  }));

  workflow.addNode("tail", async () => {
    throw new Error("tail node should not execute");
  });

  workflow.addEdge("start", "stop");
  workflow.addEdge("stop", "tail");
  workflow.setStartNode("start");

  const result = await workflow.run({ initial: "value" });

  assert.equal(result.count, 2);
  assert.equal(result.workflowState.executionHistory.length, 2);
  assert.equal(result.workflowState.node_results.start.agent, "llm_orchestrator");
  assert.equal(result.workflowState.node_results.stop.type, "analysis");
  assert.equal(result.workflowState.handoffs.length, 1);
  assert.equal(result.workflowState.handoffs[0].artifact, "plan");
  assert.equal(result.workflowState.stop_signal.reason, "evidence_sufficient");
  assert.equal(result.workflowState.stop_reason, "evidence_sufficient");
  assert.equal(result.workflowState.terminated_by, "stop");
  assert.equal(result.workflowState.executionHistory[1].stop_signal.reason, "evidence_sufficient");
});

test("createResearchWorkflow should emit standardized workflow metadata", async () => {
  const workflow = createResearchWorkflow();
  const agents = new Map([
    [AgentType.LLM_ORCHESTRATOR, {
      planTask: async () => ({
        sub_questions: ["What happened?", "Why does it matter?"],
        needed_agents: [AgentType.WEB_RESEARCHER, AgentType.FACT_VERIFIER],
        source_strategy: ["web"]
      }),
      synthesizeAnswer: async () => ({
        result: {
          headline: "done"
        }
      })
    }],
    [AgentType.WEB_RESEARCHER, {
      execute: async () => ({
        result: {
          candidates: [{ id: "source-1" }],
          markdown_report: "search report"
        }
      })
    }],
    [AgentType.LONG_TEXT_COLLECTOR, {
      execute: async () => ({
        result: {
          reads: [{ source_id: "source-1" }],
          markdown_report: "analysis report"
        }
      })
    }],
    [AgentType.FACT_VERIFIER, {
      execute: async () => ({
        result: {
          conflicts: [],
          coverage_gaps: [],
          markdown_report: "verification report"
        }
      })
    }],
  ]);

  const result = await workflow.run({
    question: "demo question",
    context: {},
    agentSystem: {
      getAgent(type) {
        return agents.get(type);
      }
    }
  });

  assert.equal(result.workflowState.handoffs.length, 4);
  assert.equal(result.workflowState.node_results.plan.agent, AgentType.LLM_ORCHESTRATOR);
  assert.equal(result.workflowState.node_results.search.outputs.candidate_count, 1);
  assert.equal(result.workflowState.node_results.verify.outputs.conflict_count, 0);
  assert.equal(result.workflowState.node_results.synthesize.agent, AgentType.LLM_ORCHESTRATOR);
  assert.equal(result.workflowState.stop_signal.reason, "workflow_completed");
  assert.equal(result.workflowState.stop_reason, "workflow_completed");
  assert.equal(result.workflowState.terminated_by, "synthesize");
});
