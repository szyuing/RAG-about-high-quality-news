const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { verifyEvidenceUnits } = require("./fact-verifier");
const { extractTextFromResponsePayload } = require("./openai-response");

// 视频转MP3和文本提取配置
const VIDEO_PROCESSING_CONFIG = {
  // ARS API配置
  arsApi: {
    enabled: process.env.ARS_API_ENABLED === "true",
    endpoint: process.env.ARS_API_ENDPOINT || "https://api.ars.example.com/transcribe",
    apiKey: process.env.ARS_API_KEY || ""
  },
  // 开源模型配置
  openSourceModel: {
    enabled: process.env.OPEN_SOURCE_MODEL_ENABLED === "true",
    endpoint: process.env.OPEN_SOURCE_MODEL_ENDPOINT || "http://localhost:8000/transcribe",
    model: process.env.OPEN_SOURCE_MODEL || "whisper-small"
  }
};

const samplePrompts = [
  "Sora 模型现在的生成时长上限是多少？相比刚发布时有哪些技术架构上的更新？",
  "苹果 2024 年发布的手机比 2023 年的在性能上提升了多少？",
  "为什么这个产品强调先规划再搜索，而不是直接搜？"
];

let sourceCatalog = [];

const TOOL_CAPABILITY_HINTS = {
  read_document_intel: [
    "read_document",
    "read_document_intel",
    "parse_pdf",
    "parse_table",
    "parse_spreadsheet",
    "parse_chart_document",
    "collect_document"
  ],
  analyze_document_multimodal: [
    "analyze_document_multimodal",
    "analyze_chart",
    "analyze_visual_document",
    "analyze_page_images"
  ],
  layout_analysis: [
    "layout_analysis",
    "analyze_document_layout",
    "document_layout_scan",
    "split_document_modalities"
  ],
  deep_read_page: [
    "read_web_page",
    "collect_long_text",
    "read_article",
    "read_page"
  ],
  extract_video_intel: [
    "parse_video",
    "extract_video_intel",
    "read_video",
    "extract_transcript"
  ],
  cross_check_facts: [
    "verify_facts",
    "cross_check_facts",
    "fact_verification"
  ]
};

function normalizeCapability(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getToolCapabilityHints(toolId) {
  return TOOL_CAPABILITY_HINTS[toolId] || [];
}

function scoreToolForTask(tool, task = {}) {
  if (!tool || tool.status === "deprecated") {
    return -1;
  }

  const preferredToolId = task.preferred_tool_id || task.preferredToolId || null;
  const capability = normalizeCapability(task.capability);
  const agent = String(task.agent || "").toLowerCase();
  const contentType = String(task.candidate?.content_type || task.candidate?.source_type || "").toLowerCase();
  const documentKind = String(task.candidate?.metadata?.mime_type || task.candidate?.url || "").toLowerCase();
  const hints = getToolCapabilityHints(tool.id);
  let score = 0;

  if (preferredToolId && tool.id === preferredToolId) {
    score += 10;
  }
  if (capability && hints.includes(capability)) {
    score += 8;
  }
  if (capability && tool.id === capability) {
    score += 7;
  }
  if (agent === "video_parser" && tool.id === "extract_video_intel") {
    score += 6;
  }
  if ((agent === "chart_parser" || agent === "pdf_parser" || agent === "table_parser") && tool.id === "read_document_intel") {
    score += 6;
  }
  if ((agent === "long_text_collector" || agent === "web_page_parser") && tool.id === "deep_read_page") {
    score += 6;
  }
  if (agent === "fact_verifier" && tool.id === "cross_check_facts") {
    score += 6;
  }
  if (contentType === "video" && tool.id === "extract_video_intel") {
    score += 5;
  }
  if (contentType === "document" && tool.id === "read_document_intel") {
    score += 5;
  }
  if (contentType === "web" && tool.id === "deep_read_page") {
    score += 5;
  }
  if (/pdf|xlsx|xls|csv|tsv/.test(documentKind) && tool.id === "read_document_intel") {
    score += 3;
  }
  if (task.candidate?.metadata?.page_images?.length && tool.id === "read_document_intel") {
    score += 2;
  }

  return score;
}

// 标准化工具接口
const ToolRegistry = {
  tools: new Map(),
  toolVersions: new Map(),
  toolAliases: new Map(),
  lifecycleEvents: [],
  
  registerTool(toolDefinition) {
    if (!toolDefinition.id) {
      throw new Error('Tool must have an id');
    }
    if (!toolDefinition.name) {
      throw new Error('Tool must have a name');
    }
    if (!toolDefinition.execute) {
      throw new Error('Tool must have an execute function');
    }

    const baseToolId = toolDefinition.base_tool_id || toolDefinition.id;
    const version = String(toolDefinition.version || "1.0.0");
    const registeredAt = new Date().toISOString();
    const existingActive = this.tools.get(toolDefinition.id);
    const normalized = {
      id: toolDefinition.id,
      name: toolDefinition.name,
      description: toolDefinition.description || '',
      parameters: toolDefinition.parameters || [],
      execute: toolDefinition.execute,
      validate: toolDefinition.validate || null,
      inputSchema: toolDefinition.inputSchema || null,
      outputSchema: toolDefinition.outputSchema || null,
      base_tool_id: baseToolId,
      version,
      status: toolDefinition.status || "active",
      source: toolDefinition.source || "builtin",
      created_by: toolDefinition.created_by || null,
      created_for: toolDefinition.created_for || null,
      promoted_to_builtin: Boolean(toolDefinition.promoted_to_builtin),
      replaced_by: null,
      supersedes: toolDefinition.supersedes || existingActive?.id || null,
      request_id: toolDefinition.request_id || null,
      registered_at: registeredAt
    };

    if (existingActive && existingActive.id !== normalized.id) {
      existingActive.status = "superseded";
      existingActive.replaced_by = normalized.id;
      this.lifecycleEvents.push({
        type: "superseded",
        tool_id: existingActive.id,
        base_tool_id: baseToolId,
        replaced_by: normalized.id,
        at: registeredAt
      });
    }

    this.tools.set(toolDefinition.id, normalized);
    this.toolAliases.set(baseToolId, toolDefinition.id);

    const history = this.toolVersions.get(baseToolId) || [];
    history.push(normalized);
    this.toolVersions.set(baseToolId, history);
    this.lifecycleEvents.push({
      type: "registered",
      tool_id: normalized.id,
      base_tool_id: baseToolId,
      version,
      at: registeredAt
    });
  },
  
  getTool(toolId) {
    const resolvedId = this.toolAliases.get(toolId) || toolId;
    return this.tools.get(resolvedId);
  },
  
  getTools() {
    return Array.from(this.tools.values());
  },

  getToolHistory(toolId) {
    const current = this.getTool(toolId);
    const baseToolId = current?.base_tool_id || toolId;
    return (this.toolVersions.get(baseToolId) || []).map((item) => ({ ...item }));
  },

  deprecateTool(toolId, reason = "deprecated") {
    const tool = this.getTool(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }
    tool.status = "deprecated";
    tool.deprecated_at = new Date().toISOString();
    tool.deprecation_reason = reason;
    this.lifecycleEvents.push({
      type: "deprecated",
      tool_id: tool.id,
      base_tool_id: tool.base_tool_id,
      reason,
      at: tool.deprecated_at
    });
    return { ...tool };
  },

  rollbackTool(toolId, targetToolId = null) {
    const current = this.getTool(toolId);
    if (!current) {
      throw new Error(`Tool not found: ${toolId}`);
    }

    const history = this.toolVersions.get(current.base_tool_id) || [];
    const target = targetToolId
      ? history.find((item) => item.id === targetToolId)
      : [...history].reverse().find((item) => item.id !== current.id && item.status !== "deprecated");

    if (!target) {
      throw new Error(`No rollback target found for ${toolId}`);
    }

    current.status = "superseded";
    current.replaced_by = target.id;
    target.status = "active";
    target.reactivated_at = new Date().toISOString();
    this.toolAliases.set(current.base_tool_id, target.id);
    this.lifecycleEvents.push({
      type: "rolled_back",
      tool_id: current.id,
      base_tool_id: current.base_tool_id,
      target_tool_id: target.id,
      at: target.reactivated_at
    });
    return { active: { ...target }, previous: { ...current } };
  },

  promoteTool(toolId, reason = "promoted_to_builtin_candidate") {
    const tool = this.getTool(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }
    tool.promoted_to_builtin = true;
    tool.promotion_reason = reason;
    tool.promoted_at = new Date().toISOString();
    this.lifecycleEvents.push({
      type: "promoted",
      tool_id: tool.id,
      base_tool_id: tool.base_tool_id,
      reason,
      at: tool.promoted_at
    });
    return { ...tool };
  },

  getLifecycleEvents(toolId = null) {
    if (!toolId) {
      return this.lifecycleEvents.map((item) => ({ ...item }));
    }
    const current = this.getTool(toolId);
    const baseToolId = current?.base_tool_id || toolId;
    return this.lifecycleEvents
      .filter((item) => item.base_tool_id === baseToolId || item.tool_id === toolId)
      .map((item) => ({ ...item }));
  },

  resolveToolForTask(task = {}) {
    const preferredToolId = task.preferred_tool_id || task.preferredToolId || null;
    const preferredTool = preferredToolId ? this.getTool(preferredToolId) : null;
    if (preferredTool && preferredTool.status !== "deprecated") {
      return {
        tool_id: preferredTool.id,
        capability: normalizeCapability(task.capability),
        reason: preferredToolId === task.capability
          ? "matched_requested_tool_id"
          : "matched_preferred_tool",
        tool: { ...preferredTool }
      };
    }

    const ranked = this.getTools()
      .map((tool) => ({
        tool,
        score: scoreToolForTask(tool, task)
      }))
      .filter((item) => item.score >= 0)
      .sort((left, right) => right.score - left.score);

    const best = ranked[0];
    if (!best || best.score <= 0) {
      return null;
    }

    return {
      tool_id: best.tool.id,
      capability: normalizeCapability(task.capability),
      reason: "matched_tool_capability",
      tool: { ...best.tool },
      alternatives: ranked.slice(1, 3).map((item) => ({
        tool_id: item.tool.id,
        score: item.score
      }))
    };
  },
  
  async executeTool(toolId, input) {
    const tool = this.getTool(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }
    
    try {
      if (tool.status === "deprecated") {
        throw new Error(`Tool is deprecated: ${tool.id}`);
      }
      this.validateToolInput(toolId, input);
      const result = await tool.execute(input);
      return {
        success: true,
        data: result,
        toolId,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: {
          message: error.message,
          stack: error.stack
        },
        toolId,
        timestamp: new Date().toISOString()
      };
    }
  },
  
  validateToolInput(toolId, input) {
    const tool = this.getTool(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }
    
    const payload = input && typeof input === "object" ? input : {};
    for (const param of tool.parameters) {
      // 这里可以添加更复杂的 schema 验证
      // 暂时使用简单的参数检查
      for (const param of tool.parameters) {
        if (param.required && !Object.prototype.hasOwnProperty.call(payload, param.name)) {
          throw new Error(`Missing required parameter: ${param.name}`);
        }
      }
    }

    if (typeof tool.validate === "function") {
      tool.validate(payload);
    }

    return true;
  },
  
  getToolCapabilities() {
    return this.getTools().map(tool => ({
      id: tool.id,
      base_tool_id: tool.base_tool_id,
      version: tool.version,
      status: tool.status,
      source: tool.source,
      promoted_to_builtin: tool.promoted_to_builtin,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      hasInputSchema: !!tool.inputSchema,
      hasOutputSchema: !!tool.outputSchema
    }));
  },
  
  testTool(toolId, testInput) {
    const tool = this.getTool(toolId);
    if (!tool) {
      return { success: false, error: `Tool not found: ${toolId}` };
    }
    
    try {
      this.validateToolInput(toolId, testInput);
      return { success: true, message: 'Input validation passed' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, options = {}) {
  const {
    timeoutMs = 15000,
    retries = 1,
    headers = {}
  } = options;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 DeepWebSearchMVP/0.1",
          ...headers
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 180)}`);
      }
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(350 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  return JSON.parse(text);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isChineseText(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function extractFocusTerms(query) {
  const raw = String(query || "");
  const englishTerms = raw.match(/[A-Za-z][A-Za-z0-9._+-]{1,20}/g) || [];
  const cleanedChinese = raw
    .replace(/[0-9A-Za-z._+-]+/g, " ")
    .replace(/[，。！？、,:：；“”"'（）()【】\[\]<>《》]/g, " ")
    .replace(/(什么|多少|哪些|为什么|如何|现在|当前|最新|最近|比较|相比|还有|以及|这个|那个|就是|一下|一下子|上手|教程|使用|反馈|视频|文章|新闻|动态|模型|产品|功能|架构|更新|互联网|中文|有哪些|有关|相关|时候|情况)/g, " ")
    .split(/\s+/)
    .flatMap((item) => item.match(/[\u4e00-\u9fff]{2,8}/g) || []);

  return unique([...englishTerms, ...cleanedChinese]).slice(0, 5);
}

function buildDouyinSearchUrl(query) {
  const normalizedQuery = normalizeWhitespace(String(query || "").replace(/\s+/g, " "));
  const finalQuery = /视频/.test(normalizedQuery) ? normalizedQuery : `${normalizedQuery} 视频`;
  return `https://www.douyin.com/search/${encodeURIComponent(finalQuery)}`;
}

function buildQueryTokens(query) {
  const tokens = new Set(
    String(query || "")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9._-]{1,}/g) || []
  );

  const dictionary = [
    [/苹果/g, ["apple", "iphone", "苹果"]],
    [/性能/g, ["performance", "benchmark", "性能"]],
    [/更新|升级/g, ["update", "更新", "升级"]],
    [/架构/g, ["architecture", "架构"]],
    [/视频|访谈|演讲|发布会/g, ["video", "talk", "视频", "访谈", "演讲", "发布会"]],
    [/研究|论文/g, ["research", "paper", "研究", "论文"]],
    [/搜索/g, ["search", "搜索"]],
    [/规划/g, ["planner", "workflow", "规划"]],
    [/时长|秒|分钟/g, ["seconds", "duration", "时长", "分钟", "秒"]],
    [/教程/g, ["tutorial", "教程"]],
    [/模型/g, ["model", "模型"]],
    [/产品/g, ["product", "产品"]]
  ];

  for (const [pattern, words] of dictionary) {
    if (pattern.test(query)) {
      for (const word of words) {
        tokens.add(word);
      }
    }
  }

  return Array.from(tokens);
}

function makeId(prefix, value) {
  return `${prefix}:${crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12)}`;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (error) {
    return "";
  }
}

function authorityScoreForUrl(url, platform) {
  const hostname = hostFromUrl(url);
  if (/openai\.com$/.test(hostname)) return 0.97;
  if (/arxiv\.org$/.test(hostname)) return 0.95;
  if (/ted\.com$/.test(hostname)) return 0.88;
  if (/douyin\.com$/.test(hostname) || /iesdouyin\.com$/.test(hostname)) return 0.78;
  if (/ithome\.com$/.test(hostname)) return 0.84;
  if (/segmentfault\.com$/.test(hostname)) return 0.8;
  if (/bilibili\.com$/.test(hostname)) return 0.76;
  if (/news\.ycombinator\.com$/.test(hostname)) return 0.74;
  if (/github\.com$/.test(hostname)) return 0.78;
  if (/stackoverflow\.com$/.test(hostname)) return 0.8;
  if (/theverge\.com$/.test(hostname)) return 0.82;
  if (platform === "Bing Web") return 0.72;
  return 0.66;
}

function decodeBingRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.bing.com") {
      return url;
    }
    const encoded = parsed.searchParams.get("u");
    if (!encoded || encoded.length <= 2) {
      return url;
    }
    const decoded = Buffer.from(encoded.slice(2), "base64").toString("utf8");
    return decoded.startsWith("http") ? decoded : url;
  } catch (error) {
    return url;
  }
}

function toReaderUrl(url) {
  return `https://r.jina.ai/http://${url}`;
}

function extractReaderMarkdown(value) {
  const marker = "Markdown Content:";
  const index = value.indexOf(marker);
  if (index === -1) {
    return normalizeWhitespace(value);
  }
  const raw = value.slice(index + marker.length).trim();
  const lines = raw.split(/\r?\n/);
  const cleaned = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^\*\s+\[/.test(trimmed)) return false;
    if (/^\[.*\]\(.*\)$/.test(trimmed)) return false;
    if (/^!\[/.test(trimmed)) return false;
    if (/^(Skip to|Log in|Switch to|Back to main menu|Search$|Menu$)/i.test(trimmed)) return false;
    if (/^[=-]{3,}$/.test(trimmed)) return false;
    return true;
  });
  return cleaned.join("\n").trim();
}

function splitIntoSentences(value) {
  return String(value || "")
    .split(/(?<=[.!?。！？])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractKeyPointsFromText(value, limit = 4) {
  const clean = stripTags(value);
  const sentences = splitIntoSentences(clean).filter((sentence) => sentence.length >= 30);
  return sentences.slice(0, limit);
}

function buildSectionsFromMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      if (current) {
        sections.push(current);
      }
      current = {
        heading: line.replace(/^#{1,6}\s+/, ""),
        excerpt: ""
      };
      continue;
    }
    if (!current) {
      current = { heading: "摘要", excerpt: line };
      continue;
    }
    if (!current.excerpt) {
      current.excerpt = line;
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections.slice(0, 8);
}

function extractNumericFacts(value, sourceId, subjectHint = "source") {
  const sentences = splitIntoSentences(stripTags(value));
  const facts = [];

  for (const sentence of sentences) {
    if (!sentence || sentence.length > 240 || /https?:\/\//i.test(sentence) || /^!\[Image/i.test(sentence)) {
      continue;
    }
    const match = sentence.match(/(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|percent|%|years?)/i);
    if (!match) {
      continue;
    }
    facts.push({
      source_id: sourceId,
      subject: subjectHint,
      kind: "numeric_statement",
      claim: sentence.slice(0, 220),
      value: Number(match[1]),
      unit: match[2].toLowerCase(),
      evidence: sentence.slice(0, 260)
    });
  }

  return facts.slice(0, 5);
}

function inferDocumentKindFromUrl(url, metadata = {}) {
  const mimeType = String(metadata?.mime_type || metadata?.content_type || "").toLowerCase();
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("csv")) return "csv";
  if (mimeType.includes("tab-separated-values")) return "tsv";
  if (mimeType.includes("json")) return "json";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "xlsx";
  if (mimeType.includes("wordprocessingml") || mimeType.includes("msword")) return "docx";

  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch (_) {
      return String(url || "").toLowerCase();
    }
  })();

  if (pathname.endsWith(".pdf")) return "pdf";
  if (pathname.endsWith(".csv")) return "csv";
  if (pathname.endsWith(".tsv")) return "tsv";
  if (pathname.endsWith(".json")) return "json";
  if (pathname.endsWith(".xlsx") || pathname.endsWith(".xls")) return "xlsx";
  if (pathname.endsWith(".docx") || pathname.endsWith(".doc")) return "docx";
  return "webpage";
}

function resolveAbsoluteUrl(baseUrl, candidateUrl) {
  if (!candidateUrl) {
    return null;
  }

  try {
    return new URL(candidateUrl, baseUrl).toString();
  } catch (_) {
    return null;
  }
}

function normalizeCandidateMediaMetadata(candidate = {}) {
  const metadata = { ...(candidate.metadata || {}) };
  const rawImageUrls = [
    ...(Array.isArray(metadata.page_images) ? metadata.page_images : []),
    metadata.preview_image,
    metadata.poster,
    metadata.thumbnail,
    metadata.image
  ].filter(Boolean);
  const pageImages = rawImageUrls
    .map((item) => resolveAbsoluteUrl(candidate.url, item))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 3);

  return {
    ...candidate,
    metadata: {
      ...metadata,
      page_images: pageImages,
      preview_image: pageImages[0] || metadata.preview_image || null
    }
  };
}

function extractDocumentPageImagesFromHtml(html, baseUrl) {
  const metaMatches = [
    ...String(html || "").matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image|twitter:image:src)["'][^>]+content=["']([^"']+)["']/gi)
  ];
  const imgMatches = [
    ...String(html || "").matchAll(/<img[^>]+src=["']([^"']+)["']/gi)
  ];

  const preferred = metaMatches.map((match) => match[1]);
  const fallback = imgMatches
    .map((match) => match[1])
    .filter((src) => !/logo|icon|avatar|sprite|badge/i.test(src));

  return [...preferred, ...fallback]
    .map((item) => resolveAbsoluteUrl(baseUrl, item))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 3);
}

async function discoverCandidatePageImages(candidate, documentKind) {
  const existingImages = Array.isArray(candidate.metadata?.page_images)
    ? candidate.metadata.page_images.filter(Boolean)
    : [];
  if (existingImages.length) {
    return existingImages.slice(0, 3);
  }

  if (!candidate?.url) {
    return [];
  }

  const pathname = (() => {
    try {
      return new URL(candidate.url).pathname.toLowerCase();
    } catch (_) {
      return String(candidate.url || "").toLowerCase();
    }
  })();

  if (/\.(pdf|docx?|xlsx?|csv|tsv|json)$/.test(pathname)) {
    return [];
  }

  try {
    const html = await fetchText(candidate.url, {
      timeoutMs: 6000,
      retries: 0,
      headers: {
        accept: "text/html,application/xhtml+xml"
      }
    });
    return extractDocumentPageImagesFromHtml(html, candidate.url);
  } catch (_) {
    return [];
  }
}

function parseDelimitedTable(text, delimiter = ",") {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return { headers: [], rows: [] };
  }

  const rows = lines.map((line) => line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, "")));
  const headers = rows[0];
  return {
    headers,
    rows: rows.slice(1).map((cells) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header || `column_${index + 1}`] = cells[index] || "";
      });
      return record;
    })
  };
}

function tableToMarkdown(table, title) {
  const headers = table.headers || [];
  const rows = table.rows || [];
  const previewRows = rows.slice(0, 5);

  if (!headers.length) {
    return `# ${title}\n\nNo structured rows were extracted.`;
  }

  const lines = [
    `# ${title}`,
    "",
    `Columns: ${headers.join(", ")}`,
    "",
    `Row count: ${rows.length}`,
    "",
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...previewRows.map((row) => `| ${headers.map((header) => String(row[header] || "")).join(" | ")} |`)
  ];

  return lines.join("\n");
}

async function maybeSummarizeDocumentWithModel(candidate, documentKind, markdown) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !markdown || markdown.length < 80) {
    return null;
  }

  const preview = markdown.slice(0, 10000);
  const prompt = [
    "Summarize this document for a research workflow.",
    "Return strict JSON with keys: summary, key_points, structured_facts.",
    "Keep key_points to at most 4 short strings.",
    "structured_facts should be an array of objects with subject, claim, value, unit when present.",
    "",
    `Title: ${candidate.title || candidate.url}`,
    `Kind: ${documentKind}`,
    "",
    preview
  ].join("\n");

  const response = await fetch(process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: process.env.OPENAI_DOCUMENT_MODEL || process.env.OPENAI_EVALUATOR_MODEL || "gpt-4o-mini",
      store: false,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "document_summary",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              key_points: {
                type: "array",
                items: { type: "string" },
                maxItems: 4
              },
              structured_facts: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    subject: { type: "string" },
                    claim: { type: "string" },
                    value: { type: ["number", "string", "null"] },
                    unit: { type: ["string", "null"] }
                  },
                  required: ["subject", "claim", "value", "unit"]
                },
                maxItems: 5
              }
            },
            required: ["summary", "key_points", "structured_facts"]
          }
        }
      }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Document model failed with HTTP ${response.status}`);
  }

  const text = payload?.output
    ?.flatMap((item) => item.content || [])
    ?.find((item) => item.type === "output_text")
    ?.text || "";

  return text ? JSON.parse(text) : null;
}

async function analyzeDocumentWithMultimodalModel(input) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const pageImages = (input.page_images || []).filter(Boolean).slice(0, 2);
  const prompt = [
    "Analyze this complex document for a research workflow.",
    "Focus on tables, charts, layout signals, and any visual evidence that matters.",
    "Return strict JSON with keys: summary, key_points, structured_facts, visual_observations.",
    `Title: ${input.title || input.url || "document"}`,
    `Document kind: ${input.document_kind || "unknown"}`,
    "",
    (input.markdown || "").slice(0, 12000)
  ].join("\n");

  const content = [{ type: "input_text", text: prompt }];
  for (const imageUrl of pageImages) {
    content.push({
      type: "input_image",
      image_url: imageUrl
    });
  }

  const response = await fetch(process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: process.env.OPENAI_MULTIMODAL_DOCUMENT_MODEL || process.env.OPENAI_DOCUMENT_MODEL || "gpt-4o-mini",
      store: false,
      input: [
        {
          role: "user",
          content
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "document_multimodal_summary",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              key_points: {
                type: "array",
                items: { type: "string" },
                maxItems: 5
              },
              structured_facts: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    subject: { type: "string" },
                    claim: { type: "string" },
                    value: { type: ["number", "string", "null"] },
                    unit: { type: ["string", "null"] }
                  },
                  required: ["subject", "claim", "value", "unit"]
                },
                maxItems: 6
              },
              visual_observations: {
                type: "array",
                items: { type: "string" },
                maxItems: 4
              }
            },
            required: ["summary", "key_points", "structured_facts", "visual_observations"]
          }
        }
      }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Document multimodal analysis failed with HTTP ${response.status}`);
  }

  const rawText = extractTextFromResponsePayload(payload);
  return rawText ? JSON.parse(rawText) : null;
}

function estimateDocumentLayoutPages(candidate, read) {
  const hintedPages = Number(candidate?.metadata?.page_count || candidate?.metadata?.pages || 0);
  if (Number.isFinite(hintedPages) && hintedPages > 0) {
    return hintedPages;
  }
  const imagePages = Array.isArray(read?.page_images) ? read.page_images.length : 0;
  const sectionPages = Math.max(1, Math.ceil((read?.sections?.length || 0) / 3));
  const tablePages = read?.table_data?.rows?.length ? 1 : 0;
  return Math.max(1, imagePages, sectionPages, tablePages);
}

function deriveDocumentLayout(read, candidate = {}) {
  const totalPages = estimateDocumentLayoutPages(candidate, read);
  const blocks = [];
  const taskSuggestions = [];
  const sections = read.sections || [];
  const textSections = sections.slice(0, 8);
  const pageImages = Array.isArray(read.page_images) ? read.page_images : [];
  const visualObservations = Array.isArray(read.visual_observations) ? read.visual_observations : [];

  if (textSections.length || read.markdown) {
    const startPage = 1;
    const endPage = Math.max(1, Math.min(totalPages, Math.max(1, Math.ceil(textSections.length / 3) || 1)));
    blocks.push({
      block_id: `${read.source_id || candidate.id}:text`,
      modality: "text",
      agent: "long_text_collector",
      pages: [startPage, endPage],
      summary: textSections.map((section) => section.heading).filter(Boolean).join(", ") || "Document text sections"
    });
    taskSuggestions.push({
      task_id: `${read.source_id || candidate.id}:task:text`,
      agent: "long_text_collector",
      capability: "read_document",
      pages: [startPage, endPage],
      objective: "Summarize the document text sections and extract core claims."
    });
  }

  if (read.table_data?.rows?.length) {
    const tablePage = Math.min(totalPages, Math.max(1, (blocks.length ? blocks[blocks.length - 1].pages[1] : 1) + 1));
    blocks.push({
      block_id: `${read.source_id || candidate.id}:table`,
      modality: "table",
      agent: "table_parser",
      pages: [tablePage, tablePage],
      summary: `Structured table with ${read.table_data.rows.length} rows`
    });
    taskSuggestions.push({
      task_id: `${read.source_id || candidate.id}:task:table`,
      agent: "table_parser",
      capability: "parse_table",
      pages: [tablePage, tablePage],
      objective: "Extract the table into structured JSON rows."
    });
  }

  if (pageImages.length || visualObservations.length) {
    const visualStartPage = Math.min(totalPages, Math.max(1, totalPages - Math.max(0, pageImages.length - 1)));
    const visualEndPage = Math.min(totalPages, Math.max(visualStartPage, visualStartPage + Math.max(0, pageImages.length - 1)));
    blocks.push({
      block_id: `${read.source_id || candidate.id}:visual`,
      modality: "visual",
      agent: "chart_parser",
      pages: [visualStartPage, visualEndPage],
      summary: visualObservations[0] || "Layout contains chart or image evidence"
    });
    taskSuggestions.push({
      task_id: `${read.source_id || candidate.id}:task:visual`,
      agent: "chart_parser",
      capability: "analyze_visual_document",
      pages: [visualStartPage, visualEndPage],
      objective: "Describe the visual evidence and identify the most important trend."
    });
  }

  return {
    source_id: read.source_id || candidate.id || null,
    total_pages: totalPages,
    blocks,
    task_suggestions: taskSuggestions,
    dominant_modalities: Array.from(new Set(blocks.map((block) => block.modality)))
  };
}

async function analyzeDocumentLayoutWithModel(candidate, read, fallbackLayout) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const totalPages = fallbackLayout?.total_pages || estimateDocumentLayoutPages(candidate, read);
  const prompt = [
    "Analyze this document layout for a multi-agent parsing workflow.",
    "Return strict JSON describing page-level blocks and parser task suggestions.",
    "Use parser agents from this fixed set only: long_text_collector, table_parser, chart_parser.",
    "Use modalities from this fixed set only: text, table, visual.",
    "Infer page ranges conservatively from the available markdown, images, and table hints.",
    "",
    `Title: ${candidate.title || candidate.url || "document"}`,
    `Document kind: ${read.document_kind || "unknown"}`,
    `Estimated total pages: ${totalPages}`,
    `Has table data: ${read.table_data?.rows?.length ? "yes" : "no"}`,
    `Page image count: ${Array.isArray(read.page_images) ? read.page_images.length : 0}`,
    "",
    "Sections:",
    JSON.stringify((read.sections || []).slice(0, 8), null, 2),
    "",
    "Visual observations:",
    JSON.stringify((read.visual_observations || []).slice(0, 4), null, 2),
    "",
    "Markdown preview:",
    String(read.markdown || "").slice(0, 8000)
  ].join("\n");

  const response = await fetch(process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: process.env.OPENAI_LAYOUT_MODEL || process.env.OPENAI_DOCUMENT_MODEL || "gpt-4o-mini",
      store: false,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "document_layout_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              total_pages: { type: "integer", minimum: 1 },
              blocks: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    block_id: { type: "string" },
                    modality: { type: "string", enum: ["text", "table", "visual"] },
                    agent: { type: "string", enum: ["long_text_collector", "table_parser", "chart_parser"] },
                    pages: {
                      type: "array",
                      minItems: 2,
                      maxItems: 2,
                      items: { type: "integer", minimum: 1 }
                    },
                    summary: { type: "string" }
                  },
                  required: ["block_id", "modality", "agent", "pages", "summary"]
                }
              },
              task_suggestions: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    task_id: { type: "string" },
                    agent: { type: "string", enum: ["long_text_collector", "table_parser", "chart_parser"] },
                    capability: { type: "string" },
                    pages: {
                      type: "array",
                      minItems: 2,
                      maxItems: 2,
                      items: { type: "integer", minimum: 1 }
                    },
                    objective: { type: "string" }
                  },
                  required: ["task_id", "agent", "capability", "pages", "objective"]
                }
              },
              dominant_modalities: {
                type: "array",
                items: { type: "string", enum: ["text", "table", "visual"] },
                maxItems: 3
              }
            },
            required: ["total_pages", "blocks", "task_suggestions", "dominant_modalities"]
          }
        }
      }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Document layout analysis failed with HTTP ${response.status}`);
  }

  const rawText = extractTextFromResponsePayload(payload);
  return rawText ? JSON.parse(rawText) : null;
}

async function readDocumentSource(candidate) {
  const normalizedCandidate = normalizeCandidateMediaMetadata(candidate);
  const documentKind = inferDocumentKindFromUrl(normalizedCandidate.url, normalizedCandidate.metadata);
  let markdown = "";
  let tableData = null;
  let processingMode = "native";

  if (documentKind === "csv" || documentKind === "tsv") {
    const raw = await fetchText(normalizedCandidate.url);
    tableData = parseDelimitedTable(raw, documentKind === "tsv" ? "\t" : ",");
    markdown = tableToMarkdown(tableData, normalizedCandidate.title);
  } else if (documentKind === "json") {
    const payload = await fetchJson(normalizedCandidate.url);
    const topKeys = Object.keys(payload || {}).slice(0, 10);
    markdown = [
      `# ${normalizedCandidate.title}`,
      "",
      `Top-level keys: ${topKeys.join(", ") || "none"}`,
      "",
      JSON.stringify(payload, null, 2).slice(0, 6000)
    ].join("\n");
  } else {
    const raw = await fetchText(toReaderUrl(normalizedCandidate.url), { timeoutMs: 20000, retries: 1 });
    markdown = extractReaderMarkdown(raw);
  }

  let llmSummary = null;
  let multimodalSummary = null;
  const discoveredPageImages = await discoverCandidatePageImages(normalizedCandidate, documentKind);
  const pageImages = discoveredPageImages.length
    ? discoveredPageImages
    : normalizedCandidate.metadata?.preview_image
      ? [normalizedCandidate.metadata.preview_image]
      : [];

  if ((["pdf", "docx", "xlsx"].includes(documentKind) || pageImages.length > 0) && process.env.OPENAI_API_KEY) {
    try {
      multimodalSummary = await analyzeDocumentWithMultimodalModel({
        url: normalizedCandidate.url,
        title: normalizedCandidate.title,
        document_kind: documentKind,
        markdown,
        page_images: pageImages
      });
      if (multimodalSummary) {
        processingMode = pageImages.length > 0 ? "multimodal_visual" : "multimodal_text_first";
      }
    } catch (_) {
      processingMode = "native";
    }
  }

  if (["pdf", "docx", "xlsx"].includes(documentKind) || (tableData && tableData.rows.length > 20)) {
    try {
      llmSummary = multimodalSummary || await maybeSummarizeDocumentWithModel(normalizedCandidate, documentKind, markdown);
      if (llmSummary) {
        processingMode = processingMode === "native" ? "llm_assisted" : processingMode;
      }
    } catch (_) {
      if (!multimodalSummary) {
        processingMode = "native";
      }
    }
  }

  const effectiveSummary = llmSummary || multimodalSummary;
  const keyPoints = effectiveSummary?.key_points?.length
    ? [
      ...effectiveSummary.key_points,
      ...(multimodalSummary?.visual_observations || [])
    ].slice(0, 6)
    : extractKeyPointsFromText(markdown);

  const facts = [
    ...extractNumericFacts(markdown, normalizedCandidate.id, normalizedCandidate.title || "document"),
    ...((effectiveSummary?.structured_facts || []).map((item) => ({
      source_id: normalizedCandidate.id,
      subject: item.subject,
      kind: "document_fact",
      claim: item.claim,
      value: item.value,
      unit: item.unit || null,
      evidence: item.claim
    })))
  ].slice(0, 8);

  const summarySections = [];
  if (effectiveSummary?.summary) {
    summarySections.push(`## Model Summary\n${effectiveSummary.summary}`);
  }
  if (multimodalSummary?.visual_observations?.length) {
    summarySections.push(
      `## Visual Observations\n${multimodalSummary.visual_observations.map((item) => `- ${item}`).join("\n")}`
    );
  }

  return {
    source_id: candidate.id,
    content_type: normalizedCandidate.content_type || normalizedCandidate.source_type || "document",
    source_type: normalizedCandidate.source_type || "document",
    tool: "read_document_intel",
    title: normalizedCandidate.title,
    url: normalizedCandidate.url,
    author: normalizedCandidate.author,
    published_at: normalizedCandidate.published_at,
    markdown: summarySections.length
      ? `${markdown}\n\n${summarySections.join("\n\n")}`
      : markdown,
    key_points: keyPoints,
    sections: buildSectionsFromMarkdown(markdown),
    facts,
    table_data: tableData,
    document_kind: documentKind,
    processing_mode: processingMode,
    visual_observations: multimodalSummary?.visual_observations || [],
    page_images: pageImages,
    source_metadata: {
      ...(normalizedCandidate.metadata || {}),
      page_images: pageImages,
      preview_image: pageImages[0] || normalizedCandidate.metadata?.preview_image || null
    }
  };
}

async function analyzeDocumentLayout(candidate, readOverride = null) {
  const read = readOverride || await readDocumentSource(candidate);
  const fallbackLayout = deriveDocumentLayout(read, candidate);
  let layout = fallbackLayout;

  try {
    const llmLayout = await analyzeDocumentLayoutWithModel(candidate, read, fallbackLayout);
    if (llmLayout?.blocks?.length || llmLayout?.task_suggestions?.length) {
      layout = {
        source_id: candidate.id,
        ...llmLayout
      };
    }
  } catch (_) {
    layout = fallbackLayout;
  }

  return {
    source_id: candidate.id,
    title: candidate.title,
    url: candidate.url,
    document_kind: read.document_kind,
    layout,
    layout_analysis_mode: layout === fallbackLayout ? "heuristic" : "llm",
    source_metadata: read.source_metadata,
    read
  };
}

function timestampFromMilliseconds(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds].map((item) => String(item).padStart(2, "0")).join(":");
  }
  return [minutes, seconds].map((item) => String(item).padStart(2, "0")).join(":");
}

function buildTranscriptTimeline(cues) {
  if (!cues || cues.length === 0) {
    return [];
  }

  const segments = [];
  let currentSegment = null;

  for (const cue of cues) {
    const textLength = cue.text?.length || 0;
    
    if (!currentSegment) {
      currentSegment = {
        start: cue.start || 0,
        end: cue.start || 0,
        texts: [cue.text],
        totalLength: textLength
      };
    } else if (currentSegment.totalLength + textLength < 200) {
      currentSegment.texts.push(cue.text);
      currentSegment.end = cue.start || currentSegment.end;
      currentSegment.totalLength += textLength;
    } else {
      segments.push(currentSegment);
      currentSegment = {
        start: cue.start || 0,
        end: cue.start || 0,
        texts: [cue.text],
        totalLength: textLength
      };
    }
  }

  if (currentSegment) {
    segments.push(currentSegment);
  }

  return segments.slice(0, 10).map((segment) => {
    const fullText = segment.texts.join(" ");
    const summary = extractKeyPointsFromText(fullText, 2);
    return {
      start: timestampFromMilliseconds(segment.start * 1000),
      end: timestampFromMilliseconds(segment.end * 1000),
      title: segment.texts[0]?.slice(0, 42) || "片段",
      summary: summary.length > 0 ? summary[0] : fullText.slice(0, 220),
      full_text: fullText.slice(0, 500)
    };
  });
}

// 提取视频关键观点和时间点
function extractVideoKeyPoints(transcript, maxPoints = 8) {
  if (!transcript || transcript.length === 0) {
    return [];
  }

  const keyPatterns = [
    /最重要|关键|核心|主要|本质/,
    /首先|第一|第二|第三|最后/,
    /但是|然而|不过|虽然|尽管/,
    /因为|所以|因此|由于|导致/,
    /比如|例如|就像|相当于/,
    /需要|必须|应该|可以|能够/,
    /问题|挑战|难点|困难|优势|劣势/,
    /总结|结论|总的来说|总而言之/
  ];

  const candidates = [];

  for (const item of transcript) {
    const text = item.text || "";
    let score = 0;

    for (const pattern of keyPatterns) {
      if (pattern.test(text)) {
        score += 1;
      }
    }

    if (text.length > 20 && text.length < 300) {
      score += text.length / 100;
    }

    if (candidates.length > 0) {
      const lastTime = candidates[candidates.length - 1].timestamp;
      if ((item.start || 0) - lastTime > 120) {
        score += 0.5;
      }
    }

    if (score > 0) {
      candidates.push({
        timestamp: item.start || 0,
        timeFormatted: timestampFromMilliseconds((item.start || 0) * 1000),
        text: text.slice(0, 300),
        score
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates.slice(0, maxPoints).sort((a, b) => a.timestamp - b.timestamp).map(item => ({
    timestamp: item.timestamp,
    time: item.timeFormatted,
    point: item.text,
    type: classifyKeyPoint(item.text)
  }));
}

function classifyKeyPoint(text) {
  const patterns = {
    conclusion: /总结|结论|总的来说|总而言之|最终|总的来说/,
    step: /首先|第一|第二|第三|最后|步骤|阶段/,
    contrast: /但是|然而|不过|虽然|尽管|相反/,
    cause: /因为|所以|因此|由于|导致|造成/,
    example: /比如|例如|就像|相当于|比如/,
    requirement: /需要|必须|应该|可以|能够|必须|应该/
  };

  for (const [type, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) {
      return type;
    }
  }
  return "insight";
}

// 视频转MP3功能
async function convertVideoToMp3(videoUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const ytDlpPath = path.join(os.tmpdir(), "yt-dlp.exe");
    const args = [
      "-x",
      "--audio-format", "mp3",
      "-o", outputPath,
      videoUrl
    ];

    const process = spawn(ytDlpPath, args);
    let output = "";
    let error = "";

    process.stdout.on("data", (data) => {
      output += data.toString();
    });

    process.stderr.on("data", (data) => {
      error += data.toString();
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`视频转MP3失败: ${error}`));
      }
    });

    process.on("error", (err) => {
      reject(err);
    });
  });
}

// 通过ARS API转文本
async function transcribeWithArsApi(audioPath) {
  if (!VIDEO_PROCESSING_CONFIG.arsApi.enabled || !VIDEO_PROCESSING_CONFIG.arsApi.apiKey) {
    throw new Error("ARS API 未配置或未启用");
  }

  const formData = new FormData();
  formData.append('audio', fs.createReadStream(audioPath));

  const response = await fetch(VIDEO_PROCESSING_CONFIG.arsApi.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VIDEO_PROCESSING_CONFIG.arsApi.apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`ARS API 调用失败: ${await response.text()}`);
  }

  return await response.json();
}

// 通过开源模型转文本
async function transcribeWithOpenSourceModel(audioPath) {
  if (!VIDEO_PROCESSING_CONFIG.openSourceModel.enabled) {
    throw new Error("开源模型未配置或未启用");
  }

  const formData = new FormData();
  formData.append('audio', fs.createReadStream(audioPath));
  formData.append('model', VIDEO_PROCESSING_CONFIG.openSourceModel.model);

  const response = await fetch(VIDEO_PROCESSING_CONFIG.openSourceModel.endpoint, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`开源模型调用失败: ${await response.text()}`);
  }

  return await response.json();
}

// 视频转文本主函数
async function transcribeVideo(videoUrl) {
  const tempDir = os.tmpdir();
  const audioPath = path.join(tempDir, `audio_${Date.now()}.mp3`);

  try {
    await convertVideoToMp3(videoUrl, audioPath);

    if (VIDEO_PROCESSING_CONFIG.arsApi.enabled) {
      try {
        const result = await transcribeWithArsApi(audioPath);
        const cues = result.cues || [];
        const timeline = result.timeline || buildTranscriptTimeline(cues);
        const keyPoints = result.key_points || extractVideoKeyPoints(cues, 8);
        return {
          success: true,
          method: "ars_api",
          transcript: result.transcript || cues,
          timeline,
          key_points: keyPoints
        };
      } catch (arsError) {
        console.warn("ARS API 调用失败，尝试使用开源模型:", arsError.message);
      }
    }

    if (VIDEO_PROCESSING_CONFIG.openSourceModel.enabled) {
      try {
        const result = await transcribeWithOpenSourceModel(audioPath);
        const cues = result.cues || [];
        const timeline = result.timeline || buildTranscriptTimeline(cues);
        const keyPoints = result.key_points || extractVideoKeyPoints(cues, 8);
        return {
          success: true,
          method: "open_source_model",
          transcript: result.transcript || cues,
          timeline,
          key_points: keyPoints
        };
      } catch (openSourceError) {
        console.warn("开源模型调用失败:", openSourceError.message);
      }
    }

    throw new Error("所有转文本方法均失败");
  } finally {
    if (fs.existsSync(audioPath)) {
      try {
        fs.unlinkSync(audioPath);
      } catch (error) {
        console.warn("清理临时文件失败:", error.message);
      }
    }
  }
}

function parseBingSearchMarkdown(markdown, query) {
  const content = extractReaderMarkdown(markdown);
  const blocks = content.split(/\n(?=\d+\.\s+)/).slice(0, 10);
  const candidates = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index].trim();
    if (!/^\d+\.\s+/.test(block)) {
      continue;
    }

    const linkMatch = block.match(/\[(.*?)\]\((.*?)\)/);
    if (!linkMatch) {
      continue;
    }

    const title = normalizeWhitespace(linkMatch[1]);
    if (!title || title.startsWith("![Image")) {
      continue;
    }
    const resolvedUrl = decodeBingRedirectUrl(linkMatch[2]);
    const rest = block
      .replace(/^\d+\.\s+/, "")
      .replace(linkMatch[0], "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^[-=]{3,}$/.test(line));

    const summaryLine = rest.join(" ").replace(/\s+/g, " ").trim();
    const publishedMatch = summaryLine.match(/^([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})·\s*/);
    const summary = publishedMatch ? summaryLine.replace(publishedMatch[0], "") : summaryLine;
    if (!summary || /Can't use this link|Unable to process this search/i.test(summary)) {
      continue;
    }

    candidates.push({
      id: makeId("web", resolvedUrl),
      connector: "bing_web",
      title,
      url: resolvedUrl,
      platform: "Bing Web",
      content_type: "web",
      source_type: "web",
      author: hostFromUrl(resolvedUrl) || "Unknown",
      published_at: publishedMatch ? publishedMatch[1] : null,
      duration: null,
      engagement: null,
      authority_score: authorityScoreForUrl(resolvedUrl, "Bing Web"),
      summary: summary || `Bing Web result for ${query}`,
      matched_query: query,
      score: Number((1.05 - index * 0.08).toFixed(4)),
      metadata: {
        rank: index + 1,
        host: hostFromUrl(resolvedUrl)
      }
    });
  }

  return candidates;
}

function parseTedSearchHtml(html, query) {
  const articles = [...html.matchAll(/<article class='m1 search__result'>([\s\S]*?)<\/article>/g)];
  const candidates = [];

  for (let index = 0; index < articles.length; index += 1) {
    const block = articles[index][1];
    const linkMatch = block.match(/href="(\/talks\/[^"]+)">([^<]+)<\/a>/);
    if (!linkMatch) {
      continue;
    }
    const descriptionMatch = block.match(/<div class='search__result__description m4'>([\s\S]*?)<\/div>/);
    const url = `https://www.ted.com${linkMatch[1]}`;
    const title = stripTags(linkMatch[2]);
    const summary = stripTags(descriptionMatch ? descriptionMatch[1] : "");

    candidates.push({
      id: makeId("video", url),
      connector: "ted",
      title,
      url,
      platform: "TED",
      content_type: "video",
      source_type: "video",
      author: title.includes(":") ? title.split(":")[0].trim() : "TED Speaker",
      published_at: null,
      duration: null,
      engagement: null,
      authority_score: 0.88,
      summary: summary || `TED talk result for ${query}`,
      matched_query: query,
      score: Number((0.96 - index * 0.07).toFixed(4)),
      metadata: {}
    });
  }

  return candidates.slice(0, 6);
}

function parseSegmentFaultSearchHtml(html, query) {
  const chineseQuery = isChineseText(query);
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!nextDataMatch) {
    return [];
  }

  const nextData = JSON.parse(nextDataMatch[1]);
  const rows = nextData.props?.pageProps?.initialState?.search?.result?.rows || [];

  return rows
    .filter((item) => item.type === "article" && item.contents?.url)
    .slice(0, 6)
    .map((item, index) => {
      const contents = item.contents;
      const url = contents.url.startsWith("http") ? contents.url : `https://segmentfault.com${contents.url}`;
      return {
        id: makeId("document", url),
        connector: "segmentfault",
        title: stripTags(contents.title),
        url,
        platform: "SegmentFault",
        content_type: "document",
        source_type: "document",
        author: "SegmentFault 作者",
        published_at: contents.created ? new Date(contents.created * 1000).toISOString() : null,
        duration: null,
        engagement: (contents.votes || 0) + (contents.comments || 0),
        authority_score: 0.8,
        summary: stripTags(contents.excerpt || `SegmentFault result for ${query}`),
        matched_query: query,
        score: Number(((chineseQuery ? 0.91 : 0.73) - index * 0.06 + Math.min((contents.comments || 0) / 100, 0.08)).toFixed(4)),
        metadata: {
          votes: contents.votes || 0,
          comments: contents.comments || 0
        }
      };
    });
}

function parseBilibiliSearchHtml(html, query) {
  const chineseQuery = isChineseText(query);
  const pattern = /<a href="\/\/www\.bilibili\.com\/video\/(BV[^\/"]+)\/"[\s\S]*?<span class="bili-video-card__stats__duration"[^>]*>([^<]+)<\/span>[\s\S]*?<h3 class="bili-video-card__info--tit" title="([^"]+)"[^>]*>[\s\S]*?<span class="bili-video-card__info--author"[^>]*>([^<]*)<\/span>/g;
  const candidates = [];

  for (const [index, match] of Array.from(html.matchAll(pattern)).entries()) {
    const bvid = match[1];
    const duration = normalizeWhitespace(match[2]);
    const title = stripTags(match[3]);
    const author = stripTags(match[4]) || "Bilibili UP 主";
    const url = `https://www.bilibili.com/video/${bvid}/`;

    candidates.push({
      id: makeId("video", url),
      connector: "bilibili",
      title,
      url,
      platform: "Bilibili",
      content_type: "video",
      source_type: "video",
      author,
      published_at: null,
      duration,
      engagement: null,
      authority_score: 0.76,
      summary: `Bilibili 视频结果：${title}`,
      matched_query: query,
      score: Number(((chineseQuery ? 0.94 : 0.68) - index * 0.05).toFixed(4)),
      metadata: {
        bvid
      }
    });

    if (candidates.length >= 6) {
      break;
    }
  }

  return candidates;
}

function parseITHomeTagHtml(html, query, term) {
  const listMatch = html.match(/<ul class="bl">([\s\S]*?)<\/ul>/);
  if (!listMatch) {
    return [];
  }

  const items = [...listMatch[1].matchAll(/<li>[\s\S]*?<div class="c" data-ot="([^"]+)">[\s\S]*?<a title="([^"]+)" target="_blank" href="([^"]+)" class="title">[\s\S]*?<\/a>[\s\S]*?<div class="m">([\s\S]*?)<\/div>/g)];
  const chineseQuery = isChineseText(query);

  return items.slice(0, 8).map((match, index) => ({
    id: makeId("web", match[3]),
    connector: "ithome",
    title: stripTags(match[2]),
    url: match[3],
    platform: "IT之家",
    content_type: "web",
    source_type: "web",
    author: "IT之家",
    published_at: match[1] || null,
    duration: null,
    engagement: null,
    authority_score: 0.84,
    summary: stripTags(match[4]),
    matched_query: query,
    score: Number(((chineseQuery ? 0.95 : 0.72) - index * 0.05).toFixed(4)),
    metadata: {
      term
    }
  }));
}

function parseArxivFeed(xml, query) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.slice(0, 6).map((match, index) => {
    const entry = match[1];
    const title = normalizeWhitespace((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const summary = normalizeWhitespace((entry.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "");
    const id = normalizeWhitespace((entry.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "");
    const publishedAt = normalizeWhitespace((entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || "");
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((item) => normalizeWhitespace(item[1]));

    return {
      id: makeId("document", id),
      connector: "arxiv",
      title,
      url: id,
      platform: "arXiv",
      content_type: "document",
      source_type: "document",
      author: authors.join(", "),
      published_at: publishedAt,
      duration: null,
      engagement: null,
      authority_score: 0.95,
      summary: summary || `arXiv result for ${query}`,
      matched_query: query,
      score: Number((0.93 - index * 0.06).toFixed(4)),
      metadata: {
        authors
      }
    };
  });
}

function parseHackerNewsHits(payload, query) {
  const hits = payload.hits || [];
  return hits.slice(0, 6).map((hit, index) => ({
    id: makeId("forum", hit.objectID),
    connector: "hacker_news",
    title: hit.title || hit.story_title || "Hacker News discussion",
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    platform: "Hacker News",
    content_type: "forum",
    source_type: "forum",
    author: hit.author || "HN user",
    published_at: hit.created_at || null,
    duration: null,
    engagement: (hit.points || 0) + (hit.num_comments || 0),
    authority_score: 0.74,
    summary: stripTags(hit.story_text || hit.comment_text || hit._highlightResult?.title?.value || `Hacker News result for ${query}`),
    matched_query: query,
    score: Number((0.9 - index * 0.06 + Math.min((hit.points || 0) / 500, 0.1)).toFixed(4)),
    metadata: {
      object_id: hit.objectID,
      points: hit.points || 0,
      comments: hit.num_comments || 0,
      external_url: hit.url || null
    }
  }));
}

async function searchBingWeb(query) {
  const markdown = await fetchText(`https://r.jina.ai/http://www.bing.com/search?q=${encodeURIComponent(query)}`);
  return parseBingSearchMarkdown(markdown, query);
}

async function searchHackerNews(query) {
  const payload = await fetchJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=6`);
  return parseHackerNewsHits(payload, query);
}

async function searchSegmentFault(query) {
  const html = await fetchText(`https://segmentfault.com/search?q=${encodeURIComponent(query)}&type=article`);
  return parseSegmentFaultSearchHtml(html, query);
}

async function searchITHome(query) {
  const terms = extractFocusTerms(query);
  const allResults = [];

  for (const term of terms) {
    try {
      const html = await fetchText(`https://www.ithome.com/tag/${encodeURIComponent(term)}/`);
      const results = parseITHomeTagHtml(html, query, term);
      allResults.push(...results);
      if (allResults.length >= 8) {
        break;
      }
    } catch (error) {
      continue;
    }
  }

  return dedupeCandidates(allResults).slice(0, 8);
}

async function searchArxiv(query) {
  const xml = await fetchText(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=6`);
  return parseArxivFeed(xml, query);
}

async function searchBilibili(query) {
  const html = await fetchText(`https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`);
  return parseBilibiliSearchHtml(html, query);
}

async function searchDouyin(query) {
  const normalizedQuery = normalizeWhitespace(String(query || "").replace(/\s+/g, " "));
  const finalQuery = /视频/.test(normalizedQuery) ? normalizedQuery : `${normalizedQuery} 视频`;
  const url = buildDouyinSearchUrl(query);

  return [
    {
      id: makeId("video", url),
      connector: "douyin",
      title: `${finalQuery} - 抖音搜索`,
      url,
      platform: "抖音",
      content_type: "video",
      source_type: "video",
      author: "抖音",
      published_at: null,
      duration: null,
      engagement: null,
      authority_score: 0.78,
      summary: "抖音站内视频搜索入口，适合查中文热点、演讲片段、现场视频和短视频反馈。",
      matched_query: query,
      score: Number((isChineseText(query) ? 0.9 : 0.62).toFixed(4)),
      metadata: {
        search_url: url,
        mode: "search_landing"
      }
    }
  ];
}

async function searchTed(query) {
  const html = await fetchText(`https://www.ted.com/search?q=${encodeURIComponent(query)}`);
  return parseTedSearchHtml(html, query);
}

function dedupeCandidates(candidates) {
  const map = new Map();
  for (const candidate of candidates) {
    const key = candidate.url;
    const current = map.get(key);
    if (!current || candidate.score > current.score) {
      map.set(key, candidate);
    }
  }
  return Array.from(map.values());
}

const connectorRegistry = [
  {
    id: "bing_web",
    label: "Bing Web + Jina Reader",
    description: "通用网页入口，可用于抓官方页、新闻页、长文页，再通过 Jina Reader 做正文抽取。",
    capabilities: ["搜索", "网页", "新闻", "官方页", "正文抽取"],
    search: searchBingWeb,
    read: readWebSource
  },
  {
    id: "hacker_news",
    label: "Hacker News",
    description: "讨论型来源，可用于补充社区观点、原始帖子和高价值评论。",
    capabilities: ["搜索", "讨论", "社区", "评论", "正文抽取"],
    search: searchHackerNews,
    read: readHackerNewsSource
  },
  {
    id: "segmentfault",
    label: "SegmentFault 思否",
    description: "中文开发者社区来源，可用于长文、经验总结、技术背景和教程。",
    capabilities: ["搜索", "长文", "教程", "社区", "正文抽取"],
    search: searchSegmentFault,
    read: readSegmentFaultSource
  },
  {
    id: "ithome",
    label: "IT之家",
    description: "中文科技资讯来源，可用于新闻、产品动态和行业消息。",
    capabilities: ["搜索", "新闻", "动态", "产品", "正文抽取"],
    search: searchITHome,
    read: readITHomeSource
  },
  {
    id: "arxiv",
    label: "arXiv",
    description: "研究型来源，可用于论文、研究摘要和长期技术背景。",
    capabilities: ["搜索", "论文", "研究", "摘要", "正文抽取"],
    search: searchArxiv,
    read: readArxivSource
  },
  {
    id: "bilibili",
    label: "Bilibili",
    description: "中文视频来源，可用于教程、拆解视频、创作者观察和热点反馈。",
    capabilities: ["搜索", "视频", "教程", "中文内容", "视频详情"],
    search: searchBilibili,
    read: readBilibiliSource
  },
  {
    id: "douyin",
    label: "抖音",
    description: "中文短视频来源，可用于热点视频、演讲片段、现场画面和中文短视频反馈。",
    capabilities: ["搜索", "视频", "短视频", "中文内容", "站内搜索入口"],
    search: searchDouyin,
    read: readDouyinSourceV2
  },
  {
    id: "ted",
    label: "TED",
    description: "视频演讲来源，可用于 Talk 页面描述、时长和 transcript。",
    capabilities: ["搜索", "视频", "演讲", "转写", "视频详情"],
    search: searchTed,
    read: readTedSource
  }
];

const connectorMap = new Map(connectorRegistry.map((item) => [item.id, item]));
sourceCatalog = connectorRegistry.map(({ search, read, ...item }) => item);

function resolveDiscoverConnectors(connectorIds) {
  const ids = Array.isArray(connectorIds) ? connectorIds.filter(Boolean) : [];
  if (!ids.length) {
    return connectorRegistry;
  }
  const idSet = new Set(ids);
  return connectorRegistry.filter((connector) => idSet.has(connector.id));
}

async function invokeSourceTool(input) {
  const action = input?.action || "discover";

  if (action === "discover") {
    const query = String(input?.query || "").trim();
    const discoverConnectors = resolveDiscoverConnectors(input?.connector_ids);
    const settled = await Promise.allSettled(discoverConnectors.map((connector) => connector.search(query)));

    const queryTokens = buildQueryTokens(query);
    const results = settled.flatMap((item) => (item.status === "fulfilled" ? item.value : []))
      .map((candidate) => {
        const blob = normalizeWhitespace(`${candidate.title} ${candidate.summary} ${candidate.url}`).toLowerCase();
        const hits = queryTokens.filter((token) => blob.includes(token)).length;
        const relevanceBoost = queryTokens.length ? hits / queryTokens.length : 0.2;
        return normalizeCandidateMediaMetadata({
          ...candidate,
          score: Number((candidate.score + relevanceBoost * 0.35).toFixed(4)),
          metadata: {
            ...(candidate.metadata || {}),
            query_hits: hits
          }
        });
      })
      .filter((candidate) => {
        if (!queryTokens.length) {
          return true;
        }
        return candidate.metadata.query_hits >= 1;
      });

    return dedupeCandidates(results).sort((left, right) => right.score - left.score);
  }

  if (action === "read") {
    const candidate = input?.candidate;
    const connector = connectorMap.get(candidate?.connector);
    if (!connector?.read) {
      throw new Error(`Unsupported connector: ${candidate?.connector}`);
    }
    return connector.read(candidate);
  }

  throw new Error(`Unsupported source tool action: ${action}`);
}

async function searchRealSources(query) {
  return invokeSourceTool({ action: "discover", query });
}

async function readWebSource(candidate) {
  const raw = await fetchText(toReaderUrl(candidate.url));
  const markdown = extractReaderMarkdown(raw);
  return {
    source_id: candidate.id,
    content_type: candidate.content_type || candidate.source_type,
    source_type: candidate.source_type,
    tool: "deep_read_page",
    title: candidate.title,
    url: candidate.url,
    author: candidate.author,
    published_at: candidate.published_at,
    markdown,
    key_points: extractKeyPointsFromText(markdown),
    sections: buildSectionsFromMarkdown(markdown),
    facts: extractNumericFacts(markdown, candidate.id, hostFromUrl(candidate.url) || "web_source")
  };
}

function flattenComments(children, output = [], limit = 4) {
  for (const child of children || []) {
    if (output.length >= limit) {
      break;
    }
    const text = stripTags(child.text || "");
    if (text) {
      output.push({
        author: child.author || "HN user",
        text
      });
    }
    if (child.children?.length) {
      flattenComments(child.children, output, limit);
    }
  }
  return output;
}

async function readHackerNewsSource(candidate) {
  const itemId = candidate.metadata?.object_id;
  const item = await fetchJson(`https://hn.algolia.com/api/v1/items/${itemId}`);
  const comments = flattenComments(item.children || []);
  let articleMarkdown = "";

  if (candidate.metadata?.external_url) {
    try {
      const external = await fetchText(toReaderUrl(candidate.metadata.external_url), { retries: 1, timeoutMs: 20000 });
      articleMarkdown = extractReaderMarkdown(external).slice(0, 8000);
    } catch (error) {
      articleMarkdown = "";
    }
  }

  const markdown = [
    `# ${item.title || candidate.title}`,
    "",
    `来源：Hacker News`,
    candidate.metadata?.external_url ? `原文链接：${candidate.metadata.external_url}` : "",
    "",
    item.text ? stripTags(item.text) : "原帖没有正文，以下为评论摘要。",
    "",
    articleMarkdown ? "## 关联原文摘要\n" : "",
    articleMarkdown || "",
    "",
    comments.length ? "## 高价值评论\n" : "",
    ...comments.map((comment) => `- ${comment.author}: ${comment.text}`)
  ].filter(Boolean).join("\n");

  return {
    source_id: candidate.id,
    content_type: candidate.content_type || candidate.source_type,
    source_type: candidate.source_type,
    tool: "deep_read_page",
    title: candidate.title,
    url: candidate.url,
    author: candidate.author,
    published_at: candidate.published_at,
    markdown,
    key_points: [
      item.text ? stripTags(item.text).slice(0, 220) : "该来源以讨论和评论为主。",
      ...comments.slice(0, 2).map((comment) => `${comment.author}: ${comment.text.slice(0, 180)}`)
    ].filter(Boolean),
    sections: buildSectionsFromMarkdown(markdown),
    facts: extractNumericFacts(markdown, candidate.id, "hacker_news")
  };
}

async function readSegmentFaultSource(candidate) {
  const html = await fetchText(candidate.url);
  const articleMatch = html.match(/<article class="article fmt article-content ">([\s\S]*?)<\/article>/);
  const articleHtml = articleMatch ? articleMatch[1] : "";
  const markdown = [
    `# ${candidate.title}`,
    "",
    candidate.published_at ? `发布时间：${candidate.published_at}` : "",
    candidate.summary,
    "",
    stripTags(articleHtml)
  ].filter(Boolean).join("\n");

  return {
    source_id: candidate.id,
    content_type: candidate.content_type || candidate.source_type,
    source_type: candidate.source_type,
    tool: "deep_read_page",
    title: candidate.title,
    url: candidate.url,
    author: candidate.author,
    published_at: candidate.published_at,
    markdown,
    key_points: extractKeyPointsFromText(markdown),
    sections: buildSectionsFromMarkdown(markdown),
    facts: extractNumericFacts(markdown, candidate.id, "segmentfault")
  };
}

async function readITHomeSource(candidate) {
  const html = await fetchText(candidate.url);
  const contentMatch = html.match(/<div class="post_content\s*" id="paragraph">([\s\S]*?)<\/div>\s*<div class="newserror">/);
  const contentHtml = contentMatch ? contentMatch[1] : "";
  const descriptionMatch = html.match(/<meta name="description" content="([^"]*)"/i);
  const markdown = [
    `# ${candidate.title}`,
    "",
    candidate.published_at ? `发布时间：${candidate.published_at}` : "",
    descriptionMatch ? `摘要：${decodeHtmlEntities(descriptionMatch[1])}` : "",
    "",
    stripTags(contentHtml)
  ].filter(Boolean).join("\n");

  return {
    source_id: candidate.id,
    content_type: candidate.content_type || candidate.source_type,
    source_type: candidate.source_type,
    tool: "deep_read_page",
    title: candidate.title,
    url: candidate.url,
    author: candidate.author,
    published_at: candidate.published_at,
    markdown,
    key_points: extractKeyPointsFromText(markdown),
    sections: buildSectionsFromMarkdown(markdown),
    facts: extractNumericFacts(markdown, candidate.id, "ithome_news")
  };
}

async function readArxivSource(candidate) {
  const idMatch = (candidate.url || "").match(/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  if (idMatch) {
    try {
      const html = await fetchText(`https://export.arxiv.org/abs/${idMatch[1]}`);
      const abstractMatch = html.match(/<blockquote[^>]*class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i);
      const authorsMatch = html.match(/<div[^>]*class="authors"[^>]*>([\s\S]*?)<\/div>/i);
      const historyMatch = html.match(/<div[^>]*class="submission-history"[^>]*>([\s\S]*?)<\/div>/i);
      const abstract = abstractMatch ? abstractMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : candidate.summary;
      const authors = authorsMatch ? authorsMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : candidate.author;
      const history = historyMatch ? historyMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
      const markdown = [`# ${candidate.title}`, "", `作者：${authors}`, candidate.published_at ? `发布时间：${candidate.published_at}` : "", history ? `提交历史：${history}` : "", "", abstract].filter(Boolean).join("\n");
      return {
        source_id: candidate.id,
        content_type: candidate.content_type || candidate.source_type,
        source_type: candidate.source_type,
        tool: "deep_read_page",
        title: candidate.title,
        url: candidate.url,
        author: authors,
        published_at: candidate.published_at,
        markdown,
        key_points: extractKeyPointsFromText(markdown),
        sections: buildSectionsFromMarkdown(markdown),
        facts: extractNumericFacts(markdown, candidate.id, "arxiv")
      };
    } catch (_) {
      // fall through to metadata-only path
    }
  }

  const markdown = [`# ${candidate.title}`, "", `作者：${candidate.author || "未知作者"}`, candidate.published_at ? `发布时间：${candidate.published_at}` : "", "", candidate.summary].filter(Boolean).join("\n");
  return {
    source_id: candidate.id,
    content_type: candidate.content_type || candidate.source_type,
    source_type: candidate.source_type,
    tool: "deep_read_page",
    title: candidate.title,
    url: candidate.url,
    author: candidate.author,
    published_at: candidate.published_at,
    markdown,
    key_points: extractKeyPointsFromText(markdown),
    sections: buildSectionsFromMarkdown(markdown),
    facts: extractNumericFacts(markdown, candidate.id, "arxiv")
  };
}

function formatUnixTimestamp(value) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return new Date(Number(value) * 1000).toISOString();
}

function extractBilibiliState(html) {
  const marker = "window.__INITIAL_STATE__=";
  const start = html.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const end = html.indexOf("};(function()", start);
  if (end === -1) {
    return null;
  }
  return JSON.parse(html.slice(start + marker.length, end + 1));
}

const EDGE_EXECUTABLE_CANDIDATES = [
  process.env.OPENSEARCH_EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

function fileExists(value) {
  try {
    return fs.existsSync(value);
  } catch (error) {
    return false;
  }
}

function findEdgeExecutable() {
  return EDGE_EXECUTABLE_CANDIDATES.find((candidate) => fileExists(candidate)) || null;
}

function requestJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error(`Timed out waiting for ${url}`));
    });
    request.on("error", reject);
  });
}

function pickOpenPort() {
  return 9200 + Math.floor(Math.random() * 700);
}

function waitForWebSocketDebuggerUrl(port, urlHint, timeoutMs = 15000) {
  const startedAt = Date.now();

  return new Promise(async (resolve, reject) => {
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const targets = await requestJson(`http://127.0.0.1:${port}/json/list`);
        const match = urlHint
          ? targets.find((target) => target.type === "page" && String(target.url || "").includes(urlHint))
          : targets.find((target) => target.type === "page");
        if (match?.webSocketDebuggerUrl) {
          resolve(match.webSocketDebuggerUrl);
          return;
        }
      } catch (error) {
        // Edge is still starting up.
      }
      await sleep(350);
    }

    reject(new Error(`Unable to attach to Edge debugger on port ${port}`));
  });
}

function createCdpClient(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(new Error("WebSocket is not available in this Node runtime"));
      return;
    }

    const socket = new WebSocket(webSocketDebuggerUrl);
    let nextId = 0;
    const pending = new Map();

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (!message.id || !pending.has(message.id)) {
          return;
        }
        const handler = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          handler.reject(new Error(message.error.message || "CDP request failed"));
        } else {
          handler.resolve(message.result);
        }
      } catch (error) {
        // Ignore non-JSON messages.
      }
    });

    socket.addEventListener("error", (error) => {
      reject(error);
    }, { once: true });

    socket.addEventListener("open", () => {
      resolve({
        async send(method, params = {}) {
          return new Promise((innerResolve, innerReject) => {
            const id = ++nextId;
            pending.set(id, {
              resolve: innerResolve,
              reject: innerReject
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try {
            socket.close();
          } catch (error) {
            // Ignore close errors.
          }
        }
      });
    }, { once: true });
  });
}

async function captureRenderedPage(url, options = {}) {
  const edgeExecutable = findEdgeExecutable();
  if (!edgeExecutable) {
    return null;
  }

  const port = pickOpenPort();
  const profileDir = path.join(os.tmpdir(), `opensearch-edge-${process.pid}-${Date.now()}-${port}`);
  const waitMs = options.waitMs || 7000;
  const browser = spawn(edgeExecutable, [
    `--remote-debugging-port=${port}`,
    "--headless=new",
    "--disable-gpu",
    "--mute-audio",
    `--user-data-dir=${profileDir}`,
    url
  ], { stdio: ["ignore", "ignore", "ignore"] });

  let client = null;
  try {
    const debuggerUrl = await waitForWebSocketDebuggerUrl(port, "douyin.com");
    client = await createCdpClient(debuggerUrl);
    await client.send("Runtime.enable");
    await sleep(waitMs);

    const expression = `(() => JSON.stringify({
      finalUrl: location.href,
      title: document.title,
      heading: document.querySelector("h1")?.innerText || "",
      subheadings: Array.from(document.querySelectorAll("h2")).map((node) => node.innerText).filter(Boolean).slice(0, 8),
      bodyText: document.body?.innerText || "",
      videos: Array.from(document.querySelectorAll("video")).slice(0, 2).map((video) => ({
        src: video.currentSrc || video.src || "",
        poster: video.poster || "",
        duration: Number.isFinite(video.duration) ? video.duration : null,
        muted: Boolean(video.muted),
        paused: Boolean(video.paused)
      })),
      jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((node) => node.textContent || "").slice(0, 6)
    }))()`;

    const result = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    return result?.result?.value ? JSON.parse(result.result.value) : null;
  } finally {
    if (client) {
      client.close();
    }
    try {
      browser.kill("SIGKILL");
    } catch (error) {
      // Ignore browser shutdown errors.
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup failures.
    }
  }
}

function parseDouyinJsonLdAuthor(jsonLdList) {
  for (const raw of jsonLdList || []) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.["@type"] !== "BreadcrumbList") {
        continue;
      }
      const author = parsed.itemListElement?.find((item) => Number(item.position) === 2)?.name;
      if (author) {
        return author;
      }
    } catch (error) {
      continue;
    }
  }
  return null;
}

function formatDouyinPublishedAt(value) {
  const normalized = normalizeWhitespace(String(value || ""));
  const match = normalized.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
  if (!match) {
    return normalized || null;
  }

  const candidate = `${match[1].replace(" ", "T")}:00+08:00`;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? normalized : date.toISOString();
}

function parseDouyinRenderedPage(payload) {
  if (!payload?.bodyText) {
    return null;
  }

  const bodyText = String(payload.bodyText || "");
  if (/验证码中间页|请完成验证|验证后继续/.test(bodyText)) {
    return null;
  }

  const lines = bodyText
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  const title = normalizeWhitespace((payload.heading || payload.title || "").replace(/\s*-\s*抖音$/, ""));
  const publishedLine = lines.find((line) => /^发布时间[:：]/.test(line)) || "";
  const publishedAtLabel = publishedLine ? normalizeWhitespace(publishedLine.replace(/^发布时间[:：]\s*/, "")) : null;
  const publishedAt = formatDouyinPublishedAt(publishedAtLabel);
  const publishedIndex = publishedLine ? lines.indexOf(publishedLine) : -1;
  let author = parseDouyinJsonLdAuthor(payload.jsonLd);

  if (!author && publishedIndex !== -1) {
    for (let index = publishedIndex + 1; index < Math.min(lines.length, publishedIndex + 6); index += 1) {
      const line = lines[index];
      if (!line || /^(粉丝|获赞|关注|推荐视频|举报|私信|点击加载更多)/.test(line)) {
        continue;
      }
      author = line;
      break;
    }
  }

  let authorStats = null;
  if (author && publishedIndex !== -1) {
    const authorIndex = lines.findIndex((line, index) => index > publishedIndex && line === author);
    if (authorIndex !== -1) {
      authorStats = lines.slice(authorIndex + 1, authorIndex + 4).find((line) => /粉丝|获赞/.test(line)) || null;
    }
  }

  const metrics = [];
  const reportIndex = lines.findIndex((line) => line === "举报");
  if (reportIndex !== -1) {
    for (let index = reportIndex - 1; index >= 0 && metrics.length < 4; index -= 1) {
      const line = lines[index];
      if (/^[\d.]+(?:万|亿)?$/.test(line)) {
        metrics.unshift(line);
        continue;
      }
      if (metrics.length) {
        break;
      }
    }
  }

  const chapterIndex = lines.findIndex((line) => line === "章节要点");
  const timeline = [];
  if (chapterIndex !== -1) {
    for (let index = chapterIndex + 1; index < Math.min(lines.length, chapterIndex + 20); index += 1) {
      const timeMatch = lines[index].match(/^(\d{2}:\d{2}(?::\d{2})?)$/);
      if (!timeMatch || !lines[index + 1]) {
        continue;
      }
      const summary = lines[index + 1];
      if (/^第\d+集/.test(summary) || summary === "下一章") {
        continue;
      }
      timeline.push({
        start: timeMatch[1],
        title: summary.slice(0, 42),
        summary: summary.slice(0, 220)
      });
      index += 1;
    }
  }

  const primaryVideo = (payload.videos || []).find((video) => video?.src) || (payload.videos || [])[0] || null;
  const seriesTitle = (payload.subheadings || []).find((heading) => heading && heading !== "推荐视频") || null;

  return {
    title: title || null,
    author: author || null,
    published_at: publishedAt,
    published_label: publishedAtLabel,
    author_stats: authorStats,
    metrics,
    series_title: seriesTitle,
    duration: primaryVideo?.duration ? timestampFromMilliseconds(primaryVideo.duration * 1000) : null,
    video_src: primaryVideo?.src || null,
    poster: primaryVideo?.poster || null,
    timeline
  };
}

async function readBilibiliSource(candidate) {
  const html = await fetchText(candidate.url);
  const state = extractBilibiliState(html);
  if (!state?.videoData) {
    throw new Error(`Bilibili state parse failed for ${candidate.url}`);
  }

  const video = state.videoData;
  const descriptionMeta = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
  const description = stripTags(video.desc || decodeHtmlEntities(descriptionMeta?.[1] || candidate.summary));
  const stats = video.stat || {};
  const duration = timestampFromMilliseconds((video.duration || 0) * 1000);
  
  // 尝试使用新的视频转文本功能
  let transcript = [];
  let timeline = [];
  let keyPoints = [
    description.slice(0, 220),
    `作者 ${video.owner?.name || candidate.author}，播放 ${stats.view || 0}，点赞 ${stats.like || 0}，评论 ${stats.reply || 0}。`
  ].filter(Boolean);
  
  try {
    const transcribeResult = await transcribeVideo(candidate.url);
    if (transcribeResult.success) {
      transcript = transcribeResult.transcript || [];
      timeline = transcribeResult.timeline || [];
      if (transcribeResult.key_points && transcribeResult.key_points.length > 0) {
        keyPoints = [...transcribeResult.key_points, ...keyPoints];
      }
    }
  } catch (error) {
    console.warn(`Bilibili视频转文本失败: ${error.message}`);
  }
  
  const markdown = [
    `# ${video.title || candidate.title}`,
    "",
    `作者：${video.owner?.name || candidate.author || "Bilibili UP 主"}`,
    formatUnixTimestamp(video.pubdate) ? `发布时间：${formatUnixTimestamp(video.pubdate)}` : "",
    duration ? `时长：${duration}` : "",
    "",
    description,
    "",
    `播放：${stats.view || 0}，点赞：${stats.like || 0}，评论：${stats.reply || 0}，收藏：${stats.favorite || 0}`
  ].filter(Boolean).join("\n");

  return {
    source_id: candidate.id,
    content_type: candidate.content_type || candidate.source_type,
    source_type: candidate.source_type,
    tool: "extract_video_intel",
    title: video.title || candidate.title,
    url: candidate.url,
    author: video.owner?.name || candidate.author,
    published_at: formatUnixTimestamp(video.pubdate),
    duration,
    markdown,
    transcript,
    timeline,
    key_points: keyPoints,
    key_frames: keyPoints,
    facts: extractNumericFacts(`${description}\n${markdown}`, candidate.id, "bilibili_video")
  };
}

async function readDouyinSource(candidate) {
  let pageTitle = candidate.title;
  let markdown = "";

  const keyPoints = [candidate.summary].filter(Boolean);
  try {
    const html = await fetchText(candidate.url, { timeoutMs: 10000, retries: 0 });
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      pageTitle = stripTags(titleMatch[1]);
    }
    // Try to extract structured video cards from embedded JSON
    const jsonMatch = html.match(/\bRENDER_DATA\s*=\s*(\{[\s\S]*?\})(?=<\/script>)/) ||
      html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(decodeURIComponent(jsonMatch[1]));
        const items = (
          data?.data?.data ||
          data?.props?.pageProps?.videoList ||
          []
        ).slice(0, 3);
        for (const item of items) {
          const desc = item?.aweme_info?.desc || item?.desc || item?.title;
          const author = item?.aweme_info?.author?.nickname || item?.author?.nickname;
          const plays = item?.aweme_info?.statistics?.play_count || item?.statistics?.play_count;
          const likes = item?.aweme_info?.statistics?.digg_count || item?.statistics?.digg_count;
          if (desc) {
            keyPoints.push([
              desc,
              author ? `作者：${author}` : "",
              plays ? `播放：${plays}` : "",
              likes ? `点赞：${likes}` : ""
            ].filter(Boolean).join(" | "));
          }
        }
      } catch (_) { /* ignore parse errors */ }
    }
  } catch (_) {
    // Keep the search-landing fallback when Douyin anti-bot blocks detail reads.
  }

  markdown = [
    `# ${pageTitle}`,
    "",
    "该来源当前以抖音站内搜索入口方式接入。",
    `搜索链接：${candidate.url}`,
    "",
    ...keyPoints
  ].filter(Boolean).join("\n");

  return {
    source_id: candidate.id,
    content_type: candidate.content_type || candidate.source_type,
    source_type: candidate.source_type,
    tool: "extract_video_intel",
    title: pageTitle,
    url: candidate.url,
    author: candidate.author,
    published_at: candidate.published_at,
    duration: null,
    markdown,
    transcript: [],
    timeline: [],
    key_points: keyPoints.length > 1 ? keyPoints : [candidate.summary, "当前接入方式是抖音站内搜索页，适合把用户带到中文短视频站点继续查看。"].filter(Boolean),
    key_frames: [candidate.summary].filter(Boolean),
    facts: extractNumericFacts(markdown, candidate.id, "douyin_search")
  };
}

function parseDouyinRenderedPageSafe(payload) {
  if (!payload?.bodyText) {
    return null;
  }

  const bodyText = String(payload.bodyText || "");
  if (/\u9a8c\u8bc1|\u4e2d\u95f4\u9875|\u5b8c\u6210\u9a8c\u8bc1/.test(bodyText)) {
    return null;
  }

  const lines = bodyText
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  const title = normalizeWhitespace((payload.heading || payload.title || "").replace(/\s*-\s*\u6296\u97f3$/, ""));
  const publishedLine = lines.find((line) => /^\u53d1\u5e03\u65f6\u95f4[:\uff1a]/.test(line)) || "";
  const publishedAtLabel = publishedLine
    ? normalizeWhitespace(publishedLine.replace(/^\u53d1\u5e03\u65f6\u95f4[:\uff1a]\s*/, ""))
    : null;
  const publishedAt = formatDouyinPublishedAt(publishedAtLabel);
  const publishedIndex = publishedLine ? lines.indexOf(publishedLine) : -1;
  let author = parseDouyinJsonLdAuthor(payload.jsonLd);

  if (!author && publishedIndex !== -1) {
    for (let index = publishedIndex + 1; index < Math.min(lines.length, publishedIndex + 6); index += 1) {
      const line = lines[index];
      if (!line || /^(?:\u7c89\u4e1d|\u83b7\u8d5e|\u5173\u6ce8|\u63a8\u8350\u89c6\u9891|\u4e3e\u62a5|\u79c1\u4fe1|\u70b9\u51fb\u52a0\u8f7d\u66f4\u591a)/.test(line)) {
        continue;
      }
      author = line;
      break;
    }
  }

  let authorStats = null;
  if (author && publishedIndex !== -1) {
    const authorIndex = lines.findIndex((line, index) => index > publishedIndex && line === author);
    if (authorIndex !== -1) {
      authorStats = lines.slice(authorIndex + 1, authorIndex + 4).find((line) => /\u7c89\u4e1d|\u83b7\u8d5e/.test(line)) || null;
    }
  }

  const metrics = [];
  const reportIndex = lines.findIndex((line) => line === "\u4e3e\u62a5");
  if (reportIndex !== -1) {
    for (let index = reportIndex - 1; index >= 0 && metrics.length < 4; index -= 1) {
      const line = lines[index];
      if (/^[\d.]+(?:\u4e07|\u4ebf)?$/.test(line)) {
        metrics.unshift(line);
        continue;
      }
      if (metrics.length) {
        break;
      }
    }
  }

  const chapterIndex = lines.findIndex((line) => line === "\u7ae0\u8282\u8981\u70b9");
  const timeline = [];
  if (chapterIndex !== -1) {
    for (let index = chapterIndex + 1; index < Math.min(lines.length, chapterIndex + 20); index += 1) {
      const timeMatch = lines[index].match(/^(\d{2}:\d{2}(?::\d{2})?)$/);
      if (!timeMatch || !lines[index + 1]) {
        continue;
      }
      const summary = lines[index + 1];
      if (/^\u7b2c\d+\u96c6/.test(summary) || summary === "\u4e0b\u4e00\u7ae0") {
        continue;
      }
      timeline.push({
        start: timeMatch[1],
        title: summary.slice(0, 42),
        summary: summary.slice(0, 220)
      });
      index += 1;
    }
  }

  const primaryVideo = (payload.videos || []).find((video) => video?.src) || (payload.videos || [])[0] || null;
  const seriesTitle = (payload.subheadings || []).find((heading) => heading && heading !== "\u63a8\u8350\u89c6\u9891") || null;

  return {
    title: title || null,
    author: author || null,
    published_at: publishedAt,
    published_label: publishedAtLabel,
    author_stats: authorStats,
    metrics,
    series_title: seriesTitle,
    duration: primaryVideo?.duration ? timestampFromMilliseconds(primaryVideo.duration * 1000) : null,
    video_src: primaryVideo?.src || null,
    poster: primaryVideo?.poster || null,
    timeline
  };
}

async function readDouyinSourceV2(candidate) {
  const detailUrl = /\/video\/\d+|modal_id=/.test(candidate.url) ? candidate.url : null;
  if (detailUrl) {
    try {
      const rendered = await captureRenderedPage(detailUrl);
      const parsed = parseDouyinRenderedPageSafe(rendered);
      if (parsed?.title) {
        let keyPoints = [
          parsed.series_title ? `\u7cfb\u5217\uff1a${parsed.series_title}` : "",
          parsed.author ? `\u4f5c\u8005\uff1a${parsed.author}` : "",
          parsed.published_label ? `\u53d1\u5e03\u65f6\u95f4\uff1a${parsed.published_label}` : "",
          parsed.author_stats ? `\u8d26\u53f7\u6982\u51b5\uff1a${parsed.author_stats}` : "",
          parsed.metrics.length ? `\u4e92\u52a8\u6307\u6807\uff1a${parsed.metrics.join(" / ")}` : ""
        ].filter(Boolean);
        let timeline = parsed.timeline;
        let transcript = [];
        
        // 尝试使用新的视频转文本功能
        try {
          const transcribeResult = await transcribeVideo(detailUrl);
          if (transcribeResult.success) {
            transcript = transcribeResult.transcript || [];
            if (transcribeResult.timeline && transcribeResult.timeline.length > 0) {
              timeline = transcribeResult.timeline;
            }
            if (transcribeResult.key_points && transcribeResult.key_points.length > 0) {
              keyPoints = [...transcribeResult.key_points, ...keyPoints];
            }
          }
        } catch (error) {
          console.warn(`抖音视频转文本失败: ${error.message}`);
        }
        
        const markdown = [
          `# ${parsed.title}`,
          "",
          parsed.series_title ? `\u7cfb\u5217\uff1a${parsed.series_title}` : "",
          parsed.author ? `\u4f5c\u8005\uff1a${parsed.author}` : "",
          parsed.published_label ? `\u53d1\u5e03\u65f6\u95f4\uff1a${parsed.published_label}` : "",
          parsed.duration ? `\u65f6\u957f\uff1a${parsed.duration}` : "",
          parsed.author_stats ? `\u8d26\u53f7\u6982\u51b5\uff1a${parsed.author_stats}` : "",
          parsed.metrics.length ? `\u4e92\u52a8\u6307\u6807\uff1a${parsed.metrics.join(" / ")}` : "",
          "",
          candidate.summary ? `\u6765\u6e90\u6458\u8981\uff1a${candidate.summary}` : "",
          timeline.length ? "## \u7ae0\u8282\u8981\u70b9" : "",
          ...timeline.map((item) => `- [${item.start}] ${item.summary}`)
        ].filter(Boolean).join("\n");

        return {
          source_id: candidate.id,
          content_type: candidate.content_type || candidate.source_type,
          source_type: candidate.source_type,
          tool: "extract_video_intel",
          title: parsed.title,
          url: rendered?.finalUrl || candidate.url,
          author: parsed.author || candidate.author,
          published_at: parsed.published_at || candidate.published_at,
          duration: parsed.duration,
          markdown,
          transcript,
          timeline,
          key_points: keyPoints.length ? keyPoints : [candidate.summary].filter(Boolean),
          key_frames: [
            parsed.title,
            ...timeline.slice(0, 2).map((item) => item.summary)
          ].filter(Boolean),
          facts: extractNumericFacts(markdown, candidate.id, "douyin_video")
        };
      }
    } catch (error) {
      // Fall through to the search-landing fallback.
    }
  }

  return readDouyinSource(candidate);
}

async function readTedSource(candidate) {
  const transcriptUrl = `${candidate.url}/transcript?language=en`;
  const html = await fetchText(transcriptUrl);
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!nextDataMatch) {
    throw new Error(`TED transcript parse failed for ${candidate.url}`);
  }

  const nextData = JSON.parse(nextDataMatch[1]);
  const pageProps = nextData.props?.pageProps || {};
  const transcriptData = pageProps.transcriptData?.translation?.paragraphs || [];
  const videoData = pageProps.videoData || {};
  const playerData = videoData.playerData ? JSON.parse(videoData.playerData) : {};
  const cues = transcriptData
    .flatMap((paragraph) => paragraph.cues || [])
    .map((cue) => ({
      start: cue.time,
      text: normalizeWhitespace(cue.text)
    }))
    .filter((cue) => cue.text);

  const description = pageProps.description || candidate.summary;
  const timeline = buildTranscriptTimeline(cues);
  let transcript = cues;
  let keyPoints = [description ? description.slice(0, 220) : "TED talk"];
  
  // 尝试使用新的视频转文本功能作为补充
  try {
    const transcribeResult = await transcribeVideo(candidate.url);
    if (transcribeResult.success) {
      if (transcribeResult.transcript && transcribeResult.transcript.length > 0) {
        transcript = transcribeResult.transcript;
      }
      if (transcribeResult.timeline && transcribeResult.timeline.length > 0) {
        timeline = transcribeResult.timeline;
      }
      if (transcribeResult.key_points && transcribeResult.key_points.length > 0) {
        keyPoints = [...transcribeResult.key_points, ...keyPoints];
      }
    }
  } catch (error) {
    console.warn(`TED视频转文本失败: ${error.message}`);
  }
  
  const transcriptText = transcript.map((cue) => `[${cue.start}] ${cue.text}`).join("\n");

  return {
    source_id: candidate.id,
    content_type: candidate.content_type || candidate.source_type,
    source_type: candidate.source_type,
    tool: "extract_video_intel",
    title: pageProps.title || candidate.title,
    url: candidate.url,
    author: candidate.author,
    published_at: candidate.published_at,
    duration: playerData.duration ? timestampFromMilliseconds(playerData.duration * 1000) : null,
    transcript,
    timeline,
    key_points: keyPoints,
    key_frames: [
      description ? description.slice(0, 220) : "TED talk",
      ...(timeline.slice(0, 2).map((item) => item.summary))
    ],
    facts: extractNumericFacts(`${description}\n${transcriptText}`, candidate.id, "ted_talk")
  };
}

async function readCandidate(candidate) {
  return invokeSourceTool({ action: "read", candidate });
}

function inferConnectorIdFromUrl(url) {
  const hostname = hostFromUrl(url);
  if (/bilibili\.com$/.test(hostname)) return "bilibili";
  if (/douyin\.com$/.test(hostname) || /iesdouyin\.com$/.test(hostname)) return "douyin";
  if (/ted\.com$/.test(hostname)) return "ted";
  if (/segmentfault\.com$/.test(hostname)) return "segmentfault";
  if (/ithome\.com$/.test(hostname)) return "ithome";
  if (/arxiv\.org$/.test(hostname)) return "arxiv";
  if (/news\.ycombinator\.com$/.test(hostname) || /ycombinator\.com$/.test(hostname)) return "hacker_news";
  return "bing_web";
}

function contentTypeForConnector(connectorId) {
  if (connectorId === "bilibili" || connectorId === "douyin" || connectorId === "ted") {
    return "video";
  }
  if (connectorId === "segmentfault" || connectorId === "arxiv") {
    return "document";
  }
  if (connectorId === "hacker_news") {
    return "forum";
  }
  return "web";
}

function buildCandidateFromToolInput(toolId, input) {
  if (input?.candidate?.url) {
    return input.candidate;
  }

  const url = String(input?.url || "").trim();
  if (!url) {
    throw new Error("Either candidate or url is required");
  }

  const connector = input?.connector || inferConnectorIdFromUrl(url);
  const inferredDocumentKind = inferDocumentKindFromUrl(url, input?.metadata);
  const contentType = input?.content_type || (inferredDocumentKind !== "webpage" ? "document" : contentTypeForConnector(connector));

  if (toolId === "extract_video_intel" && contentType !== "video") {
    throw new Error(`extract_video_intel does not support inferred connector ${connector}`);
  }
  if (toolId === "deep_read_page" && contentType === "video") {
    throw new Error("Use extract_video_intel for video sources");
  }

  return normalizeCandidateMediaMetadata({
    id: makeId(contentType === "video" ? "video" : "web", url),
    connector,
    title: input?.title || url,
    url,
    platform: input?.platform || hostFromUrl(url),
    content_type: contentType,
    source_type: contentType,
    author: input?.author || null,
    published_at: input?.published_at || null,
    summary: input?.summary || "",
    metadata: input?.metadata || {}
  });
}

async function executeReadTool(toolId, input) {
  const candidate = buildCandidateFromToolInput(toolId, input);
  const documentKind = inferDocumentKindFromUrl(candidate.url, candidate.metadata);
  if (toolId !== "extract_video_intel" && documentKind !== "webpage" && candidate.connector !== "arxiv") {
    return readDocumentSource(candidate);
  }
  const connector = connectorMap.get(candidate.connector);
  if (!connector?.read) {
    throw new Error(`Unsupported connector: ${candidate.connector}`);
  }
  return connector.read(candidate);
}

// 注册核心工具
ToolRegistry.registerTool({
  id: 'layout_analysis',
  name: 'Layout Analysis',
  description: 'Scan a complex document and return page/block level modality hints plus parser task suggestions.',
  parameters: [
    {
      name: 'url',
      type: 'string',
      required: false,
      description: 'Document URL'
    },
    {
      name: 'candidate',
      type: 'object',
      required: false,
      description: 'Structured document candidate'
    },
    {
      name: 'read',
      type: 'object',
      required: false,
      description: 'Optional pre-read document snapshot to avoid re-reading the same source'
    }
  ],
  validate(input) {
    if (!input?.read && !input?.url && !input?.candidate?.url) {
      throw new Error('Either read, url, or candidate.url is required');
    }
  },
  async execute(input) {
    const candidate = buildCandidateFromToolInput('layout_analysis', input);
    return analyzeDocumentLayout(candidate, input.read || null);
  }
});

ToolRegistry.registerTool({
  id: 'read_document_intel',
  name: 'Read Document Intel',
  description: 'Read PDFs, tables, and complex documents with native parsing plus optional model-assisted summarization.',
  parameters: [
    {
      name: 'url',
      type: 'string',
      required: false,
      description: 'Document URL'
    },
    {
      name: 'candidate',
      type: 'object',
      required: false,
      description: 'Structured document candidate'
    }
  ],
  validate(input) {
    if (!input?.url && !input?.candidate?.url) {
      throw new Error('Either url or candidate.url is required');
    }
  },
  async execute(input) {
    const candidate = buildCandidateFromToolInput('read_document_intel', input);
    return readDocumentSource(candidate);
  }
});

ToolRegistry.registerTool({
  id: 'analyze_document_multimodal',
  name: 'Analyze Document Multimodal',
  description: 'Use a multimodal LLM to analyze complex documents, optionally with page images for charts and layout-heavy pages.',
  parameters: [
    {
      name: 'url',
      type: 'string',
      required: false,
      description: 'Document URL'
    },
    {
      name: 'candidate',
      type: 'object',
      required: false,
      description: 'Structured document candidate'
    },
    {
      name: 'markdown',
      type: 'string',
      required: false,
      description: 'Extracted document text'
    },
    {
      name: 'page_images',
      type: 'array',
      required: false,
      description: 'Optional document page images'
    }
  ],
  validate(input) {
    if (!input?.url && !input?.candidate?.url) {
      throw new Error('Either url or candidate.url is required');
    }
  },
  async execute(input) {
    const candidate = buildCandidateFromToolInput('analyze_document_multimodal', input);
    return analyzeDocumentWithMultimodalModel({
      url: candidate.url,
      title: candidate.title,
      document_kind: inferDocumentKindFromUrl(candidate.url, candidate.metadata),
      markdown: input.markdown || "",
      page_images: input.page_images || candidate.metadata?.page_images || []
    });
  }
});

ToolRegistry.registerTool({
  id: 'deep_read_page',
  name: 'Deep Read Page',
  description: 'Read web or document sources through the shared connector layer.',
  parameters: [
    {
      name: 'url',
      type: 'string',
      required: false,
      description: 'Target page URL'
    },
    {
      name: 'candidate',
      type: 'object',
      required: false,
      description: 'Structured source candidate from the planner'
    },
    {
      name: 'timeout',
      type: 'number',
      required: false,
      description: 'Timeout in milliseconds',
      default: 20000
    }
  ],
  validate(input) {
    if (!input?.url && !input?.candidate?.url) {
      throw new Error('Either url or candidate.url is required');
    }
  },
  async execute(input) {
    return executeReadTool('deep_read_page', input);
  }
});

ToolRegistry.registerTool({
  id: 'extract_video_intel',
  name: 'Extract Video Intel',
  description: 'Read supported video sources through the shared connector layer.',
  parameters: [
    {
      name: 'url',
      type: 'string',
      required: false,
      description: 'Video URL'
    },
    {
      name: 'candidate',
      type: 'object',
      required: false,
      description: 'Structured video candidate from the planner'
    },
    {
      name: 'timeout',
      type: 'number',
      required: false,
      description: 'Timeout in milliseconds',
      default: 30000
    }
  ],
  validate(input) {
    if (!input?.url && !input?.candidate?.url) {
      throw new Error('Either url or candidate.url is required');
    }
  },
  async execute(input) {
    return executeReadTool('extract_video_intel', input);
  }
});

ToolRegistry.registerTool({
  id: 'cross_check_facts',
  name: 'Cross Check Facts',
  description: 'Verify structured evidence items and explain conflicts.',
  parameters: [
    {
      name: 'evidenceItems',
      type: 'array',
      required: true,
      description: 'Evidence items for verification'
    }
  ],
  validate(input) {
    if (!Array.isArray(input?.evidenceItems)) {
      throw new Error('Evidence items is required and must be an array');
    }
  },
  async execute(input) {
    return verifyEvidenceUnits(input.evidenceItems);
  }
});

// 图文理解工具
ToolRegistry.registerTool({
  id: 'analyze_image',
  name: 'Analyze Image',
  description: 'Analyze image content and answer questions about it.',
  parameters: [
    {
      name: 'imageUrl',
      type: 'string',
      required: false,
      description: 'Image URL to analyze'
    },
    {
      name: 'imagePath',
      type: 'string',
      required: false,
      description: 'Local image path to analyze'
    },
    {
      name: 'question',
      type: 'string',
      required: false,
      description: 'Question about the image'
    },
    {
      name: 'analysisType',
      type: 'string',
      required: false,
      description: 'Type of analysis (description, objects, text, faces)',
      default: 'description'
    }
  ],
  validate(input) {
    if (!input?.imageUrl && !input?.imagePath) {
      throw new Error('Either imageUrl or imagePath is required');
    }
  },
  async execute(input) {
    const { imageUrl, imagePath, question, analysisType = 'description' } = input;
    
    // 模拟图像分析（实际项目中应集成真实的图像分析API）
    return {
      success: true,
      data: {
        imageSource: imageUrl || imagePath,
        analysisType,
        question,
        analysis: {
          description: `Analyzing ${analysisType} for image: ${imageUrl || imagePath}`,
          objects: ['person', 'building', 'vehicle'],
          text: 'Sample text detected in image',
          faces: 2,
          confidence: 0.85
        },
        answer: question ? `Answer to: ${question}` : 'No question provided'
      }
    };
  }
});

// 图文搜索工具
ToolRegistry.registerTool({
  id: 'image_search',
  name: 'Image Search',
  description: 'Search for images based on text query or image similarity.',
  parameters: [
    {
      name: 'query',
      type: 'string',
      required: false,
      description: 'Text query for image search'
    },
    {
      name: 'imageUrl',
      type: 'string',
      required: false,
      description: 'Image URL for similarity search'
    },
    {
      name: 'count',
      type: 'number',
      required: false,
      description: 'Number of results to return',
      default: 5
    }
  ],
  validate(input) {
    if (!input?.query && !input?.imageUrl) {
      throw new Error('Either query or imageUrl is required');
    }
  },
  async execute(input) {
    const { query, imageUrl, count = 5 } = input;
    
    // 模拟图像搜索（实际项目中应集成真实的图像搜索API）
    return {
      success: true,
      data: {
        searchQuery: query || `Similar to: ${imageUrl}`,
        results: Array.from({ length: count }, (_, i) => ({
          id: `image_${i + 1}`,
          url: `https://example.com/image${i + 1}.jpg`,
          title: `Image result ${i + 1}`,
          confidence: 0.8 - (i * 0.1),
          tags: ['relevant', 'high quality']
        }))
      }
    };
  }
});

// 视频转文本工具
ToolRegistry.registerTool({
  id: 'transcribe_video',
  name: 'Transcribe Video',
  description: 'Convert video to text using ARS API or open-source model. First converts video to MP3, then transcribes audio to text.',
  parameters: [
    {
      name: 'videoUrl',
      type: 'string',
      required: true,
      description: 'Video URL to transcribe'
    },
    {
      name: 'method',
      type: 'string',
      required: false,
      description: 'Transcription method: "auto" (default), "ars_api", or "open_source_model"',
      default: 'auto'
    }
  ],
  validate(input) {
    if (!input?.videoUrl) {
      throw new Error('videoUrl is required');
    }
  },
  async execute(input) {
    const { videoUrl, method = 'auto' } = input;
    
    const originalArsEnabled = VIDEO_PROCESSING_CONFIG.arsApi.enabled;
    const originalOpenSourceEnabled = VIDEO_PROCESSING_CONFIG.openSourceModel.enabled;
    
    try {
      if (method === 'ars_api') {
        VIDEO_PROCESSING_CONFIG.arsApi.enabled = true;
        VIDEO_PROCESSING_CONFIG.openSourceModel.enabled = false;
      } else if (method === 'open_source_model') {
        VIDEO_PROCESSING_CONFIG.arsApi.enabled = false;
        VIDEO_PROCESSING_CONFIG.openSourceModel.enabled = true;
      }
      
      const result = await transcribeVideo(videoUrl);
      return result;
    } finally {
      VIDEO_PROCESSING_CONFIG.arsApi.enabled = originalArsEnabled;
      VIDEO_PROCESSING_CONFIG.openSourceModel.enabled = originalOpenSourceEnabled;
    }
  }
});

// 搜索工具
ToolRegistry.registerTool({
  id: 'search_sources',
  name: 'Search Sources',
  description: 'Search for relevant sources across multiple connectors including web, video, document, and forum sources.',
  parameters: [
    {
      name: 'query',
      type: 'string',
      required: true,
      description: 'Search query to find relevant sources'
    },
    {
      name: 'connector_ids',
      type: 'array',
      required: false,
      description: 'Specific connector IDs to search (e.g., ["web", "video", "document", "forum"])'
    }
  ],
  validate(input) {
    if (!input?.query || typeof input.query !== 'string') {
      throw new Error('Query is required and must be a string');
    }
  },
  async execute(input) {
    const { query, connector_ids } = input;
    return invokeSourceTool({
      action: "discover",
      query,
      connector_ids
    });
  }
});

module.exports = {
  samplePrompts,
  sourceCatalog,
  invokeSourceTool,
  searchRealSources,
  readCandidate,
  ToolRegistry,
  __internal: {
    buildQueryTokens,
    buildDouyinSearchUrl,
    extractFocusTerms,
    decodeBingRedirectUrl,
    parseBingSearchMarkdown,
    parseSegmentFaultSearchHtml,
    parseBilibiliSearchHtml,
    parseITHomeTagHtml,
    parseTedSearchHtml,
    extractBilibiliState,
    resolveDiscoverConnectors,
    captureRenderedPage,
    findEdgeExecutable,
    parseDouyinRenderedPageSafe,
    extractReaderMarkdown,
    stripTags,
    inferDocumentKindFromUrl,
    parseDelimitedTable
  }
};
