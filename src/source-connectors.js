const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { verifyEvidenceUnits } = require("./fact-verifier");
const { extractTextFromResponsePayload } = require("./openai-response");
const { registerProductivityTools } = require("./productivity-tools");
const { createToolRegistry } = require("./tool-registry-core");

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

// 鏁版嵁杞崲宸ュ叿
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
    // 瑙ｆ瀽杈撳叆鏁版嵁
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
      // 瑙ｆ瀽 JSON 瀛楃涓?      parsedData = JSON.parse(data);
    }

    // 搴旂敤杩囨护
    if (filter && typeof filter === 'object') {
      if (Array.isArray(parsedData)) {
        parsedData = parsedData.filter(item => {
          return Object.entries(filter).every(([key, value]) => {
            return item[key] === value;
          });
        });
      }
    }

    // 搴旂敤鏄犲皠
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

    // 搴旂敤鎺掑簭
    if (sortBy && Array.isArray(parsedData)) {
      parsedData.sort((a, b) => {
        if (a[sortBy] < b[sortBy]) return -1;
        if (a[sortBy] > b[sortBy]) return 1;
        return 0;
      });
    }

    // 搴旂敤闄愬埗
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
      // 杈撳嚭 JSON
      result = typeof parsedData === 'string' ? parsedData : JSON.stringify(parsedData, null, 2);
    } else {
      // 鐩存帴杩斿洖鏁版嵁
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

// API 娴嬭瘯宸ュ叿
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

// GitHub API 宸ュ叿
async function fetchGitHubRepoInfo(repo) {
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    throw new Error('Invalid GitHub repo format. Use owner/repo');
  }

  const apiUrl = `https://api.github.com/repos/${owner}/${repoName}`;
  const readmeUrl = `https://api.github.com/repos/${owner}/${repoName}/readme`;
  const contentsUrl = `https://api.github.com/repos/${owner}/${repoName}/contents`;

  try {
    // 鑾峰彇浠撳簱鍩烘湰淇℃伅
    const repoResponse = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'OpenSearch-Tool'
      }
    });
    if (!repoResponse.ok) {
      throw new Error(`GitHub API error: ${repoResponse.status}`);
    }
    const repoInfo = await repoResponse.json();

    // 鑾峰彇README
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

    // 鑾峰彇鏂囦欢缁撴瀯
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

// 娉ㄥ唽鍐呯疆宸ュ叿
ToolRegistry.registerTool({
  id: 'fetch_github_repo',
  name: 'GitHub Repo Info',
  description: 'Fetch GitHub repository metadata, README content, and file structure',
  parameters: [
    {
      name: 'repo',
      type: 'string',
      required: true,
      description: 'GitHub浠撳簱璺緞锛屾牸寮忎负 owner/repo'
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
      description: '鏂囨。URL'
    },
    {
      name: 'markdown',
      type: 'string',
      required: false,
      description: '鏂囨。鍐呭'
    },
    {
      name: 'page_images',
      type: 'array',
      required: false,
      description: '椤甸潰鍥惧儚URL鍒楄〃'
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
  description: '鍒嗘瀽鏂囨。甯冨眬锛岃瘑鍒枃鏈€佽〃鏍煎拰瑙嗚鍏冪礌',
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
      description: '鏂囨。URL'
    },
    {
      name: 'title',
      type: 'string',
      required: false,
      description: '鏂囨。鏍囬'
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
      description: '缃戦〉URL'
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
      description: '鎼滅储鏌ヨ'
    },
    {
      name: 'connector_ids',
      type: 'array',
      required: false,
      description: '杩炴帴鍣↖D鍒楄〃'
    }
  ],
  execute: async (input) => {
    const { query, connectorIds } = input;
    // 杩欓噷鍙互瀹炵幇鍏蜂綋鐨勬悳绱㈤€昏緫
    // 鏆傛椂杩斿洖妯℃嫙鏁版嵁
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
      description: 'API绔偣URL'
    },
    {
      name: 'method',
      type: 'string',
      required: false,
      description: 'HTTP鏂规硶锛岄粯璁や负GET'
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
      description: '璇锋眰瓒呮椂鏃堕棿锛堟绉掞級'
    },
    {
      name: 'expectedStatus',
      type: 'number',
      required: false,
      description: '鏈熸湜鐨凥TTP鐘舵€佺爜'
    },
    {
      name: 'auth',
      type: 'object',
      required: false,
      description: '璁よ瘉淇℃伅锛屾敮鎸乥asic鍜宐earer绫诲瀷'
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
  description: '杞崲鏁版嵁鏍煎紡锛屾敮鎸丣SON鍜孋SV涔嬮棿鐨勮浆鎹紝浠ュ強鏁版嵁杩囨护銆佹槧灏勩€佹帓搴忓拰闄愬埗',
  parameters: [
    {
      name: 'data',
      type: 'any',
      required: true,
      description: '瑕佽浆鎹㈢殑鏁版嵁'
    },
    {
      name: 'fromFormat',
      type: 'string',
      required: false,
      description: '杈撳叆鏁版嵁鏍煎紡锛岄粯璁や负json'
    },
    {
      name: 'toFormat',
      type: 'string',
      required: false,
      description: '杈撳嚭鏁版嵁鏍煎紡锛岄粯璁や负json'
    },
    {
      name: 'filter',
      type: 'object',
      required: false,
      description: '杩囨护鏉′欢'
    },
    {
      name: 'map',
      type: 'object',
      required: false,
      description: '瀛楁鏄犲皠'
    },
    {
      name: 'sortBy',
      type: 'string',
      required: false,
      description: '鎺掑簭瀛楁'
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

// 鍝旂珯瑙嗛闊抽涓嬭浇宸ュ叿
async function downloadBilibiliAudio(videoUrl, options = {}) {
  const {
    outputDir = './downloads',
    quality = 'high',
    format = 'mp3'
  } = options;

  try {
    // 楠岃瘉URL鏍煎紡
    const bvMatch = videoUrl.match(/BV[\w]+/);
    const avMatch = videoUrl.match(/av(\d+)/);
    
    if (!bvMatch && !avMatch) {
      throw new Error('Invalid Bilibili video URL. Must contain BV or av ID');
    }

    // 鑾峰彇瑙嗛椤甸潰鍐呭
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

    // 鎻愬彇瑙嗛淇℃伅
    const titleMatch = html.match(/<h1[^>]*title="([^"]*)"/);
    const title = titleMatch ? titleMatch[1].trim() : 'unknown';

    // 鎻愬彇playinfo鏁版嵁
    const playInfoMatch = html.match(/window\.__playinfo__\s*=\s*({[\s\S]*?})<\/script>/);
    if (!playInfoMatch) {
      throw new Error('Could not find playinfo data');
    }

    const playInfo = JSON.parse(playInfoMatch[1]);
    
    // 鑾峰彇闊抽URL
    let audioUrl = null;
    if (playInfo.data && playInfo.data.dash && playInfo.data.dash.audio) {
      const audios = playInfo.data.dash.audio;
      // 閫夋嫨鏈€楂樿川閲忕殑闊抽
      audioUrl = audios[0].baseUrl;
    }

    if (!audioUrl) {
      throw new Error('Could not find audio URL');
    }

    // 涓嬭浇闊抽
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
    
    // 鐢熸垚鏂囦欢鍚?    const safeTitle = title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const fileName = `${safeTitle}_${Date.now()}.${format}`;
    const filePath = path.join(outputDir, fileName);

    // 纭繚杈撳嚭鐩綍瀛樺湪
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 淇濆瓨闊抽鏂囦欢
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
      description: '鍝旂珯瑙嗛閾炬帴锛屾敮鎸丅V鎴朼v鏍煎紡'
    },
    {
      name: 'outputDir',
      type: 'string',
      required: false,
      description: '闊抽鏂囦欢淇濆瓨鐩綍锛岄粯璁や负./downloads'
    },
    {
      name: 'quality',
      type: 'string',
      required: false,
      description: '闊抽璐ㄩ噺锛岄粯璁や负high'
    },
    {
      name: 'format',
      type: 'string',
      required: false,
      description: '闊抽鏍煎紡锛岄粯璁や负mp3'
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

// 鎶栭煶瑙嗛淇℃伅鎻愬彇宸ュ叿
async function extractDouyinVideoInfo(videoUrl, options = {}) {
  const {
    cookie = null,
    includeDownloadMethods = true
  } = options;

  try {
    // 楠岃瘉URL鏍煎紡
    const douyinPattern = /douyin\.com|iesdouyin\.com/;
    if (!douyinPattern.test(videoUrl)) {
      throw new Error('Invalid Douyin video URL. Must be a douyin.com or iesdouyin.com link');
    }

    // 澶勭悊鐭摼鎺ワ紝鑾峰彇鐪熷疄URL
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
          // 妫€鏌ユ槸鍚︽槸搴旂敤鍗忚
          if (shortUrlRedirect && !shortUrlRedirect.startsWith('sslocal://')) {
            realUrl = shortUrlRedirect;
          }
        }
      } catch (e) {
        // 鐭摼鎺ュ鐞嗗け璐ワ紝缁х画浣跨敤鍘熷URL
      }
    }

    // 鎻愬彇瑙嗛ID
    const videoIdMatch = realUrl.match(/video\/(\d+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;
    
    // 鏋勫缓鍒嗕韩閾炬帴
    const shareUrl = videoId ? `https://v.douyin.com/${videoId}/` : videoUrl;

    // 鑾峰彇瑙嗛椤甸潰鍐呭
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

    // 鎻愬彇瑙嗛淇℃伅
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(' - 鎶栭煶', '').trim() : 'unknown';

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
          // 鍦ㄦ覆鏌撴暟鎹腑瀵绘壘瑙嗛URL
          const videoData = findVideoUrlInObject(renderData);
          if (videoData) {
            videoDownloadUrl = videoData;
            extractionMethod = 'RENDER_DATA';
          }
        } catch (parseError) {
          // 瑙ｆ瀽澶辫触
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
      
      // 濡傛灉鏈塁ookie锛屾坊鍔燙ookie鏂规硶
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
          hasJsProtection ? '椤甸潰浣跨敤浜咼avaScript淇濇姢锛屽缓璁彁渚涙湁鏁堢殑Cookie' : null,
          '鍙互灏濊瘯浣跨敤绗笁鏂逛笅杞藉伐鍏锋垨API',
          '鍙互浣跨敤娴忚鍣ㄥ紑鍙戣€呭伐鍏锋墜鍔ㄨ幏鍙栬棰戝湴鍧€',
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

// 鎵归噺鎻愬彇鎶栭煶瑙嗛淇℃伅
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
      // 娣诲姞寤惰繜閬垮厤璇锋眰杩囧揩
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

// 杈呭姪鍑芥暟锛氬湪瀵硅薄涓€掑綊鏌ユ壘瑙嗛URL
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
      description: '鎶栭煶瑙嗛閾炬帴锛屾敮鎸乿.douyin.com鐭摼鎺ュ拰瀹屾暣閾炬帴'
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
      description: '骞跺彂鏁帮紝榛樿涓?'
    },
    {
      name: 'delay',
      type: 'number',
      required: false,
      description: '璇锋眰闂撮殧寤惰繜锛堟绉掞級锛岄粯璁や负1000'
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
    // 楠岃瘉URL鏍煎紡
    const douyinPattern = /douyin\.com|iesdouyin\.com/;
    if (!douyinPattern.test(videoUrl)) {
      throw new Error('Invalid Douyin video URL. Must be a douyin.com or iesdouyin.com link');
    }

    console.log(`姝ｅ湪瑙ｆ瀽瑙嗛: ${videoUrl}`);
    
    // 璋冪敤瑙ｆ瀽API
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
    
    // 鑾峰彇瑙嗛涓嬭浇鍦板潃
    const videoDownloadUrl = videoData.video || videoData.play_url || videoData.url;
    const coverUrl = videoData.cover;
    const title = videoData.title || 'douyin_video';
    const author = videoData.author || 'unknown';
    
    if (!videoDownloadUrl) {
      throw new Error('No video URL found in API response');
    }

    console.log(`瑙ｆ瀽鎴愬姛锛屽噯澶囦笅杞? ${title}`);
    console.log(`瑙嗛鍦板潃: ${videoDownloadUrl}`);

    // 鍒涘缓涓嬭浇鐩綍
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

    // 涓嬭浇瑙嗛
    console.log(`寮€濮嬩笅杞藉埌: ${outputPath}`);
    
    const videoResponse = await fetch(videoDownloadUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.douyin.com/'
      }
    });

    if (!videoResponse.ok) {
      throw new Error(`Video download failed: ${videoResponse.status}`);
    }

    // 鑾峰彇瑙嗛娴佸苟淇濆瓨
    const arrayBuffer = await videoResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    fs.writeFileSync(outputPath, buffer);
    
    const fileSize = (buffer.length / 1024 / 1024).toFixed(2);
    console.log(`涓嬭浇瀹屾垚! 鏂囦欢澶у皬: ${fileSize} MB`);

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
    console.error('涓嬭浇澶辫触:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// 鎵归噺涓嬭浇鎶栭煶瑙嗛
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
      // 娣诲姞寤惰繜閬垮厤璇锋眰杩囧揩
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      console.log(`\n[${i + index + 1}/${videoUrls.length}] 寮€濮嬪鐞? ${url}`);
      
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
      current = { heading: "鎽樿", excerpt: line };
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
      title: segment.texts[0]?.slice(0, 42) || "鐗囨",
      summary: summary.length > 0 ? summary[0] : fullText.slice(0, 220),
      full_text: fullText.slice(0, 500)
    };
  });
}

// 鎻愬彇瑙嗛鍏抽敭瑙傜偣鍜屾椂闂寸偣
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

// 瑙嗛杞琈P3鍔熻兘
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
        reject(new Error(`瑙嗛杞琈P3澶辫触: ${error}`));
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

// 閫氳繃寮€婧愭ā鍨嬭浆鏂囨湰
async function transcribeWithOpenSourceModel(audioPath) {
  if (!VIDEO_PROCESSING_CONFIG.openSourceModel.enabled) {
    throw new Error("寮€婧愭ā鍨嬫湭閰嶇疆鎴栨湭鍚敤");
  }

  const formData = new FormData();
  formData.append('audio', fs.createReadStream(audioPath));
  formData.append('model', VIDEO_PROCESSING_CONFIG.openSourceModel.model);

  const response = await fetch(VIDEO_PROCESSING_CONFIG.openSourceModel.endpoint, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`寮€婧愭ā鍨嬭皟鐢ㄥけ璐? ${await response.text()}`);
  }

  return await response.json();
}

// 瑙嗛杞枃鏈富鍑芥暟
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
        console.warn("ARS API 璋冪敤澶辫触锛屽皾璇曚娇鐢ㄥ紑婧愭ā鍨?", arsError.message);
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
    const publishedMatch = summaryLine.match(/^([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})路\s*/);
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
      summary: `Bilibili 瑙嗛缁撴灉锛?{title}`,
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
  const finalQuery = /瑙嗛/.test(normalizedQuery) ? normalizedQuery : `${normalizedQuery} 瑙嗛`;
  const url = buildDouyinSearchUrl(query);

  return [
    {
      id: makeId("video", url),
      connector: "douyin",
      title: `${finalQuery} - 鎶栭煶鎼滅储`,
      url,
      platform: "鎶栭煶",
      content_type: "video",
      source_type: "video",
      author: "鎶栭煶",
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
    candidate.published_at ? `鍙戝竷鏃堕棿锛?{candidate.published_at}` : "",
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
    candidate.published_at ? `鍙戝竷鏃堕棿锛?{candidate.published_at}` : "",
    descriptionMatch ? `鎽樿锛?{decodeHtmlEntities(descriptionMatch[1])}` : "",
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
      const markdown = [`# ${candidate.title}`, "", `浣滆€咃細${authors}`, candidate.published_at ? `鍙戝竷鏃堕棿锛?{candidate.published_at}` : "", history ? `鎻愪氦鍘嗗彶锛?{history}` : "", "", abstract].filter(Boolean).join("\n");
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

  const title = normalizeWhitespace((payload.heading || payload.title || "").replace(/\s*-\s*鎶栭煶$/, ""));
  const publishedLine = lines.find((line) => /^发布时间[:：]/.test(line)) || "";
  const publishedAtLabel = publishedLine ? normalizeWhitespace(publishedLine.replace(/^发布时间[:：]\s*/, "")) : null;
  const publishedAt = formatDouyinPublishedAt(publishedAtLabel);
  const publishedIndex = publishedLine ? lines.indexOf(publishedLine) : -1;
  let author = parseDouyinJsonLdAuthor(payload.jsonLd);

  if (!author && publishedIndex !== -1) {
    for (let index = publishedIndex + 1; index < Math.min(lines.length, publishedIndex + 6); index += 1) {
      const line = lines[index];
      if (!line || /^(绮変笣|鑾疯禐|鍏虫敞|鎺ㄨ崘瑙嗛|涓炬姤|绉佷俊|鐐瑰嚮鍔犺浇鏇村)/.test(line)) {
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
      authorStats = lines.slice(authorIndex + 1, authorIndex + 4).find((line) => /绮変笣|鑾疯禐/.test(line)) || null;
    }
  }

  const metrics = [];
  const reportIndex = lines.findIndex((line) => line === "涓炬姤");
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

  const chapterIndex = lines.findIndex((line) => line === "绔犺妭瑕佺偣");
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
  const seriesTitle = (payload.subheadings || []).find((heading) => heading && heading !== "鎺ㄨ崘瑙嗛") || null;

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
    `鎾斁锛?{stats.view || 0}锛岀偣璧烇細${stats.like || 0}锛岃瘎璁猴細${stats.reply || 0}锛屾敹钘忥細${stats.favorite || 0}`
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
              author ? `浣滆€咃細${author}` : "",
              plays ? `鎾斁锛?{plays}` : "",
              likes ? `鐐硅禐锛?{likes}` : ""
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

// 娉ㄥ唽鏍稿績宸ュ叿
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

// 鍥炬枃鐞嗚В宸ュ叿
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

// 鍥炬枃鎼滅储宸ュ叿
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

// Video transcription tool
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

// 鎼滅储宸ュ叿
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

// 娉ㄥ唽鎶栭煶瑙嗛涓嬭浇宸ュ叿
ToolRegistry.registerTool({
  id: 'download_douyin_video',
  name: 'Douyin Video Downloader',
  description: '涓嬭浇鎶栭煶瑙嗛锛堟棤姘村嵃锛夛紝鏀寔鍗曚釜瑙嗛涓嬭浇',
  parameters: [
    {
      name: 'videoUrl',
      type: 'string',
      required: true,
      description: '鎶栭煶瑙嗛閾炬帴锛屾敮鎸乿.douyin.com鐭摼鎺ュ拰瀹屾暣閾炬帴'
    },
    {
      name: 'outputDir',
      type: 'string',
      required: false,
      description: '涓嬭浇鐩綍锛岄粯璁や负./downloads'
    },
    {
      name: 'filename',
      type: 'string',
      required: false,
      description: '鑷畾涔夋枃浠跺悕锛岄粯璁や负浣滆€卂鏍囬_鏃堕棿鎴?mp4'
    }
  ],
  execute: async (input) => {
    const { videoUrl, outputDir, filename } = input;
    if (!videoUrl) {
      throw new Error('Missing required parameter: videoUrl');
    }
    const result = await downloadDouyinVideo(videoUrl, {
      outputDir,
      filename
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.data;
  },
  source: 'builtin',
  status: 'active'
});

// 娉ㄥ唽鎵归噺鎶栭煶瑙嗛涓嬭浇宸ュ叿
ToolRegistry.registerTool({
  id: 'batch_download_douyin_videos',
  name: 'Batch Douyin Video Downloader',
  description: '鎵归噺涓嬭浇鎶栭煶瑙嗛锛屾敮鎸佸苟鍙戞帶鍒跺拰寤惰繜璁剧疆',
  parameters: [
    {
      name: 'videoUrls',
      type: 'array',
      required: true,
      description: '鎶栭煶瑙嗛閾炬帴鏁扮粍'
    },
    {
      name: 'outputDir',
      type: 'string',
      required: false,
      description: '涓嬭浇鐩綍锛岄粯璁や负./downloads'
    },
    {
      name: 'concurrency',
      type: 'number',
      required: false,
      description: '骞跺彂鏁帮紝榛樿涓?'
    },
    {
      name: 'delay',
      type: 'number',
      required: false,
      description: '璇锋眰闂撮殧寤惰繜锛堟绉掞級锛岄粯璁や负2000'
    }
  ],
  execute: async (input) => {
    const { videoUrls, outputDir, concurrency, delay } = input;
    if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length === 0) {
      throw new Error('Missing required parameter: videoUrls (must be a non-empty array)');
    }
    const result = await batchDownloadDouyinVideos(videoUrls, {
      outputDir,
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









