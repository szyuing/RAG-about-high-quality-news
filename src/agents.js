const crypto = require("crypto");
const { invokeSourceTool, ToolRegistry } = require("./source-connectors");
const { verifyEvidenceUnits } = require("./fact-verifier");
const { agentCommunication } = require("./agent-communication");
const { normalizeToolSpec, normalizeToolCreationRequest } = require("./tool-platform");

const AgentStatus = {
  IDLE: "idle",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  WAITING: "waiting"
};

const AgentType = {
  LLM_ORCHESTRATOR: "llm_orchestrator",
  WEB_RESEARCHER: "web_researcher",
  LONG_TEXT_COLLECTOR: "long_text_collector",
  VIDEO_PARSER: "video_parser",
  CHART_PARSER: "chart_parser",
  TABLE_PARSER: "table_parser",
  FACT_VERIFIER: "fact_verifier",
  TOOL_CREATOR: "tool_creator"
};

function toErrorMessage(errorLike) {
  if (!errorLike) {
    return "";
  }
  if (typeof errorLike === "string") {
    return errorLike;
  }
  if (typeof errorLike.message === "string") {
    return errorLike.message;
  }
  return String(errorLike);
}

class BaseAgent {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.type = config.type;
    this.prompt = config.prompt;
    this.tools = config.tools || [];
    this.status = AgentStatus.IDLE;
    this.result = null;
    this.error = null;
    this.startTime = null;
    this.endTime = null;
  }

  async execute(input) {
    this.status = AgentStatus.RUNNING;
    this.startTime = Date.now();
    this.result = null;
    this.error = null;
    this.retryCount = 0;

    try {
      const toolResults = await this.executeTools(input);
      this.ensureAnySuccessfulItems(toolResults, {
        label: "tools",
        isSuccess: (item) => item?.success !== false,
        getError: (item) => item?.error
      });
      this.result = this.processResults(toolResults);
      this.status = AgentStatus.COMPLETED;
      this.lastSuccessTime = Date.now();
    } catch (error) {
      this.error = error;
      this.status = AgentStatus.FAILED;
      this.lastFailureTime = Date.now();

      if (this.retryCount < 2) {
        this.retryCount++;
        console.log(`Agent ${this.id} failed, retrying (${this.retryCount}/2)...`);
        try {
          const toolResults = await this.executeTools(input);
          this.ensureAnySuccessfulItems(toolResults, {
            label: "tools",
            isSuccess: (item) => item?.success !== false,
            getError: (item) => item?.error
          });
          this.result = this.processResults(toolResults);
          this.error = null;
          this.status = AgentStatus.COMPLETED;
          this.lastSuccessTime = Date.now();
        } catch (retryError) {
          this.error = retryError;
          this.status = AgentStatus.FAILED;
        }
      }
    }

    this.endTime = Date.now();
    this.executionTime = this.endTime - this.startTime;
    return this.getResult();
  }

  async executeTools(input) {
    const results = [];
    for (const toolId of this.tools) {
      try {
        const result = await ToolRegistry.executeTool(toolId, input);
        results.push({ toolId, ...result });
      } catch (error) {
        results.push({ toolId, success: false, error: error.message });
      }
    }
    return results;
  }

  processResults(toolResults) {
    return toolResults;
  }

  ensureAnySuccessfulItems(items, options = {}) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      return list;
    }

    const isSuccess = options.isSuccess || ((item) => item?.success !== false);
    if (list.some((item) => isSuccess(item))) {
      return list;
    }

    const getError = options.getError || ((item) => item?.error);
    const reasons = list
      .map((item) => toErrorMessage(getError(item)))
      .filter(Boolean)
      .slice(0, 3);
    const prefix = options.label ? `All ${options.label} failed` : "All items failed";
    throw new Error(reasons.length > 0 ? `${prefix}: ${reasons.join("; ")}` : prefix);
  }

  getResult() {
    return {
      agentId: this.id,
      agentType: this.type,
      status: this.status,
      result: this.result,
      error: this.error,
      duration: this.endTime && this.startTime ? this.endTime - this.startTime : null
    };
  }

  reset() {
    this.status = AgentStatus.IDLE;
    this.result = null;
    this.error = null;
    this.startTime = null;
    this.endTime = null;
  }
}

class LLMOrchestratorAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.LLM_ORCHESTRATOR,
      tools: []
    });
    this.taskQueue = [];
    this.agentStates = new Map();
  }

  async planTask(question) {
    this.updateStatus(AgentStatus.RUNNING);

    const subQuestions = this.decomposeQuestion(question);
    const sourceStrategy = this.determineSourceStrategy(question);
    const stopCondition = this.determineStopCondition(question);

    return {
      task_goal: question,
      sub_questions: subQuestions,
      source_strategy: sourceStrategy,
      stop_condition: stopCondition,
      agents_needed: this.determineAgentsNeeded(question)
    };
  }

  decomposeQuestion(question) {
    const isComparison = /(相比|对比|差异|提升|versus|vs|update)/i.test(question);
    const isWhy = /(为什么|why|how)/i.test(question);

    if (isComparison) {
      return [
        "当前版本或当前状态是什么？",
        "历史基线或对照版本是什么？",
        "两者差异体现在哪些指标、能力或工作流上？"
      ];
    }

    if (isWhy) {
      return [
        "核心原因是什么？",
        "有哪些支持或反对的证据？",
        "最终结论是什么？"
      ];
    }

    return [
      "核心问题的直接答案是什么？",
      "哪些证据足以支撑这个答案？"
    ];
  }

  determineSourceStrategy(question) {
    const strategies = [];

    if (/视频|访谈|演讲|发布会|talk|video/i.test(question)) {
      strategies.push("video");
    }
    if (/新闻|动态|最新|发布/i.test(question)) {
      strategies.push("news", "web");
    }
    if (/论文|研究|paper|research/i.test(question)) {
      strategies.push("document");
    }
    if (/论坛|讨论|社区|forum/i.test(question)) {
      strategies.push("forum");
    }

    return strategies.length ? strategies : ["web", "video", "document"];
  }

  determineStopCondition() {
    return "Stop when core questions are covered by evidence from at least two source types and conflicts are disclosed.";
  }

  determineAgentsNeeded(question) {
    const agents = [AgentType.WEB_RESEARCHER];

    if (/视频|访谈|演讲/i.test(question)) {
      agents.push(AgentType.VIDEO_PARSER);
    }
    if (/长文|文档|论文|pdf/i.test(question)) {
      agents.push(AgentType.LONG_TEXT_COLLECTOR);
    }
    if (/chart|graph|figure|dashboard|图表|图像/.test(question)) {
      agents.push(AgentType.CHART_PARSER);
    }
    if (/table|spreadsheet|csv|xlsx|表格/.test(question)) {
      agents.push(AgentType.TABLE_PARSER);
    }
    if (/对比|差异|冲突/i.test(question)) {
      agents.push(AgentType.FACT_VERIFIER);
    }

    return agents;
  }

  dispatchTask(agentId, task) {
    this.taskQueue.push({ agentId, task, status: "pending" });
    this.agentStates.set(agentId, { task, status: "dispatched" });
  }

  updateStatus(status) {
    this.status = status;
  }

  processResults(toolResults) {
    return {
      plan: toolResults,
      tasks: this.taskQueue
    };
  }

  generateSynthesisMarkdownReport({ question, evidenceItems, verification, evaluation, agentReports }) {
    const lines = [
      `# Research Summary: ${question}`,
      "",
      "## Conclusion",
      this.buildConclusion(question, evidenceItems || [], verification),
      "",
      `**Confidence**: ${(this.calculateConfidence(verification, evaluation) * 100).toFixed(0)}%`,
      ""
    ];

    if (verification?.conflicts?.length) {
      lines.push("## Conflicts");
      for (const item of verification.conflicts) {
        lines.push(`- ${item.claim || "Unknown claim"}`);
      }
      lines.push("");
    }

    if (evaluation?.risk_notes?.length) {
      lines.push("## Risk Notes");
      for (const note of evaluation.risk_notes) {
        lines.push(`- ${note}`);
      }
      lines.push("");
    }

    if (agentReports?.length) {
      lines.push("## Agent Reports");
      for (const report of agentReports) {
        lines.push(`### ${report.agent || report.agentId || "Agent"}`);
        lines.push(report.markdown_report || report.summary || "");
      }
      lines.push("");
    }

    lines.push("## Sources");
    for (const source of this.buildSourceList(evidenceItems || [])) {
      lines.push(`- ${source.title} (${source.source_type})`);
    }
    lines.push("");

    return lines.join("\n");
  }

  async synthesizeAnswer(input) {
    this.status = AgentStatus.RUNNING;
    this.startTime = Date.now();

    try {
      const { question, evidenceItems, verification, evaluation, agentReports } = input;
      const keyClaims = this.extractKeyClaims(evidenceItems || []);
      const conclusion = this.buildConclusion(question, evidenceItems || [], verification);
      const confidence = this.calculateConfidence(verification, evaluation);

      this.result = {
        headline: `Research summary for "${question}"`,
        conclusion,
        key_claims: keyClaims,
        confidence,
        sources: this.buildSourceList(evidenceItems || []),
        conflicts: verification?.conflicts || [],
        uncertainty: evaluation?.risk_notes || [],
        markdown_report: this.generateSynthesisMarkdownReport({ question, evidenceItems, verification, evaluation, agentReports })
      };
      this.status = AgentStatus.COMPLETED;
    } catch (error) {
      this.error = error;
      this.status = AgentStatus.FAILED;
      this.result = {
        markdown_report: `# LLM-Orchestrator Report\n\n**Error**: ${error.message}`
      };
    }

    this.endTime = Date.now();
    return this.getResult();
  }

  extractKeyClaims(evidenceItems) {
    const claims = [];
    for (const item of evidenceItems || []) {
      for (const claim of item.claims || []) {
        claims.push({
          claim: claim.claim,
          source: item.source_id,
          authority: item.source_metadata?.authority_score || 0.66
        });
      }
    }
    return claims.slice(0, 5);
  }

  buildConclusion(question, evidenceItems, verification) {
    const supported = verification?.confirmations?.length || 0;
    const conflicted = verification?.conflicts?.length || 0;
    return `Research on "${question}" found ${evidenceItems.length} sources with ${supported} confirmations and ${conflicted} conflicts.`;
  }

  calculateConfidence(verification, evaluation) {
    const base = evaluation?.is_sufficient ? 0.7 : 0.5;
    const conflictPenalty = (verification?.conflicts?.length || 0) * 0.1;
    return Math.max(0, Math.min(1, base - conflictPenalty));
  }

  buildSourceList(evidenceItems) {
    return evidenceItems.map((item) => ({
      source_id: item.source_id,
      title: item.title,
      source_type: item.source_type
    }));
  }
}

class WebResearcherAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.WEB_RESEARCHER,
      tools: ["search_sources"]
    });
  }

  generateMarkdownReport(query, candidates) {
    const lines = [
      "# Web Researcher Agent 报告",
      `**查询**: ${query}`,
      `**候选来源数量**: ${candidates?.length || 0}`,
      "",
      "## 搜索结果",
      ""
    ];

    for (const candidate of candidates || []) {
      lines.push(`### ${candidate.title || "Untitled"}`);
      lines.push(`- **平台**: ${candidate.platform || "Unknown"}`);
      lines.push(`- **来源类型**: ${candidate.source_type || candidate.content_type || "Unknown"}`);
      lines.push(`- **URL**: ${candidate.url || "N/A"}`);
      if (candidate.snippet) {
        lines.push(`- **摘要**: ${candidate.snippet}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  async execute(input) {
    this.status = AgentStatus.RUNNING;
    this.startTime = Date.now();

    try {
      const { query, connectorIds } = input;
      const toolResults = await this.executeTools({
        query,
        connector_ids: connectorIds
      });
      this.ensureAnySuccessfulItems(toolResults, {
        label: "tools",
        isSuccess: (item) => item?.success !== false,
        getError: (item) => item?.error
      });

      const candidates = toolResults[0]?.data || [];

      this.result = {
        query,
        candidates: candidates || [],
        count: candidates?.length || 0,
        markdown_report: this.generateMarkdownReport(query, candidates)
      };
      this.status = AgentStatus.COMPLETED;
    } catch (error) {
      this.error = error;
      this.status = AgentStatus.FAILED;
      this.result = {
        markdown_report: `# Web Researcher Agent 报告\n\n**错误**: ${error.message}`
      };
    }

    this.endTime = Date.now();
    return this.getResult();
  }
}

class LongTextCollectorAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.LONG_TEXT_COLLECTOR,
      tools: ["deep_read_page"]
    });
  }

  generateMarkdownReport(reads) {
    const lines = [
      "# Long Text Collector Agent 报告",
      `**长文/网页阅读数量**: ${reads.length}`,
      ""
    ];

    for (const read of reads) {
      if (read.error) {
        lines.push(`## ❌ ${read.candidate?.title || "Unknown"}`);
        lines.push(`- **错误**: ${read.error}`);
        lines.push("");
        continue;
      }

      lines.push(`## ${read.title || "Untitled"}`);
      lines.push(`- **来源**: ${read.source_type}`);
      lines.push(`- **URL**: ${read.url}`);
      if (read.author) {
        lines.push(`- **作者**: ${read.author}`);
      }
      if (read.summary) {
        lines.push(`- **摘要**: ${read.summary}`);
      }
      if (read.key_points?.length) {
        lines.push("### 关键点");
        for (const point of read.key_points) {
          lines.push(`- ${point}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  async execute(input) {
    this.status = AgentStatus.RUNNING;
    this.startTime = Date.now();

    try {
      const { candidates } = input;
      const reads = [];

      for (const candidate of candidates || []) {
        try {
          const read = await invokeSourceTool({
            action: "read",
            candidate
          });
          reads.push(read);
        } catch (error) {
          reads.push({ error: error.message, candidate });
        }
      }
      if ((candidates || []).length > 0) {
        this.ensureAnySuccessfulItems(reads, {
          label: "reads",
          isSuccess: (item) => !item?.error,
          getError: (item) => item?.error
        });
      }

      this.result = {
        reads,
        count: reads.length,
        markdown_report: this.generateMarkdownReport(reads)
      };
      this.status = AgentStatus.COMPLETED;
    } catch (error) {
      this.error = error;
      this.status = AgentStatus.FAILED;
      this.result = {
        markdown_report: `# Long Text Collector Agent 报告\n\n**错误**: ${error.message}`
      };
    }

    this.endTime = Date.now();
    return this.getResult();
  }
}

class VideoParserAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.VIDEO_PARSER,
      tools: ["extract_video_intel"]
    });
  }

  generateMarkdownReport(videoIntel) {
    const lines = [
      "# Video Parser Agent 报告",
      `**视频数量**: ${videoIntel.length}`,
      ""
    ];

    for (const video of videoIntel) {
      if (video.error) {
        lines.push(`## ❌ ${video.candidate?.title || "Unknown"}`);
        lines.push(`- **错误**: ${video.error}`);
        lines.push("");
        continue;
      }

      lines.push(`## ${video.title || "Untitled"}`);
      lines.push(`- **来源**: ${video.source_type}`);
      lines.push(`- **URL**: ${video.url}`);
      if (video.author) {
        lines.push(`- **作者**: ${video.author}`);
      }
      if (video.duration) {
        lines.push(`- **时长**: ${video.duration}`);
      }
      if (video.summary) {
        lines.push(`- **摘要**: ${video.summary}`);
      }
      if (video.key_points?.length) {
        lines.push("### 关键点");
        for (const point of video.key_points) {
          lines.push(`- ${point}`);
        }
        lines.push("");
      }

      if (video.key_frames && video.key_frames.length > 0) {
        lines.push("### 关键帧描述");
        for (const frame of video.key_frames) {
          lines.push(`- ${frame}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  async execute(input) {
    this.status = AgentStatus.RUNNING;
    this.startTime = Date.now();

    try {
      const { candidates } = input;
      const videoIntel = [];

      for (const candidate of candidates || []) {
        try {
          const intel = await invokeSourceTool({
            action: "read",
            candidate
          });
          videoIntel.push(intel);
        } catch (error) {
          videoIntel.push({ error: error.message, candidate });
        }
      }
      if ((candidates || []).length > 0) {
        this.ensureAnySuccessfulItems(videoIntel, {
          label: "reads",
          isSuccess: (item) => !item?.error,
          getError: (item) => item?.error
        });
      }

      this.result = {
        videos: videoIntel,
        count: videoIntel.length,
        markdown_report: this.generateMarkdownReport(videoIntel)
      };
      this.status = AgentStatus.COMPLETED;
    } catch (error) {
      this.error = error;
      this.status = AgentStatus.FAILED;
      this.result = {
        markdown_report: `# Video Parser Agent 报告\n\n**错误**: ${error.message}`
      };
    }

    this.endTime = Date.now();
    return this.getResult();
  }
}

class ChartParserAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.CHART_PARSER,
      tools: ["read_document_intel"]
    });
  }
}

class TableParserAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.TABLE_PARSER,
      tools: ["read_document_intel"]
    });
  }
}

class FactVerifierAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.FACT_VERIFIER,
      tools: ["cross_check_facts"]
    });
  }

  generateMarkdownReport(verification) {
    const lines = [
      "# Fact Verifier Agent 报告",
      "",
      "## 验证摘要",
      `- ✅ **已确认**: ${verification.confirmations?.length || 0} 项`,
      `- ❌ **存在冲突**: ${verification.conflicts?.length || 0} 项`,
      `- ⚠️ **覆盖空白**: ${verification.coverage_gaps?.length || 0} 项`,
      verification.review_summary?.overall_verdict ? `- 🧠 **LLM 结论**: ${verification.review_summary.overall_verdict}` : null,
      verification.review_summary?.risk_level ? `- 📌 **风险等级**: ${verification.review_summary.risk_level}` : null,
      ""
    ].filter(Boolean);

    if (verification.review_summary?.explanation) {
      lines.push(`> ${verification.review_summary.explanation}`);
      lines.push("");
    }

    if (verification.confirmations && verification.confirmations.length > 0) {
      lines.push("## ✅ 已确认的事实");
      lines.push("");
      for (const item of verification.confirmations) {
        lines.push(`### ${item.claim || item.preferred_fact?.claim || "Unknown claim"}`);
        lines.push(`- **来源**: ${item.sources?.join(", ") || "Unknown"}`);
        lines.push(`- **确认程度**: ${((Number(item.confidence) || 0) * 100).toFixed(0)}%`);
        if (item.reason) {
          lines.push(`- **说明**: ${item.reason}`);
        }
        lines.push("");
      }
    }

    if (verification.conflicts && verification.conflicts.length > 0) {
      lines.push("## ❌ 存在冲突的事实");
      lines.push("");
      for (const item of verification.conflicts) {
        lines.push(`### ${item.claim || item.preferred_fact?.claim || "Unknown claim"}`);
        lines.push(`- **当前更可信来源**: ${item.comparison?.preferred_source || item.sources?.[0] || "Unknown"}`);
        lines.push(`- **冲突来源**: ${(item.sources || []).join(", ") || "Unknown"}`);
        if (item.reason) {
          lines.push(`- **说明**: ${item.reason}`);
        }
        if (item.missing_evidence?.length) {
          lines.push(`- **仍缺证据**: ${item.missing_evidence.join("；")}`);
        }
        lines.push("");
      }
    }

    if (verification.coverage_gaps && verification.coverage_gaps.length > 0) {
      lines.push("## ⚠️ 需要更多证据的领域");
      lines.push("");
      for (const item of verification.coverage_gaps) {
        lines.push(`- **缺失领域**: ${item.claim || item.preferred_fact?.claim || "Unknown"}`);
        if (item.suggested_sources?.length) {
          lines.push(`- **建议来源**: ${item.suggested_sources.join(", ")}`);
        }
        if (item.suggested_queries?.length) {
          lines.push(`- **建议补搜**: ${item.suggested_queries.join(" | ")}`);
        }
      }
      lines.push("");
    }

    if (verification.follow_up_queries?.length) {
      lines.push("## 🔎 建议下一步搜索");
      lines.push("");
      for (const query of verification.follow_up_queries) {
        lines.push(`- ${query}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  async execute(input) {
    this.status = AgentStatus.RUNNING;
    this.startTime = Date.now();

    try {
      const { evidenceItems } = input;

      const verification = await verifyEvidenceUnits(evidenceItems || []);

      this.result = {
        confirmations: verification.confirmations,
        conflicts: verification.conflicts,
        coverage_gaps: verification.coverage_gaps,
        summary: {
          confirmed: verification.confirmations.length,
          conflicted: verification.conflicts.length,
          gaps: verification.coverage_gaps.length
        },
        markdown_report: this.generateMarkdownReport(verification)
      };
      this.status = AgentStatus.COMPLETED;
    } catch (error) {
      this.error = error;
      this.status = AgentStatus.FAILED;
      this.result = {
        markdown_report: `# Fact Verifier Agent 报告\n\n**错误**: ${error.message}`
      };
    }

    this.endTime = Date.now();
    return this.getResult();
  }
}

class FinalAnswerComposer extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.LLM_ORCHESTRATOR,
      tools: []
    });
  }

  generateMarkdownReport({ question, evidenceItems, verification, evaluation, agentReports }) {
    const lines = [
      `# Research Summary: ${question}`,
      "",
      "## 结论",
      this.buildConclusion(question, evidenceItems || [], verification),
      "",
      `**置信度**: ${(this.calculateConfidence(verification, evaluation) * 100).toFixed(0)}%`,
      ""
    ];

    if (verification?.conflicts?.length) {
      lines.push("## 冲突与不确定性");
      for (const item of verification.conflicts) {
        lines.push(`- ${item.claim || "Unknown claim"}`);
      }
      lines.push("");
    }

    if (evaluation?.risk_notes?.length) {
      lines.push("## 风险提示");
      for (const note of evaluation.risk_notes) {
        lines.push(`- ${note}`);
      }
      lines.push("");
    }

    if (agentReports?.length) {
      lines.push("## Agent 报告摘录");
      for (const report of agentReports) {
        lines.push(`### ${report.agent || report.agentId || "Agent"}`);
        lines.push(report.markdown_report || report.summary || "");
      }
      lines.push("");
    }

    lines.push("---\n");
    lines.push("## 📚 参考来源\n");
    for (const source of this.buildSourceList(evidenceItems || [])) {
      lines.push(`- ${source.title} (${source.source_type})`);
    }
    lines.push("");

    return lines.join("\n");
  }

  async execute(input) {
    this.status = AgentStatus.RUNNING;
    this.startTime = Date.now();

    try {
      const { question, evidenceItems, verification, evaluation, agentReports } = input;

      const keyClaims = this.extractKeyClaims(evidenceItems || []);
      const conclusion = this.buildConclusion(question, evidenceItems || [], verification);
      const confidence = this.calculateConfidence(verification, evaluation);

      this.result = {
        headline: `Research summary for "${question}"`,
        conclusion,
        key_claims: keyClaims,
        confidence,
        sources: this.buildSourceList(evidenceItems || []),
        conflicts: verification?.conflicts || [],
        uncertainty: evaluation?.risk_notes || [],
        markdown_report: this.generateMarkdownReport({ question, evidenceItems, verification, evaluation, agentReports })
      };
      this.status = AgentStatus.COMPLETED;
    } catch (error) {
      this.error = error;
      this.status = AgentStatus.FAILED;
      this.result = {
        markdown_report: `# Final Answer Composer Report\n\n**Error**: ${error.message}`
      };
    }

    this.endTime = Date.now();
    return this.getResult();
  }

  extractKeyClaims(evidenceItems) {
    const claims = [];
    for (const item of evidenceItems || []) {
      for (const claim of item.claims || []) {
        claims.push({
          claim: claim.claim,
          source: item.source_id,
          authority: item.source_metadata?.authority_score || 0.66
        });
      }
    }
    return claims.slice(0, 5);
  }

  buildConclusion(question, evidenceItems, verification) {
    const supported = verification?.confirmations?.length || 0;
    const conflicted = verification?.conflicts?.length || 0;
    return `Research on "${question}" found ${evidenceItems.length} sources with ${supported} confirmations and ${conflicted} conflicts.`;
  }

  calculateConfidence(verification, evaluation) {
    const base = evaluation?.is_sufficient ? 0.7 : 0.5;
    const conflictPenalty = (verification?.conflicts?.length || 0) * 0.1;
    return Math.max(0, Math.min(1, base - conflictPenalty));
  }

  buildSourceList(evidenceItems) {
    return evidenceItems.map((item) => ({
      source_id: item.source_id,
      title: item.title,
      source_type: item.source_type
    }));
  }
}

class ToolCreatorAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.TOOL_CREATOR,
      tools: []
    });
    this.requestQueue = [];
    this.isProcessing = false;
  }

  generateMarkdownReport(toolResults) {
    const lines = [
      "# Tool Creator Agent 报告",
      `**工具创建结果**: ${toolResults.length} 个工具`,
      ""
    ];

    for (const tool of toolResults) {
      lines.push(`## ${tool.name}`);
      lines.push(`- **ID**: ${tool.id}`);
      lines.push(`- **描述**: ${tool.description}`);
      lines.push(`- **参数**: ${JSON.stringify(tool.parameters || {})}`);
      lines.push(`- **状态**: ${tool.status || "created"}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  async execute(input) {
    if (this.isProcessing) {
      return new Promise((resolve) => {
        this.requestQueue.push({ input, resolve });
      });
    }

    this.isProcessing = true;
    try {
      const result = await this.processRequest(input);
      this.processNextRequest();
      return result;
    } finally {
      this.isProcessing = false;
    }
  }

  async processRequest(input) {
    this.status = AgentStatus.RUNNING;
    this.startTime = Date.now();

    try {
      const normalizedRequest = normalizeToolCreationRequest(
        input?.toolCreationRequest || {
          requester: input?.requestMetadata?.requester || null,
          metadata: input?.requestMetadata || {},
          tool_specs: input?.toolSpecs || input?.tools || []
        }
      );
      const toolSpecs = normalizedRequest.tool_specs || [];
      const requestMetadata = {
        ...(normalizedRequest.metadata || {}),
        requester: normalizedRequest.requester || null
      };
      const createdTools = [];

      for (const spec of toolSpecs) {
        const tool = this.createTool(spec, requestMetadata);
        if (tool) {
          createdTools.push(tool);
        }
      }
      if (toolSpecs.length > 0 && createdTools.length === 0) {
        throw new Error("No tools were created");
      }

      this.result = {
        tools: createdTools,
        count: createdTools.length,
        markdown_report: this.generateMarkdownReport(createdTools)
      };
      this.status = AgentStatus.COMPLETED;
    } catch (error) {
      this.error = error;
      this.status = AgentStatus.FAILED;
      this.result = {
        markdown_report: `# Tool Creator Agent 报告\n\n**错误**: ${error.message}`
      };
    }

    this.endTime = Date.now();
    return this.getResult();
  }

  processNextRequest() {
    if (this.requestQueue.length > 0) {
      const { input, resolve } = this.requestQueue.shift();
      this.execute(input).then(resolve);
    }
  }

  createTool(spec, requestMetadata = {}) {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString("hex");
    const agentId = this.id;
    const toolId = spec.id || spec.tool_id || `tool_${agentId}_${timestamp}_${random}`;
    const implementation = spec.implementation || this.generateToolImplementation(spec);
    return normalizeToolSpec({
      ...spec,
      id: toolId,
      tool_id: toolId,
      base_tool_id: spec.base_tool_id || spec.id || toolId,
      name: spec.name || `Tool ${toolId}`,
      description: spec.description || "Generated tool",
      parameters: spec.parameters || [],
      implementation,
      source: spec.source || "dynamic",
      runtime: spec.runtime || null,
      lifecycle_state: "ephemeral",
      synthesis_mode: "creator_agent",
      created_by: agentId,
      created_for: requestMetadata.requester || spec.created_for || null,
      request_id: requestMetadata.request_id || null
    }, {
      ...requestMetadata,
      requester: requestMetadata.requester || spec.created_for || null
    });
  }

  normalizeToolCreationRequest(message) {
    const normalized = normalizeToolCreationRequest({
      requester: message?.sender || null,
      metadata: {
        request_id: message?.metadata?.request_id || null,
        purpose: message?.content?.purpose || null
      },
      tool_specs: message?.content?.tool_specs || message?.content?.toolSpecs || []
    });
    return {
      toolCreationRequest: normalized,
      toolSpecs: normalized.tool_specs,
      requestMetadata: {
        request_id: normalized.metadata?.request_id || null,
        requester: normalized.requester || null,
        purpose: normalized.metadata?.purpose || null
      }
    };
  }

  async handleToolCreationRequest(message) {
    const payload = this.normalizeToolCreationRequest(message);

    try {
      const result = await this.execute(payload);
      agentCommunication.respondToolCreation(
        this.type,
        message.sender,
        message.metadata?.request_id,
        {
          success: result.status === AgentStatus.COMPLETED,
          tools: result.result?.tools || [],
          count: result.result?.count || 0,
          markdown_report: result.result?.markdown_report || "",
          request_id: message.metadata?.request_id || null
        },
        {
          handled_by: this.id
        }
      );
      return result;
    } catch (error) {
      agentCommunication.sendError(
        this.type,
        message.sender,
        {
          request_type: "tool_creation_result",
          success: false,
          error: error.message
        },
        {
          correlation_id: message.metadata?.request_id,
          handled_by: this.id
        }
      );
      throw error;
    }
  }

  generateToolImplementation(spec) {
    return async function toolImplementation(input) {
      return {
        success: true,
        result: `Tool ${spec.name} executed with input: ${JSON.stringify(input)}`,
        metadata: {
          tool_id: spec.id,
          executed_at: new Date().toISOString()
        }
      };
    };
  }
}

class ToolCreatorPool {
  constructor(agentSystem, poolSize = 2) {
    this.agents = [];
    this.currentIndex = 0;
    this.agentSystem = agentSystem;

    for (let i = 0; i < poolSize; i++) {
      const agent = agentSystem.createAgent(AgentType.TOOL_CREATOR, {
        id: `tool_creator_${i}`,
        name: `Tool Creator ${i}`
      });
      this.agents.push(agent);
    }
  }

  getNextAgent() {
    const agent = this.agents[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.agents.length;
    return agent;
  }

  async execute(toolSpecs) {
    const agent = this.getNextAgent();
    return await agent.execute({ toolSpecs });
  }

  getAgents() {
    return this.agents;
  }

  getStatus() {
    return {
      poolSize: this.agents.length,
      agents: this.agents.map((agent) => ({
        id: agent.id,
        status: agent.status,
        queueLength: agent.requestQueue?.length || 0
      }))
    };
  }
}

function createAgent(type, config = {}) {
  const baseConfig = {
    ...config,
    id: config.id || type,
    name: config.name || type,
    prompt: config.prompt || ""
  };

  switch (type) {
    case AgentType.LLM_ORCHESTRATOR:
      return new LLMOrchestratorAgent(baseConfig);
    case AgentType.WEB_RESEARCHER:
      return new WebResearcherAgent(baseConfig);
    case AgentType.LONG_TEXT_COLLECTOR:
      return new LongTextCollectorAgent(baseConfig);
    case AgentType.VIDEO_PARSER:
      return new VideoParserAgent(baseConfig);
    case AgentType.CHART_PARSER:
      return new ChartParserAgent(baseConfig);
    case AgentType.TABLE_PARSER:
      return new TableParserAgent(baseConfig);
    case AgentType.FACT_VERIFIER:
      return new FactVerifierAgent(baseConfig);
    case AgentType.TOOL_CREATOR:
      return new ToolCreatorAgent(baseConfig);
    default:
      throw new Error(`Unknown agent type: ${type}`);
  }
}

module.exports = {
  AgentStatus,
  AgentType,
  BaseAgent,
  LLMOrchestratorAgent,
  WebResearcherAgent,
  LongTextCollectorAgent,
  VideoParserAgent,
  ChartParserAgent,
  TableParserAgent,
  FactVerifierAgent,
  ToolCreatorAgent,
  ToolCreatorPool,
  createAgent
};
