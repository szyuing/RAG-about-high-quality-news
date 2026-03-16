const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAgentRegistry,
  createAgentRuntime,
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentRuntimeSnapshot,
  runFactVerifierReview
} = require("../src/agent-orchestrator");

test("agent runtime should track task lifecycle, inbox, and outbox", () => {
  const runtime = createAgentRuntime(createAgentRegistry());
  const task = dispatchAgentTask(runtime, {
    from: "llm_orchestrator",
    agentId: "long_text_collector",
    taskType: "collect_long_text",
    input: { source_id: "source-1" },
    metadata: { connector: "bing_web" }
  });

  assert.equal(runtime.agents.long_text_collector.status, "running");
  assert.equal(runtime.agents.long_text_collector.inbox.length, 1);
  assert.equal(runtime.agents.llm_orchestrator.outbox.length, 1);

  completeAgentTask(runtime, task.id, { source_id: "source-1" });

  assert.equal(runtime.agents.long_text_collector.status, "completed");
  assert.equal(runtime.agents.long_text_collector.completed_tasks, 1);
  assert.equal(runtime.tasks[0].status, "completed");
  assert.equal(runtime.messages.length, 2);
});

test("agent runtime should capture failure state and snapshots", () => {
  const runtime = createAgentRuntime(createAgentRegistry());
  const task = dispatchAgentTask(runtime, {
    from: "llm_orchestrator",
    agentId: "fact_verifier",
    taskType: "verify_conflict"
  });

  failAgentTask(runtime, task.id, new Error("comparison failed"));
  const snapshot = getAgentRuntimeSnapshot(runtime);
  const verifier = snapshot.agents.find((item) => item.id === "fact_verifier");

  assert.equal(verifier.status, "failed");
  assert.equal(verifier.failed_tasks, 1);
  assert.equal(snapshot.tasks[0].status, "failed");
  assert.equal(snapshot.messages.length, 2);
});

test("runFactVerifierReview should create explicit verifier tasks for conflicts and gaps", async () => {
  const runtime = createAgentRuntime(createAgentRegistry());
  const telemetry = { events: [], failures: [] };

  const review = await runFactVerifierReview(
    {
      conflicts: [
        {
          key: "latency:numeric_statement:ms",
          preferred_fact: { claim: "Latency is 95 ms", source_id: "source-b" },
          comparison: { preferred_source: "source-b", competing_sources: [{ source_id: "source-a" }] },
          reason: "preferred source has higher authority"
        }
      ],
      coverage_gaps: [
        {
          key: "price:numeric_statement:usd",
          preferred_fact: { claim: "Price is 20 USD", source_id: "source-c" },
          comparison: { preferred_source: "source-c", competing_sources: [] },
          reason: "only one source supports the claim"
        }
      ]
    },
    telemetry,
    runtime
  );

  assert.equal(review.summary.review_count, 2);
  assert.equal(runtime.agents.fact_verifier.completed_tasks, 2);
  assert.equal(runtime.tasks.length, 2);
  assert.equal(runtime.tasks[0].status, "completed");
});
