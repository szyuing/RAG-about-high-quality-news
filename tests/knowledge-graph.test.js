const test = require("node:test");
const assert = require("node:assert/strict");
const { KnowledgeGraph, buildKnowledgeGraphFromEvidence } = require("../src/knowledge-graph");

test("KnowledgeGraph should create versioned claim history from evidence", () => {
  const graph = new KnowledgeGraph({ question: "demo" });
  graph.createVersion("initialized", { operations: [] });

  const firstVersion = graph.importEvidence([
    {
      source_id: "source-1",
      source_type: "document",
      title: "Latency report",
      source_metadata: { connector: "bing_web" },
      claims: [
        {
          subject: "latency",
          type: "numeric_statement",
          claim: "Latency is 120 ms",
          value: 120,
          unit: "ms",
          source_id: "source-1",
          authority_score: 0.7
        }
      ]
    }
  ], { label: "round_1" });

  const secondVersion = graph.importEvidence([
    {
      source_id: "source-1",
      source_type: "document",
      title: "Latency report",
      source_metadata: { connector: "bing_web" },
      claims: [
        {
          subject: "latency",
          type: "numeric_statement",
          claim: "Latency is 95 ms",
          value: 95,
          unit: "ms",
          source_id: "source-1",
          authority_score: 0.9
        }
      ]
    }
  ], { label: "round_2" });

  const exported = graph.export();
  assert.equal(exported.versions.length, 3);
  assert.equal(firstVersion.counts.claims, 1);
  assert.equal(secondVersion.counts.claims, 1);
  assert.equal(exported.claims[0].history.length, 1);
  assert.equal(exported.claims[0].current.value, 95);
});

test("buildKnowledgeGraphFromEvidence should return an initialized graph export", () => {
  const result = buildKnowledgeGraphFromEvidence([
    {
      source_id: "source-2",
      source_type: "web",
      title: "Capability note",
      source_metadata: { connector: "bing_web" },
      claims: [
        {
          subject: "Sora",
          type: "key_point",
          claim: "Sora supports longer videos",
          value: null,
          unit: null,
          source_id: "source-2",
          authority_score: 0.8
        }
      ]
    }
  ], { question: "What changed?" }, "round_1");

  assert.equal(result.versions.length, 2);
  assert.equal(result.latest_version.label, "round_1");
  assert.ok(result.entities.length >= 2);
  assert.equal(result.claims.length, 1);
});

test("KnowledgeGraph should retain visual observation claims imported from evidence", () => {
  const result = buildKnowledgeGraphFromEvidence([
    {
      source_id: "source-visual",
      source_type: "document",
      title: "Chart report",
      source_metadata: {
        connector: "bing_web",
        page_images: ["https://example.com/chart.png"]
      },
      claims: [
        {
          subject: "Chart report",
          type: "visual_observation",
          claim: "The chart shows quarter-over-quarter growth accelerating in Q4.",
          value: null,
          unit: null,
          source_id: "source-visual",
          authority_score: 0.82
        }
      ]
    }
  ], { question: "What does the chart show?" }, "round_visual");

  assert.equal(result.latest_version.label, "round_visual");
  assert.equal(result.claims[0].type, "visual_observation");
  assert.equal(result.claims[0].current.claim, "The chart shows quarter-over-quarter growth accelerating in Q4.");
});

test("KnowledgeGraph should mark missing source claims as stale during evolution", async () => {
  const graph = new KnowledgeGraph({ question: "What changed?" });
  graph.createVersion("initialized", { operations: [] });

  await graph.updateFromNewEvidence([
    {
      source_id: "source-1",
      source_type: "document",
      title: "Latency report",
      source_metadata: { connector: "bing_web" },
      claims: [
        {
          subject: "latency",
          type: "numeric_statement",
          claim: "Latency is 120 ms",
          value: 120,
          unit: "ms",
          source_id: "source-1",
          authority_score: 0.7
        }
      ]
    }
  ], { label: "round_1" });

  const second = await graph.updateFromNewEvidence([
    {
      source_id: "source-2",
      source_type: "web",
      title: "Capability note",
      source_metadata: { connector: "bing_web" },
      claims: [
        {
          subject: "Sora",
          type: "key_point",
          claim: "Sora supports longer videos",
          value: null,
          unit: null,
          source_id: "source-2",
          authority_score: 0.8
        }
      ]
    }
  ], { label: "round_2" });

  const exported = graph.export();
  const staleClaim = exported.claims.find((item) => item.current.source_id === "source-1");
  assert.equal(staleClaim.status, "stale");
  assert.equal(second.evolution_summary.stale_marked, 1);
});

test("KnowledgeGraph should reload from export and continue evolving", async () => {
  const graph = new KnowledgeGraph({ question: "demo" });
  graph.createVersion("initialized", { operations: [] });

  await graph.updateFromNewEvidence([
    {
      source_id: "source-1",
      source_type: "document",
      title: "Latency report",
      source_metadata: { connector: "bing_web" },
      claims: [
        {
          subject: "latency",
          type: "numeric_statement",
          claim: "Latency is 120 ms",
          value: 120,
          unit: "ms",
          source_id: "source-1",
          authority_score: 0.7
        }
      ]
    }
  ], { label: "round_1" });

  const restored = KnowledgeGraph.fromExport(graph.export());
  const update = await restored.updateFromNewEvidence([
    {
      source_id: "source-1",
      source_type: "document",
      title: "Latency report",
      source_metadata: { connector: "bing_web" },
      claims: [
        {
          subject: "latency",
          type: "numeric_statement",
          claim: "Latency is 95 ms",
          value: 95,
          unit: "ms",
          source_id: "source-1",
          authority_score: 0.9
        }
      ]
    }
  ], { label: "round_2" });

  const exported = restored.export();
  assert.equal(exported.latest_version.label, "round_2");
  assert.equal(exported.claims[0].current.value, 95);
  assert.ok(update.evolution_summary.updated >= 1);
});
