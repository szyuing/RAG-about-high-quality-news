const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { verifyEvidenceUnits } = require("./fact-verifier");

const samplePrompts = [
  "Sora 模型现在的生成时长上限是多少？相比刚发布时有哪些技术架构上的更新？",
  "苹果 2024 年发布的手机比 2023 年的在性能上提升了多少？",
  "为什么这个产品强调先规划再搜索，而不是直接搜？"
];

let sourceCatalog = [];

// 标准化工具接口
const ToolRegistry = {
  tools: new Map(),
  
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
    
    this.tools.set(toolDefinition.id, {
      id: toolDefinition.id,
      name: toolDefinition.name,
      description: toolDefinition.description || '',
      parameters: toolDefinition.parameters || [],
      execute: toolDefinition.execute,
      validate: toolDefinition.validate || null,
      inputSchema: toolDefinition.inputSchema || null,
      outputSchema: toolDefinition.outputSchema || null
    });
  },
  
  getTool(toolId) {
    return this.tools.get(toolId);
  },
  
  getTools() {
    return Array.from(this.tools.values());
  },
  
  async executeTool(toolId, input) {
    const tool = this.getTool(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }
    
    try {
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
  const groups = [];
  let buffer = [];

  for (const cue of cues) {
    buffer.push(cue);
    if (buffer.length >= 6) {
      groups.push(buffer);
      buffer = [];
    }
  }
  if (buffer.length) {
    groups.push(buffer);
  }

  return groups.slice(0, 6).map((group) => ({
    start: group[0].start,
    title: group[0].text.slice(0, 42),
    summary: group.map((item) => item.text).join(" ").slice(0, 220)
  }));
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
        return {
          ...candidate,
          score: Number((candidate.score + relevanceBoost * 0.35).toFixed(4)),
          metadata: {
            ...(candidate.metadata || {}),
            query_hits: hits
          }
        };
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
  const keyPoints = [
    description.slice(0, 220),
    `作者 ${video.owner?.name || candidate.author}，播放 ${stats.view || 0}，点赞 ${stats.like || 0}，评论 ${stats.reply || 0}。`
  ].filter(Boolean);
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
    transcript: [],
    timeline: [],
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
        const keyPoints = [
          parsed.series_title ? `\u7cfb\u5217\uff1a${parsed.series_title}` : "",
          parsed.author ? `\u4f5c\u8005\uff1a${parsed.author}` : "",
          parsed.published_label ? `\u53d1\u5e03\u65f6\u95f4\uff1a${parsed.published_label}` : "",
          parsed.author_stats ? `\u8d26\u53f7\u6982\u51b5\uff1a${parsed.author_stats}` : "",
          parsed.metrics.length ? `\u4e92\u52a8\u6307\u6807\uff1a${parsed.metrics.join(" / ")}` : ""
        ].filter(Boolean);
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
          parsed.timeline.length ? "## \u7ae0\u8282\u8981\u70b9" : "",
          ...parsed.timeline.map((item) => `- [${item.start}] ${item.summary}`)
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
          transcript: [],
          timeline: parsed.timeline,
          key_points: keyPoints.length ? keyPoints : [candidate.summary].filter(Boolean),
          key_frames: [
            parsed.title,
            ...parsed.timeline.slice(0, 2).map((item) => item.summary)
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
      start: timestampFromMilliseconds(cue.time),
      text: normalizeWhitespace(cue.text)
    }))
    .filter((cue) => cue.text);

  const description = pageProps.description || candidate.summary;
  const timeline = buildTranscriptTimeline(cues);
  const transcriptText = cues.map((cue) => `[${cue.start}] ${cue.text}`).join("\n");

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
    transcript: cues,
    timeline,
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
  const contentType = input?.content_type || contentTypeForConnector(connector);

  if (toolId === "extract_video_intel" && contentType !== "video") {
    throw new Error(`extract_video_intel does not support inferred connector ${connector}`);
  }
  if (toolId === "deep_read_page" && contentType === "video") {
    throw new Error("Use extract_video_intel for video sources");
  }

  return {
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
  };
}

async function executeReadTool(toolId, input) {
  const candidate = buildCandidateFromToolInput(toolId, input);
  const connector = connectorMap.get(candidate.connector);
  if (!connector?.read) {
    throw new Error(`Unsupported connector: ${candidate.connector}`);
  }
  return connector.read(candidate);
}

// 注册核心工具
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
    stripTags
  }
};
