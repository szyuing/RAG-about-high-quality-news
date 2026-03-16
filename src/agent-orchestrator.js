const { invokeSourceTool, ToolRegistry } = require("./source-connectors");
const { createEvidenceUnit, normalizeText, scoreQuestionCoverage, toIsoTimestamp } = require("./evidence-model");
const { verifyEvidenceUnits } = require("./fact-verifier");
const { synthesizeTool, runEphemeralTool } = require("./ephemeral-tooling");
const { statePersistence } = require("./state-persistence");
const { agentCommunication } = require("./agent-communication");
const { knowledgeSharingSystem } = require("./knowledge-sharing");
const { AgentManager, Task } = require("./agent-manager");
const { dataAnalyzer, researchProgressTracker } = require("./data-analysis");
const { smartInformationRetriever } = require("./smart-retriever");
const crypto = require('crypto');

// ============================================
// Supervisor + Specialists 多 Agent 架构
// ============================================

// Agent 状态枚举
const AgentStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  WAITING: 'waiting'
};

// Agent 类型枚举
const AgentType = {
  SUPERVISOR: 'supervisor',
  WEB_RESEARCHER: 'web_researcher',
  LONG_TEXT_COLLECTOR: 'long_text_collector',
  VIDEO_PARSER: 'video_parser',
  CHART_PARSER: 'chart_parser',
  TABLE_PARSER: 'table_parser',
  FACT_VERIFIER: 'fact_verifier',
  SYNTHESIZER: 'synthesizer',
  TOOL_CREATOR: 'tool_creator'
};

// 创建 Agent 类
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
      this.result = this.processResults(toolResults);
      this.status = AgentStatus.COMPLETED;
      this.lastSuccessTime = Date.now();
    } catch (error) {
      this.error = error;
      this.status = AgentStatus.FAILED;
      this.lastFailureTime = Date.now();
      
      // 故障恢复尝试
      if (this.retryCount < 2) {
        this.retryCount++;
        console.log(`Agent ${this.id} failed, retrying (${this.retryCount}/2)...`);
        try {
          const toolResults = await this.executeTools(input);
          this.result = this.processResults(toolResults);
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

// Supervisor Agent - 负责任务规划、任务分发、进度监控
class SupervisorAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.SUPERVISOR,
      tools: []
    });
    this.taskQueue = [];
    this.agentStates = new Map();
  }

  async planTask(question, context) {
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
        "两者差异体现在什么指标、能力或工作流上？"
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
      strategies.push('video');
    }
    if (/新闻|动态、最新|发布/i.test(question)) {
      strategies.push('news', 'web');
    }
    if (/论文|研究|paper|research/i.test(question)) {
      strategies.push('document');
    }
    if (/论坛|讨论|社区|forum/i.test(question)) {
      strategies.push('forum');
    }
    
    return strategies.length ? strategies : ['web', 'video', 'document'];
  }

  determineStopCondition(question) {
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
    if (/chart|graph|figure|dashboard|图表|鍥捐〃/i.test(question)) {
      agents.push(AgentType.CHART_PARSER);
    }
    if (/table|spreadsheet|csv|xlsx|表格|鏁版嵁琛?/i.test(question)) {
      agents.push(AgentType.TABLE_PARSER);
    }
    if (/对比|差异|冲突/i.test(question)) {
      agents.push(AgentType.FACT_VERIFIER);
    }
    
    agents.push(AgentType.SYNTHESIZER);
    return agents;
  }

  dispatchTask(agentId, task) {
    this.taskQueue.push({ agentId, task, status: 'pending' });
    this.agentStates.set(agentId, { task, status: 'dispatched' });
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
}

// Web Researcher Agent - 负责广度搜索
class WebResearcherAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.WEB_RESEARCHER,
      tools: ['search_sources']
    });
  }

  generateMarkdownReport(query, candidates) {
    const lines = [
      `# Web Researcher Agent 报告`,
      `**查询**: ${query}`,
      `**候选来源数量**: ${candidates?.length || 0}`,
      ``,
      `## 搜索结果`,
      ``
    ];

    for (const candidate of candidates || []) {
      const score = (candidate.score * 100).toFixed(1);
      lines.push(`### ${candidate.title || 'Untitled'}`);
      lines.push(`- **来源**: ${candidate.connector}`);
      lines.push(`- **URL**: ${candidate.url}`);
      lines.push(`- **相关性得分**: ${score}%`);
      if (candidate.summary) {
        lines.push(`- **摘要**: ${candidate.summary.slice(0, 200)}...`);
      }
      if (candidate.author) {
        lines.push(`- **作者**: ${candidate.author}`);
      }
      if (candidate.published_at) {
        lines.push(`- **发布时间**: ${candidate.published_at}`);
      }
      lines.push(``);
    }

    return lines.join('\n');
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

// Long Text Collector Agent - 负责长文和网页阅读
class LongTextCollectorAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.LONG_TEXT_COLLECTOR,
      tools: ['deep_read_page']
    });
  }

  generateMarkdownReport(reads) {
    const lines = [
      `# Long Text Collector Agent 报告`,
      `**长文/网页阅读数量**: ${reads.length}`,
      ``
    ];

    for (const read of reads) {
      if (read.error) {
        lines.push(`## ❌ ${read.candidate?.title || 'Unknown'}`);
        lines.push(`- **错误**: ${read.error}`);
        lines.push(``);
        continue;
      }

      lines.push(`## ${read.title || 'Untitled'}`);
      lines.push(`- **来源**: ${read.source_type}`);
      lines.push(`- **URL**: ${read.url}`);
      if (read.author) {
        lines.push(`- **作者**: ${read.author}`);
      }
      if (read.published_at) {
        lines.push(`- **发布时间**: ${read.published_at}`);
      }
      if (read.duration) {
        lines.push(`- **时长**: ${read.duration}`);
      }
      lines.push(``);

      if (read.markdown) {
        lines.push(`### 内容摘要`);
        lines.push(read.markdown.slice(0, 1000));
        lines.push(``);
      }

      if (read.key_points && read.key_points.length > 0) {
        lines.push(`### 关键要点`);
        for (const point of read.key_points) {
          lines.push(`- ${point}`);
        }
        lines.push(``);
      }

      if (read.facts && read.facts.length > 0) {
        lines.push(`### 提取的事实`);
        for (const fact of read.facts.slice(0, 5)) {
          lines.push(`- ${fact}`);
        }
        lines.push(``);
      }
    }

    return lines.join('\n');
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

// Video Parser Agent - 负责视频内容提取
class VideoParserAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.VIDEO_PARSER,
      tools: ['extract_video_intel']
    });
  }

  generateMarkdownReport(videoIntel) {
    const lines = [
      `# Video Parser Agent 报告`,
      `**视频数量**: ${videoIntel.length}`,
      ``
    ];

    for (const video of videoIntel) {
      if (video.error) {
        lines.push(`## ❌ ${video.candidate?.title || 'Unknown'}`);
        lines.push(`- **错误**: ${video.error}`);
        lines.push(``);
        continue;
      }

      lines.push(`## ${video.title || 'Untitled'}`);
      lines.push(`- **来源**: ${video.source_type}`);
      lines.push(`- **URL**: ${video.url}`);
      if (video.author) {
        lines.push(`- **作者**: ${video.author}`);
      }
      if (video.published_at) {
        lines.push(`- **发布时间**: ${video.published_at}`);
      }
      if (video.duration) {
        lines.push(`- **时长**: ${video.duration}`);
      }
      lines.push(``);

      if (video.transcript && video.transcript.length > 0) {
        lines.push(`### 转录文本`);
        const transcriptText = video.transcript.map(t => `[${t.start}] ${t.text}`).join('\n');
        lines.push(transcriptText.slice(0, 2000));
        lines.push(``);
      }

      if (video.timeline && video.timeline.length > 0) {
        lines.push(`### 时间轴摘要`);
        for (const item of video.timeline) {
          lines.push(`- **[${item.start}]** ${item.title || item.summary}`);
        }
        lines.push(``);
      }

      if (video.key_points && video.key_points.length > 0) {
        lines.push(`### 关键要点`);
        for (const point of video.key_points) {
          lines.push(`- ${point}`);
        }
        lines.push(``);
      }

      if (video.key_frames && video.key_frames.length > 0) {
        lines.push(`### 关键帧描述`);
        for (const frame of video.key_frames) {
          lines.push(`- ${frame}`);
        }
        lines.push(``);
      }
    }

    return lines.join('\n');
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
      tools: ['read_document_intel']
    });
  }
}

class TableParserAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.TABLE_PARSER,
      tools: ['read_document_intel']
    });
  }
}

// Fact Verifier Agent - 负责事实验证
class FactVerifierAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.FACT_VERIFIER,
      tools: ['cross_check_facts']
    });
  }

  generateMarkdownReport(verification) {
    const lines = [
      `# Fact Verifier Agent 报告`,
      ``,
      `## 验证摘要`,
      `- ✅ **已确认**: ${verification.confirmations?.length || 0} 项`,
      `- ❌ **存在冲突**: ${verification.conflicts?.length || 0} 项`,
      `- ⚠️ **覆盖空白**: ${verification.coverage_gaps?.length || 0} 项`,
      ``
    ];

    if (verification.confirmations && verification.confirmations.length > 0) {
      lines.push(`## ✅ 已确认的事实`);
      lines.push(``);
      for (const item of verification.confirmations) {
        lines.push(`### ${item.claim || 'Unknown claim'}`);
        lines.push(`- **来源**: ${item.sources?.join(', ') || 'Unknown'}`);
        lines.push(`- **确认程度**: ${(item.confidence * 100).toFixed(0)}%`);
        if (item.explanation) {
          lines.push(`- **说明**: ${item.explanation}`);
        }
        lines.push(``);
      }
    }

    if (verification.conflicts && verification.conflicts.length > 0) {
      lines.push(`## ❌ 存在冲突的事实`);
      lines.push(``);
      for (const item of verification.conflicts) {
        lines.push(`### ${item.claim || 'Unknown claim'}`);
        lines.push(`- **冲突来源 1**: ${item.sources?.[0] || 'Unknown'}`);
        lines.push(`- **冲突来源 2**: ${item.sources?.[1] || 'Unknown'}`);
        if (item.explanation) {
          lines.push(`- **说明**: ${item.explanation}`);
        }
        lines.push(``);
      }
    }

    if (verification.coverage_gaps && verification.coverage_gaps.length > 0) {
      lines.push(`## ⚠️ 需要更多证据的领域`);
      lines.push(``);
      for (const item of verification.coverage_gaps) {
        lines.push(`- **缺失领域**: ${item.claim || 'Unknown'}`);
        if (item.suggested_sources) {
          lines.push(`- **建议来源**: ${item.suggested_sources.join(', ')}`);
        }
      }
      lines.push(``);
    }

    return lines.join('\n');
  }

  async execute(input) {
    this.status = AgentStatus.RUNNING;
    this.startTime = Date.now();
    
    try {
      const { evidenceItems } = input;
      
      const verification = verifyEvidenceUnits(evidenceItems || []);
      
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

// Synthesizer Agent - 负责整合输出
class SynthesizerAgent extends BaseAgent {
  constructor(config) {
    super({
      ...config,
      type: AgentType.SYNTHESIZER,
      tools: []
    });
  }

  generateMarkdownReport(input) {
    const { question, evidenceItems, verification, evaluation, agentReports } = input;
    
    const lines = [
      `# 研究报告`,
      `**问题**: ${question}`,
      `**生成时间**: ${new Date().toISOString()}`,
      ``
    ];

    lines.push(`---\n`);
    lines.push(`## ?? ??gent???????n`);
    
    const normalizedReports = {
      web_researcher: agentReports?.web_researcher,
      long_text_collector: agentReports?.long_text_collector,
      video_parser: agentReports?.video_parser,
      chart_parser: agentReports?.chart_parser,
      table_parser: agentReports?.table_parser,
      fact_verifier: agentReports?.fact_verifier
    };

    if (agentReports) {
      if (normalizedReports.web_researcher) {
        lines.push(`## Web Researcher Agent ???\n`);
        lines.push(normalizedReports.web_researcher);
        lines.push(`\n---\n`);
      }
      
      if (normalizedReports.long_text_collector) {
        lines.push(`## Long Text Collector Agent ???\n`);
        lines.push(normalizedReports.long_text_collector);
        lines.push(`\n---\n`);
      }
      
      if (normalizedReports.video_parser) {
        lines.push(`## Video Parser Agent ???\n`);
        lines.push(normalizedReports.video_parser);
        lines.push(`\n---\n`);
      }

      if (normalizedReports.chart_parser) {
        lines.push(`## Chart Parser Agent ???\n`);
        lines.push(normalizedReports.chart_parser);
        lines.push(`\n---\n`);
      }

      if (normalizedReports.table_parser) {
        lines.push(`## Table Parser Agent ???\n`);
        lines.push(normalizedReports.table_parser);
        lines.push(`\n---\n`);
      }
      
      if (normalizedReports.fact_verifier) {
        lines.push(`## Fact Verifier Agent ???\n`);
        lines.push(normalizedReports.fact_verifier);
        lines.push(`\n---\n`);
      }
    }

    const keyClaims = this.extractKeyClaims(evidenceItems || []);
    const conclusion = this.buildConclusion(question, evidenceItems || [], verification);
    const confidence = this.calculateConfidence(verification, evaluation);
    
    lines.push(`---\n`);
    lines.push(`## 🎯 结论\n`);
    lines.push(conclusion);
    lines.push(``);
    
    lines.push(`## 📈 置信度\n`);
    lines.push(`- **置信度**: ${(confidence * 100).toFixed(0)}%`);
    lines.push(``);
    
    if (keyClaims.length > 0) {
      lines.push(`## 🔑 关键发现\n`);
      for (const claim of keyClaims) {
        lines.push(`- ${claim.claim} (来源: ${claim.source}, 可信度: ${(claim.authority * 100).toFixed(0)}%)`);
      }
      lines.push(``);
    }
    
    if (verification?.conflicts && verification.conflicts.length > 0) {
      lines.push(`## ⚠️ 冲突信息\n`);
      for (const conflict of verification.conflicts) {
        lines.push(`- ${conflict.claim}`);
      }
      lines.push(``);
    }
    
    if (evaluation?.risk_notes && evaluation.risk_notes.length > 0) {
      lines.push(`## 📝 不确定性说明\n`);
      for (const note of evaluation.risk_notes) {
        lines.push(`- ${note}`);
      }
      lines.push(``);
    }
    
    lines.push(`---\n`);
    lines.push(`## 📚 参考来源\n`);
    for (const source of this.buildSourceList(evidenceItems || [])) {
      lines.push(`- ${source.title} (${source.source_type})`);
    }
    lines.push(``);
    
    return lines.join('\n');
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
        markdown_report: `# Synthesizer Agent 报告\n\n**错误**: ${error.message}`
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
    return evidenceItems.map(item => ({
      source_id: item.source_id,
      title: item.title,
      source_type: item.source_type
    }));
  }
}

// Tool Creator Agent - 负责工具创建和管理
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
      `# Tool Creator Agent 报告`,
      `**工具创建结果**: ${toolResults.length} 个工具`,
      ``
    ];

    for (const tool of toolResults) {
      lines.push(`## ${tool.name}`);
      lines.push(`- **ID**: ${tool.id}`);
      lines.push(`- **描述**: ${tool.description}`);
      lines.push(`- **参数**: ${JSON.stringify(tool.parameters || {})}`);
      lines.push(`- **状态**: ${tool.status || 'created'}`);
      lines.push(``);
    }

    return lines.join('\n');
  }

  async execute(input) {
    // 如果正在处理，将请求加入队列
    if (this.isProcessing) {
      return new Promise((resolve) => {
        this.requestQueue.push({ input, resolve });
      });
    }

    this.isProcessing = true;
    try {
      const result = await this.processRequest(input);
      
      // 处理队列中的下一个请求
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
      const toolSpecs = input?.toolSpecs || input?.tools || [];
      const requestMetadata = input?.requestMetadata || {};
      const createdTools = [];
      
      for (const spec of toolSpecs) {
        const tool = this.createTool(spec, requestMetadata);
        if (tool) {
          createdTools.push(tool);
        }
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
    const random = crypto.randomBytes(8).toString('hex');
    const agentId = this.id;
    const toolId = spec.id || `tool_${agentId}_${timestamp}_${random}`;
    const implementation = spec.implementation || this.generateToolImplementation(spec);
    
    const toolDefinition = {
      id: toolId,
      base_tool_id: spec.base_tool_id || spec.id || toolId,
      name: spec.name || `Tool ${toolId}`,
      description: spec.description || 'Generated tool',
      parameters: spec.parameters || [],
      execute: implementation,
      source: spec.source || "dynamic"
    };
    
    // 注册工具
    if (typeof ToolRegistry.registerTool === 'function') {
      ToolRegistry.registerTool(toolDefinition);
    }
    
    return {
      ...toolDefinition,
      status: 'created',
      version: spec.version || "1.0.0",
      created_by: agentId,
      created_for: requestMetadata.requester || spec.created_for || null,
      request_id: requestMetadata.request_id || null,
      created_at: new Date().toISOString()
    };
  }

  normalizeToolCreationRequest(message) {
    const content = message?.content || {};
    const toolSpecs = Array.isArray(content.tool_specs)
      ? content.tool_specs
      : Array.isArray(content.toolSpecs)
        ? content.toolSpecs
        : [];
    return {
      toolSpecs,
      requestMetadata: {
        request_id: message?.metadata?.request_id || null,
        requester: message?.sender || content.requester || null,
        purpose: content.purpose || null
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
          markdown_report: result.result?.markdown_report || ""
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
    // 基于规范生成工具实现
    return async function toolImplementation(input) {
      // 生成的工具实现逻辑
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

// Tool Creator Agent 池
class ToolCreatorPool {
  constructor(agentSystem, poolSize = 2) {
    this.agents = [];
    this.currentIndex = 0;
    this.agentSystem = agentSystem;
    
    // 创建指定数量的 Tool Creator Agent
    for (let i = 0; i < poolSize; i++) {
      const agent = agentSystem.createAgent(AgentType.TOOL_CREATOR, {
        id: `tool_creator_${i}`,
        name: `Tool Creator ${i}`
      });
      this.agents.push(agent);
    }
  }
  
  // 轮询选择 Agent
  getNextAgent() {
    const agent = this.agents[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.agents.length;
    return agent;
  }
  
  // 执行工具创建请求
  async execute(toolSpecs) {
    const agent = this.getNextAgent();
    return await agent.execute({ toolSpecs });
  }
  
  // 获取所有 Agent
  getAgents() {
    return this.agents;
  }
  
  // 获取池状态
  getStatus() {
    return {
      poolSize: this.agents.length,
      agents: this.agents.map(agent => ({
        id: agent.id,
        status: agent.status,
        queueLength: agent.requestQueue?.length || 0
      }))
    };
  }
}

// Agent 工厂函数
function createAgent(type, config = {}) {
  const baseConfig = {
    ...config,
    id: config.id || type,
    name: config.name || type,
    prompt: config.prompt || ''
  };

  switch (type) {
    case AgentType.SUPERVISOR:
      return new SupervisorAgent(baseConfig);
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
    case AgentType.SYNTHESIZER:
      return new SynthesizerAgent(baseConfig);
    case AgentType.TOOL_CREATOR:
      return new ToolCreatorAgent(baseConfig);
    default:
      throw new Error(`Unknown agent type: ${type}`);
  }
}

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

// 状态机工作流引擎
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
          status: 'success',
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
        
        // 故障恢复策略
        if (this.recoveryStrategy) {
          const recoveryResult = await this.recoveryStrategy(currentNode, error, state);
          if (recoveryResult.success) {
            state = recoveryResult.state;
            state.workflowState.executionHistory.push({
              node: currentNode,
              status: 'recovered',
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

  // 设置故障恢复策略
  setRecoveryStrategy(strategy) {
    this.recoveryStrategy = strategy;
  }
}

// 工作流定义
function createResearchWorkflow() {
  const workflow = new StateGraph();
  
  // 添加节点
  workflow.addNode('plan', async (state) => {
    const supervisor = state.agentSystem.getAgent(AgentType.SUPERVISOR);
    const plan = await supervisor.planTask(state.question, state.context);
    return {
      state_patch: { plan },
      node_result: {
        agent: AgentType.SUPERVISOR,
        type: "planning",
        summary: `Planned ${plan?.sub_questions?.length || 0} sub-questions.`,
        outputs: {
          sub_question_count: plan?.sub_questions?.length || 0,
          needed_agents: plan?.needed_agents || plan?.agents_needed || []
        }
      },
      handoff: {
        from: AgentType.SUPERVISOR,
        to: AgentType.WEB_RESEARCHER,
        reason: "Research plan is ready for discovery.",
        artifact: "plan"
      }
    };
  });

  workflow.addNode('search', async (state) => {
    const webResearcher = state.agentSystem.getAgent(AgentType.WEB_RESEARCHER);
    const searchResult = await webResearcher.execute({
      query: state.question,
      connectorIds: state.plan?.source_strategy || ['web']
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

  workflow.addNode('analyze', async (state) => {
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

  workflow.addNode('verify', async (state) => {
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
        to: AgentType.SYNTHESIZER,
        reason: "Verified evidence is ready for synthesis.",
        artifact: "verificationResult"
      }
    };
  });

  workflow.addNode('synthesize', async (state) => {
    const synthesizer = state.agentSystem.getAgent(AgentType.SYNTHESIZER);
    const synthesisResult = await synthesizer.execute({
      question: state.question,
      evidenceItems: state.analysisResult?.result?.reads || [],
      verification: state.verificationResult?.result,
      evaluation: { is_sufficient: true, risk_notes: [] },
      agentReports: {
        web_researcher: state.searchResult?.result?.markdown_report || '',
        long_text_collector: state.analysisResult?.result?.markdown_report || '',
        fact_verifier: state.verificationResult?.result?.markdown_report || ''
      }
    });
    return {
      state_patch: { synthesisResult },
      node_result: {
        agent: AgentType.SYNTHESIZER,
        type: "synthesis",
        summary: "Final answer assembled from verified evidence.",
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

  // 添加边
  workflow.addEdge('plan', 'search');
  workflow.addEdge('search', 'analyze');
  workflow.addEdge('analyze', 'verify');
  workflow.addEdge('verify', 'synthesize');
  
  // 设置起始节点
  workflow.setStartNode('plan');
  
  return workflow;
}

// Agent 管理系统
class AgentSystem {
  constructor() {
    this.agents = new Map();
    this.workflows = new Map();
    this.taskHistory = [];
    this.agentManager = new AgentManager();
    this.toolCreatorPool = null;
    this.boundToolCreationHandler = null;
    this.initializeAgents();
    this.initializeWorkflows();
    this.initializeAgentManager();
    this.initializeToolCreatorPool();
    this.initializeCommunicationProtocols();
  }

  initializeAgents() {
    const agentTypes = [
      AgentType.SUPERVISOR,
      AgentType.WEB_RESEARCHER,
      AgentType.LONG_TEXT_COLLECTOR,
      AgentType.VIDEO_PARSER,
      AgentType.CHART_PARSER,
      AgentType.TABLE_PARSER,
      AgentType.FACT_VERIFIER,
      AgentType.SYNTHESIZER,
      AgentType.TOOL_CREATOR
    ];

    for (const type of agentTypes) {
      this.agents.set(type, createAgent(type));
    }
  }

  initializeToolCreatorPool(poolSize = 2) {
    this.toolCreatorPool = new ToolCreatorPool(this, poolSize);
  }

  getToolCreatorPool() {
    return this.toolCreatorPool;
  }

  initializeCommunicationProtocols() {
    const toolCreator = this.getAgent(AgentType.TOOL_CREATOR);
    if (!toolCreator) {
      return;
    }

    this.boundToolCreationHandler = async (message) => {
      if (message.type !== 'request') {
        return;
      }
      if (message.content?.request_type !== 'tool_creation') {
        return;
      }
      if (message.metadata?._tool_creation_handled) {
        return;
      }
      message.metadata._tool_creation_handled = true;
      await toolCreator.handleToolCreationRequest(message);
    };

    agentCommunication.subscribe(AgentType.TOOL_CREATOR, this.boundToolCreationHandler);
  }

  async createTool(toolSpec) {
    if (this.toolCreatorPool) {
      return await this.toolCreatorPool.execute([toolSpec]);
    }
    
    // 回退到单个 Tool Creator Agent
    const toolCreator = this.getAgent(AgentType.TOOL_CREATOR);
    return await toolCreator.execute({ toolSpecs: [toolSpec] });
  }

  async createTools(toolSpecs) {
    if (this.toolCreatorPool) {
      return await this.toolCreatorPool.execute(toolSpecs);
    }
    
    // 回退到单个 Tool Creator Agent
    const toolCreator = this.getAgent(AgentType.TOOL_CREATOR);
    return await toolCreator.execute({ toolSpecs });
  }

  async requestToolCreation(requester, toolSpecs, metadata = {}) {
    const { response } = await agentCommunication.requestToolCreation(
      requester,
      AgentType.TOOL_CREATOR,
      toolSpecs,
      metadata
    );
    return response.content;
  }

  respondToolCreation(sender, receiver, requestId, payload, metadata = {}) {
    return agentCommunication.respondToolCreation(sender, receiver, requestId, payload, metadata);
  }

  getToolHistory(toolId) {
    return ToolRegistry.getToolHistory(toolId);
  }

  deprecateTool(toolId, reason = "deprecated_by_agent_system") {
    return ToolRegistry.deprecateTool(toolId, reason);
  }

  rollbackTool(toolId, targetToolId = null) {
    return ToolRegistry.rollbackTool(toolId, targetToolId);
  }

  promoteTool(toolId, reason = "promoted_by_agent_system") {
    return ToolRegistry.promoteTool(toolId, reason);
  }

  resolveToolForTask(taskSpec = {}) {
    return ToolRegistry.resolveToolForTask(taskSpec);
  }

  initializeWorkflows() {
    this.workflows.set('research', createResearchWorkflow());
  }

  initializeAgentManager() {
    // 注册Agent类型
    this.agentManager.registerAgentType(AgentType.WEB_RESEARCHER, (config) => {
      return new BaseAgent({
        id: `web_researcher_${Date.now()}`,
        type: AgentType.WEB_RESEARCHER,
        name: 'Web Researcher',
        ...config
      });
    });
    
    this.agentManager.registerAgentType(AgentType.LONG_TEXT_COLLECTOR, (config) => {
      return new BaseAgent({
        id: `long_text_collector_${Date.now()}`,
        type: AgentType.LONG_TEXT_COLLECTOR,
        name: 'Long Text Collector',
        ...config
      });
    });
    
    this.agentManager.registerAgentType(AgentType.VIDEO_PARSER, (config) => {
      return new BaseAgent({
        id: `video_parser_${Date.now()}`,
        type: AgentType.VIDEO_PARSER,
        name: 'Video Parser',
        ...config
      });
    });

    this.agentManager.registerAgentType(AgentType.CHART_PARSER, (config) => {
      return new BaseAgent({
        id: `chart_parser_${Date.now()}`,
        type: AgentType.CHART_PARSER,
        name: 'Chart Parser',
        ...config
      });
    });

    this.agentManager.registerAgentType(AgentType.TABLE_PARSER, (config) => {
      return new BaseAgent({
        id: `table_parser_${Date.now()}`,
        type: AgentType.TABLE_PARSER,
        name: 'Table Parser',
        ...config
      });
    });
    
    this.agentManager.registerAgentType(AgentType.FACT_VERIFIER, (config) => {
      return new BaseAgent({
        id: `fact_verifier_${Date.now()}`,
        type: AgentType.FACT_VERIFIER,
        name: 'Fact Verifier',
        ...config
      });
    });
    
    this.agentManager.registerAgentType(AgentType.SYNTHESIZER, (config) => {
      return new BaseAgent({
        id: `synthesizer_${Date.now()}`,
        type: AgentType.SYNTHESIZER,
        name: 'Synthesizer',
        ...config
      });
    });
    
    this.agentManager.registerAgentType(AgentType.TOOL_CREATOR, (config) => {
      return new ToolCreatorAgent({
        id: `tool_creator_${Date.now()}`,
        type: AgentType.TOOL_CREATOR,
        name: 'Tool Creator',
        ...config
      });
    });
  }

  getAgent(type) {
    return this.agents.get(type);
  }

  getAllAgents() {
    return Array.from(this.agents.values()).map(agent => ({
      id: agent.id,
      type: agent.type,
      name: agent.name,
      status: agent.status
    }));
  }

  async executeWorkflow(workflowId, initialState) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const state = {
      ...initialState,
      agentSystem: this
    };

    return await workflow.run(state);
  }

  getSystemStatus() {
    const agents = Array.from(this.agents.values());
    const activeAgents = agents.filter(a => a.status === AgentStatus.RUNNING);
    const completedAgents = agents.filter(a => a.status === AgentStatus.COMPLETED);
    const failedAgents = agents.filter(a => a.status === AgentStatus.FAILED);
    
    return {
      agents: this.getAllAgents(),
      totalTasks: this.taskHistory.length,
      activeAgents: activeAgents.length,
      completedAgents: completedAgents.length,
      failedAgents: failedAgents.length,
      workflows: Array.from(this.workflows.keys()),
      systemHealth: this.getSystemHealth(),
      performanceMetrics: this.getPerformanceMetrics()
    };
  }

  // 系统健康检查
  getSystemHealth() {
    const agents = Array.from(this.agents.values());
    const failedAgents = agents.filter(a => a.status === AgentStatus.FAILED);
    const totalAgents = agents.length;
    const failureRate = totalAgents > 0 ? failedAgents.length / totalAgents : 0;
    
    let status = 'healthy';
    if (failureRate > 0.5) {
      status = 'critical';
    } else if (failureRate > 0.2) {
      status = 'warning';
    }
    
    return {
      status,
      failureRate: Number(failureRate.toFixed(2)),
      totalAgents,
      failedAgents: failedAgents.length,
      timestamp: Date.now()
    };
  }

  // 性能指标
  getPerformanceMetrics() {
    const agents = Array.from(this.agents.values());
    const completedAgents = agents.filter(a => a.status === AgentStatus.COMPLETED);
    const executionTimes = completedAgents.map(a => a.executionTime).filter(Boolean);
    
    const avgExecutionTime = executionTimes.length > 0 
      ? executionTimes.reduce((sum, time) => sum + time, 0) / executionTimes.length 
      : 0;
    
    return {
      averageExecutionTime: Number(avgExecutionTime.toFixed(2)),
      completedTasks: completedAgents.length,
      totalAgents: agents.length,
      timestamp: Date.now()
    };
  }

  // 监控Agent状态
  monitorAgentStatus() {
    const agents = Array.from(this.agents.values());
    const statusReport = {
      timestamp: Date.now(),
      agents: agents.map(agent => ({
        id: agent.id,
        type: agent.type,
        status: agent.status,
        lastSuccessTime: agent.lastSuccessTime,
        lastFailureTime: agent.lastFailureTime,
        executionTime: agent.executionTime
      }))
    };
    
    console.log('Agent Status Monitor:', statusReport);
    return statusReport;
  }

  // 故障恢复
  async recoverFromFailure(agentId, error) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, message: 'Agent not found' };
    }
    
    console.log(`Attempting to recover agent ${agentId} from error: ${error.message}`);
    
    try {
      agent.reset();
      return { success: true, message: 'Agent reset successfully' };
    } catch (recoveryError) {
      return { success: false, message: `Recovery failed: ${recoveryError.message}` };
    }
  }

  // 状态持久化
  async saveSystemState() {
    const state = {
      agents: Array.from(this.agents.entries()).map(([id, agent]) => ({
        id,
        type: agent.type,
        status: agent.status,
        lastSuccessTime: agent.lastSuccessTime,
        lastFailureTime: agent.lastFailureTime
      })),
      taskHistory: this.taskHistory,
      workflows: Array.from(this.workflows.keys()),
      timestamp: Date.now()
    };
    
    return await statePersistence.saveState('system', state);
  }

  // 加载系统状态
  async loadSystemState() {
    const result = await statePersistence.loadState('system');
    if (result.success) {
      console.log('System state loaded successfully');
      return result.data;
    }
    return null;
  }

  // 保存会话状态
  async saveSession(sessionId, sessionData) {
    return await statePersistence.saveSession(sessionId, sessionData);
  }

  // 加载会话状态
  async loadSession(sessionId) {
    const result = await statePersistence.loadSession(sessionId);
    if (result.success) {
      console.log(`Session ${sessionId} loaded successfully`);
      return result.data;
    }
    return null;
  }

  // 保存Agent状态
  async saveAgentState(agentId, additionalState = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, message: 'Agent not found' };
    }
    
    const state = {
      id: agent.id,
      type: agent.type,
      status: agent.status,
      lastSuccessTime: agent.lastSuccessTime,
      lastFailureTime: agent.lastFailureTime,
      executionTime: agent.executionTime,
      ...additionalState
    };
    
    return await statePersistence.saveAgentState(agentId, state);
  }

  // 加载Agent状态
  async loadAgentState(agentId) {
    const result = await statePersistence.loadAgentState(agentId);
    if (result.success) {
      console.log(`Agent ${agentId} state loaded successfully`);
      return result.data;
    }
    return null;
  }

  // 列出所有保存的状态
  listSavedStates() {
    return statePersistence.listStates();
  }

  // Agent通信
  sendMessage(sender, receiver, type, content, metadata = {}) {
    return agentCommunication.sendMessage(sender, receiver, type, content, metadata);
  }

  // 发送请求
  sendRequest(sender, receiver, content, metadata = {}) {
    return agentCommunication.sendRequest(sender, receiver, content, metadata);
  }

  // 发送响应
  sendResponse(sender, receiver, content, metadata = {}) {
    return agentCommunication.sendResponse(sender, receiver, content, metadata);
  }

  // 发送通知
  sendNotification(sender, receiver, content, metadata = {}) {
    return agentCommunication.sendNotification(sender, receiver, content, metadata);
  }

  // 发送错误
  sendError(sender, receiver, content, metadata = {}) {
    return agentCommunication.sendError(sender, receiver, content, metadata);
  }

  // 订阅角色消息
  subscribe(role, callback) {
    agentCommunication.subscribe(role, callback);
  }

  // 取消订阅
  unsubscribe(role, callback) {
    agentCommunication.unsubscribe(role, callback);
  }

  // 获取消息历史
  getMessageHistory() {
    return agentCommunication.getMessageHistory();
  }

  // 获取消息统计
  getMessageStats() {
    return agentCommunication.getMessageStats();
  }

  // 清理消息历史
  clearMessageHistory() {
    agentCommunication.clearMessageHistory();
  }

  // 知识共享
  shareKnowledge(source, content, tags = [], confidence = 0.8) {
    return knowledgeSharingSystem.shareKnowledge(source, content, tags, confidence);
  }

  // 获取知识
  getKnowledge(id) {
    return knowledgeSharingSystem.getKnowledge(id);
  }

  // 搜索知识
  searchKnowledge(query, tags = []) {
    return knowledgeSharingSystem.searchKnowledge(query, tags);
  }

  // 解决冲突
  resolveConflict(conflictId, resolution) {
    return knowledgeSharingSystem.resolveConflict(conflictId, resolution);
  }

  // 获取冲突
  getConflicts() {
    return knowledgeSharingSystem.getConflicts();
  }

  // 获取未解决的冲突
  getUnresolvedConflicts() {
    return knowledgeSharingSystem.getUnresolvedConflicts();
  }

  // 获取知识统计
  getKnowledgeStats() {
    return knowledgeSharingSystem.getKnowledgeStats();
  }

  // 清理过期知识
  cleanupOldKnowledge(maxAge) {
    return knowledgeSharingSystem.cleanupOldKnowledge(maxAge);
  }

  // 动态创建Agent
  createAgent(type, config = {}) {
    const agent = this.agentManager.createAgent(type, config);
    this.agents.set(agent.id, agent);
    return agent;
  }

  // 销毁Agent
  destroyAgent(agentId) {
    return this.agentManager.destroyAgent(agentId);
  }

  // 分配任务
  assignTask(taskType, content, priority = 'medium', metadata = {}) {
    const task = new Task(null, taskType, content, priority, metadata);
    const result = this.agentManager.assignTask(task);
    
    if (result.success) {
      task.assignTo(result.agentId);
      this.taskHistory.push(task);
    }
    
    return {
      ...result,
      task
    };
  }

  // 完成任务
  completeTask(agentId, taskId, result) {
    const success = this.agentManager.completeTask(agentId, taskId);
    if (success) {
      const task = this.taskHistory.find(t => t.id === taskId);
      if (task) {
        task.complete(result);
      }
    }
    return success;
  }

  // 获取Agent状态
  getAgentStatus() {
    return this.agentManager.getAgentStatus();
  }

  // 动态调整Agent池
  adjustAgentPool() {
    this.agentManager.adjustAgentPool();
  }

  // 获取Agent管理器
  getAgentManager() {
    return this.agentManager;
  }

  // 分析文本数据
  analyzeText(data, options = {}) {
    return dataAnalyzer.analyzeText(data, options);
  }

  // 分析结构化数据
  analyzeStructuredData(data, options = {}) {
    return dataAnalyzer.analyzeStructuredData(data, options);
  }

  // 分析研究数据
  analyzeResearchData(researchData, options = {}) {
    return dataAnalyzer.analyzeResearchData(researchData, options);
  }

  // 获取分析历史
  getAnalysisHistory() {
    return dataAnalyzer.getAnalysisHistory();
  }

  // 清理分析历史
  clearAnalysisHistory() {
    dataAnalyzer.clearAnalysisHistory();
  }

  // 创建研究任务
  createResearchTask(id, title, description, priority = 'medium') {
    return researchProgressTracker.createTask(id, title, description, priority);
  }

  // 更新任务状态
  updateTaskStatus(id, status) {
    return researchProgressTracker.updateTaskStatus(id, status);
  }

  // 更新任务进度
  updateTaskProgress(id, progress) {
    return researchProgressTracker.updateTaskProgress(id, progress);
  }

  // 添加任务步骤
  addTaskStep(id, step) {
    return researchProgressTracker.addTaskStep(id, step);
  }

  // 更新步骤状态
  updateStepStatus(taskId, stepId, status) {
    return researchProgressTracker.updateStepStatus(taskId, stepId, status);
  }

  // 获取任务
  getResearchTask(id) {
    return researchProgressTracker.getTask(id);
  }

  // 获取所有研究任务
  getAllResearchTasks() {
    return researchProgressTracker.getAllTasks();
  }

  // 获取任务统计
  getTaskStats() {
    return researchProgressTracker.getTaskStats();
  }

  // 删除任务
  deleteResearchTask(id) {
    return researchProgressTracker.deleteTask(id);
  }

  // 清理完成的任务
  cleanupCompletedTasks() {
    return researchProgressTracker.cleanupCompletedTasks();
  }

  // 智能搜索查询生成
  generateSearchQueries(question, options = {}) {
    return smartInformationRetriever.generateSearchQueries(question, options);
  }

  // 智能搜索结果筛选
  filterSearchResults(results, options = {}) {
    return smartInformationRetriever.filterSearchResults(results, options);
  }

  // 执行智能搜索
  async executeSmartSearch(query, options = {}) {
    return smartInformationRetriever.executeSmartSearch(query, options);
  }

  // 批量处理搜索结果
  batchProcessResults(results, options = {}) {
    return smartInformationRetriever.batchProcessResults(results, options);
  }

  // 获取搜索历史
  getSearchHistory() {
    return smartInformationRetriever.getSearchHistory();
  }

  // 清理搜索历史
  clearSearchHistory() {
    smartInformationRetriever.clearSearchHistory();
  }

  // 动态注册工作流
  registerWorkflow(id, workflow) {
    this.workflows.set(id, workflow);
  }

  // 动态创建Agent
  createAndRegisterAgent(type, config) {
    const agent = createAgent(type, config);
    this.agents.set(config.id || type, agent);
    return agent;
  }
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    const current = map.get(key);
    if (!current || (item.score || 0) > (current.score || 0)) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

function buildToolCreationGoal(candidate, error) {
  const contentType = candidate.content_type || candidate.source_type || "web";
  return `Recover a failed ${contentType} read for ${candidate.url} after ${error.message}`;
}

function buildToolCreationConstraints(candidate, error) {
  return [
    "Use the existing ephemeral tooling execution path.",
    "Return a normalized read object compatible with createEvidenceUnit.",
    `Target connector: ${candidate.connector || "unknown"}`,
    `Original failure: ${error.message}`
  ];
}

function createRecoveredRead(candidate, execution, toolId) {
  const data = execution.extracted_data || {};
  const contentType = candidate.content_type || candidate.source_type || "web";
  const timeline = data.timeline || [];
  const transcript = data.transcript || [];
  const keyPoints = data.key_points || data.paragraphs || [];
  const markdown = data.markdown || [
    `# ${data.title || candidate.title || "Recovered source"}`,
    data.description || "",
    ...(data.paragraphs || [])
  ].filter(Boolean).join("\n\n");

  return {
    source_id: candidate.id,
    content_type: contentType,
    source_type: contentType,
    tool: toolId,
    title: data.title || candidate.title,
    url: candidate.url,
    author: data.author || candidate.author || null,
    published_at: data.published_at || candidate.published_at || null,
    duration: data.duration || null,
    markdown,
    timeline,
    transcript,
    key_points: keyPoints.slice(0, 6),
    key_frames: data.key_frames || timeline.slice(0, 3).map((item) => item.summary || item.title).filter(Boolean),
    facts: []
  };
}

async function attemptToolCreationRecovery(agent, candidate, error, telemetry, runtime = null, runtimeTask = null) {
  const agentSystem = telemetry?.agent_system;
  if (!agentSystem || typeof agentSystem.requestToolCreation !== "function") {
    return null;
  }

  const toolSpec = {
    name: `Recovery Tool ${candidate.connector || agent}`,
    description: `Recover failed ${candidate.content_type || candidate.source_type || "source"} reads for ${candidate.url}`,
    parameters: [
      {
        name: "candidate",
        type: "object",
        required: true,
        description: "Source candidate requiring recovery"
      }
    ],
    implementation: async (input) => {
      const targetCandidate = input?.candidate || candidate;
      const tool = await synthesizeTool({
        goal: buildToolCreationGoal(targetCandidate, error),
        target: {
          url: targetCandidate.url,
          title: targetCandidate.title,
          platform: targetCandidate.platform,
          connector: targetCandidate.connector,
          content_type: targetCandidate.content_type || targetCandidate.source_type
        },
        constraints: buildToolCreationConstraints(targetCandidate, error)
      });
      const execution = await runEphemeralTool(tool, {
        timeout_ms: 15000,
        network: true
      });
      if (!execution.success) {
        throw new Error(execution.error || "recovery tool failed");
      }
      return createRecoveredRead(targetCandidate, execution, tool.tool_id);
    }
  };

  const response = await agentSystem.requestToolCreation(agent, [toolSpec], {
    purpose: `Recover failed source read for ${candidate.url}`,
    timeout_ms: 15000
  });

  const createdTool = response?.tools?.[0];
  if (!createdTool?.id) {
    return null;
  }

  telemetry.tool_creation_requests = telemetry.tool_creation_requests || [];
  telemetry.tool_creation_requests.push({
    agent,
    candidate_id: candidate.id,
    tool_id: createdTool.id,
    created_for: createdTool.created_for,
    request_id: createdTool.request_id
  });

  const recoveryExecution = await ToolRegistry.executeTool(createdTool.id, { candidate });
  if (!recoveryExecution.success) {
    throw new Error(recoveryExecution.error?.message || "tool-created recovery failed");
  }

  if (runtimeTask) {
    completeAgentTask(runtime, runtimeTask.id, {
      source_id: candidate.id,
      tool: createdTool.id,
      recovered_via: "tool_creation_request"
    });
  }

  return {
    candidate,
    read: recoveryExecution.data,
    recovered_by: createdTool.id
  };
}

function createRuntimeTaskId(agentId, taskType) {
  return `${agentId}:${taskType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function createAgentRuntime(agentRegistry) {
  const agents = {};
  for (const [agentId, config] of Object.entries(agentRegistry || {})) {
    agents[agentId] = {
      id: config.id || agentId,
      prompt: config.prompt || "",
      status: AgentStatus.IDLE,
      current_task_id: null,
      inbox: [],
      outbox: [],
      completed_tasks: 0,
      failed_tasks: 0,
      last_result: null,
      last_error: null,
      last_updated_at: new Date().toISOString()
    };
  }

  return {
    agents,
    tasks: [],
    messages: []
  };
}

function pushRuntimeMessage(runtime, message) {
  const entry = {
    id: `msg:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...message
  };
  runtime.messages.push(entry);

  if (entry.to && runtime.agents[entry.to]) {
    runtime.agents[entry.to].inbox.push(entry);
    runtime.agents[entry.to].last_updated_at = entry.at;
  }
  if (entry.from && runtime.agents[entry.from]) {
    runtime.agents[entry.from].outbox.push(entry);
    runtime.agents[entry.from].last_updated_at = entry.at;
  }

  return entry;
}

function dispatchAgentTask(runtime, { from = "supervisor", agentId, taskType, input = null, metadata = {} }) {
  if (!runtime?.agents?.[agentId]) {
    throw new Error(`Unknown runtime agent: ${agentId}`);
  }

  const task = {
    id: createRuntimeTaskId(agentId, taskType),
    agent_id: agentId,
    from,
    task_type: taskType,
    status: "running",
    input,
    metadata,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    result: null,
    error: null
  };

  runtime.tasks.push(task);
  runtime.agents[agentId].status = AgentStatus.RUNNING;
  runtime.agents[agentId].current_task_id = task.id;
  runtime.agents[agentId].last_error = null;
  runtime.agents[agentId].last_updated_at = task.updated_at;

  pushRuntimeMessage(runtime, {
    type: "task_dispatched",
    from,
    to: agentId,
    task_id: task.id,
    task_type: taskType,
    metadata
  });

  return task;
}

function completeAgentTask(runtime, taskId, result = null, metadata = {}) {
  const task = runtime?.tasks?.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`Unknown runtime task: ${taskId}`);
  }

  task.status = "completed";
  task.result = result;
  task.metadata = { ...task.metadata, ...metadata };
  task.updated_at = new Date().toISOString();

  const agent = runtime.agents[task.agent_id];
  agent.status = AgentStatus.COMPLETED;
  agent.current_task_id = null;
  agent.completed_tasks += 1;
  agent.last_result = result;
  agent.last_updated_at = task.updated_at;

  pushRuntimeMessage(runtime, {
    type: "task_completed",
    from: task.agent_id,
    to: task.from,
    task_id: task.id,
    task_type: task.task_type,
    metadata
  });

  return task;
}

function failAgentTask(runtime, taskId, error, metadata = {}) {
  const task = runtime?.tasks?.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`Unknown runtime task: ${taskId}`);
  }

  task.status = "failed";
  task.error = typeof error === "string" ? error : error?.message || "unknown error";
  task.metadata = { ...task.metadata, ...metadata };
  task.updated_at = new Date().toISOString();

  const agent = runtime.agents[task.agent_id];
  agent.status = AgentStatus.FAILED;
  agent.current_task_id = null;
  agent.failed_tasks += 1;
  agent.last_error = task.error;
  agent.last_updated_at = task.updated_at;

  pushRuntimeMessage(runtime, {
    type: "task_failed",
    from: task.agent_id,
    to: task.from,
    task_id: task.id,
    task_type: task.task_type,
    metadata: {
      ...metadata,
      error: task.error
    }
  });

  return task;
}

function getAgentRuntimeSnapshot(runtime) {
  return {
    tasks: runtime.tasks.map((task) => ({
      id: task.id,
      agent_id: task.agent_id,
      from: task.from,
      task_type: task.task_type,
      status: task.status,
      created_at: task.created_at,
      updated_at: task.updated_at,
      metadata: task.metadata
    })),
    agents: Object.values(runtime.agents).map((agent) => ({
      id: agent.id,
      status: agent.status,
      current_task_id: agent.current_task_id,
      completed_tasks: agent.completed_tasks,
      failed_tasks: agent.failed_tasks,
      inbox_count: agent.inbox.length,
      outbox_count: agent.outbox.length,
      last_updated_at: agent.last_updated_at
    })),
    messages: runtime.messages.slice(-30)
  };
}

function isChartHeavyCandidate(candidate) {
  const contentType = candidate.content_type || candidate.source_type;
  if (contentType !== "document") {
    return false;
  }

  const documentKind = String(candidate.metadata?.mime_type || candidate.metadata?.content_type || candidate.url || "").toLowerCase();
  if (/pdf|xlsx|xls|spreadsheet|chart|dashboard/.test(documentKind)) {
    return true;
  }
  if (candidate.metadata?.page_images?.length || candidate.metadata?.preview_image) {
    return true;
  }

  const blob = `${candidate.title || ""} ${candidate.summary || ""}`.toLowerCase();
  return /chart|graph|figure|dashboard|tableau|plot|trend/.test(blob);
}

function routeCandidate(candidate) {
  const contentType = candidate.content_type || candidate.source_type;
  if (contentType === "video") {
    return "video_parser";
  }
  if (contentType === "forum") {
    return "fact_verifier";
  }
  if (isChartHeavyCandidate(candidate)) {
    return "chart_parser";
  }
  return "long_text_collector";
}

function collectorToolForCandidate(candidate) {
  const agent = routeCandidate(candidate);
  if (agent === "video_parser") {
    return "extract_video_intel";
  }
  if (agent === "chart_parser") {
    return "read_document_intel";
  }
  return "deep_read_page";
}

function collectorCapabilityForTask(agent, candidate) {
  if (agent === "video_parser") {
    return "parse_video";
  }
  if (agent === "chart_parser") {
    return "parse_chart_document";
  }
  if (agent === "table_parser") {
    return "parse_table";
  }
  if (agent === "fact_verifier") {
    return "verify_facts";
  }

  const contentType = candidate?.content_type || candidate?.source_type;
  if (contentType === "document") {
    return "read_document";
  }
  return "read_web_page";
}

function mergeUniqueStrings(values, limit = 6) {
  return Array.from(new Set((values || []).filter(Boolean))).slice(0, limit);
}

function buildTableFacts(tableData, sourceId, subjectHint) {
  const rows = tableData?.rows || [];
  const headers = tableData?.headers || Object.keys(rows[0] || {});

  return rows.slice(0, 5).map((row, index) => ({
    source_id: sourceId,
    subject: subjectHint,
    kind: "table_row",
    claim: `Table row ${index + 1}: ${headers.map((header) => `${header}=${row[header] || ""}`).join(", ")}`,
    value: null,
    unit: null,
    evidence: JSON.stringify(row)
  }));
}

function buildDocumentTaskToolInput(candidate, baseRead, task) {
  return {
    candidate,
    read: baseRead,
    markdown: baseRead.markdown,
    page_images: baseRead.page_images || [],
    table_data: baseRead.table_data || null,
    layout_task: task
  };
}

function resolveDocumentTaskPreferredTool(task, baseRead) {
  if (task.agent === "chart_parser" && (baseRead.page_images?.length || baseRead.visual_observations?.length)) {
    return "analyze_document_multimodal";
  }
  return "read_document_intel";
}

function buildTaskScopedRead(baseRead, candidate, task, toolId, toolData = null) {
  const taskId = task?.task_id || `${candidate.id}:${task.agent}`;
  const pageLabel = Array.isArray(task?.pages) ? task.pages.join("-") : "unknown";
  const toolResult = toolData && typeof toolData === "object" ? toolData : {};
  const sharedBase = {
    ...baseRead,
    tool: toolId || baseRead.tool,
    parent_source_id: candidate.id,
    segment_pages: task.pages || [],
    parser_task_id: taskId
  };

  if (task.agent === "table_parser") {
    const tableData = toolResult.table_data || baseRead.table_data || { headers: [], rows: [] };
    const tableRows = tableData.rows || [];
    const headers = tableData.headers || Object.keys(tableRows[0] || {});
    return {
      ...sharedBase,
      source_id: `${candidate.id}::table::${pageLabel}`,
      title: `${candidate.title} Table Segment`,
      markdown: [
        `# Table Segment`,
        "",
        `Pages: ${pageLabel}`,
        "",
        `Columns: ${headers.join(", ") || "none"}`,
        "",
        JSON.stringify(tableRows.slice(0, 10), null, 2)
      ].join("\n"),
      key_points: mergeUniqueStrings([
        `Extracted ${tableRows.length} table rows`,
        ...(headers.length ? [`Columns: ${headers.join(", ")}`] : [])
      ]),
      sections: [
        {
          heading: "Table Segment",
          excerpt: `Extracted ${tableRows.length} rows from pages ${pageLabel}.`
        }
      ],
      table_data: tableData,
      facts: buildTableFacts(tableData, `${candidate.id}::table::${pageLabel}`, candidate.title || "document table"),
      visual_observations: [],
      page_images: [],
      parser_agent: "table_parser"
    };
  }

  if (task.agent === "chart_parser") {
    const visualObservations = mergeUniqueStrings([
      ...(toolResult.visual_observations || []),
      ...(baseRead.visual_observations || [])
    ], 4);
    const visualFacts = (toolResult.structured_facts || []).slice(0, 4).map((item) => ({
      source_id: `${candidate.id}::visual::${pageLabel}`,
      subject: item.subject,
      kind: "visual_document_fact",
      claim: item.claim,
      value: item.value,
      unit: item.unit || null,
      evidence: item.claim
    }));
    return {
      ...sharedBase,
      source_id: `${candidate.id}::visual::${pageLabel}`,
      title: `${candidate.title} Visual Segment`,
      markdown: [
        `# Visual Segment`,
        "",
        `Pages: ${pageLabel}`,
        "",
        ...(toolResult.summary ? [`Summary: ${toolResult.summary}`, ""] : []),
        ...visualObservations.map((item) => `- ${item}`)
      ].join("\n"),
      key_points: mergeUniqueStrings([
        ...(toolResult.key_points || []),
        ...visualObservations,
        ...(baseRead.key_points || []).slice(0, 2)
      ]),
      sections: [
        {
          heading: "Visual Segment",
          excerpt: visualObservations[0] || toolResult.summary || task.objective || "Visual evidence extracted from document layout."
        }
      ],
      facts: visualFacts,
      visual_observations: visualObservations,
      parser_agent: "chart_parser"
    };
  }

  const sections = (baseRead.sections || []).slice(0, 6);
  return {
    ...sharedBase,
    source_id: `${candidate.id}::text::${pageLabel}`,
    title: `${candidate.title} Text Segment`,
    markdown: [
      `# Text Segment`,
      "",
      `Pages: ${pageLabel}`,
      "",
      ...sections.map((section) => `## ${section.heading || "Section"}\n${section.excerpt || ""}`)
    ].join("\n"),
    key_points: mergeUniqueStrings(baseRead.key_points || [], 5),
    sections,
    facts: (baseRead.facts || []).slice(0, 6),
    visual_observations: [],
    page_images: [],
    parser_agent: "long_text_collector"
  };
}

async function runDocumentParsingTasks(candidate, telemetry, runtime, parentTask = null) {
  const baseExecution = await ToolRegistry.executeTool("read_document_intel", { candidate });
  if (!baseExecution.success) {
    throw new Error(baseExecution.error?.message || "read_document_intel failed");
  }

  const baseRead = baseExecution.data;
  const layoutExecution = await ToolRegistry.executeTool("layout_analysis", { candidate, read: baseRead });
  if (!layoutExecution.success) {
    throw new Error(layoutExecution.error?.message || "layout_analysis failed");
  }

  const layout = layoutExecution.data.layout || { task_suggestions: [] };
  const taskSuggestions = layout.task_suggestions?.length
    ? layout.task_suggestions
    : [{
        task_id: `${candidate.id}:task:text`,
        agent: "long_text_collector",
        capability: "read_document",
        pages: [1, layout.total_pages || 1],
        objective: "Summarize the document text sections and extract core claims."
      }];

  const parserResults = [];
  const routedTasks = [];
  for (const task of taskSuggestions) {
    const preferredToolId = resolveDocumentTaskPreferredTool(task, baseRead);
    const toolResolution = telemetry?.agent_system?.resolveToolForTask
      ? telemetry.agent_system.resolveToolForTask({
          agent: task.agent,
          capability: task.capability,
          candidate,
          preferred_tool_id: preferredToolId
        })
      : null;
    const toolId = toolResolution?.tool_id || preferredToolId;
    const runtimeTask = runtime
      ? dispatchAgentTask(runtime, {
          from: "supervisor",
          agentId: task.agent,
          taskType: `parse_document_${task.agent}`,
          input: {
            candidate,
            task
          },
          metadata: {
            source_id: candidate.id,
            pages: task.pages,
            modality: task.capability,
            tool: toolId
          }
        })
      : null;

    try {
      let taskToolData = null;
      if (toolId && toolId !== "read_document_intel") {
        const execution = await ToolRegistry.executeTool(toolId, buildDocumentTaskToolInput(candidate, baseRead, task));
        if (!execution.success) {
          throw new Error(execution.error?.message || `${toolId} failed`);
        }
        taskToolData = execution.data;
      }

      const read = buildTaskScopedRead(baseRead, candidate, task, toolId, taskToolData);
      const routedTask = {
        source_id: candidate.id,
        segment_source_id: read.source_id,
        agent: task.agent,
        tool: toolId,
        capability: task.capability,
        pages: task.pages,
        objective: task.objective,
        layout_analysis_mode: layoutExecution.data.layout_analysis_mode || "heuristic"
      };
      parserResults.push({
        candidate,
        read,
        evidence_unit: createEvidenceUnit(read, candidate),
        layout
      });
      routedTasks.push(routedTask);
      if (runtimeTask) {
        completeAgentTask(runtime, runtimeTask.id, {
          source_id: read.source_id,
          pages: task.pages,
          parser_agent: task.agent,
          tool: toolId
        });
      }
    } catch (error) {
      if (runtimeTask) {
        failAgentTask(runtime, runtimeTask.id, error, {
          source_id: candidate.id,
          parser_agent: task.agent
        });
      }
      throw error;
    }
  }

  if (parentTask) {
    completeAgentTask(runtime, parentTask.id, {
      source_id: candidate.id,
      parser_task_count: parserResults.length,
      layout_blocks: layout.blocks?.length || 0,
      layout_analysis_mode: layoutExecution.data.layout_analysis_mode || "heuristic"
    });
  }

  return {
    results: parserResults,
    layout,
    routed_tasks: routedTasks,
    layout_analysis_mode: layoutExecution.data.layout_analysis_mode || "heuristic"
  };
}

function scoreCandidateFit(candidate, question, plan) {
  let score = candidate.score || 0;
  const contentType = candidate.content_type || candidate.source_type;
  const preferred = plan.preferred_connectors || [];
  const preferredIndex = preferred.findIndex((item) => item.id === candidate.connector);

  if (preferredIndex !== -1) {
    score += Math.max(0.05, 0.24 - preferredIndex * 0.05);
  }
  if (/[\u4e00-\u9fff]/.test(question) && /segmentfault|bilibili|ithome|douyin/.test(candidate.connector || "")) {
    score += 0.1;
  }
  if (/最新|当前|发布|现在|动态|新闻/.test(question) && contentType === "web") {
    score += 0.12;
  }
  if (/教程|演讲|视频|访谈|体验|测评/.test(question) && contentType === "video") {
    score += 0.16;
  }

  return score;
}

function selectCandidates(candidates, question, plan) {
  const selected = [];
  const remaining = [...candidates].map((item) => ({
    ...item,
    selection_score: scoreCandidateFit(item, question, plan)
  }));

  while (selected.length < 4 && remaining.length) {
    const selectedConnectors = new Set(selected.map((item) => item.connector));
    const selectedContentTypes = new Set(selected.map((item) => item.content_type || item.source_type));
    const next = remaining
      .map((item) => ({
        ...item,
        final_score: item.selection_score
          + (selectedConnectors.has(item.connector) ? 0 : 0.08)
          + (selectedContentTypes.has(item.content_type || item.source_type) ? 0 : 0.05)
      }))
      .sort((left, right) => right.final_score - left.final_score)[0];

    selected.push(next);
    const index = remaining.findIndex((item) => item.url === next.url);
    if (index >= 0) {
      remaining.splice(index, 1);
    }
  }

  return selected;
}

function evaluateResearch(plan, scratchpad, evidenceUnits, verification, roundsCompleted) {
  const safeVerification = {
    confirmations: verification?.confirmations || [],
    conflicts: verification?.conflicts || [],
    coverage_gaps: verification?.coverage_gaps || []
  };
  const stopPolicy = plan.stop_policy || {};
  const sourceTypesCovered = new Set([
    ...evidenceUnits.map((item) => item.source_type).filter(Boolean),
    ...((scratchpad.sources_read || []).map((item) => item.content_type || item.source_type).filter(Boolean))
  ]);
  const overallCoverage = scoreQuestionCoverage(plan.task_goal, evidenceUnits);
  const hasEnoughDiversity = sourceTypesCovered.size >= (stopPolicy.min_source_types || 2);
  const hasEnoughEvidence = evidenceUnits.length >= (stopPolicy.min_evidence_items || 3);
  const resolvedQuestions = [];
  const missingQuestions = [];

  if (overallCoverage >= (stopPolicy.overall_coverage_threshold || 0.18) && hasEnoughDiversity && hasEnoughEvidence) {
    resolvedQuestions.push(...plan.sub_questions);
  } else {
    for (const question of plan.sub_questions) {
      const coverage = scoreQuestionCoverage(`${plan.task_goal} ${question}`, evidenceUnits);
      if (
        coverage >= (stopPolicy.sub_question_coverage_threshold || 0.18)
        || (hasEnoughEvidence && coverage >= (stopPolicy.fallback_sub_question_coverage_threshold || 0.12))
      ) {
        resolvedQuestions.push(question);
      } else {
        missingQuestions.push(question);
      }
    }
  }

  const hardConflict = safeVerification.conflicts.length > (stopPolicy.max_relevant_conflicts ?? 1);
  const isSufficient = (
    (stopPolicy.require_all_sub_questions === false ? resolvedQuestions.length > 0 : missingQuestions.length === 0)
    && hasEnoughDiversity
    && hasEnoughEvidence
    && !hardConflict
  );

  scratchpad.resolved_questions = resolvedQuestions;
  scratchpad.missing_questions = missingQuestions;
  scratchpad.conflicts_found = verification.conflicts;
  scratchpad.facts_collected = evidenceUnits.flatMap((item) => item.facts || []);

  return {
    is_sufficient: isSufficient,
    resolved_questions: resolvedQuestions,
    missing_questions: missingQuestions,
    risk_notes: [
      ...(!hasEnoughDiversity ? ["source type diversity is still insufficient"] : []),
      ...(safeVerification.conflicts.length ? ["conflicting evidence remains and must be disclosed"] : []),
      ...(safeVerification.coverage_gaps.length ? ["some conclusions still rely on a single source"] : [])
    ],
    next_best_action: isSufficient
      ? "synthesize_answer"
      : roundsCompleted >= (stopPolicy.max_rounds || 2)
        ? "stop_with_partial_answer"
        : "run_follow_up_search",
    reason: isSufficient
      ? "required questions are covered by enough evidence types"
      : "evidence is still missing, too narrow, or still conflicted",
    metrics: {
      source_types_covered: sourceTypesCovered.size,
      evidence_units: evidenceUnits.length,
      overall_coverage: Number(overallCoverage.toFixed(2)),
      conflict_count: safeVerification.conflicts.length,
      single_source_claims: safeVerification.coverage_gaps.length
    }
  };
}

function createAgentRegistry() {
  return {
    supervisor: {
      id: "supervisor",
      prompt: "Plan rounds, dispatch specialist tasks, and enforce stop policy."
    },
    web_researcher: {
      id: "web_researcher",
      prompt: "Discover breadth-first source candidates and return structured candidate cards."
    },
    video_parser: {
      id: "video_parser",
      prompt: "Parse video sources into normalized Markdown, transcripts, timelines, and key evidence."
    },
    long_text_collector: {
      id: "long_text_collector",
      prompt: "Read long-form pages or documents and return normalized Markdown evidence units."
    },
    chart_parser: {
      id: "chart_parser",
      prompt: "Parse chart-heavy documents and multimodal pages into Markdown, visual observations, and structured facts."
    },
    table_parser: {
      id: "table_parser",
      prompt: "Extract tables and spreadsheet-like evidence into normalized JSON and Markdown previews."
    },
    fact_verifier: {
      id: "fact_verifier",
      prompt: "Compare conflicting evidence and explain which source is more credible and why."
    },
    synthesizer: {
      id: "synthesizer",
      prompt: "Assemble the final evidence-backed answer with uncertainty and conflicts."
    }
  };
}

async function runWebResearcher(plan, queries, telemetry, runtime = null) {
  const startedAt = Date.now();
  const queryReports = await Promise.all(queries.map(async (query) => {
    const runtimeTask = runtime
      ? dispatchAgentTask(runtime, {
          from: "supervisor",
          agentId: "web_researcher",
          taskType: "discover_sources",
          input: { query, connector_ids: plan.chosen_connector_ids },
          metadata: { query }
        })
      : null;
    try {
      const candidates = await invokeSourceTool({
        action: "discover",
        query,
        connector_ids: plan.chosen_connector_ids
      });
      if (runtimeTask) {
        completeAgentTask(runtime, runtimeTask.id, {
          query,
          candidate_count: candidates.length
        });
      }
      return { query, candidates, error: null };
    } catch (error) {
      if (runtimeTask) {
        failAgentTask(runtime, runtimeTask.id, error, { query });
      }
      return { query, candidates: [], error };
    }
  }));

  const failures = queryReports.filter((item) => item.error);
  for (const failure of failures) {
    telemetry.failures.push({
      stage: "discover",
      query: failure.query,
      reason: failure.error.message
    });
  }

  telemetry.events.push({
    stage: "web_researcher",
    duration_ms: Date.now() - startedAt,
    query_count: queries.length,
    result_count: queryReports.reduce((total, item) => total + item.candidates.length, 0)
  });

  return dedupeBy(queryReports.flatMap((item) => item.candidates), (item) => item.url)
    .sort((left, right) => right.score - left.score);
}

async function runSpecialistReads(selected, telemetry, runtime = null) {
  const longTextCandidates = selected.filter((item) => routeCandidate(item) === "long_text_collector");
  const videoCandidates = selected.filter((item) => routeCandidate(item) === "video_parser");
  const chartCandidates = selected.filter((item) => routeCandidate(item) === "chart_parser");
  const forumCandidates = selected.filter((item) => routeCandidate(item) === "fact_verifier");

  async function readGroup(agent, candidates) {
    const startedAt = Date.now();
    const settled = await Promise.all(candidates.map(async (candidate) => {
      const taskType = agent === "video_parser"
        ? "parse_video_source"
        : agent === "chart_parser"
          ? "parse_chart_source"
          : "collect_long_text";
      const runtimeTask = runtime
        ? dispatchAgentTask(runtime, {
            from: "supervisor",
            agentId: agent,
            taskType,
            input: { candidate },
            metadata: {
              source_id: candidate.id,
              connector: candidate.connector
            }
          })
        : null;
      try {
        if ((candidate.content_type === "document" || candidate.source_type === "document") && agent !== "fact_verifier") {
          const parsed = await runDocumentParsingTasks(candidate, telemetry, runtime, runtimeTask);
          return {
            candidate,
            reads: parsed.results.map((item) => item.read),
            evidence_units: parsed.results.map((item) => item.evidence_unit),
            layout: parsed.layout,
            routed_tasks: parsed.routed_tasks || [],
            error: null
          };
        }

        const preferredToolId = collectorToolForCandidate(candidate);
        const capability = collectorCapabilityForTask(agent, candidate);
        const toolResolution = telemetry?.agent_system?.resolveToolForTask
          ? telemetry.agent_system.resolveToolForTask({
              agent,
              capability,
              candidate,
              preferred_tool_id: preferredToolId
            })
          : null;
        const toolId = toolResolution?.tool_id || preferredToolId;
        const execution = await ToolRegistry.executeTool(toolId, { candidate });
        if (!execution.success) {
          throw new Error(execution.error?.message || `${toolId} failed`);
        }
        if (runtimeTask) {
          completeAgentTask(runtime, runtimeTask.id, {
            source_id: candidate.id,
            tool: toolId,
            capability
          });
        }
        return {
          candidate,
          reads: [execution.data],
          evidence_units: [createEvidenceUnit(execution.data, candidate)],
          routed_tasks: [{
            source_id: candidate.id,
            segment_source_id: execution.data.source_id,
            agent,
            tool: toolId,
            capability,
            pages: null,
            objective: null
          }],
          error: null
        };
      } catch (error) {
        try {
          const recovered = await attemptToolCreationRecovery(agent, candidate, error, telemetry, runtime, runtimeTask);
          if (recovered?.read) {
            return {
              candidate,
              reads: [recovered.read],
              evidence_units: [createEvidenceUnit(recovered.read, candidate)],
              routed_tasks: [{
                source_id: candidate.id,
                segment_source_id: recovered.read.source_id,
                agent,
                tool: recovered.recovered_by || recovered.read.tool || collectorToolForCandidate(candidate),
                capability: collectorCapabilityForTask(agent, candidate),
                pages: null,
                objective: "Recovered after tool creation"
              }],
              error: null,
              recovered_by: recovered.recovered_by
            };
          }
        } catch (recoveryError) {
          telemetry.failures.push({
            stage: `${agent}_tool_creation_recovery`,
            query: candidate.url,
            connector: candidate.connector,
            reason: recoveryError.message
          });
        }

        if (runtimeTask) {
          failAgentTask(runtime, runtimeTask.id, error, {
            source_id: candidate.id
          });
        }
        return { candidate, read: null, error };
      }
    }));

    telemetry.events.push({
      stage: agent,
      duration_ms: Date.now() - startedAt,
      task_count: candidates.length,
      success_count: settled.filter((item) => item.reads?.length).length
    });

    for (const failure of settled.filter((item) => item.error)) {
      telemetry.failures.push({
        stage: agent,
        query: failure.candidate.url,
        connector: failure.candidate.connector,
        reason: failure.error.message
      });
    }

    return {
      results: settled
        .filter((item) => item.reads?.length)
        .flatMap((item) => item.reads.map((read, index) => ({
          candidate: item.candidate,
          read,
          evidence_unit: item.evidence_units?.[index] || createEvidenceUnit(read, item.candidate),
          layout: item.layout || null
        }))),
      routed_tasks: settled.flatMap((item) => item.routed_tasks || []),
      failures: settled
        .filter((item) => item.error)
        .map((item) => ({
          agent,
          candidate: item.candidate,
          error: item.error
        }))
    };
  }

  const [longTextReads, videoReads, chartReads, forumReads] = await Promise.all([
    readGroup("long_text_collector", longTextCandidates),
    readGroup("video_parser", videoCandidates),
    readGroup("chart_parser", chartCandidates),
    readGroup("fact_verifier", forumCandidates)
  ]);

  return {
    results: [...longTextReads.results, ...videoReads.results, ...chartReads.results, ...forumReads.results],
    routed_tasks: [...longTextReads.routed_tasks, ...videoReads.routed_tasks, ...chartReads.routed_tasks, ...forumReads.routed_tasks],
    failures: [...longTextReads.failures, ...videoReads.failures, ...chartReads.failures, ...forumReads.failures]
  };
}

async function runFactVerifierReview(verification, telemetry, runtime = null) {
  const reviewItems = [
    ...(verification?.conflicts || []).map((item) => ({ kind: "conflict", item })),
    ...(verification?.coverage_gaps || []).map((item) => ({ kind: "coverage_gap", item }))
  ];

  const tasks = reviewItems.map(({ kind, item }) => {
    const runtimeTask = runtime
      ? dispatchAgentTask(runtime, {
          from: "supervisor",
          agentId: "fact_verifier",
          taskType: "review_evidence_consistency",
          input: {
            key: item.key,
            kind,
            preferred_claim: item.preferred_fact?.claim || null
          },
          metadata: {
            kind,
            key: item.key
          }
        })
      : null;

    const resolution = {
      key: item.key,
      kind,
      preferred_source: item.comparison?.preferred_source || item.preferred_fact?.source_id || null,
      preferred_claim: item.preferred_fact?.claim || null,
      reason: item.reason,
      status: kind === "conflict" ? "needs_disclosure" : "needs_more_sources",
      competing_sources: item.comparison?.competing_sources || []
    };

    if (runtimeTask) {
      completeAgentTask(runtime, runtimeTask.id, resolution);
    }

    return resolution;
  });

  telemetry.events.push({
    stage: "fact_verifier_review",
    task_count: tasks.length,
    conflict_count: verification?.conflicts?.length || 0,
    coverage_gap_count: verification?.coverage_gaps?.length || 0
  });

  return {
    tasks,
    summary: {
      conflicts: verification?.conflicts?.length || 0,
      coverage_gaps: verification?.coverage_gaps?.length || 0,
      review_count: tasks.length
    }
  };
}

module.exports = {
  createAgentRuntime,
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentRuntimeSnapshot,
  createAgentRegistry,
  routeCandidate,
  collectorToolForCandidate,
  collectorCapabilityForTask,
  selectCandidates,
  runWebResearcher,
  runSpecialistReads,
  runFactVerifierReview,
  verifyEvidenceUnits,
  evaluateResearch,
  AgentSystem,
  createAgent,
  AgentType,
  AgentStatus,
  BaseAgent,
  SupervisorAgent,
  WebResearcherAgent,
  LongTextCollectorAgent,
  VideoParserAgent,
  ChartParserAgent,
  TableParserAgent,
  FactVerifierAgent,
  SynthesizerAgent,
  ToolCreatorAgent,
  ToolCreatorPool,
  StateGraph,
  createResearchWorkflow
};
