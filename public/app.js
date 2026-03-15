const state = {
  memory: []
};

const sourceTypeLabels = {
  web: "网页",
  forum: "讨论",
  document: "文档",
  video: "视频"
};

const toolLabels = {
  deep_read_page: "正文深读",
  extract_video_intel: "视频提取"
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
  document.getElementById(targetId).textContent = data ? JSON.stringify(data, null, 2) : "等待输出...";
}

function displaySourceType(value) {
  return sourceTypeLabels[value] || value || "未知";
}

function displayTool(value) {
  return toolLabels[value] || value || "未知工具";
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
        <span class="pill">${escapeHtml(displaySourceType(item.source_type))}</span>
      </div>
      <h4>${escapeHtml(item.label)}</h4>
      <p>${escapeHtml(item.description)}</p>
    </article>
  `).join("");
}

function renderMemory(entries) {
  const container = document.getElementById("memoryOutput");
  if (!entries.length) {
    container.className = "memory-grid empty-state";
    container.textContent = "暂无历史经验。";
    return;
  }

  container.className = "memory-grid";
  container.innerHTML = entries.map((entry) => `
    <article class="memory-card">
      <p class="memory-time">${escapeHtml(new Date(entry.created_at).toLocaleString())}</p>
      <h4>${escapeHtml(entry.question)}</h4>
      <p>${escapeHtml(entry.note)}</p>
      <div class="memory-tags">
        ${(entry.useful_source_types || []).map((item) => `<span>${escapeHtml(displaySourceType(item))}</span>`).join("")}
      </div>
    </article>
  `).join("");
}

function renderFinalAnswer(result) {
  const container = document.getElementById("finalAnswer");
  const summary = result.final_answer.deep_research_summary;
  const evidenceList = summary.evidence_chain || [];
  const conflicts = summary.conflicts || [];
  const uncertainty = summary.uncertainty || [];

  container.className = "answer-card";
  container.innerHTML = `
    <h3>${escapeHtml(result.final_answer.headline)}</h3>
    <p class="lead">${escapeHtml(result.final_answer.quick_answer)}</p>
    <div class="answer-grid">
      <section>
        <h4>结论</h4>
        <p>${escapeHtml(summary.conclusion)}</p>
      </section>
      <section>
        <h4>证据链</h4>
        <ul class="tight-list">
          ${evidenceList.map((item) => `<li>${escapeHtml(item.title)} · ${escapeHtml(displaySourceType(item.source_type))} · ${escapeHtml(item.why_it_matters)}</li>`).join("")}
        </ul>
      </section>
      <section>
        <h4>冲突处理</h4>
        <ul class="tight-list">
          ${(conflicts.length ? conflicts : [{ preferred_claim: "无显著冲突", reason: "当前轮次没有发现明确的数字冲突。" }])
            .map((item) => `<li>${escapeHtml(item.preferred_claim || "无")} · ${escapeHtml(item.reason)}</li>`)
            .join("")}
        </ul>
      </section>
      <section>
        <h4>不确定性</h4>
        <ul class="tight-list">
          ${uncertainty.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>
    </div>
  `;

  document.getElementById("confidenceBadge").textContent = `置信度 ${summary.confidence}`;
  document.getElementById("confidenceBadge").className = "badge";
}

function renderRounds(rounds) {
  const container = document.getElementById("roundsOutput");
  if (!rounds.length) {
    container.className = "timeline empty-state";
    container.textContent = "没有可展示的轮次。";
    return;
  }

  container.className = "timeline";
  container.innerHTML = rounds.map((round) => `
    <article class="timeline-item">
      <div class="timeline-index">R${round.round}</div>
      <div class="timeline-body">
        <h4>第 ${round.round} 轮</h4>
        <p><strong>查询词:</strong> ${round.queries.map(escapeHtml).join(" / ")}</p>
        <p><strong>选中来源:</strong> ${round.selected_sources.map((item) => `${escapeHtml(item.title)} (${escapeHtml(item.connector)})`).join("；")}</p>
        <p><strong>下一步:</strong> ${escapeHtml(round.evaluation_snapshot.next_best_action)}</p>
      </div>
    </article>
  `).join("");
}

function renderCandidates(candidates) {
  const container = document.getElementById("candidateOutput");
  if (!candidates.length) {
    container.className = "card-list empty-state";
    container.textContent = "没有候选来源。";
    return;
  }

  container.className = "card-list";
  container.innerHTML = candidates.map((item) => `
    <article class="data-card">
      <div class="data-card-top">
        <span class="pill">${escapeHtml(displaySourceType(item.source_type))}</span>
        <span class="score">${escapeHtml(item.connector)}</span>
      </div>
      <h4>${escapeHtml(item.title)}</h4>
      <p>${escapeHtml(item.summary)}</p>
      <div class="meta-line">${escapeHtml(item.platform)} · ${escapeHtml(item.author || "未知作者")} · 权威分 ${item.authority_score}</div>
    </article>
  `).join("");
}

function renderReads(reads) {
  const container = document.getElementById("readOutput");
  if (!reads.length) {
    container.className = "card-list empty-state";
    container.textContent = "没有深读结果。";
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

async function fetchSamples() {
  const response = await fetch("/api/samples");
  const data = await response.json();
  renderSamples(data.prompts || []);
  renderCapabilities(data.source_capabilities || []);
  state.memory = data.experience_memory || [];
  renderMemory(state.memory);
}

async function checkHealth() {
  const badge = document.getElementById("healthBadge");
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    badge.textContent = data.ok ? "服务在线" : "服务异常";
    badge.className = "badge";
  } catch (error) {
    badge.textContent = "服务离线";
    badge.className = "badge badge-muted";
  }
}

async function runResearch() {
  const question = document.getElementById("questionInput").value.trim();
  const mode = document.querySelector("input[name='mode']:checked").value;
  const button = document.getElementById("runButton");

  if (!question) {
    document.getElementById("finalAnswer").className = "answer-card empty-state";
    document.getElementById("finalAnswer").textContent = "请输入研究问题。";
    return;
  }

  button.disabled = true;
  button.textContent = "运行中...";

  try {
    const response = await fetch("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, mode })
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || result.error || "研究失败");
    }

    renderFinalAnswer(result);
    prettyJson("planOutput", result.plan);
    prettyJson("evaluationOutput", result.evaluation);
    renderRounds(result.rounds || []);
    renderCandidates(result.candidates || []);
    renderReads(result.reads || []);

    state.memory = [result.experience, ...state.memory].slice(0, 8);
    renderMemory(state.memory);
  } catch (error) {
    document.getElementById("finalAnswer").className = "answer-card empty-state";
    document.getElementById("finalAnswer").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "运行研究流程";
  }
}

function resetView() {
  document.getElementById("questionInput").value = "";
  document.getElementById("finalAnswer").className = "answer-card empty-state";
  document.getElementById("finalAnswer").textContent = "运行后在这里展示证据化回答。";
  document.getElementById("confidenceBadge").textContent = "未运行";
  document.getElementById("confidenceBadge").className = "badge badge-muted";
  prettyJson("planOutput", null);
  prettyJson("evaluationOutput", null);
  document.getElementById("roundsOutput").className = "timeline empty-state";
  document.getElementById("roundsOutput").textContent = "运行后展示多代理闭环。";
  document.getElementById("candidateOutput").className = "card-list empty-state";
  document.getElementById("candidateOutput").textContent = "等待候选结果...";
  document.getElementById("readOutput").className = "card-list empty-state";
  document.getElementById("readOutput").textContent = "等待正文与转写结果...";
}

document.getElementById("runButton").addEventListener("click", runResearch);
document.getElementById("resetButton").addEventListener("click", resetView);

checkHealth();
fetchSamples();
