const test = require("node:test");
const assert = require("node:assert/strict");
const { runResearch } = require("../src/research-engine");

test("research workflow returns planner, rounds and final answer", () => {
  const result = runResearch({
    question: "Sora 模型现在的生成时长上限是多少？相比刚发布时有哪些技术架构上的更新？",
    mode: "deep"
  });

  assert.ok(result.plan);
  assert.ok(result.rounds.length >= 1);
  assert.ok(result.candidates.length >= 1);
  assert.ok(result.reads.length >= 1);
  assert.equal(typeof result.final_answer.quick_answer, "string");
  assert.ok(result.final_answer.deep_research_summary.evidence_chain.length >= 1);
});

test("comparison query should trigger multiple sub questions", () => {
  const result = runResearch({
    question: "苹果 2024 年发布的手机比 2023 年的在性能上提升了多少？",
    mode: "quick"
  });

  assert.ok(result.plan.sub_questions.length >= 3);
  assert.ok(result.final_answer.quick_answer.includes("苹果 2024 年发布的手机比 2023 年的在性能上提升了多少"));
});
