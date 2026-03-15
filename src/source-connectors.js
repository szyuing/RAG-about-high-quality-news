const crypto = require("crypto");

const samplePrompts = [
  "Sora 模型现在的生成时长上限是多少？相比刚发布时有哪些技术架构上的更新？",
  "苹果 2024 年发布的手机比 2023 年的在性能上提升了多少？",
  "为什么这个产品强调先规划再搜索，而不是直接搜？"
];

const sourceCatalog = [
  {
    id: "bing_web",
    label: "Bing Web + Jina Reader",
    source_type: "web",
    description: "通用网页入口，用于抓官方页、新闻页和长文页，再通过 Jina Reader 做正文抽取。"
  },
  {
    id: "hacker_news",
    label: "Hacker News",
    source_type: "forum",
    description: "讨论型来源，用于补充社区观点、原始帖子和高价值评论。"
  },
  {
    id: "arxiv",
    label: "arXiv",
    source_type: "document",
    description: "文档型来源，用于论文、研究摘要和长期技术背景。"
  },
  {
    id: "ted",
    label: "TED",
    source_type: "video",
    description: "真实视频来源，用于提取 Talk 页面描述、时长和 transcript。"
  }
];

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

function buildQueryTokens(query) {
  const tokens = new Set(
    String(query || "")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9._-]{1,}/g) || []
  );

  const dictionary = [
    [/苹果/g, ["apple", "iphone"]],
    [/性能/g, ["performance", "benchmark"]],
    [/更新|升级/g, ["update"]],
    [/架构/g, ["architecture"]],
    [/视频|访谈|演讲|发布会/g, ["video", "talk"]],
    [/研究|论文/g, ["research", "paper"]],
    [/搜索/g, ["search"]],
    [/规划/g, ["planner", "workflow"]],
    [/时长|秒|分钟/g, ["seconds", "duration"]]
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

async function searchArxiv(query) {
  const xml = await fetchText(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=6`);
  return parseArxivFeed(xml, query);
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

async function searchRealSources(query) {
  const settled = await Promise.allSettled([
    searchBingWeb(query),
    searchHackerNews(query),
    searchArxiv(query),
    searchTed(query)
  ]);

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

async function readWebSource(candidate) {
  const raw = await fetchText(toReaderUrl(candidate.url));
  const markdown = extractReaderMarkdown(raw);
  return {
    source_id: candidate.id,
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

async function readArxivSource(candidate) {
  const markdown = [
    `# ${candidate.title}`,
    "",
    `作者：${candidate.author || "未知作者"}`,
    candidate.published_at ? `发布时间：${candidate.published_at}` : "",
    "",
    candidate.summary
  ].filter(Boolean).join("\n");

  return {
    source_id: candidate.id,
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
  switch (candidate.connector) {
    case "bing_web":
      return readWebSource(candidate);
    case "hacker_news":
      return readHackerNewsSource(candidate);
    case "arxiv":
      return readArxivSource(candidate);
    case "ted":
      return readTedSource(candidate);
    default:
      throw new Error(`Unsupported connector: ${candidate.connector}`);
  }
}

module.exports = {
  samplePrompts,
  sourceCatalog,
  searchRealSources,
  readCandidate,
  __internal: {
    buildQueryTokens,
    decodeBingRedirectUrl,
    parseBingSearchMarkdown,
    parseTedSearchHtml,
    extractReaderMarkdown,
    stripTags
  }
};
