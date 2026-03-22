const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { verifyEvidenceUnits } = require("./fact-verifier");
require("./project-env").initializeProjectEnv();
const { extractTextFromResponsePayload, normalizeResponsesRequestBody, readResponsesApiPayload } = require("./openai-response");
const { registerProductivityTools } = require("./productivity-tools");
const { createToolRegistry } = require("./tool-registry-core");
const { createConnectorRuntime } = require("./source-connectors-runtime");
const { registerVideoTools } = require("./video-tooling");
const {
  normalizeGeneratedConnectorRecord,
  readGeneratedConnectorStore
} = require("./generated-site-connectors-store");
const {
  searchGeneratedSiteConnector,
  readGeneratedSiteConnector,
  normalizeSiteDomain: normalizeGeneratedConnectorDomain
} = require("./generated-site-connector-runtime");
const OPENAI_REQUEST_TIMEOUT_MS = Math.max(20000, Number(process.env.OPENSEARCH_OPENAI_TIMEOUT_MS || 90000));

// Video processing configuration
const VIDEO_PROCESSING_CONFIG = {
  arsApi: {
    enabled: process.env.ARS_API_ENABLED === "true",
    endpoint: process.env.ARS_API_ENDPOINT || "https://api.ars.example.com/transcribe",
    apiKey: process.env.ARS_API_KEY || ""
  },
  openSourceModel: {
    enabled: process.env.OPEN_SOURCE_MODEL_ENABLED === "true",
    endpoint: process.env.OPEN_SOURCE_MODEL_ENDPOINT || "http://localhost:8000/transcribe",
    model: process.env.OPEN_SOURCE_MODEL || "whisper-small"
  }
};

const samplePrompts = [
  "What is OpenAI Sora's current generation limit, and how has it changed since launch?",
  "How much performance improvement does Apple's 2024 flagship phone have over the 2023 model?",
  "Why does this product emphasize planning before search instead of searching immediately?"
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
  if (tool.lifecycle_state === "registered" || tool.status === "active") {
    score += 3;
  } else if (tool.lifecycle_state === "candidate" || tool.status === "candidate") {
    score += 1;
  }

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

// 数据转换工具
async function convertData(data, options = {}) {
  const {
    fromFormat = 'json',
    toFormat = 'json',
    filter = null,
    map = null,
    sortBy = null,
    limit = null
  } = options;

  try {
    // 解析输入数据
    let parsedData = data;
    if (fromFormat === 'csv' && typeof data === 'string') {
      // CSV 杞?JSON
      const lines = data.trim().split('\n');
      const headers = lines[0].split(',');
      parsedData = lines.slice(1).map(line => {
        const values = line.split(',');
        return headers.reduce((obj, header, index) => {
          obj[header.trim()] = values[index] ? values[index].trim() : '';
          return obj;
        }, {});
      });
    } else if (fromFormat === 'json' && typeof data === 'string') {
      // 解析 JSON 字符串
      parsedData = JSON.parse(data);
    }

    // 应用过滤
    if (filter && typeof filter === 'object') {
      if (Array.isArray(parsedData)) {
        parsedData = parsedData.filter(item => {
          return Object.entries(filter).every(([key, value]) => {
            return item[key] === value;
          });
        });
      }
    }

    // 应用映射
    if (map && typeof map === 'object') {
      if (Array.isArray(parsedData)) {
        parsedData = parsedData.map(item => {
          const newItem = {};
          Object.entries(map).forEach(([key, value]) => {
            newItem[value] = item[key];
          });
          return newItem;
        });
      } else if (typeof parsedData === 'object') {
        const newItem = {};
        Object.entries(map).forEach(([key, value]) => {
          newItem[value] = parsedData[key];
        });
        parsedData = newItem;
      }
    }

    // 应用排序
    if (sortBy && Array.isArray(parsedData)) {
      parsedData.sort((a, b) => {
        if (a[sortBy] < b[sortBy]) return -1;
        if (a[sortBy] > b[sortBy]) return 1;
        return 0;
      });
    }

    // 应用限制
    if (limit && Array.isArray(parsedData)) {
      parsedData = parsedData.slice(0, limit);
    }

    // Convert into target format
    let result;
    if (toFormat === 'csv' && Array.isArray(parsedData)) {
      // JSON 杞?CSV
      if (parsedData.length === 0) {
        result = '';
      } else {
        const headers = Object.keys(parsedData[0]);
        const rows = [
          headers.join(','),
          ...parsedData.map(item => {
            return headers.map(header => {
              const value = item[header];
              return typeof value === 'string' && value.includes(',') ? `"${value}"` : value;
            }).join(',');
          })
        ];
        result = rows.join('\n');
      }
    } else if (toFormat === 'json') {
      // 输出 JSON
      result = typeof parsedData === 'string' ? parsedData : JSON.stringify(parsedData, null, 2);
    } else {
      // 直接返回数据
      result = parsedData;
    }

    return {
      success: true,
      data: result
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// API 测试工具
async function testApiEndpoint(endpoint, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 10000,
    expectedStatus = 200,
    auth = null
  } = options;

  try {
    const fetchOptions = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      signal: AbortSignal.timeout(timeout)
    };

    if (auth) {
      if (auth.type === 'basic') {
        const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        fetchOptions.headers['Authorization'] = `Basic ${credentials}`;
      } else if (auth.type === 'bearer') {
        fetchOptions.headers['Authorization'] = `Bearer ${auth.token}`;
      }
    }

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const startTime = Date.now();
    const response = await fetch(endpoint, fetchOptions);
    const endTime = Date.now();
    const responseTime = endTime - startTime;

    let responseBody;
    try {
      responseBody = await response.json();
    } catch (error) {
      responseBody = await response.text();
    }

    const success = response.status === expectedStatus;

    return {
      success,
      data: {
        endpoint,
        method,
        status: response.status,
        statusText: response.statusText,
        responseTime,
        headers: Object.fromEntries(response.headers),
        body: responseBody,
        expectedStatus,
        passed: success
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// GitHub API 工具
async function fetchGitHubRepoInfo(repo) {
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    throw new Error('Invalid GitHub repo format. Use owner/repo');
  }

  const apiUrl = `https://api.github.com/repos/${owner}/${repoName}`;
  const readmeUrl = `https://api.github.com/repos/${owner}/${repoName}/readme`;
  const contentsUrl = `https://api.github.com/repos/${owner}/${repoName}/contents`;

  try {
    // 获取仓库基本信息
    const repoResponse = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'OpenSearch-Tool'
      }
    });
    if (!repoResponse.ok) {
      throw new Error(`GitHub API error: ${repoResponse.status}`);
    }
    const repoInfo = await repoResponse.json();

    // 获取README
    let readmeContent = '';
    try {
      const readmeResponse = await fetch(readmeUrl, {
        headers: {
          'User-Agent': 'OpenSearch-Tool'
        }
      });
      if (readmeResponse.ok) {
        const readmeData = await readmeResponse.json();
        readmeContent = Buffer.from(readmeData.content, 'base64').toString('utf8');
      }
    } catch (readmeError) {
      // Ignore README fetch failures
    }

    // 获取文件结构
    let fileStructure = [];
    try {
      const contentsResponse = await fetch(contentsUrl, {
        headers: {
          'User-Agent': 'OpenSearch-Tool'
        }
      });
      if (contentsResponse.ok) {
        const contents = await contentsResponse.json();
        fileStructure = contents.map(item => ({
          name: item.name,
          type: item.type,
          path: item.path,
          size: item.size
        }));
      }
    } catch (contentsError) {
      // Ignore file structure fetch failures
    }

    return {
      success: true,
      data: {
        name: repoInfo.name,
        full_name: repoInfo.full_name,
        description: repoInfo.description,
        stargazers_count: repoInfo.stargazers_count,
        forks_count: repoInfo.forks_count,
        open_issues_count: repoInfo.open_issues_count,
        created_at: repoInfo.created_at,
        updated_at: repoInfo.updated_at,
        html_url: repoInfo.html_url,
        owner: repoInfo.owner,
        readme: readmeContent,
        file_structure: fileStructure
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

const ToolRegistry = createToolRegistry({
  normalizeCapability,
  scoreToolForTask
});

// 注册内置工具
ToolRegistry.registerTool({
  id: 'fetch_github_repo',
  name: 'GitHub Repo Info',
  description: 'Fetch GitHub repository metadata, README content, and file structure',
  parameters: [
    {
      name: 'repo',
      type: 'string',
      required: true,
      description: 'GitHub仓库路径，格式为 owner/repo'
    }
  ],
  execute: async (input) => {
    const { repo } = input;
    if (!repo) {
      throw new Error('Missing required parameter: repo');
    }
    const result = await fetchGitHubRepoInfo(repo);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.data;
  },
  source: 'builtin',
  status: 'active'
});

ToolRegistry.registerTool({
  id: 'analyze_document_multimodal',
  name: 'Analyze Document Multimodal',
  description: 'Analyze a document with multimodal signals, including text and images',
  parameters: [
    {
      name: 'url',
      type: 'string',
      required: true,
      description: '文档URL'
    },
    {
      name: 'markdown',
      type: 'string',
      required: false,
      description: '文档内容'
    },
    {
      name: 'page_images',
      type: 'array',
      required: false,
      description: '页面图像URL列表'
    }
  ],
  execute: async (input) => {
    return await analyzeDocumentWithMultimodalModel(input);
  },
  source: 'builtin',
  status: 'active'
});

ToolRegistry.registerTool({
  id: 'layout_analysis',
  name: 'Document Layout Analysis',
  description: '分析文档布局，识别文本、表格和视觉元素',
  parameters: [
    {
      name: 'candidate',
      type: 'object',
      required: true,
      description: 'Document candidate descriptor'
    }
  ],
  execute: async (input) => {
    const { candidate } = input;
    const read = await readDocumentSource(candidate);
    const fallbackLayout = deriveDocumentLayout(read, candidate);
    const llmLayout = await analyzeDocumentLayoutWithModel(candidate, read, fallbackLayout);
    return {
      layout: llmLayout || fallbackLayout,
      layout_analysis_mode: llmLayout ? 'llm' : 'heuristic'
    };
  },
  source: 'builtin',
  status: 'active'
});

ToolRegistry.registerTool({
  id: 'read_document_intel',
  name: 'Read Document Intel',
  description: 'Read document content from URL or candidate metadata.',
  parameters: [
    {
      name: 'url',
      type: 'string',
      required: false,
      description: '文档URL'
    },
    {
      name: 'title',
      type: 'string',
      required: false,
      description: '文档标题'
    },
    {
      name: 'candidate',
      type: 'object',
      required: false,
      description: 'Document candidate object'
    }
  ],
  execute: async (input) => {
    const { candidate, url, title } = input;
    if (candidate) {
      return await readDocumentSource(candidate);
    }
    if (url) {
      return await readDocumentSource({ url, title, content_type: 'document', source_type: 'document' });
    }
    throw new Error('Either candidate or url is required');
  },
  source: 'builtin',
  status: 'active'
});

ToolRegistry.registerTool({
  id: 'deep_read_page',
  name: 'Deep Read Page',
  description: 'Extract readable content and key facts from a page.',
  parameters: [
    {
      name: 'candidate',
      type: 'object',
      required: false,
      description: 'Web page candidate object'
    },
    {
      name: 'url',
      type: 'string',
      required: false,
      description: '网页URL'
    }
  ],
  execute: async (input) => {
    const { candidate, url } = input;
    if (!candidate && !url) {
      throw new Error('Either url or candidate.url is required');
    }
    const target = candidate || { url, content_type: 'web', source_type: 'web' };
    const tool = await synthesizeTool({ goal: 'Extract web page content', target });
    const result = await runEphemeralTool(tool);
    if (!result.success) {
      throw new Error(result.error);
    }
    return {
      ...result.extracted_data,
      source_id: target.id || target.url,
      url: target.url,
      content_type: target.content_type,
      source_type: target.source_type
    };
  },
  source: 'builtin',
  status: 'active'
});

ToolRegistry.registerTool({
  id: 'extract_video_intel',
  name: 'Extract Video Intel',
  description: 'Extract video metadata and timeline details.',
  parameters: [
    {
      name: 'candidate',
      type: 'object',
      required: true,
      description: 'Video candidate object'
    }
  ],
  execute: async (input) => {
    const { candidate } = input;
    const tool = await synthesizeTool({ goal: 'Extract video metadata', target: candidate });
    const result = await runEphemeralTool(tool);
    if (!result.success) {
      throw new Error(result.error);
    }
    return {
      ...result.extracted_data,
      source_id: candidate.id,
      url: candidate.url,
      content_type: candidate.content_type,
      source_type: candidate.source_type
    };
  },
  source: 'builtin',
  status: 'active'
});

ToolRegistry.registerTool({
  id: 'cross_check_facts',
  name: 'Cross Check Facts',
  description: 'Verify evidence items and detect conflicts.',
  parameters: [
    {
      name: 'evidenceItems',
      type: 'array',
      required: true,
      description: 'Evidence item list'
    }
  ],
  execute: async (input) => {
    return verifyEvidenceUnits(input.evidenceItems);
  },
  source: 'builtin',
  status: 'active'
});

ToolRegistry.registerTool({
  id: 'search_sources',
  name: 'Search Sources',
  description: 'Search related sources.',
  parameters: [
    {
      name: 'query',
      type: 'string',
      required: true,
      description: '搜索查询'
    },
    {
      name: 'connector_ids',
      type: 'array',
      required: false,
      description: '连接器ID列表'
    }
  ],
  execute: async (input) => {
    const { query, connectorIds } = input;
    // 这里可以实现具体的搜索逻辑
    // 暂时返回模拟数据
    return [
      {
        id: 'search-1',
        title: 'Search Result 1',
        url: 'https://example.com/result1',
        connector: 'bing_web',
        content_type: 'web',
        source_type: 'web',
        snippet: 'This is a search result snippet'
      }
    ];
  },
  source: 'builtin',
  status: 'active'
});

ToolRegistry.registerTool({
  id: 'test_api_endpoint',
  name: 'API Test',
  description: 'Send an HTTP request and validate the response.',
  parameters: [
    {
      name: 'endpoint',
      type: 'string',
      required: true,
      description: 'API端点URL'
    },
    {
      name: 'method',
      type: 'string',
      required: false,
      description: 'HTTP方法，默认为GET'
    },
    {
      name: 'headers',
      type: 'object',
      required: false,
      description: 'HTTP request headers'
    },
    {
      name: 'body',
      type: 'object',
      required: false,
      description: 'HTTP request payload'
    },
    {
      name: 'timeout',
      type: 'number',
      required: false,
      description: '请求超时时间（毫秒）'
    },
    {
      name: 'expectedStatus',
      type: 'number',
      required: false,
      description: '期望的HTTP状态码'
    },
    {
      name: 'auth',
      type: 'object',
      required: false,
      description: '认证信息，支持basic和bearer类型'
    }
  ],
  execute: async (input) => {
    const { endpoint, method, headers, body, timeout, expectedStatus, auth } = input;
    if (!endpoint) {
      throw new Error('Missing required parameter: endpoint');
    }
    const result = await testApiEndpoint(endpoint, {
      method,
      headers,
      body,
      timeout,
      expectedStatus,
      auth
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.data;
  },
  source: 'builtin',
  status: 'active'
});

ToolRegistry.registerTool({
  id: 'convert_data',
  name: 'Data Converter',
  description: '转换数据格式，支持JSON和CSV之间的转换，以及数据过滤、映射、排序和限制',
  parameters: [
    {
      name: 'data',
      type: 'any',
      required: true,
      description: '要转换的数据'
    },
    {
      name: 'fromFormat',
      type: 'string',
      required: false,
      description: '输入数据格式，默认为json'
    },
    {
      name: 'toFormat',
      type: 'string',
      required: false,
      description: '输出数据格式，默认为json'
    },
    {
      name: 'filter',
      type: 'object',
      required: false,
      description: '过滤条件'
    },
    {
      name: 'map',
      type: 'object',
      required: false,
      description: '字段映射'
    },
    {
      name: 'sortBy',
      type: 'string',
      required: false,
      description: '排序字段'
    },
    {
      name: 'limit',
      type: 'number',
      required: false,
      description: 'Maximum number of records to return'
    }
  ],
  execute: async (input) => {
    const { data, fromFormat, toFormat, filter, map, sortBy, limit } = input;
    if (data === undefined || data === null) {
      throw new Error('Missing required parameter: data');
    }
    const result = await convertData(data, {
      fromFormat,
      toFormat,
      filter,
      map,
      sortBy,
      limit
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.data;
  },
  source: 'builtin',
  status: 'active'
});

// 哔站视频音频下载工具
async function downloadBilibiliAudio(videoUrl, options = {}) {
  const {
    outputDir = './downloads',
    quality = 'high',
    format = 'mp3'
  } = options;

  try {
    // 验证URL格式
    const bvMatch = videoUrl.match(/BV[\w]+/);
    const avMatch = videoUrl.match(/av(\d+)/);
    
    if (!bvMatch && !avMatch) {
      throw new Error('Invalid Bilibili video URL. Must contain BV or av ID');
    }

    // 获取视频页面内容
    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch video page: ${response.status}`);
    }

    const html = await response.text();

    // 提取视频信息
    const titleMatch = html.match(/<h1[^>]*title="([^"]*)"/);
    const title = titleMatch ? titleMatch[1].trim() : 'unknown';

    // 提取playinfo数据
    const playInfoMatch = html.match(/window\.__playinfo__\s*=\s*({[\s\S]*?})<\/script>/);
    if (!playInfoMatch) {
      throw new Error('Could not find playinfo data');
    }

    const playInfo = JSON.parse(playInfoMatch[1]);
    
    // 获取音频URL
    let audioUrl = null;
    if (playInfo.data && playInfo.data.dash && playInfo.data.dash.audio) {
      const audios = playInfo.data.dash.audio;
      // 选择最高质量的音频
      audioUrl = audios[0].baseUrl;
    }

    if (!audioUrl) {
      throw new Error('Could not find audio URL');
    }

    // 下载音频
    const audioResponse = await fetch(audioUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com'
      }
    });

    if (!audioResponse.ok) {
      throw new Error(`Failed to download audio: ${audioResponse.status}`);
    }

    const audioBuffer = await audioResponse.arrayBuffer();
    
    // 生成文件名
    const safeTitle = title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const fileName = `${safeTitle}_${Date.now()}.${format}`;
    const filePath = path.join(outputDir, fileName);

    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 保存音频文件
    fs.writeFileSync(filePath, Buffer.from(audioBuffer));

    return {
      success: true,
      data: {
        title: title,
        fileName: fileName,
        filePath: filePath,
        fileSize: audioBuffer.byteLength,
        format: format,
        quality: quality,
        videoUrl: videoUrl
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

ToolRegistry.registerTool({
  id: 'download_bilibili_audio',
  name: 'Bilibili Audio Downloader',
  description: 'Download Bilibili video audio by BV or av URL.',
  parameters: [
    {
      name: 'videoUrl',
      type: 'string',
      required: true,
      description: '哔站视频链接，支持BV或av格式'
    },
    {
      name: 'outputDir',
      type: 'string',
      required: false,
      description: '音频文件保存目录，默认为./downloads'
    },
    {
      name: 'quality',
      type: 'string',
      required: false,
      description: '音频质量，默认为high'
    },
    {
      name: 'format',
      type: 'string',
      required: false,
      description: '音频格式，默认为mp3'
    }
  ],
  execute: async (input) => {
    const { videoUrl, outputDir, quality, format } = input;
    if (!videoUrl) {
      throw new Error('Missing required parameter: videoUrl');
    }
    const result = await downloadBilibiliAudio(videoUrl, {
      outputDir,
      quality,
      format
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.data;
  },
  source: 'builtin',
  status: 'active'
});

// 抖音视频信息提取工具
async function extractDouyinVideoInfo(videoUrl, options = {}) {
  const {
    cookie = null,
    includeDownloadMethods = true
  } = options;

  try {
    // 验证URL格式
    const douyinPattern = /douyin\.com|iesdouyin\.com/;
    if (!douyinPattern.test(videoUrl)) {
      throw new Error('Invalid Douyin video URL. Must be a douyin.com or iesdouyin.com link');
    }

    // 处理短链接，获取真实URL
    let realUrl = videoUrl;
    let shortUrlRedirect = null;
    
    if (videoUrl.includes('v.douyin.com')) {
      try {
        const response = await fetch(videoUrl, {
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
          }
        });
        
        if (response.status === 302 || response.status === 301) {
          shortUrlRedirect = response.headers.get('location') || videoUrl;
          // 检查是否是应用协议
          if (shortUrlRedirect && !shortUrlRedirect.startsWith('sslocal://')) {
            realUrl = shortUrlRedirect;
          }
        }
      } catch (e) {
        // 短链接处理失败，继续使用原始URL
      }
    }

    // 提取视频ID
    const videoIdMatch = realUrl.match(/video\/(\d+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;
    
    // 构建分享链接
    const shareUrl = videoId ? `https://v.douyin.com/${videoId}/` : videoUrl;

    // 获取视频页面内容
    const headers = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Referer': 'https://www.douyin.com/'
    };
    
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    
    const response = await fetch(realUrl, {
      headers: headers
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch video page: ${response.status}`);
    }

    const html = await response.text();

    // 提取视频信息
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(' - 抖音', '').trim() : 'unknown';

    // Extract video download url
    let videoDownloadUrl = null;
    let extractionMethod = null;
    
    // Try extracting from SSR hydrated data first.
    const ssrDataMatch = html.match(/<script[^>]*>window\._SSR_HYDRATED_DATA\s*=\s*({[\s\S]*?})<\/script>/);
    if (ssrDataMatch) {
      try {
        const ssrData = JSON.parse(ssrDataMatch[1]);
        if (ssrData.app && ssrData.app.videoDetail && ssrData.app.videoDetail.video) {
          const videoInfo = ssrData.app.videoDetail.video;
          // Prefer no-watermark playback URL when available.
          if (videoInfo.playAddr) {
            videoDownloadUrl = videoInfo.playAddr;
            extractionMethod = 'SSR_HYDRATED_DATA.playAddr';
          } else if (videoInfo.downloadAddr) {
            videoDownloadUrl = videoInfo.downloadAddr;
            extractionMethod = 'SSR_HYDRATED_DATA.downloadAddr';
          }
        }
      } catch (parseError) {
        // Ignore parse failures and continue
      }
    }

    // If SSR data does not contain media URL, try render data.
    if (!videoDownloadUrl) {
      const renderDataMatch = html.match(/<script[^>]*>window\._RENDER_DATA\s*=\s*({[\s\S]*?})<\/script>/);
      if (renderDataMatch) {
        try {
          const renderData = JSON.parse(renderDataMatch[1]);
          // 在渲染数据中寻找视频URL
          const videoData = findVideoUrlInObject(renderData);
          if (videoData) {
            videoDownloadUrl = videoData;
            extractionMethod = 'RENDER_DATA';
          }
        } catch (parseError) {
          // 解析失败
        }
      }
    }

    // If still missing, try HTML video tag.
    if (!videoDownloadUrl) {
      const videoTagMatch = html.match(/<video[^>]*src="([^"]*)"[^>]*>/);
      if (videoTagMatch) {
        videoDownloadUrl = videoTagMatch[1];
        extractionMethod = 'video_tag';
      }
    }

    // If still missing, try play_url style fields.
    if (!videoDownloadUrl) {
      const playUrlMatch = html.match(/play_url["']?\s*:\s*["']([^"']+)["']/);
      if (playUrlMatch) {
        videoDownloadUrl = playUrlMatch[1];
        extractionMethod = 'play_url_param';
      }
    }

    // If still not found, scan all mp4 links in page source.
    if (!videoDownloadUrl) {
      const allUrls = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/g);
      if (allUrls && allUrls.length > 0) {
        videoDownloadUrl = allUrls[0];
        extractionMethod = 'regex_mp4';
      }
    }

    // Check whether the page uses JavaScript anti-bot protection
    const hasJsProtection = html.includes('_$jsvmprt') || html.includes('byted_acrawler');
    
    // Build downloadable-method suggestions.
    let downloadMethods = [];
    if (includeDownloadMethods) {
      downloadMethods = [
        {
          name: 'Browser developer tools',
          description: 'Inspect network requests to locate the media URL',
          steps: [
            '1. Open the video page in a browser',
            '2. Press F12 to open developer tools',
            '3. Switch to the Network panel',
            '4. Play the video and filter mp4/media requests',
            '5. Copy the media URL'
          ],
          difficulty: 'medium',
          successRate: 'high'
        },
        {
          name: 'Online parser tools',
          description: 'Use an external URL parser service',
          examples: [
            'https://douyin.video',
            'https://www.tiktok.com/download',
            'Any stable no-watermark parser service'
          ],
          difficulty: 'easy',
          successRate: 'medium'
        },
        {
          name: 'Python + Selenium',
          description: 'Use browser automation to retrieve media source',
          code: `from selenium import webdriver
from selenium.webdriver.common.by import By
import time

driver = webdriver.Chrome()
driver.get('${realUrl}')
time.sleep(5)
video = driver.find_element(By.TAG_NAME, 'video')
video_url = video.get_attribute('src')
print(video_url)`,
          difficulty: 'hard',
          successRate: 'high'
        },
        {
          name: 'Mobile app share flow',
          description: 'Copy link in app and parse with external tool',
          steps: [
            '1. Open the video in app',
            '2. Tap share',
            '3. Copy link',
            '4. Parse using an external tool'
          ],
          difficulty: 'easy',
          successRate: 'high'
        }
      ];
      
      // 如果有Cookie，添加Cookie方法
      if (!cookie && hasJsProtection) {
        downloadMethods.unshift({
          name: 'Use cookie authentication',
          description: 'Provide a valid Douyin web cookie',
          steps: [
            '1. Log in on web',
            '2. Open developer tools',
            '3. Locate cookies in storage panel',
            '4. Copy cookie string',
            '5. Pass it via the cookie parameter'
          ],
          difficulty: 'medium',
          successRate: 'high'
        });
      }
    }

    return {
      success: true,
      data: {
        title: title,
        videoId: videoId,
        originalUrl: videoUrl,
        resolvedUrl: realUrl,
        shareUrl: shareUrl,
        shortUrlRedirect: shortUrlRedirect,
        videoDownloadUrl: videoDownloadUrl,
        extractionMethod: extractionMethod,
        hasJsProtection: hasJsProtection,
        pageLength: html.length,
        extractionStatus: videoDownloadUrl ? 'success' : (hasJsProtection ? 'js_protection' : 'not_found'),
        suggestions: videoDownloadUrl ? [] : [
          hasJsProtection ? '页面使用了JavaScript保护，建议提供有效的Cookie' : null,
          '可以尝试使用第三方下载工具或API',
          '可以使用浏览器开发者工具手动获取视频地址',
          'Try Selenium or Playwright browser automation as fallback'
        ].filter(Boolean),
        downloadMethods: videoDownloadUrl ? [] : downloadMethods,
        metadata: {
          platform: 'douyin',
          urlType: videoUrl.includes('v.douyin.com') ? 'short' : 'full',
          extractedAt: new Date().toISOString(),
          toolVersion: '2.0'
        }
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// 批量提取抖音视频信息
async function batchExtractDouyinVideoInfo(videoUrls, options = {}) {
  const {
    cookie = null,
    concurrency = 3,
    delay = 1000
  } = options;

  const results = [];
  const errors = [];

  for (let i = 0; i < videoUrls.length; i += concurrency) {
    const batch = videoUrls.slice(i, i + concurrency);
    
    const batchPromises = batch.map(async (url, index) => {
      // 添加延迟避免请求过快
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      const result = await extractDouyinVideoInfo(url, { cookie });
      return {
        url: url,
        ...result
      };
    });

    const batchResults = await Promise.allSettled(batchPromises);
    
    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        errors.push({
          url: batch[index],
          error: result.reason.message
        });
      }
    });
  }

  return {
    success: true,
    data: {
      total: videoUrls.length,
      successful: results.filter(r => r.success).length,
      failed: errors.length,
      results: results,
      errors: errors
    }
  };
}

// 辅助函数：在对象中递归查找视频URL
function findVideoUrlInObject(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return null;
  }

  for (const key in obj) {
    if (typeof obj[key] === 'string') {
      // Look for values that resemble video URLs.
      if (obj[key].includes('.mp4') || obj[key].includes('video')) {
        if (obj[key].startsWith('http')) {
          return obj[key];
        }
      }
    } else if (typeof obj[key] === 'object') {
      const result = findVideoUrlInObject(obj[key]);
      if (result) {
        return result;
      }
    }
  }
  return null;
}

ToolRegistry.registerTool({
  id: 'extract_douyin_video_info',
  name: 'Douyin Video Info Extractor',
  description: 'Extract Douyin video information from short or full URLs.',
  parameters: [
    {
      name: 'videoUrl',
      type: 'string',
      required: true,
      description: '抖音视频链接，支持v.douyin.com短链接和完整链接'
    },
    {
      name: 'cookie',
      type: 'string',
      required: false,
      description: 'Optional Douyin cookie for gated pages'
    }
  ],
  execute: async (input) => {
    const { videoUrl, cookie } = input;
    if (!videoUrl) {
      throw new Error('Missing required parameter: videoUrl');
    }
    const result = await extractDouyinVideoInfo(videoUrl, {
      cookie
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.data;
  },
  source: 'builtin',
  status: 'active'
});

ToolRegistry.registerTool({
  id: 'batch_extract_douyin_video_info',
  name: 'Batch Douyin Video Info Extractor',
  description: 'Batch extract Douyin video metadata with concurrency control.',
  parameters: [
    {
      name: 'videoUrls',
      type: 'array',
      required: true,
      description: 'List of Douyin video URLs'
    },
    {
      name: 'cookie',
      type: 'string',
      required: false,
      description: 'Optional Douyin cookie for gated pages'
    },
    {
      name: 'concurrency',
      type: 'number',
      required: false,
      description: '并发数，默认为3'
    },
    {
      name: 'delay',
      type: 'number',
      required: false,
      description: '请求间隔延迟（毫秒），默认为1000'
    }
  ],
  execute: async (input) => {
    const { videoUrls, cookie, concurrency, delay } = input;
    if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length === 0) {
      throw new Error('Missing required parameter: videoUrls (must be a non-empty array)');
    }
    const result = await batchExtractDouyinVideoInfo(videoUrls, {
      cookie,
      concurrency,
      delay
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.data;
  },
  source: 'builtin',
  status: 'active'
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Douyin downloader backed by third-party parser APIs.
async function downloadDouyinVideo(videoUrl, options = {}) {
  const {
    outputDir = './downloads',
    filename = null,
    apiUrl = 'https://apis.jxcxin.cn/api/douyin'
  } = options;

  try {
    // 验证URL格式
    const douyinPattern = /douyin\.com|iesdouyin\.com/;
    if (!douyinPattern.test(videoUrl)) {
      throw new Error('Invalid Douyin video URL. Must be a douyin.com or iesdouyin.com link');
    }

    console.log(`正在解析视频: ${videoUrl}`);
    
    // 调用解析API
    const apiEndpoint = `${apiUrl}?url=${encodeURIComponent(videoUrl)}`;
    
    const response = await fetch(apiEndpoint, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.code !== 200 || !data.data) {
      throw new Error(`API error: ${data.msg || 'Unknown error'}`);
    }

    const videoData = data.data;
    
    // 获取视频下载地址
    const videoDownloadUrl = videoData.video || videoData.play_url || videoData.url;
    const coverUrl = videoData.cover;
    const title = videoData.title || 'douyin_video';
    const author = videoData.author || 'unknown';
    
    if (!videoDownloadUrl) {
      throw new Error('No video URL found in API response');
    }

    console.log(`解析成功，准备下载: ${title}`);
    console.log(`视频地址: ${videoDownloadUrl}`);

    // 创建下载目录
    const fs = require('fs');
    const path = require('path');
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Build safe output filename
    const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
    const safeAuthor = author.replace(/[<>:"/\\|?*]/g, '_').substring(0, 30);
    const finalFilename = filename || `${safeAuthor}_${safeTitle}_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, finalFilename);

    // 下载视频
    console.log(`开始下载到: ${outputPath}`);
    
    const videoResponse = await fetch(videoDownloadUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.douyin.com/'
      }
    });

    if (!videoResponse.ok) {
      throw new Error(`Video download failed: ${videoResponse.status}`);
    }

    // 获取视频流并保存
    const arrayBuffer = await videoResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    fs.writeFileSync(outputPath, buffer);
    
    const fileSize = (buffer.length / 1024 / 1024).toFixed(2);
    console.log(`下载完成! 文件大小: ${fileSize} MB`);

    return {
      success: true,
      data: {
        title: title,
        author: author,
        videoUrl: videoDownloadUrl,
        coverUrl: coverUrl,
        downloadPath: outputPath,
        filename: finalFilename,
        fileSize: `${fileSize} MB`,
        fileSizeBytes: buffer.length
      }
    };

  } catch (error) {
    console.error('下载失败:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// 批量下载抖音视频
async function batchDownloadDouyinVideos(videoUrls, options = {}) {
  const {
    outputDir = './downloads',
    concurrency = 2,
    delay = 2000
  } = options;

  const results = [];
  const errors = [];

  for (let i = 0; i < videoUrls.length; i += concurrency) {
    const batch = videoUrls.slice(i, i + concurrency);
    
    const batchPromises = batch.map(async (url, index) => {
      // 添加延迟避免请求过快
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      console.log(`\n[${i + index + 1}/${videoUrls.length}] 开始处理: ${url}`);
      
      const result = await downloadDouyinVideo(url, { outputDir });
      return {
        url: url,
        ...result
      };
    });

    const batchResults = await Promise.allSettled(batchPromises);
    
    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
        if (result.value.success) {
          console.log(`鉁?鎴愬姛: ${result.value.data.filename}`);
        } else {
          console.log(`鉂?澶辫触: ${result.value.error}`);
          errors.push({
            url: batch[index],
            error: result.value.error
          });
        }
      } else {
        console.log(`鉂?澶辫触: ${result.reason.message}`);
        errors.push({
          url: batch[index],
          error: result.reason.message
        });
      }
    });
  }

  return {
    success: true,
    data: {
      total: videoUrls.length,
      successful: results.filter(r => r.success).length,
      failed: errors.length,
      results: results,
      errors: errors,
      outputDir: outputDir
    }
  };
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
  const englishTerms = raw.match(/[A-Za-z][A-Za-z0-9._+-]{1,32}/g) || [];
  const chineseTerms = raw.match(/[\u4e00-\u9fff]{2,8}/g) || [];
  return unique([...englishTerms, ...chineseTerms]).slice(0, 6);
}

function buildDouyinSearchUrl(query) {
  const normalizedQuery = normalizeWhitespace(String(query || "").replace(/\s+/g, " "));
  const finalQuery = /视频|video/i.test(normalizedQuery) ? normalizedQuery : `${normalizedQuery} 视频`;
  return `https://www.douyin.com/search/${encodeURIComponent(finalQuery)}`;
}

function buildQueryTokens(query) {
  const raw = String(query || "");
  const tokens = new Set(raw.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) || []);
  const focusTerms = extractFocusTerms(raw).map((item) => String(item).toLowerCase());
  for (const term of focusTerms) {
    tokens.add(term);
  }
  return Array.from(tokens).slice(0, 24);
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
  if (/reuters\.com$/.test(hostname)) return 0.93;
  if (/apnews\.com$/.test(hostname)) return 0.92;
  if (/xinhuanet\.com$/.test(hostname) || /news\.cn$/.test(hostname)) return 0.92;
  if (/people\.com\.cn$/.test(hostname)) return 0.9;
  if (/news\.cctv\.com$/.test(hostname) || /cctv\.com$/.test(hostname)) return 0.9;
  if (/bbc\.com$/.test(hostname) || /bbc\.co\.uk$/.test(hostname)) return 0.9;
  if (/bloomberg\.com$/.test(hostname)) return 0.91;
  if (/nytimes\.com$/.test(hostname)) return 0.9;
  if (/wsj\.com$/.test(hostname)) return 0.9;
  if (/caixin\.com$/.test(hostname)) return 0.88;
  if (/thepaper\.cn$/.test(hostname)) return 0.86;
  if (/jiemian\.com$/.test(hostname)) return 0.84;
  if (/ted\.com$/.test(hostname)) return 0.88;
  if (/youtube\.com$/.test(hostname) || /youtu\.be$/.test(hostname)) return 0.86;
  if (/douyin\.com$/.test(hostname) || /iesdouyin\.com$/.test(hostname)) return 0.78;
  if (/ithome\.com$/.test(hostname)) return 0.84;
  if (/segmentfault\.com$/.test(hostname)) return 0.8;
  if (/bilibili\.com$/.test(hostname)) return 0.76;
  if (/news\.ycombinator\.com$/.test(hostname)) return 0.74;
  if (/github\.com$/.test(hostname)) return 0.78;
  if (/reddit\.com$/.test(hostname)) return 0.74;
  if (/wikipedia\.org$/.test(hostname)) return 0.9;
  if (/zhihu\.com$/.test(hostname)) return 0.72;
  if (/stackoverflow\.com$/.test(hostname)) return 0.8;
  if (/planetebook\.com$/.test(hostname)) return 0.76;
  if (/google\.com$/.test(hostname) || /blog\.google$/.test(hostname) || /developers\.google\.com$/.test(hostname) || /ai\.google\.dev$/.test(hostname) || /cloud\.google\.com$/.test(hostname) || /support\.google\.com$/.test(hostname) || /research\.google$/.test(hostname)) return 0.94;
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
    .split(/[.!?。！？]+\s+/)
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
    signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
    body: JSON.stringify(normalizeResponsesRequestBody({
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
    }, { forceStream: true }))
  });

  const { rawText: responseText, payload } = await readResponsesApiPayload(response);
  if (!response.ok) {
    throw new Error(payload?.error?.message || responseText.trim() || `Document model failed with HTTP ${response.status}`);
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
    signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
    body: JSON.stringify(normalizeResponsesRequestBody({
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
    }, { forceStream: true }))
  });

  const { rawText: responseText, payload } = await readResponsesApiPayload(response);
  if (!response.ok) {
    throw new Error(payload?.error?.message || responseText.trim() || `Document multimodal analysis failed with HTTP ${response.status}`);
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
    signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
    body: JSON.stringify(normalizeResponsesRequestBody({
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
    }, { forceStream: true }))
  });

  const { rawText: responseText, payload } = await readResponsesApiPayload(response);
  if (!response.ok) {
    throw new Error(payload?.error?.message || responseText.trim() || `Document layout analysis failed with HTTP ${response.status}`);
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
    /关键|核心|重点|主要|本质|important|key|core/i,
    /首先|第一|第二|第三|最后|first|second|third|finally/i,
    /但是|不过|然而|虽然|but|however|although/i,
    /因为|所以|因此|导致|because|therefore|result/i,
    /比如|例如|就像|for example|such as/i,
    /需要|必须|应该|可以|need|must|should|can/i,
    /问题|挑战|难点|优势|劣势|problem|challenge|risk|advantage/i,
    /总结|结论|总的来说|conclusion|summary/i
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
    conclusion: /总结|结论|总的来说|overall|in conclusion/i,
    step: /首先|第一|第二|第三|最后|步骤|阶段|first|second|third|finally/i,
    contrast: /但是|不过|然而|虽然|尽管|相反|but|however|although/i,
    cause: /因为|所以|因此|由于|导致|造成|because|therefore|result/i,
    example: /比如|例如|就像|for example|such as/i,
    requirement: /需要|必须|应该|可以|能够|need|must|should|can/i
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

// Transcribe audio through ARS API.
async function transcribeWithArsApi(audioPath) {
  if (!VIDEO_PROCESSING_CONFIG.arsApi.enabled || !VIDEO_PROCESSING_CONFIG.arsApi.apiKey) {
    throw new Error("ARS API is not configured or enabled");
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
    throw new Error(`ARS API request failed: ${await response.text()}`);
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
        console.warn("ARS API 调用失败，尝试使用开源模型", arsError.message);
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
        console.warn("Open-source transcription failed:", openSourceError.message);
      }
    }

    throw new Error("All transcription methods failed");
  } finally {
    if (fs.existsSync(audioPath)) {
      try {
        fs.unlinkSync(audioPath);
      } catch (error) {
        console.warn("Failed to clean temporary file:", error.message);
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

function parseBingSearchHtml(html, query) {
  const candidates = [];
  const pattern = /<li\s+class="b_algo"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?[\s\S]*?<\/li>/gi;
  let match = null;

  while ((match = pattern.exec(html)) && candidates.length < 8) {
    const resolvedUrl = decodeBingRedirectUrl(decodeHtmlEntities(match[1]));
    const title = stripTags(match[2]);
    const summary = stripTags(match[3] || "");
    if (!resolvedUrl || !title) {
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
      published_at: null,
      duration: null,
      engagement: null,
      authority_score: authorityScoreForUrl(resolvedUrl, "Bing Web"),
      summary: summary || `Bing Web result for ${query}`,
      matched_query: query,
      score: Number((1.05 - candidates.length * 0.08).toFixed(4)),
      metadata: {
        rank: candidates.length + 1,
        host: hostFromUrl(resolvedUrl),
        parser: "html_fallback"
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
        author: "SegmentFault Author",
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
    const author = stripTags(match[4]) || "Bilibili Creator";
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
  try {
    const markdown = await fetchText(`https://r.jina.ai/http://www.bing.com/search?q=${encodeURIComponent(query)}`, {
      timeoutMs: 8000,
      retries: 0
    });
    const candidates = parseBingSearchMarkdown(markdown, query);
    if (candidates.length > 0) {
      return candidates;
    }
  } catch (_) {
  }

  const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
    timeoutMs: 10000,
    retries: 0,
    headers: {
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  });
  return parseBingSearchHtml(html, query);
}

function normalizeSiteConnectorCandidate(candidate, query, {
  connectorId,
  platform,
  contentType = "web",
  sourceType = "web",
  authorityFloor = null
}) {
  const authorityScore = authorityFloor == null
    ? authorityScoreForUrl(candidate.url, platform)
    : Math.max(authorityFloor, authorityScoreForUrl(candidate.url, platform));

  return {
    ...candidate,
    connector: connectorId,
    platform,
    content_type: contentType,
    source_type: sourceType,
    authority_score: authorityScore,
    summary: candidate.summary || `${platform} result for ${query}`,
    metadata: {
      ...(candidate.metadata || {}),
      site_connector: true
    }
  };
}

function createStructuredSiteConnectorCandidate({
  connectorId,
  platform,
  query,
  title,
  url,
  author,
  publishedAt = null,
  summary = "",
  contentType = "web",
  sourceType = "web",
  authorityFloor = null,
  score = 0.88,
  engagement = null,
  duration = null,
  metadata = {}
}) {
  return normalizeSiteConnectorCandidate({
    id: makeId(contentType === "video" ? "video" : "web", url),
    title: normalizeWhitespace(title || platform),
    url,
    platform,
    content_type: contentType,
    source_type: sourceType,
    author: normalizeWhitespace(author || platform),
    published_at: publishedAt,
    duration,
    engagement,
    authority_score: authorityFloor == null ? authorityScoreForUrl(url, platform) : Math.max(authorityFloor, authorityScoreForUrl(url, platform)),
    summary: normalizeWhitespace(summary || `${platform} result for ${query}`),
    matched_query: query,
    score: Number(score.toFixed(4)),
    metadata
  }, query, {
    connectorId,
    platform,
    contentType,
    sourceType,
    authorityFloor
  });
}

function createBingSiteConnectorSearch({ connectorId, platform, domain, contentType = "web", sourceType = "web", authorityFloor = null }) {
  const domains = Array.isArray(domain) ? domain : [domain];
  return async function searchSiteConnector(query) {
    const searchQuery = `site:${domains[0]} ${query}`;
    const candidates = await searchBingWeb(searchQuery);
    return candidates
      .filter((item) => domains.some((candidateDomain) => hostFromUrl(item.url) === candidateDomain || hostFromUrl(item.url).endsWith(`.${candidateDomain}`)))
      .map((item) => normalizeSiteConnectorCandidate(item, query, {
        connectorId,
        platform,
        contentType,
        sourceType,
        authorityFloor
      }))
      .slice(0, 6);
  };
}

async function searchAcrossBingDomains(query, domains, options = {}) {
  const {
    connectorId,
    platform,
    contentType = "web",
    sourceType = "web",
    authorityFloor = null,
    maxResults = 6,
    metadata = {}
  } = options;
  const uniqueDomains = Array.from(new Set((domains || []).filter(Boolean)));
  const collected = [];
  const seen = new Set();

  for (const domain of uniqueDomains) {
    let candidates = [];
    try {
      candidates = await searchBingWeb(`site:${domain} ${query}`);
    } catch (error) {
      continue;
    }
    for (const candidate of candidates) {
      const hostname = hostFromUrl(candidate.url);
      if (!hostname || !uniqueDomains.some((item) => hostname === item || hostname.endsWith(`.${item}`))) {
        continue;
      }
      if (seen.has(candidate.url)) {
        continue;
      }
      seen.add(candidate.url);
      collected.push(normalizeSiteConnectorCandidate({
        ...candidate,
        metadata: {
          ...(candidate.metadata || {}),
          ...metadata,
          fallback_search: true
        }
      }, query, {
        connectorId,
        platform,
        contentType,
        sourceType,
        authorityFloor
      }));
      if (collected.length >= maxResults) {
        return collected;
      }
    }
  }

  return collected;
}

function resolveUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch (error) {
    return "";
  }
}

function parseGenericSiteSearchHtml(html, query, {
  connectorId,
  platform,
  domain,
  searchUrl,
  contentType = "web",
  sourceType = "web",
  authorityFloor = null
}) {
  const domains = Array.isArray(domain) ? domain : [domain];
  const candidates = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
  let match = null;

  while ((match = anchorPattern.exec(html)) && candidates.length < 8) {
    const rawHref = match[1] || match[2] || "";
    const resolvedUrl = resolveUrl(decodeHtmlEntities(rawHref), searchUrl);
    const hostname = hostFromUrl(resolvedUrl);
    const title = stripTags(match[3] || "");
    if (!resolvedUrl || !hostname || !title) {
      continue;
    }
    if (!domains.some((candidateDomain) => hostname === candidateDomain || hostname.endsWith(`.${candidateDomain}`))) {
      continue;
    }
    if (/\/search|\bsearch\?|\/tag\/|\/topics?\//i.test(resolvedUrl)) {
      continue;
    }
    if (seen.has(resolvedUrl)) {
      continue;
    }
    seen.add(resolvedUrl);

    candidates.push(normalizeSiteConnectorCandidate({
      id: makeId(contentType === "video" ? "video" : "web", resolvedUrl),
      connector: connectorId,
      title,
      url: resolvedUrl,
      platform,
      content_type: contentType,
      source_type: sourceType,
      author: hostname || platform,
      published_at: null,
      duration: null,
      engagement: null,
      authority_score: authorityFloor == null ? authorityScoreForUrl(resolvedUrl, platform) : Math.max(authorityFloor, authorityScoreForUrl(resolvedUrl, platform)),
      summary: `${platform} result for ${query}`,
      matched_query: query,
      score: Number((0.98 - candidates.length * 0.06).toFixed(4)),
      metadata: {
        rank: candidates.length + 1,
        host: hostname,
        parser: "native_search_html",
        native_search: true
      }
    }, query, {
      connectorId,
      platform,
      contentType,
      sourceType,
      authorityFloor
    }));
  }

  return candidates;
}

function createNativeFirstSiteConnectorSearch({
  connectorId,
  platform,
  domain,
  searchUrlBuilder,
  parse = parseGenericSiteSearchHtml,
  contentType = "web",
  sourceType = "web",
  authorityFloor = null,
  headers = { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" }
}) {
  const fallbackSearch = createBingSiteConnectorSearch({ connectorId, platform, domain, contentType, sourceType, authorityFloor });
  return async function searchSiteConnector(query) {
    if (typeof searchUrlBuilder === "function") {
      try {
        const searchUrl = searchUrlBuilder(query);
        const html = await fetchText(searchUrl, {
          timeoutMs: 12000,
          retries: 0,
          headers
        });
        const nativeCandidates = parse(html, query, {
          connectorId,
          platform,
          domain,
          searchUrl,
          contentType,
          sourceType,
          authorityFloor
        });
        if (nativeCandidates.length) {
          return nativeCandidates;
        }
      } catch (error) {
      }
    }
    return fallbackSearch(query);
  };
}

function extractMetaContent(html, keys = []) {
  for (const key of keys) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${key}["']`, "i")
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return decodeHtmlEntities(match[1]).trim();
      }
    }
  }
  return "";
}

function extractTitleFromHtml(html) {
  const ogTitle = extractMetaContent(html, ["og:title", "twitter:title"]);
  if (ogTitle) {
    return ogTitle;
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch ? stripTags(titleMatch[1]) : "";
}

function extractArticleParagraphs(html) {
  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const scope = articleMatch ? articleMatch[1] : html;
  const paragraphs = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((item) => stripTags(item[1]))
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 40)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 18);

  return paragraphs;
}

function isRestrictedNewsMarkdown(markdown) {
  return /subscribe|subscription|sign in|log in|for subscribers|already a subscriber|continue reading|register to keep reading|本文仅供订阅用户|会员|订阅后继续阅读/i.test(String(markdown || ""));
}

function createNewsReadResult(candidate, {
  title,
  author,
  publishedAt,
  markdown,
  accessLimited = false,
  accessNotes = null
}) {
  return {
    source_id: candidate.id,
    content_type: candidate.content_type || candidate.source_type,
    source_type: candidate.source_type,
    tool: "deep_read_page",
    title: title || candidate.title,
    url: candidate.url,
    author: author || candidate.author,
    published_at: publishedAt || candidate.published_at,
    markdown,
    key_points: extractKeyPointsFromText(markdown),
    sections: buildSectionsFromMarkdown(markdown),
    facts: extractNumericFacts(markdown, candidate.id, candidate.connector || hostFromUrl(candidate.url) || "news_source"),
    access_limited: accessLimited,
    access_notes: accessNotes
  };
}

function createNativeFirstNewsReadSource({ platform, paywalled = false }) {
  return async function readNewsSource(candidate) {
    try {
      const html = await fetchText(candidate.url, {
        timeoutMs: 15000,
        retries: 0,
        headers: {
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
        }
      });
      const title = extractTitleFromHtml(html) || candidate.title;
      const summary = extractMetaContent(html, ["description", "og:description", "twitter:description"]);
      const author = extractMetaContent(html, ["author", "article:author"]);
      const publishedAt = extractMetaContent(html, ["article:published_time", "og:published_time", "publishdate", "parsely-pub-date"]);
      const paragraphs = extractArticleParagraphs(html);
      const body = paragraphs.join("\n\n");
      const accessLimited = paywalled && (!body || isRestrictedNewsMarkdown(html));
      const markdown = [
        `# ${title}`,
        summary ? `> ${summary}` : "",
        body || summary || candidate.summary || `${platform} article content is not fully available from direct fetch.`,
        accessLimited ? "\n\n[Access limited: article appears to require subscription or sign-in.]" : ""
      ].filter(Boolean).join("\n\n");

      if (body || summary) {
        return createNewsReadResult(candidate, {
          title,
          author,
          publishedAt,
          markdown,
          accessLimited,
          accessNotes: accessLimited ? "subscription_or_login_required" : null
        });
      }
    } catch (error) {
    }

    try {
      const fallback = await readWebSource(candidate);
      const accessLimited = paywalled && isRestrictedNewsMarkdown(fallback.markdown);
      return {
        ...fallback,
        access_limited: accessLimited,
        access_notes: accessLimited ? "subscription_or_login_required" : null
      };
    } catch (error) {
      const markdown = [
        `# ${candidate.title}`,
        candidate.summary || `${platform} article content is not directly readable.`,
        paywalled ? "[Access limited: article appears to require subscription or sign-in.]" : "[Read failed: content could not be extracted.]"
      ].join("\n\n");
      return createNewsReadResult(candidate, {
        title: candidate.title,
        author: candidate.author,
        publishedAt: candidate.published_at,
        markdown,
        accessLimited: paywalled,
        accessNotes: paywalled ? "subscription_or_login_required" : "read_failed"
      });
    }
  };
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
      summary: "Douyin in-site video search entry for Chinese trending clips and event videos.",
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


async function searchGitHub(query) {
  try {
    const payload = await fetchJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=6&sort=stars&order=desc`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28"
      },
      timeoutMs: 12000,
      retries: 0
    });
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const candidates = items
      .filter((item) => item?.html_url && item?.full_name)
      .map((item, index) => createStructuredSiteConnectorCandidate({
        connectorId: "github",
        platform: "GitHub",
        query,
        title: item.full_name,
        url: item.html_url,
        author: item.owner?.login || "GitHub",
        publishedAt: item.updated_at || item.created_at || null,
        summary: [
          item.description,
          item.language ? `Language: ${item.language}` : "",
          Number.isFinite(item.stargazers_count) ? `${item.stargazers_count} stars` : "",
          Number.isFinite(item.forks_count) ? `${item.forks_count} forks` : ""
        ].filter(Boolean).join(" | "),
        authorityFloor: 0.78,
        score: 0.96 - index * 0.05,
        engagement: (item.stargazers_count || 0) + (item.forks_count || 0),
        metadata: {
          native_search: true,
          search_backend: "github_public_api",
          stars: item.stargazers_count || 0,
          forks: item.forks_count || 0,
          language: item.language || null,
          topics: Array.isArray(item.topics) ? item.topics.slice(0, 6) : []
        }
      }));
    if (candidates.length) {
      return candidates;
    }
  } catch (error) {
  }

  return createNativeFirstSiteConnectorSearch({
    connectorId: "github",
    platform: "GitHub",
    domain: "github.com",
    searchUrlBuilder: (nativeQuery) => `https://github.com/search?q=${encodeURIComponent(nativeQuery)}&type=repositories`,
    authorityFloor: 0.78
  })(query);
}

async function searchReddit(query) {
  try {
    const payload = await fetchJson(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=6&sort=relevance&t=all&raw_json=1`, {
      headers: {
        accept: "application/json"
      },
      timeoutMs: 12000,
      retries: 0
    });
    const items = Array.isArray(payload?.data?.children) ? payload.data.children : [];
    const candidates = items
      .map((item) => item?.data)
      .filter((item) => item?.permalink && item?.title)
      .map((item, index) => createStructuredSiteConnectorCandidate({
        connectorId: "reddit",
        platform: "Reddit",
        query,
        title: item.title,
        url: `https://www.reddit.com${item.permalink}`,
        author: item.author ? `u/${item.author}` : "Reddit",
        publishedAt: item.created_utc ? new Date(item.created_utc * 1000).toISOString() : null,
        summary: [
          item.selftext,
          item.subreddit ? `r/${item.subreddit}` : "",
          Number.isFinite(item.score) ? `${item.score} points` : "",
          Number.isFinite(item.num_comments) ? `${item.num_comments} comments` : ""
        ].filter(Boolean).join(" | "),
        authorityFloor: 0.74,
        score: 0.95 - index * 0.05,
        engagement: (item.score || 0) + (item.num_comments || 0),
        metadata: {
          native_search: true,
          search_backend: "reddit_public_json",
          subreddit: item.subreddit || null,
          num_comments: item.num_comments || 0,
          is_self: item.is_self === true
        }
      }));
    if (candidates.length) {
      return candidates;
    }
  } catch (error) {
  }

  return createNativeFirstSiteConnectorSearch({
    connectorId: "reddit",
    platform: "Reddit",
    domain: "reddit.com",
    searchUrlBuilder: (nativeQuery) => `https://www.reddit.com/search/?q=${encodeURIComponent(nativeQuery)}`,
    authorityFloor: 0.74
  })(query);
}

async function searchWikipedia(query) {
  const language = isChineseText(query) ? "zh" : "en";
  try {
    const payload = await fetchJson(`https://${language}.wikipedia.org/w/api.php?action=query&list=search&utf8=1&format=json&srlimit=6&srsearch=${encodeURIComponent(query)}`, {
      headers: {
        accept: "application/json"
      },
      timeoutMs: 12000,
      retries: 0
    });
    const items = Array.isArray(payload?.query?.search) ? payload.query.search : [];
    const candidates = items
      .filter((item) => item?.title)
      .map((item, index) => {
        const pageUrl = `https://${language}.wikipedia.org/wiki/${encodeURIComponent(String(item.title).replace(/\s+/g, "_"))}`;
        return createStructuredSiteConnectorCandidate({
          connectorId: "wikipedia",
          platform: "Wikipedia",
          query,
          title: item.title,
          url: pageUrl,
          author: `${language.toUpperCase()} Wikipedia`,
          publishedAt: null,
          summary: stripTags(item.snippet || item.title),
          authorityFloor: 0.9,
          score: 0.97 - index * 0.04,
          metadata: {
            native_search: true,
            search_backend: "mediawiki_api",
            wiki_language: language,
            pageid: item.pageid || null,
            wordcount: item.wordcount || null
          }
        });
      });
    if (candidates.length) {
      return candidates;
    }
  } catch (error) {
  }

  return createNativeFirstSiteConnectorSearch({
    connectorId: "wikipedia",
    platform: "Wikipedia",
    domain: "wikipedia.org",
    searchUrlBuilder: (nativeQuery) => `https://${language}.wikipedia.org/w/index.php?search=${encodeURIComponent(nativeQuery)}`,
    authorityFloor: 0.9
  })(query);
}

function parseZhihuSearchHtml(html, query, context = {}) {
  const genericCandidates = parseGenericSiteSearchHtml(html, query, {
    connectorId: "zhihu",
    platform: "Zhihu",
    domain: "zhihu.com",
    searchUrl: context.searchUrl || "https://www.zhihu.com/",
    authorityFloor: 0.72
  });

  return genericCandidates
    .filter((candidate) => /zhihu\.com\/(question\/\d+|p\/\d+|zvideo\/\d+|column\/[^/?#]+)/i.test(candidate.url))
    .map((candidate) => ({
      ...candidate,
      metadata: {
        ...(candidate.metadata || {}),
        native_search: true,
        search_backend: "zhihu_html"
      }
    }));
}

async function searchZhihu(query) {
  return createNativeFirstSiteConnectorSearch({
    connectorId: "zhihu",
    platform: "Zhihu",
    domain: "zhihu.com",
    searchUrlBuilder: (nativeQuery) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(nativeQuery)}`,
    parse: parseZhihuSearchHtml,
    authorityFloor: 0.72,
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  })(query);
}

const GOOGLE_CONNECTOR_DOMAINS = [
  "google.com",
  "blog.google",
  "developers.google.com",
  "ai.google.dev",
  "cloud.google.com",
  "support.google.com",
  "research.google"
];

function markNativeSearchCandidates(candidates, searchBackend) {
  return candidates.map((candidate) => ({
    ...candidate,
    metadata: {
      ...(candidate.metadata || {}),
      native_search: true,
      search_backend: searchBackend
    }
  }));
}

async function searchPlanetEbook(query) {
  return createNativeFirstSiteConnectorSearch({
    connectorId: "planetebook",
    platform: "Planet eBook",
    domain: "planetebook.com",
    searchUrlBuilder: (nativeQuery) => `https://www.planetebook.com/?s=${encodeURIComponent(nativeQuery)}`,
    contentType: "document",
    sourceType: "document",
    authorityFloor: 0.76,
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9"
    }
  })(query);
}

async function searchGoogle(query) {
  const domainClause = GOOGLE_CONNECTOR_DOMAINS.map((domain) => `site:${domain}`).join(" OR ");
  const searchQuery = `${query} ${domainClause}`;
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
    const html = await fetchText(searchUrl, {
      timeoutMs: 12000,
      retries: 0,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    const nativeCandidates = parseGenericSiteSearchHtml(html, query, {
      connectorId: "google",
      platform: "Google",
      domain: GOOGLE_CONNECTOR_DOMAINS,
      searchUrl,
      authorityFloor: 0.94
    });
    if (nativeCandidates.length) {
      return markNativeSearchCandidates(nativeCandidates, "google_search_html").slice(0, 6);
    }
  } catch (error) {
  }

  return searchAcrossBingDomains(query, GOOGLE_CONNECTOR_DOMAINS, {
    connectorId: "google",
    platform: "Google",
    authorityFloor: 0.94,
    maxResults: 6,
    metadata: {
      search_backend: "bing_multi_site"
    }
  });
}

async function searchStackOverflow(query) {
  try {
    const payload = await fetchJson(`https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=6&filter=withbody`, {
      headers: {
        accept: "application/json"
      },
      timeoutMs: 12000,
      retries: 0
    });
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const candidates = items
      .filter((item) => item?.link && item?.title)
      .map((item, index) => createStructuredSiteConnectorCandidate({
        connectorId: "stack_overflow",
        platform: "Stack Overflow",
        query,
        title: stripTags(item.title),
        url: item.link,
        author: item.owner?.display_name || "Stack Overflow",
        publishedAt: item.creation_date ? new Date(item.creation_date * 1000).toISOString() : null,
        summary: stripTags(item.excerpt || item.body || item.title),
        authorityFloor: 0.8,
        score: 0.95 - index * 0.05,
        engagement: (item.score || 0) + (item.answer_count || 0),
        metadata: {
          native_search: true,
          search_backend: "stackexchange_api",
          tags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : [],
          answer_count: item.answer_count || 0,
          is_answered: item.is_answered === true
        }
      }));
    if (candidates.length) {
      return candidates;
    }
  } catch (error) {
  }

  return createNativeFirstSiteConnectorSearch({
    connectorId: "stack_overflow",
    platform: "Stack Overflow",
    domain: "stackoverflow.com",
    searchUrlBuilder: (nativeQuery) => `https://stackoverflow.com/search?q=${encodeURIComponent(nativeQuery)}`,
    authorityFloor: 0.8
  })(query);
}

function extractBalancedJsonBlock(text, startIndex) {
  const source = String(text || "");
  const start = Number(startIndex);
  if (!Number.isInteger(start) || start < 0 || start >= source.length) {
    return null;
  }

  const opening = source[start];
  const closing = opening === "{" ? "}" : (opening === "[" ? "]" : null);
  if (!closing) {
    return null;
  }

  const stack = [closing];
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function extractJsonFromHtmlByMarkers(html, markers = []) {
  const source = String(html || "");
  for (const marker of markers) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) {
      continue;
    }
    const start = source.slice(markerIndex + marker.length).search(/[\[{]/);
    if (start === -1) {
      continue;
    }
    const jsonStart = markerIndex + marker.length + start;
    const block = extractBalancedJsonBlock(source, jsonStart);
    if (!block) {
      continue;
    }
    try {
      return JSON.parse(block);
    } catch (_) {
      continue;
    }
  }
  return null;
}

function readYouTubeTextNode(node) {
  if (!node) {
    return "";
  }
  if (typeof node === "string") {
    return normalizeWhitespace(node);
  }
  if (typeof node.simpleText === "string") {
    return normalizeWhitespace(node.simpleText);
  }
  if (Array.isArray(node.runs)) {
    return normalizeWhitespace(node.runs.map((item) => item?.text || "").join(" "));
  }
  return "";
}

function collectYouTubeVideoRenderers(root, limit = 12) {
  const results = [];

  function visit(node) {
    if (!node || results.length >= limit) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
        if (results.length >= limit) {
          break;
        }
      }
      return;
    }
    if (typeof node !== "object") {
      return;
    }
    if (node.videoRenderer && typeof node.videoRenderer === "object") {
      results.push(node.videoRenderer);
      return;
    }
    for (const value of Object.values(node)) {
      visit(value);
      if (results.length >= limit) {
        break;
      }
    }
  }

  visit(root);
  return results;
}

function extractYouTubeSearchDuration(renderer) {
  const direct = readYouTubeTextNode(renderer.lengthText);
  if (direct) {
    return direct;
  }
  const overlays = Array.isArray(renderer.thumbnailOverlays) ? renderer.thumbnailOverlays : [];
  for (const overlay of overlays) {
    const label = readYouTubeTextNode(overlay?.thumbnailOverlayTimeStatusRenderer?.text);
    if (label) {
      return label;
    }
  }
  return null;
}

function parseYouTubeSearchHtml(html, query) {
  const initialData = extractJsonFromHtmlByMarkers(html, [
    "var ytInitialData = ",
    "window['ytInitialData'] = ",
    "window[\"ytInitialData\"] = ",
    "ytInitialData = "
  ]);
  if (!initialData) {
    return [];
  }

  const renderers = collectYouTubeVideoRenderers(initialData, 12);
  const seen = new Set();
  const candidates = [];

  for (const renderer of renderers) {
    const videoId = renderer.videoId;
    if (!videoId) {
      continue;
    }
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);

    const title = readYouTubeTextNode(renderer.title) || `YouTube video for ${query}`;
    const author = readYouTubeTextNode(renderer.ownerText) || readYouTubeTextNode(renderer.longBylineText) || null;
    const publishedLabel = readYouTubeTextNode(renderer.publishedTimeText) || null;
    const duration = extractYouTubeSearchDuration(renderer);
    const views = readYouTubeTextNode(renderer.viewCountText) || readYouTubeTextNode(renderer.shortViewCountText) || null;
    const description = [
      readYouTubeTextNode(renderer.descriptionSnippet),
      ...(Array.isArray(renderer.detailedMetadataSnippets)
        ? renderer.detailedMetadataSnippets.map((item) => readYouTubeTextNode(item?.snippetText))
        : [])
    ].filter(Boolean).join(" ");
    const thumbnails = Array.isArray(renderer.thumbnail?.thumbnails)
      ? renderer.thumbnail.thumbnails.map((item) => item?.url).filter(Boolean)
      : [];
    const candidate = normalizeSiteConnectorCandidate({
      id: makeId("video", url),
      title,
      url,
      author,
      published_at: publishedLabel,
      duration,
      summary: description || [author, views, publishedLabel].filter(Boolean).join(" | "),
      score: Number(Math.max(0.58, 0.93 - (candidates.length * 0.05)).toFixed(4)),
      metadata: {
        preview_image: thumbnails[thumbnails.length - 1] || null,
        page_images: thumbnails.slice(-3),
        views,
        published_label: publishedLabel,
        native_search: true,
        video_id: videoId
      }
    }, query, {
      connectorId: "youtube",
      platform: "YouTube",
      contentType: "video",
      sourceType: "video",
      authorityFloor: 0.86
    });
    candidates.push(candidate);
    if (candidates.length >= 8) {
      break;
    }
  }

  return candidates;
}

async function searchYouTube(query) {
  try {
    const html = await fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      timeoutMs: 12000,
      retries: 0,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    const nativeCandidates = parseYouTubeSearchHtml(html, query);
    if (nativeCandidates.length > 0) {
      return nativeCandidates;
    }
  } catch (_) {
  }

  return createBingSiteConnectorSearch({
    connectorId: "youtube",
    platform: "YouTube",
    domain: ["youtube.com", "youtu.be"],
    contentType: "video",
    sourceType: "video",
    authorityFloor: 0.86
  })(query);
}

function parseIso8601DurationToTimestamp(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) {
    return null;
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
  return totalSeconds > 0 ? timestampFromMilliseconds(totalSeconds * 1000) : null;
}

function parseYouTubePageMetadata(html, candidate = {}) {
  const normalizedHtml = String(html || "");
  const titleMatch = normalizedHtml.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
    || normalizedHtml.match(/<title>([^<]+)<\/title>/i);
  const descriptionMatch = normalizedHtml.match(/<meta[^>]+(?:name|property)="(?:description|og:description)"[^>]+content="([^"]+)"/i);
  const imageMatch = normalizedHtml.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  const authorMatch = normalizedHtml.match(/<link[^>]+itemprop="name"[^>]+content="([^"]+)"/i)
    || normalizedHtml.match(/<meta[^>]+itemprop="author"[^>]+content="([^"]+)"/i)
    || normalizedHtml.match(/"ownerChannelName":"([^"]+)"/i);
  const publishedAtMatch = normalizedHtml.match(/<meta[^>]+itemprop="datePublished"[^>]+content="([^"]+)"/i)
    || normalizedHtml.match(/"publishDate":"([^"]+)"/i);
  const durationMatch = normalizedHtml.match(/<meta[^>]+itemprop="duration"[^>]+content="([^"]+)"/i);

  let structured = null;
  const ldJsonMatches = [...normalizedHtml.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of ldJsonMatches) {
    try {
      const payload = JSON.parse(match[1]);
      const records = Array.isArray(payload) ? payload : [payload];
      structured = records.find((item) => item?.["@type"] === "VideoObject") || structured;
      if (structured) {
        break;
      }
    } catch (_) {
      // Ignore malformed JSON-LD blocks.
    }
  }

  const title = stripTags(decodeHtmlEntities(structured?.name || titleMatch?.[1] || candidate.title || "")).replace(/\s*-\s*YouTube$/i, "").trim();
  const description = normalizeWhitespace(stripTags(decodeHtmlEntities(structured?.description || descriptionMatch?.[1] || candidate.summary || "")));
  const author = normalizeWhitespace(stripTags(decodeHtmlEntities(structured?.author?.name || authorMatch?.[1] || candidate.author || ""))) || null;
  const publishedAt = structured?.uploadDate || publishedAtMatch?.[1] || candidate.published_at || null;
  const duration = parseIso8601DurationToTimestamp(structured?.duration || durationMatch?.[1]);
  const previewImage = resolveAbsoluteUrl(candidate.url, structured?.thumbnailUrl || imageMatch?.[1] || candidate.metadata?.preview_image || null);

  return {
    title: title || candidate.title,
    description,
    author,
    published_at: publishedAt,
    duration,
    preview_image: previewImage
  };
}

function extractYouTubePlayerResponse(html) {
  return extractJsonFromHtmlByMarkers(html, [
    "var ytInitialPlayerResponse = ",
    "window['ytInitialPlayerResponse'] = ",
    "window[\"ytInitialPlayerResponse\"] = ",
    "ytInitialPlayerResponse = "
  ]);
}

function selectYouTubeCaptionTrack(tracks = []) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return null;
  }

  const scored = tracks.map((track, index) => {
    const languageCode = String(track.languageCode || "").toLowerCase();
    const vssId = String(track.vssId || "").toLowerCase();
    const name = readYouTubeTextNode(track.name).toLowerCase();
    let score = 0;
    if (!/^a\./.test(vssId)) score += 4;
    if (languageCode === "en") score += 3;
    if (languageCode.startsWith("en-")) score += 2;
    if (!/auto|generated/.test(name)) score += 1;
    return { track, score, index };
  });

  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored[0]?.track || null;
}

function parseYouTubeCaptionJson3(payload) {
  const data = typeof payload === "string" ? JSON.parse(payload) : (payload || {});
  const events = Array.isArray(data.events) ? data.events : [];
  return events
    .map((event) => {
      const text = normalizeWhitespace((event.segs || []).map((segment) => decodeHtmlEntities(segment?.utf8 || "")).join(""));
      const startSeconds = Number(event.tStartMs || 0) / 1000;
      if (!text) {
        return null;
      }
      return {
        start: startSeconds,
        dur: Number(event.dDurationMs || 0) / 1000,
        time: timestampFromMilliseconds(startSeconds * 1000),
        text
      };
    })
    .filter(Boolean);
}

function parseYouTubeCaptionXml(xml) {
  return [...String(xml || "").matchAll(/<text\b[^>]*start="([^"]+)"[^>]*?(?:dur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((match) => {
      const startSeconds = Number(match[1] || 0);
      const durSeconds = Number(match[2] || 0);
      const text = normalizeWhitespace(decodeHtmlEntities(match[3]).replace(/<[^>]+>/g, " "));
      if (!text) {
        return null;
      }
      return {
        start: startSeconds,
        dur: durSeconds,
        time: timestampFromMilliseconds(startSeconds * 1000),
        text
      };
    })
    .filter(Boolean);
}

async function fetchYouTubeCaptionTrack(track) {
  if (!track?.baseUrl) {
    return [];
  }

  const jsonUrl = new URL(track.baseUrl);
  jsonUrl.searchParams.set("fmt", "json3");
  try {
    const payload = await fetchJson(jsonUrl.toString(), {
      timeoutMs: 10000,
      retries: 0,
      headers: {
        accept: "application/json,text/plain;q=0.9,*/*;q=0.8"
      }
    });
    const cues = parseYouTubeCaptionJson3(payload);
    if (cues.length > 0) {
      return cues;
    }
  } catch (_) {
  }

  const xmlUrl = new URL(track.baseUrl);
  xmlUrl.searchParams.delete("fmt");
  const xml = await fetchText(xmlUrl.toString(), {
    timeoutMs: 10000,
    retries: 0,
    headers: {
      accept: "text/xml,application/xml,text/plain;q=0.9,*/*;q=0.8"
    }
  });
  return parseYouTubeCaptionXml(xml);
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
    description: "General-purpose web search and page reading via Jina Reader.",
    capabilities: ["search", "web", "news", "official pages", "content extraction"],
    search: searchBingWeb,
    read: readWebSource
  },
  {
    id: "hacker_news",
    label: "Hacker News",
    description: "Community discussion source for opinions and early signals.",
    capabilities: ["search", "discussion", "community", "comments", "content extraction"],
    search: searchHackerNews,
    read: readHackerNewsSource
  },
  {
    id: "segmentfault",
    label: "SegmentFault",
    description: "Chinese developer community source for tutorials and deep technical articles.",
    capabilities: ["search", "long-form", "tutorials", "community", "content extraction"],
    search: searchSegmentFault,
    read: readSegmentFaultSource
  },
  {
    id: "ithome",
    label: "ITHome",
    description: "Chinese tech news source for product and industry updates.",
    capabilities: ["search", "news", "updates", "products", "content extraction"],
    search: searchITHome,
    read: readITHomeSource
  },
  {
    id: "arxiv",
    label: "arXiv",
    description: "Research source for papers, abstracts, and citations.",
    capabilities: ["search", "papers", "research", "abstracts", "content extraction"],
    search: searchArxiv,
    read: readArxivSource
  },
  {
    id: "bilibili",
    label: "Bilibili",
    description: "Chinese video platform for tutorials, talks, and creator content.",
    capabilities: ["search", "video", "tutorials", "chinese content", "video metadata"],
    search: searchBilibili,
    read: readBilibiliSource
  },
  {
    id: "douyin",
    label: "Douyin",
    description: "Chinese short-video source for trending clips and event footage.",
    capabilities: ["search", "video", "short-form", "chinese content", "in-site search"],
    search: searchDouyin,
    read: readDouyinSourceV2
  },
  {
    id: "ted",
    label: "TED",
    description: "Talk-video source with transcripts and speaker metadata.",
    capabilities: ["search", "video", "talks", "transcripts", "video metadata"],
    search: searchTed,
    read: readTedSource
  },
  {
    id: "youtube",
    label: "YouTube",
    description: "Global video platform for talks, tutorials, interviews, and creator content.",
    capabilities: ["search", "video", "talks", "tutorials", "transcripts", "video metadata"],
    domains: ["youtube.com", "youtu.be"],
    search: searchYouTube,
    read: readYouTubeSource
  },
  {
    id: "xinhua",
    label: "Xinhua",
    description: "Chinese state news source for official reporting and breaking news coverage.",
    capabilities: ["search", "news", "china news", "official reporting", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "xinhua",
      platform: "Xinhua",
      domain: ["xinhuanet.com", "news.cn"],
      searchUrlBuilder: (query) => `https://so.news.cn/?keyword=${encodeURIComponent(query)}`,
      authorityFloor: 0.92
    }),
    read: createNativeFirstNewsReadSource({ platform: "Xinhua" })
  },
  {
    id: "people",
    label: "People.cn",
    description: "Chinese official news source for public affairs, policy, and major events.",
    capabilities: ["search", "news", "china news", "official reporting", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "people",
      platform: "People.cn",
      domain: "people.com.cn",
      searchUrlBuilder: (query) => `http://search.people.com.cn/s?keyword=${encodeURIComponent(query)}`,
      authorityFloor: 0.9
    }),
    read: createNativeFirstNewsReadSource({ platform: "People.cn" })
  },
  {
    id: "cctv_news",
    label: "CCTV News",
    description: "Chinese broadcast news source for major events, policy, and official video-backed reports.",
    capabilities: ["search", "news", "china news", "official reporting", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "cctv_news",
      platform: "CCTV News",
      domain: ["news.cctv.com", "cctv.com"],
      searchUrlBuilder: (query) => `https://search.cctv.com/search.php?qtext=${encodeURIComponent(query)}`,
      authorityFloor: 0.9
    }),
    read: createNativeFirstNewsReadSource({ platform: "CCTV News" })
  },
  {
    id: "the_paper",
    label: "The Paper",
    description: "Chinese mainstream news source for current affairs, investigations, and explanatory reporting.",
    capabilities: ["search", "news", "china news", "current affairs", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "the_paper",
      platform: "The Paper",
      domain: "thepaper.cn",
      searchUrlBuilder: (query) => `https://www.thepaper.cn/searchResult?id=${encodeURIComponent(query)}`,
      authorityFloor: 0.86
    }),
    read: createNativeFirstNewsReadSource({ platform: "The Paper" })
  },
  {
    id: "caixin",
    label: "Caixin",
    description: "Chinese business news source for finance, policy, and enterprise coverage.",
    capabilities: ["search", "news", "business news", "finance", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "caixin",
      platform: "Caixin",
      domain: "caixin.com",
      searchUrlBuilder: (query) => `https://search.caixin.com/search/${encodeURIComponent(query)}.html`,
      authorityFloor: 0.88
    }),
    read: createNativeFirstNewsReadSource({ platform: "Caixin", paywalled: true })
  },
  {
    id: "jiemian",
    label: "Jiemian",
    description: "Chinese business and market news source for companies, industries, and commentary.",
    capabilities: ["search", "news", "business news", "markets", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "jiemian",
      platform: "Jiemian",
      domain: "jiemian.com",
      searchUrlBuilder: (query) => `https://www.jiemian.com/search?searchText=${encodeURIComponent(query)}`,
      authorityFloor: 0.84
    }),
    read: createNativeFirstNewsReadSource({ platform: "Jiemian" })
  },
  {
    id: "reuters",
    label: "Reuters",
    description: "International wire service for breaking news, markets, and official reporting.",
    capabilities: ["search", "news", "breaking news", "international news", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "reuters",
      platform: "Reuters",
      domain: "reuters.com",
      searchUrlBuilder: (query) => `https://www.reuters.com/site-search/?query=${encodeURIComponent(query)}`,
      authorityFloor: 0.93
    }),
    read: createNativeFirstNewsReadSource({ platform: "Reuters" })
  },
  {
    id: "ap_news",
    label: "AP News",
    description: "Associated Press news source for breaking news and factual reporting.",
    capabilities: ["search", "news", "breaking news", "international news", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "ap_news",
      platform: "AP News",
      domain: "apnews.com",
      searchUrlBuilder: (query) => `https://apnews.com/search?q=${encodeURIComponent(query)}`,
      authorityFloor: 0.92
    }),
    read: createNativeFirstNewsReadSource({ platform: "AP News" })
  },
  {
    id: "bbc_news",
    label: "BBC News",
    description: "International public-service news source for breaking events and explainers.",
    capabilities: ["search", "news", "international news", "explainers", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "bbc_news",
      platform: "BBC News",
      domain: ["bbc.com", "bbc.co.uk"],
      searchUrlBuilder: (query) => `https://www.bbc.co.uk/search?q=${encodeURIComponent(query)}`,
      authorityFloor: 0.9
    }),
    read: createNativeFirstNewsReadSource({ platform: "BBC News" })
  },
  {
    id: "bloomberg",
    label: "Bloomberg",
    description: "Global business news source for markets, companies, and macroeconomic coverage.",
    capabilities: ["search", "news", "business news", "markets", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "bloomberg",
      platform: "Bloomberg",
      domain: "bloomberg.com",
      searchUrlBuilder: (query) => `https://www.bloomberg.com/search?query=${encodeURIComponent(query)}`,
      authorityFloor: 0.91
    }),
    read: createNativeFirstNewsReadSource({ platform: "Bloomberg", paywalled: true })
  },
  {
    id: "nytimes",
    label: "The New York Times",
    description: "International newspaper source for politics, business, and long-form reporting.",
    capabilities: ["search", "news", "international news", "analysis", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "nytimes",
      platform: "The New York Times",
      domain: "nytimes.com",
      searchUrlBuilder: (query) => `https://www.nytimes.com/search?query=${encodeURIComponent(query)}`,
      authorityFloor: 0.9
    }),
    read: createNativeFirstNewsReadSource({ platform: "The New York Times", paywalled: true })
  },
  {
    id: "wsj",
    label: "The Wall Street Journal",
    description: "Business and finance newspaper source for markets, companies, and policy coverage.",
    capabilities: ["search", "news", "business news", "markets", "content extraction"],
    search: createNativeFirstSiteConnectorSearch({
      connectorId: "wsj",
      platform: "The Wall Street Journal",
      domain: "wsj.com",
      searchUrlBuilder: (query) => `https://www.wsj.com/search?query=${encodeURIComponent(query)}`,
      authorityFloor: 0.9
    }),
    read: createNativeFirstNewsReadSource({ platform: "The Wall Street Journal", paywalled: true })
  },
  {
    id: "planetebook",
    label: "Planet eBook",
    description: "Free classic literature source for downloadable eBooks, author pages, and reading formats.",
    capabilities: ["search", "ebooks", "books", "classics", "content extraction"],
    search: searchPlanetEbook,
    read: readWebSource
  },
  {
    id: "google",
    label: "Google",
    description: "Official Google source for product announcements, documentation, help content, and research pages.",
    capabilities: ["search", "official pages", "docs", "product updates", "content extraction"],
    search: searchGoogle,
    read: readWebSource
  },
  {
    id: "github",
    label: "GitHub",
    description: "Code hosting source for repositories, issues, documentation, and release notes.",
    capabilities: ["search", "code", "repositories", "issues", "docs", "content extraction"],
    search: searchGitHub,
    read: readWebSource
  },
  {
    id: "reddit",
    label: "Reddit",
    description: "Community discussion source for user reports, troubleshooting, and sentiment.",
    capabilities: ["search", "discussion", "community", "user reports", "content extraction"],
    search: searchReddit,
    read: readWebSource
  },
  {
    id: "wikipedia",
    label: "Wikipedia",
    description: "Reference source for encyclopedic summaries and historical background.",
    capabilities: ["search", "reference", "encyclopedia", "background", "content extraction"],
    search: searchWikipedia,
    read: readWebSource
  },
  {
    id: "zhihu",
    label: "Zhihu",
    description: "Chinese knowledge community source for explainers, Q&A, and commentary.",
    capabilities: ["search", "community", "q&a", "explainers", "content extraction"],
    search: searchZhihu,
    read: readWebSource
  },
  {
    id: "stack_overflow",
    label: "Stack Overflow",
    description: "Developer Q&A source for implementation details, debugging, and code examples.",
    capabilities: ["search", "q&a", "developer", "debugging", "content extraction"],
    search: searchStackOverflow,
    read: readWebSource
  }
];

const STATIC_CONNECTOR_DOMAINS = {
  bing_web: [],
  hacker_news: ["news.ycombinator.com", "hn.algolia.com"],
  segmentfault: ["segmentfault.com"],
  ithome: ["ithome.com"],
  arxiv: ["arxiv.org"],
  bilibili: ["bilibili.com"],
  douyin: ["douyin.com", "iesdouyin.com"],
  ted: ["ted.com"],
  github: ["github.com"],
  reddit: ["reddit.com"],
  wikipedia: ["wikipedia.org"],
  zhihu: ["zhihu.com"],
  stack_overflow: ["stackoverflow.com"],
  planetebook: ["planetebook.com"],
  google: GOOGLE_CONNECTOR_DOMAINS
};

function finalizeConnectorMetadata(connector, overrides = {}) {
  const normalizedDomains = Array.from(new Set([
    ...((overrides.domains || connector.domains || STATIC_CONNECTOR_DOMAINS[connector.id] || []).map((item) => normalizeGeneratedConnectorDomain(item)))
  ].filter(Boolean)));
  connector.generated = overrides.generated === true || connector.generated === true;
  connector.domains = normalizedDomains;
  connector.supports_search = overrides.supports_search != null
    ? overrides.supports_search === true
    : typeof connector.search === "function";
  connector.supports_read = overrides.supports_read != null
    ? overrides.supports_read === true
    : typeof connector.read === "function";
  connector.capabilities = Array.from(new Set([
    ...(Array.isArray(connector.capabilities) ? connector.capabilities : []),
    ...(connector.supports_search ? ["search"] : []),
    ...(connector.supports_read ? ["content extraction"] : [])
  ]));
  return connector;
}

for (const connector of connectorRegistry) {
  finalizeConnectorMetadata(connector, { generated: false });
}

const connectorRuntime = createConnectorRuntime({
  connectorRegistry,
  buildQueryTokens,
  normalizeWhitespace,
  normalizeCandidateMediaMetadata
});
const connectorMap = connectorRuntime.connectorMap;
const resolveDiscoverConnectors = connectorRuntime.resolveDiscoverConnectors;
const invokeSourceTool = connectorRuntime.invokeSourceTool;
const searchRealSources = connectorRuntime.searchRealSources;
const readCandidate = connectorRuntime.readCandidate;
sourceCatalog = connectorRuntime.sourceCatalog;

function getConnectorById(connectorId) {
  return connectorMap.get(connectorId) || null;
}

function connectorSupportsDomain(connector, domain) {
  const normalizedDomain = normalizeGeneratedConnectorDomain(domain);
  if (!connector || !normalizedDomain) {
    return false;
  }
  return (connector.domains || []).some((item) => item === normalizedDomain || normalizedDomain.endsWith(`.${item}`) || item.endsWith(`.${normalizedDomain}`));
}

function findConnectorByDomain(domain) {
  const normalizedDomain = normalizeGeneratedConnectorDomain(domain);
  if (!normalizedDomain) {
    return null;
  }
  return sourceCatalog.find((connector) => connectorSupportsDomain(connector, normalizedDomain)) || null;
}

function ensureGeneratedConnectorTools(record) {
  const readToolId = record.tool_ids?.read || `generated_read_${record.id}`;
  const searchToolId = record.tool_ids?.search || `generated_search_${record.id}`;

  if (!ToolRegistry.getTool(readToolId)) {
    ToolRegistry.registerTool({
      id: readToolId,
      base_tool_id: readToolId,
      name: `${record.label} Read`,
      description: `Read public pages from ${record.domain} through the generated connector runtime.`,
      parameters: [{ name: "candidate", type: "object", required: true, description: "Candidate to read" }],
      execute: async ({ candidate }) => readGeneratedSiteConnector(candidate, record),
      source: "dynamic",
      status: "active",
      lifecycle_state: "registered",
      promoted_to_builtin: true,
      created_for: "llm_orchestrator"
    });
  }

  if (record.supports_search && !ToolRegistry.getTool(searchToolId)) {
    ToolRegistry.registerTool({
      id: searchToolId,
      base_tool_id: searchToolId,
      name: `${record.label} Search`,
      description: `Search ${record.domain} through the generated connector runtime.`,
      parameters: [{ name: "query", type: "string", required: true, description: "Query to search" }],
      execute: async ({ query }) => ({ results: await searchGeneratedSiteConnector(query, record) }),
      source: "dynamic",
      status: "active",
      lifecycle_state: "registered",
      promoted_to_builtin: true,
      created_for: "llm_orchestrator"
    });
  }
}

function registerGeneratedSiteConnector(record) {
  const normalized = normalizeGeneratedConnectorRecord(record);
  const existing = connectorMap.get(normalized.id);
  if (existing) {
    finalizeConnectorMetadata(existing, normalized);
    return existing;
  }

  ensureGeneratedConnectorTools(normalized);

  const generatedConnector = finalizeConnectorMetadata({
    id: normalized.id,
    label: normalized.label,
    description: normalized.description,
    capabilities: normalized.capabilities,
    generated: true,
    domains: normalized.domains,
    supports_search: normalized.supports_search,
    supports_read: normalized.supports_read,
    tool_id: normalized.tool_id,
    tool_ids: normalized.tool_ids,
    status: normalized.status,
    search_config: normalized.search_config,
    last_verification: normalized.last_verification,
    last_verified_at: normalized.last_verified_at,
    search: normalized.supports_search
      ? async (query) => searchGeneratedSiteConnector(query, normalized)
      : async () => [],
    read: normalized.supports_read
      ? async (candidate) => readGeneratedSiteConnector(candidate, normalized)
      : null
  }, normalized);

  connectorRegistry.push(generatedConnector);
  connectorMap.set(generatedConnector.id, generatedConnector);
  sourceCatalog.push({
    id: generatedConnector.id,
    label: generatedConnector.label,
    description: generatedConnector.description,
    capabilities: generatedConnector.capabilities,
    generated: true,
    domains: generatedConnector.domains,
    supports_search: generatedConnector.supports_search,
    supports_read: generatedConnector.supports_read,
    tool_id: generatedConnector.tool_id,
    tool_ids: generatedConnector.tool_ids,
    status: generatedConnector.status,
    last_verified_at: generatedConnector.last_verified_at || null
  });
  return generatedConnector;
}

function loadPersistedGeneratedSiteConnectors() {
  const store = readGeneratedConnectorStore();
  for (const record of store.connectors.filter((item) => item.status !== "deleted")) {
    registerGeneratedSiteConnector(record);
  }
  return store.connectors.length;
}

loadPersistedGeneratedSiteConnectors();

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
    "Source: Hacker News",
    candidate.metadata?.external_url ? `Original URL: ${candidate.metadata.external_url}` : "",
    "",
    item.text ? stripTags(item.text) : "Original post has no body text; comment highlights are listed below.",
    "",
    articleMarkdown ? "## Related Article Summary\n" : "",
    articleMarkdown || "",
    "",
    comments.length ? "## Top Comments\n" : "",
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
      item.text ? stripTags(item.text).slice(0, 220) : "This source mainly contains discussion threads and comments.",
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

  const markdown = [
    `# ${candidate.title}`,
    "",
    `Author: ${candidate.author || "Unknown"}`,
    candidate.published_at ? `Published At: ${candidate.published_at}` : "",
    "",
    candidate.summary
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
  if (/(captcha|verification|complete verification)/i.test(bodyText)) {
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
      if (/^第\d+集/.test(summary) || summary === "下一集") {
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
  
  // Try enriching with transcription when available.
  let transcript = [];
  let timeline = [];
  let keyPoints = [
    description.slice(0, 220),
    `Author ${video.owner?.name || candidate.author || "Unknown"}, views ${stats.view || 0}, likes ${stats.like || 0}, comments ${stats.reply || 0}.`
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
    console.warn(`Bilibili video transcription failed: ${error.message}`);
  }
  
  const markdown = [
    `# ${video.title || candidate.title}`,
    "",
    `Author: ${video.owner?.name || candidate.author || "Bilibili Creator"}`,
    formatUnixTimestamp(video.pubdate) ? `Published At: ${formatUnixTimestamp(video.pubdate)}` : "",
    duration ? `Duration: ${duration}` : "",
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
    "This source is currently accessed via the Douyin in-site search landing flow.",
    `Search URL: ${candidate.url}`,
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
    key_points: keyPoints.length > 1
      ? keyPoints
      : [candidate.summary, "Current access is via Douyin search landing pages; open the source for full context."].filter(Boolean),
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
        
        // Try enriching the result with video transcription.
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
          console.warn(`Douyin video transcription failed: ${error.message}`);
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
  let timeline = buildTranscriptTimeline(cues);
  let transcript = cues;
  let keyPoints = [description ? description.slice(0, 220) : "TED talk"];
  
  // Try enriching with automatic video transcription.
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
    console.warn(`TED video transcription failed: ${error.message}`);
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

async function readYouTubeSource(candidate) {
  const html = await fetchText(candidate.url, {
    timeoutMs: 10000,
    retries: 0,
    headers: {
      accept: "text/html,application/xhtml+xml"
    }
  });

  const parsed = parseYouTubePageMetadata(html, candidate);
  const playerResponse = extractYouTubePlayerResponse(html) || {};
  const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const selectedTrack = selectYouTubeCaptionTrack(captionTracks);
  let transcriptSource = null;
  let transcript = [];
  let timeline = [];
  let keyPoints = [
    parsed.description ? parsed.description.slice(0, 220) : candidate.summary,
    parsed.author ? `Author ${parsed.author}` : null,
    parsed.duration ? `Duration ${parsed.duration}` : null
  ].filter(Boolean);

  try {
    if (selectedTrack) {
      transcript = await fetchYouTubeCaptionTrack(selectedTrack);
      timeline = buildTranscriptTimeline(transcript);
      transcriptSource = transcript.length > 0 ? "caption_track" : null;
      const captionKeyPoints = extractVideoKeyPoints(transcript, 8);
      if (captionKeyPoints.length > 0) {
        keyPoints = [...captionKeyPoints, ...keyPoints];
      }
    }
  } catch (error) {
    console.warn(`YouTube caption fetch failed: ${error.message}`);
  }

  if (transcript.length === 0) {
    try {
      const transcribeResult = await transcribeVideo(candidate.url);
      if (transcribeResult.success) {
        transcript = transcribeResult.transcript || [];
        timeline = transcribeResult.timeline || [];
        transcriptSource = transcript.length > 0 ? "audio_transcription" : transcriptSource;
        if (Array.isArray(transcribeResult.key_points) && transcribeResult.key_points.length > 0) {
          keyPoints = [...transcribeResult.key_points, ...keyPoints];
        }
      }
    } catch (error) {
      console.warn(`YouTube video transcription failed: ${error.message}`);
    }
  }

  const transcriptText = transcript
    .map((cue) => {
      const stamp = cue.time || cue.start || "00:00";
      return `[${stamp}] ${cue.text || ""}`.trim();
    })
    .filter(Boolean)
    .join("\n");
  const markdown = [
    `# ${parsed.title || candidate.title}`,
    "",
    parsed.author ? `Author: ${parsed.author}` : "",
    parsed.published_at ? `Published At: ${parsed.published_at}` : "",
    parsed.duration ? `Duration: ${parsed.duration}` : "",
    "",
    parsed.description || candidate.summary || ""
  ].filter(Boolean).join("\n");

  return {
    source_id: candidate.id,
    content_type: candidate.content_type || candidate.source_type,
    source_type: candidate.source_type,
    tool: "extract_video_intel",
    title: parsed.title || candidate.title,
    url: candidate.url,
    author: parsed.author || candidate.author,
    published_at: parsed.published_at || candidate.published_at,
    duration: parsed.duration,
    markdown,
    transcript,
    timeline,
    key_points: keyPoints,
    key_frames: [
      parsed.description ? parsed.description.slice(0, 220) : parsed.title || candidate.title,
      ...timeline.slice(0, 2).map((item) => item.summary)
    ].filter(Boolean),
    facts: extractNumericFacts(`${markdown}\n${transcriptText}`, candidate.id, "youtube_video"),
    metadata: {
      ...(candidate.metadata || {}),
      preview_image: parsed.preview_image || candidate.metadata?.preview_image || null,
      page_images: [parsed.preview_image].filter(Boolean),
      transcript_source: transcriptSource,
      caption_language: selectedTrack?.languageCode || null,
      caption_name: readYouTubeTextNode(selectedTrack?.name) || null
    }
  };
}

function inferConnectorIdFromUrl(url) {
  const hostname = hostFromUrl(url);
  if (/xinhuanet\.com$/.test(hostname) || /news\.cn$/.test(hostname)) return "xinhua";
  if (/people\.com\.cn$/.test(hostname)) return "people";
  if (/news\.cctv\.com$/.test(hostname) || /cctv\.com$/.test(hostname)) return "cctv_news";
  if (/thepaper\.cn$/.test(hostname)) return "the_paper";
  if (/caixin\.com$/.test(hostname)) return "caixin";
  if (/jiemian\.com$/.test(hostname)) return "jiemian";
  if (/reuters\.com$/.test(hostname)) return "reuters";
  if (/apnews\.com$/.test(hostname)) return "ap_news";
  if (/bbc\.com$/.test(hostname) || /bbc\.co\.uk$/.test(hostname)) return "bbc_news";
  if (/bloomberg\.com$/.test(hostname)) return "bloomberg";
  if (/nytimes\.com$/.test(hostname)) return "nytimes";
  if (/wsj\.com$/.test(hostname)) return "wsj";
  if (/planetebook\.com$/.test(hostname)) return "planetebook";
  if (/google\.com$/.test(hostname) || /blog\.google$/.test(hostname) || /developers\.google\.com$/.test(hostname) || /ai\.google\.dev$/.test(hostname) || /cloud\.google\.com$/.test(hostname) || /support\.google\.com$/.test(hostname) || /research\.google$/.test(hostname)) return "google";
  if (/github\.com$/.test(hostname)) return "github";
  if (/reddit\.com$/.test(hostname)) return "reddit";
  if (/wikipedia\.org$/.test(hostname)) return "wikipedia";
  if (/zhihu\.com$/.test(hostname)) return "zhihu";
  if (/stackoverflow\.com$/.test(hostname)) return "stack_overflow";
  if (/youtube\.com$/.test(hostname) || /youtu\.be$/.test(hostname)) return "youtube";
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
  if (connectorId === "bilibili" || connectorId === "douyin" || connectorId === "ted" || connectorId === "youtube") {
    return "video";
  }
  if (connectorId === "segmentfault" || connectorId === "arxiv" || connectorId === "planetebook") {
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
    
    // Mock image analysis output; replace with real provider integration as needed.
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
    
    // Mock image-search output; replace with real provider integration as needed.
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

registerVideoTools(ToolRegistry, {
  transcribeVideo,
  downloadDouyinVideo,
  batchDownloadDouyinVideos,
  VIDEO_PROCESSING_CONFIG
});

registerProductivityTools(ToolRegistry, {
  captureRenderedPage,
  findEdgeExecutable
});

module.exports = {
  samplePrompts,
  sourceCatalog,
  invokeSourceTool,
  searchRealSources,
  readCandidate,
  ToolRegistry,
  registerGeneratedSiteConnector,
  findConnectorByDomain,
  getConnectorById,
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
    parseZhihuSearchHtml,
    parseYouTubeSearchHtml,
    extractYouTubePlayerResponse,
    selectYouTubeCaptionTrack,
    parseYouTubeCaptionJson3,
    parseYouTubeCaptionXml,
    extractBilibiliState,
    resolveDiscoverConnectors,
    captureRenderedPage,
    findEdgeExecutable,
    parseDouyinRenderedPageSafe,
    extractReaderMarkdown,
    stripTags,
    inferConnectorIdFromUrl,
    contentTypeForConnector,
    inferDocumentKindFromUrl,
    parseDelimitedTable,
    connectorSupportsDomain,
    registerGeneratedSiteConnector,
    findConnectorByDomain,
    getConnectorById
  }
};
