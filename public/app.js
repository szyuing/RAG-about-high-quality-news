const state = {
  memory: [],
  connectorLabels: {},
  activeStream: null,
  liveRounds: [],
  streamCompleted: false,
  toolAttempts: [],
  toolMemory: null
};

const sourceTypeLabels = {
  web: "Web",
  forum: "Forum",
  document: "Document",
  video: "Video"
};

const toolLabels = {
  deep_read_page: "Deep Read",
  extract_video_intel: "Video Intel",
  run_ephemeral_tool: "Ephemeral Tool",
  read_document_intel: "Document Intel"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function prettyJson(targetId, data) {
  document.getElementById(targetId).textContent = data ? JSON.stringify(data, null, 2) : "Waiting for output...";
}

function displaySourceType(value) {
  return sourceTypeLabels[value] || value || "Unknown";
}

function displayTool(value) {
  return toolLabels[value] || value || "Unknown tool";
}

function displayConnector(value) {
  return state.connectorLabels[value] || value || "Unknown connector";
}

function setRunButtonIdle() {
  const button = document.getElementById("runButton");
  button.disabled = false;
  button.textContent = "Run research";
}

function closeActiveStream() {
  if (state.activeStream) {
    state.activeStream.close();
    state.activeStream = null;
  }
  state.streamCompleted = false;
}

function renderProgressCard(title, message, badges = [], details = []) {
  const container = document.getElementById("finalAnswer");
  container.className = "answer-card";
  container.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <p class="lead">${escapeHtml(message)}</p>
    ${badges.length ? `<div class="memory-tags">${badges.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
    ${details.length ? `<ul class="tight-list">${details.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
  `;
}

function renderSamples(prompts) {
  const container = document.getElementById("sampleList");
  container.innerHTML = prompts
    .map((prompt) => `<button class="sample-chip" data-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`)
    .join("");

  container.querySelectorAll(".sample-chip").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("questionInput").value = button.dataset.prompt;
    });
  });
}

function renderCapabilities(capabilities) {
  const container = document.getElementById("capabilityList");
  container.innerHTML = capabilities.map((item) => `
    <article class="data-card">
      <div class="data-card-top">
        <span class="pill">Unified source tool</span>
      </div>
      <h4>${escapeHtml(item.label || item.id)}</h4>
      <p>${escapeHtml(item.description || "")}</p>
      <div class="memory-tags">
        ${(item.capabilities || []).map((capability) => `<span>${escapeHtml(capability)}</span>`).join("")}
      </div>
    </article>
  `).join("");
}

function renderMemory(entries) {
  const container = document.getElementById("memoryOutput");
  if (!entries.length) {
    container.className = "memory-grid empty-state";
    container.textContent = "No research memory yet.";
    return;
  }

  container.className = "memory-grid";
  container.innerHTML = entries.map((entry) => `
    <article class="memory-card">
      <p class="memory-time">${escapeHtml(new Date(entry.created_at).toLocaleString())}</p>
      <h4>${escapeHtml(entry.question)}</h4>
      <p>${escapeHtml(entry.note || "")}</p>
      <div class="memory-tags">
        ${(entry.useful_source_types || []).map((item) => `<span>${escapeHtml(displaySourceType(item))}</span>`).join("")}
      </div>
    </article>
  `).join("");
}

function renderFinalAnswer(result) {
  const container = document.getElementById("finalAnswer");
  const summary = result.final_answer.deep_research_summary || {};
  const evidenceList = summary.evidence_chain || [];
  const conflicts = summary.conflicts || [];
  const uncertainty = summary.uncertainty || [];
  const dynamicTools = summary.dynamic_tools || [];
  const scorecard = summary.evaluation_scorecard || null;
  const stopState = summary.stop_state || null;
  const stopDecision = summary.stop_decision || null;

  container.className = "answer-card";
  container.innerHTML = `
    <h3>${escapeHtml(result.final_answer.headline || "Research complete")}</h3>
    <p class="lead">${escapeHtml(result.final_answer.quick_answer || "")}</p>
    <div class="answer-grid">
      <section>
        <h4>Conclusion</h4>
        <p>${escapeHtml(summary.conclusion || "")}</p>
      </section>
      <section>
        <h4>Evidence</h4>
        <ul class="tight-list">
          ${evidenceList.map((item) => `<li>${escapeHtml(item.title)} | ${escapeHtml(displaySourceType(item.content_type || item.source_type))} | ${escapeHtml(item.why_it_matters || "")}</li>`).join("")}
        </ul>
      </section>
      <section>
        <h4>Conflicts</h4>
        <ul class="tight-list">
          ${(conflicts.length ? conflicts : [{ preferred_claim: "No major conflicts", reason: "No direct contradiction detected." }])
            .map((item) => `<li>${escapeHtml(item.preferred_claim || "")} | ${escapeHtml(item.reason || "")}</li>`)
            .join("")}
        </ul>
      </section>
      <section>
        <h4>Dynamic Tools</h4>
        <ul class="tight-list">
          ${(dynamicTools.length ? dynamicTools : [{ strategy: "none", success: true, target: { url: "" }, worth_promoting: { reason: "No ephemeral tool was needed." } }])
            .map((item) => `<li>${escapeHtml(item.strategy || "tool")} | ${escapeHtml(item.success ? "success" : "failed")} | ${escapeHtml(item.target?.url || item.target?.title || "")} | ${escapeHtml(item.worth_promoting?.reason || "")}</li>`)
            .join("")}
        </ul>
      </section>
      <section>
        <h4>Stop Decision</h4>
        <ul class="tight-list">
          ${stopDecision
            ? `<li>${escapeHtml(stopDecision.should_stop ? "stop" : "continue")} | ${escapeHtml(stopDecision.can_answer_accurately ? "accurate" : "not yet accurate")} | ${escapeHtml(stopDecision.reasoning || "")}</li>`
            : `<li>${escapeHtml(stopState?.reason || "no_stop_decision")} | ${escapeHtml(stopState?.should_answer_now ? "answer now" : "continue gathering")} | ${escapeHtml(scorecard?.status || "heuristic only")}</li>`}
        </ul>
      </section>
      <section>
        <h4>Evaluation</h4>
        <ul class="tight-list">
          ${scorecard
            ? `<li>readiness ${escapeHtml(String(scorecard.readiness))} | ${escapeHtml(scorecard.status || "")} | evidence ${escapeHtml(String(scorecard.checkpoints?.evidence_depth?.actual || 0))}/${escapeHtml(String(scorecard.checkpoints?.evidence_depth?.target || 0))}</li>`
            : "<li>No evaluation scorecard available.</li>"}
        </ul>
      </section>
      <section>
        <h4>Uncertainty</h4>
        <ul class="tight-list">
          ${uncertainty.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>
    </div>
  `;

  document.getElementById("confidenceBadge").textContent = `Confidence ${summary.confidence ?? "n/a"}`;
  document.getElementById("confidenceBadge").className = "badge";
}

function renderRounds(rounds) {
  const container = document.getElementById("roundsOutput");
  if (!rounds.length) {
    container.className = "timeline empty-state";
    container.textContent = "No rounds yet.";
    return;
  }

  container.className = "timeline";
  container.innerHTML = rounds.map((round) => `
    <article class="timeline-item">
      <div class="timeline-index">R${round.round}</div>
      <div class="timeline-body">
        <h4>Round ${round.round}</h4>
        <p><strong>Queries:</strong> ${(round.queries || []).map(escapeHtml).join(" / ")}</p>
        <p><strong>Sources:</strong> ${(round.selected_sources || []).map((item) => `${escapeHtml(item.title)} (${escapeHtml(displayConnector(item.connector))} / ${escapeHtml(displaySourceType(item.content_type || item.source_type))})`).join(" | ") || "none"}</p>
        <p><strong>Dynamic tools:</strong> ${(round.tool_attempts || []).map((item) => `${escapeHtml(item.strategy)} (${escapeHtml(item.success ? "success" : "failed")})`).join(" | ") || "none"}</p>
        <p><strong>Next step:</strong> ${escapeHtml(round.evaluation_snapshot?.next_best_action || "n/a")}</p>
      </div>
    </article>
  `).join("");
}

function renderCandidates(candidates) {
  const container = document.getElementById("candidateOutput");
  if (!candidates.length) {
    container.className = "card-list empty-state";
    container.textContent = "No candidates.";
    return;
  }

  container.className = "card-list";
  container.innerHTML = candidates.map((item) => `
    <article class="data-card">
      <div class="data-card-top">
        <span class="pill">${escapeHtml(displaySourceType(item.content_type || item.source_type))}</span>
        <span class="score">${escapeHtml(displayConnector(item.connector))}</span>
      </div>
      <h4>${escapeHtml(item.title)}</h4>
      <p>${escapeHtml(item.summary || "")}</p>
      <div class="meta-line">${escapeHtml(item.platform || "")} | ${escapeHtml(item.author || "Unknown")} | authority ${escapeHtml(item.authority_score ?? "n/a")}</div>
    </article>
  `).join("");
}

function renderReads(reads) {
  const container = document.getElementById("readOutput");
  if (!reads.length) {
    container.className = "card-list empty-state";
    container.textContent = "No reads yet.";
    return;
  }

  container.className = "card-list";
  container.innerHTML = reads.map((item) => {
    const highlights = item.key_points || (item.timeline || []).map((entry) => `${entry.start} ${entry.summary}`);
    return `
      <article class="data-card">
        <div class="data-card-top">
          <span class="pill">${escapeHtml(displayTool(item.tool))}</span>
          <span class="score">${escapeHtml(item.published_at || item.duration || "")}</span>
        </div>
        <h4>${escapeHtml(item.title)}</h4>
        <ul class="tight-list">
          ${highlights.slice(0, 4).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}
        </ul>
      </article>
    `;
  }).join("");
}

function renderAgentRuntime(runtime) {
  const container = document.getElementById("agentRuntimeOutput");
  const agents = runtime?.agents || [];
  if (!agents.length) {
    container.className = "card-list empty-state";
    container.textContent = "No agent runtime state.";
    return;
  }

  container.className = "card-list";
  container.innerHTML = agents.map((agent) => `
    <article class="data-card">
      <div class="data-card-top">
        <span class="pill">${escapeHtml(agent.id)}</span>
        <span class="score">${escapeHtml(agent.status || "unknown")}</span>
      </div>
      <h4>${escapeHtml(agent.current_task_id || "No active task")}</h4>
      <ul class="tight-list">
        <li>completed ${escapeHtml(String(agent.completed_tasks || 0))}</li>
        <li>failed ${escapeHtml(String(agent.failed_tasks || 0))}</li>
        <li>inbox ${escapeHtml(String(agent.inbox_count || 0))} / outbox ${escapeHtml(String(agent.outbox_count || 0))}</li>
      </ul>
    </article>
  `).join("");
}

function renderScratchpadTimeline(scratchpad) {
  const container = document.getElementById("scratchpadTimelineOutput");
  const items = scratchpad?.workspace?.timeline || [];
  if (!items.length) {
    container.className = "timeline empty-state";
    container.textContent = "No scratchpad timeline yet.";
    return;
  }

  container.className = "timeline";
  container.innerHTML = items.slice(-8).map((item, index) => `
    <article class="timeline-item">
      <div class="timeline-index">T${index + 1}</div>
      <div class="timeline-body">
        <h4>${escapeHtml(item.type || "event")}</h4>
        <p><strong>At:</strong> ${escapeHtml(item.at || "")}</p>
        <p><strong>Agent:</strong> ${escapeHtml(item.agent || "system")}</p>
        <p><strong>Detail:</strong> ${escapeHtml(item.queries?.join(" | ") || item.selected_sources?.join(" | ") || String(item.evidence_items || ""))}</p>
      </div>
    </article>
  `).join("");
}

function renderVerifierFollowUps(result) {
  const container = document.getElementById("verifierOutput");
  const followUps = result?.rounds?.flatMap((round) => round.agent_reports?.fact_verifier?.follow_ups || []) || [];
  if (!followUps.length) {
    container.className = "card-list empty-state";
    container.textContent = "No verifier follow-ups.";
    return;
  }

  container.className = "card-list";
  container.innerHTML = followUps.map((item) => `
    <article class="data-card">
      <div class="data-card-top">
        <span class="pill">${escapeHtml(item.kind || "review")}</span>
        <span class="score">${escapeHtml(item.status || "")}</span>
      </div>
      <h4>${escapeHtml(item.key || "unknown key")}</h4>
      <p>${escapeHtml(item.reason || "")}</p>
      <div class="meta-line">${escapeHtml(item.preferred_source || "unknown source")}</div>
    </article>
  `).join("");
}

function renderKnowledgeGraph(graph) {
  const container = document.getElementById("knowledgeGraphOutput");
  if (!graph?.latest_version) {
    container.className = "card-list empty-state";
    container.textContent = "No knowledge graph yet.";
    return;
  }

  const latest = graph.latest_version;
  container.className = "card-list";
  container.innerHTML = `
    <article class="data-card">
      <div class="data-card-top">
        <span class="pill">${escapeHtml(latest.id || "version")}</span>
        <span class="score">${escapeHtml(latest.label || "")}</span>
      </div>
      <h4>Latest Graph Snapshot</h4>
      <ul class="tight-list">
        <li>versions ${escapeHtml(String((graph.versions || []).length))}</li>
        <li>entities ${escapeHtml(String(latest.counts?.entities || 0))}</li>
        <li>claims ${escapeHtml(String(latest.counts?.claims || 0))}</li>
        <li>relations ${escapeHtml(String(latest.counts?.relations || 0))}</li>
      </ul>
    </article>
  `;
}

function setEmptyResultState() {
  document.getElementById("roundsOutput").className = "timeline empty-state";
  document.getElementById("roundsOutput").textContent = "Rounds will appear here.";
  document.getElementById("agentRuntimeOutput").className = "card-list empty-state";
  document.getElementById("agentRuntimeOutput").textContent = "Waiting for agent task traces...";
  document.getElementById("scratchpadTimelineOutput").className = "timeline empty-state";
  document.getElementById("scratchpadTimelineOutput").textContent = "Waiting for scratchpad timeline...";
  document.getElementById("candidateOutput").className = "card-list empty-state";
  document.getElementById("candidateOutput").textContent = "Waiting for candidates...";
  document.getElementById("readOutput").className = "card-list empty-state";
  document.getElementById("readOutput").textContent = "Waiting for reads...";
  document.getElementById("verifierOutput").className = "card-list empty-state";
  document.getElementById("verifierOutput").textContent = "Waiting for verifier follow-ups...";
  document.getElementById("knowledgeGraphOutput").className = "card-list empty-state";
  document.getElementById("knowledgeGraphOutput").textContent = "Waiting for knowledge graph...";
}

function renderPlanProgress(plan) {
  const connectors = (plan.chosen_connector_ids || []).map(displayConnector);
  prettyJson("planOutput", plan);
  document.getElementById("confidenceBadge").textContent = "Planning";
  document.getElementById("confidenceBadge").className = "badge";
  renderProgressCard(
    "Planning complete",
    `Planner selected ${connectors.length} connectors for this question.`,
    connectors,
    [
      `planner_mode: ${plan.planner_mode || "unknown"}`,
      `max_rounds: ${plan.stop_policy?.max_rounds || 0}`,
      `queries: ${(plan.initial_queries || []).join(" | ")}`,
      `memory hints: ${(plan.experience_hints?.boosted_source_types || []).join(" | ") || "none"}`
    ]
  );
}

function renderRoundProgress(payload) {
  state.liveRounds = [...state.liveRounds, payload.round];
  renderRounds(state.liveRounds);
  document.getElementById("confidenceBadge").textContent = `Round ${payload.round.round}`;
  document.getElementById("confidenceBadge").className = "badge";
  renderProgressCard(
    `Running round ${payload.round.round}`,
    `Collected ${payload.totals?.candidates || 0} candidates and ${payload.totals?.reads || 0} reads so far.`,
    (payload.round.chosen_connector_ids || []).map(displayConnector),
    [
      `queries: ${(payload.round.queries || []).join(" | ")}`,
      `selected: ${(payload.round.selected_sources || []).map((item) => `${item.title} (${displayConnector(item.connector)})`).join(" | ") || "none"}`,
      `verifier follow-ups: ${payload.round.agent_reports?.fact_verifier?.review_count || 0}`
    ]
  );
}

function renderEvaluationProgress(payload) {
  prettyJson("evaluationOutput", payload.evaluation);
  document.getElementById("confidenceBadge").textContent = payload.evaluation?.is_sufficient ? "Evidence sufficient" : "Need more evidence";
  document.getElementById("confidenceBadge").className = "badge";
}

function renderSynthesizingProgress(payload) {
  document.getElementById("confidenceBadge").textContent = "Synthesizing";
  document.getElementById("confidenceBadge").className = "badge";
  renderProgressCard(
    "Synthesizing answer",
    "Building the final answer from collected evidence.",
    [],
    [
      `rounds: ${payload.counts?.rounds || 0}`,
      `candidates: ${payload.counts?.candidates || 0}`,
      `reads: ${payload.counts?.reads || 0}`
    ]
  );
}

function renderToolProgress(payload) {
  state.toolAttempts = [...state.toolAttempts, payload.tool_attempt];
  document.getElementById("confidenceBadge").textContent = "Dynamic tool";
  document.getElementById("confidenceBadge").className = "badge";
  renderProgressCard(
    "Running ephemeral tool",
    payload.tool_attempt?.success ? "A synthesized tool recovered extra data." : "A synthesized tool was attempted as a fallback.",
    [payload.tool_attempt?.strategy || "tool"],
    [
      `target: ${payload.tool_attempt?.target?.url || payload.tool_attempt?.target?.title || "unknown"}`,
      `status: ${payload.tool_attempt?.success ? "success" : "failed"}`,
      `promote: ${payload.tool_attempt?.worth_promoting?.should_promote ? "yes" : "no"}`
    ]
  );
}

async function fetchSamples() {
  const response = await fetch("/api/samples");
  const data = await response.json();
  renderSamples(data.prompts || []);
  renderCapabilities(data.source_capabilities || []);
  state.connectorLabels = Object.fromEntries((data.source_capabilities || []).map((item) => [item.id, item.label || item.id]));
  state.memory = data.experience_memory || [];
  state.toolMemory = data.tool_memory || null;
  renderMemory(state.memory);
}

async function checkHealth() {
  const badge = document.getElementById("healthBadge");
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    badge.textContent = data.ok ? "Service online" : "Service error";
    badge.className = "badge";
  } catch (error) {
    badge.textContent = "Service offline";
    badge.className = "badge badge-muted";
  }
}

async function runResearch() {
  const question = document.getElementById("questionInput").value.trim();
  const mode = document.querySelector("input[name='mode']:checked").value;

  if (!question) {
    document.getElementById("finalAnswer").className = "answer-card empty-state";
    document.getElementById("finalAnswer").textContent = "Please enter a research question.";
    return;
  }

  closeActiveStream();
  state.liveRounds = [];
  state.toolAttempts = [];
  state.streamCompleted = false;
  const button = document.getElementById("runButton");
  button.disabled = true;
  button.textContent = "Streaming...";
  prettyJson("planOutput", null);
  prettyJson("evaluationOutput", null);
  setEmptyResultState();
  document.getElementById("confidenceBadge").textContent = "Connecting";
  document.getElementById("confidenceBadge").className = "badge";
  renderProgressCard("Starting research", "Opening streaming research session.", [], [
    `question: ${question}`,
    `mode: ${mode}`
  ]);

  try {
    const params = new URLSearchParams({ question, mode });
    const stream = new EventSource(`/api/research/stream?${params.toString()}`);
    state.activeStream = stream;

    stream.addEventListener("plan", (event) => {
      const payload = JSON.parse(event.data);
      renderPlanProgress(payload.plan || {});
    });

    stream.addEventListener("round", (event) => {
      const payload = JSON.parse(event.data);
      renderRoundProgress(payload);
    });

    stream.addEventListener("evaluation", (event) => {
      const payload = JSON.parse(event.data);
      renderEvaluationProgress(payload);
    });

    stream.addEventListener("synthesizing", (event) => {
      const payload = JSON.parse(event.data);
      renderSynthesizingProgress(payload);
    });

    stream.addEventListener("tool", (event) => {
      const payload = JSON.parse(event.data);
      renderToolProgress(payload);
    });

    stream.addEventListener("done", (event) => {
      const payload = JSON.parse(event.data);
      const result = payload.result;
      state.streamCompleted = true;
      closeActiveStream();
      renderFinalAnswer(result);
      prettyJson("planOutput", result.plan);
      prettyJson("evaluationOutput", result.evaluation);
      renderRounds(result.rounds || []);
      renderAgentRuntime(result.agent_runtime || null);
      renderScratchpadTimeline(result.scratchpad || null);
      renderCandidates(result.candidates || []);
      renderReads(result.reads || []);
      renderVerifierFollowUps(result);
      renderKnowledgeGraph(result.knowledge_graph || null);
      state.memory = [result.experience, ...state.memory].slice(0, 8);
      state.toolMemory = result.tool_memory || state.toolMemory;
      renderMemory(state.memory);
      setRunButtonIdle();
    });

    stream.addEventListener("failed", (event) => {
      const payload = JSON.parse(event.data);
      state.streamCompleted = true;
      closeActiveStream();
      document.getElementById("finalAnswer").className = "answer-card empty-state";
      document.getElementById("finalAnswer").textContent = payload.message || payload.error || "Research failed.";
      document.getElementById("confidenceBadge").textContent = "Failed";
      document.getElementById("confidenceBadge").className = "badge badge-muted";
      setRunButtonIdle();
    });

    stream.onerror = () => {
      if (state.streamCompleted) {
        return;
      }

      closeActiveStream();
      document.getElementById("finalAnswer").className = "answer-card empty-state";
      document.getElementById("finalAnswer").textContent = "Streaming connection failed.";
      document.getElementById("confidenceBadge").textContent = "Disconnected";
      document.getElementById("confidenceBadge").className = "badge badge-muted";
      setRunButtonIdle();
    };
  } catch (error) {
    document.getElementById("finalAnswer").className = "answer-card empty-state";
    document.getElementById("finalAnswer").textContent = error.message;
    document.getElementById("confidenceBadge").textContent = "Failed";
    document.getElementById("confidenceBadge").className = "badge badge-muted";
    setRunButtonIdle();
  }
}

function resetView() {
  closeActiveStream();
  state.liveRounds = [];
  state.toolAttempts = [];
  document.getElementById("questionInput").value = "";
  document.getElementById("finalAnswer").className = "answer-card empty-state";
  document.getElementById("finalAnswer").textContent = "Run a task to see the evidence-backed answer here.";
  document.getElementById("confidenceBadge").textContent = "Idle";
  document.getElementById("confidenceBadge").className = "badge badge-muted";
  prettyJson("planOutput", null);
  prettyJson("evaluationOutput", null);
  setEmptyResultState();
  setRunButtonIdle();
}

document.getElementById("runButton").addEventListener("click", runResearch);
document.getElementById("resetButton").addEventListener("click", resetView);

checkHealth();
fetchSamples();
setEmptyResultState();
