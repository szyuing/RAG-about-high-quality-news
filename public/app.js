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
  run_ephemeral_tool: "Ephemeral Tool"
};

function escapeHtml(value) {
  return String(value)
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
          ${(conflicts.length ? conflicts : [{ preferred_claim: "No major conflicts", reason: "No direct numerical contradiction detected." }])
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
      `queries: ${(plan.initial_queries || []).join(" | ")}`
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
      `ephemeral tools: ${(payload.round.tool_attempts || []).map((item) => `${item.strategy} ${item.success ? "ok" : "failed"}`).join(" | ") || "none"}`
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
  const button = document.getElementById("runButton");

  if (!question) {
    document.getElementById("finalAnswer").className = "answer-card empty-state";
    document.getElementById("finalAnswer").textContent = "Please enter a research question.";
    return;
  }

  closeActiveStream();
  state.liveRounds = [];
  state.toolAttempts = [];
  button.disabled = true;
  button.textContent = "Streaming...";
  prettyJson("planOutput", null);
  prettyJson("evaluationOutput", null);
  document.getElementById("roundsOutput").className = "timeline empty-state";
  document.getElementById("roundsOutput").textContent = "Waiting for round events...";
  document.getElementById("candidateOutput").className = "card-list empty-state";
  document.getElementById("candidateOutput").textContent = "Candidates will appear after completion.";
  document.getElementById("readOutput").className = "card-list empty-state";
  document.getElementById("readOutput").textContent = "Reads will appear after completion.";
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
      renderCandidates(result.candidates || []);
      renderReads(result.reads || []);
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
  document.getElementById("roundsOutput").className = "timeline empty-state";
  document.getElementById("roundsOutput").textContent = "Rounds will appear here.";
  document.getElementById("candidateOutput").className = "card-list empty-state";
  document.getElementById("candidateOutput").textContent = "Waiting for candidates...";
  document.getElementById("readOutput").className = "card-list empty-state";
  document.getElementById("readOutput").textContent = "Waiting for reads...";
  setRunButtonIdle();
}

document.getElementById("runButton").addEventListener("click", runResearch);
document.getElementById("resetButton").addEventListener("click", resetView);

checkHealth();
fetchSamples();
