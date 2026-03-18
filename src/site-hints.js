const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DEFAULT_SITE_HINT_FILENAMES = [
  "信息采集网站专用表格.xlsx",
  "site-hints.xlsx",
  "site-hints.json",
  "site-hints.csv",
  "site-hints.tsv"
];

const HEADER_PATTERNS = {
  name: /网站|站点|平台|名称|名字|媒体|来源|source|site|name/i,
  domain: /域名|网址|链接|地址|官网|首页|url|domain|host/i,
  category: /分类|类型|领域|行业|赛道|主题|topic|category|type/i,
  tags: /标签|关键词|关键字|适用|内容|说明|备注|描述|notes?|tags?|keywords?|desc/i,
  priority: /优先|推荐|重要|权重|等级|星级|quality|priority|score|rank/i
};

let siteHintCache = {
  cacheKey: null,
  profiles: [],
  error: null
};

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.:/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return Array.from(new Set(normalizeText(value).split(" ").filter((token) => token.length > 1)));
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function toHostname(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const urlLike = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
  try {
    return new URL(urlLike).hostname.toLowerCase().replace(/^www\./, "");
  } catch (error) {
    const match = raw.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
    return match ? match[1].toLowerCase().replace(/^www\./, "") : "";
  }
}

function extractDomains(values) {
  const joined = Array.isArray(values) ? values.join(" ") : String(values || "");
  const matches = joined.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || [];
  return Array.from(new Set(matches.map((item) => toHostname(item)).filter(Boolean)));
}

function resolveSiteHintsPath(explicitPath = process.env.OPENSEARCH_SITE_HINTS_PATH) {
  const candidates = [];
  if (explicitPath) {
    candidates.push(explicitPath);
  }

  const cwd = process.cwd();
  for (const filename of DEFAULT_SITE_HINT_FILENAMES) {
    candidates.push(path.resolve(cwd, filename));
    candidates.push(path.resolve(cwd, "data", filename));
    candidates.push(path.resolve(cwd, "..", filename));
  }

  for (const candidatePath of candidates) {
    if (candidatePath && fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

function parseDelimitedTable(text, delimiter) {
  const rows = [];
  let currentCell = "";
  let currentRow = [];
  let inQuotes = false;

  const flushCell = () => {
    currentRow.push(currentCell);
    currentCell = "";
  };
  const flushRow = () => {
    if (currentRow.length > 0) {
      rows.push(currentRow);
    }
    currentRow = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      flushCell();
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      flushCell();
      flushRow();
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    flushCell();
    flushRow();
  }

  return rows;
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let index = buffer.length - 22; index >= minimumOffset; index -= 1) {
    if (buffer.readUInt32LE(index) === signature) {
      return index;
    }
  }
  throw new Error("Invalid xlsx archive: end of central directory not found");
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let pointer = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (pointer < end) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const fileNameLength = buffer.readUInt16LE(pointer + 28);
    const extraFieldLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localHeaderOffset = buffer.readUInt32LE(pointer + 42);
    const fileName = buffer.slice(pointer + 46, pointer + 46 + fileNameLength).toString("utf8");

    entries.set(fileName, {
      compressionMethod,
      compressedSize,
      localHeaderOffset
    });

    pointer += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  return {
    getText(entryName) {
      const entry = entries.get(entryName);
      if (!entry) {
        return null;
      }

      const offset = entry.localHeaderOffset;
      if (buffer.readUInt32LE(offset) !== 0x04034b50) {
        throw new Error(`Invalid zip local header for ${entryName}`);
      }

      const fileNameLength = buffer.readUInt16LE(offset + 26);
      const extraFieldLength = buffer.readUInt16LE(offset + 28);
      const dataOffset = offset + 30 + fileNameLength + extraFieldLength;
      const compressed = buffer.slice(dataOffset, dataOffset + entry.compressedSize);

      if (entry.compressionMethod === 0) {
        return compressed.toString("utf8");
      }
      if (entry.compressionMethod === 8) {
        return zlib.inflateRawSync(compressed).toString("utf8");
      }

      throw new Error(`Unsupported compression method ${entry.compressionMethod} for ${entryName}`);
    },
    list() {
      return Array.from(entries.keys());
    }
  };
}

function parseWorkbookSheets(workbookXml, relsXml) {
  const relMap = new Map();
  for (const match of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    const target = match[2].replace(/^\/+/, "");
    relMap.set(match[1], target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\//, "")}`);
  }

  return Array.from(workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)).map((match) => ({
    name: decodeXmlText(match[1]),
    path: relMap.get(match[2])
  })).filter((sheet) => sheet.path);
}

function parseSharedStrings(xml) {
  if (!xml) {
    return [];
  }
  return Array.from(xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)).map((match) => {
    const fragments = Array.from(match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)).map((item) => decodeXmlText(item[1]));
    return fragments.join("");
  });
}

function columnIndexFromRef(ref) {
  const letters = String(ref || "").replace(/\d+/g, "").toUpperCase();
  let value = 0;
  for (const char of letters) {
    value = (value * 26) + (char.charCodeAt(0) - 64);
  }
  return Math.max(0, value - 1);
}

function extractCellValue(cellXml, sharedStrings) {
  const typeMatch = cellXml.match(/\bt="([^"]+)"/);
  const cellType = typeMatch ? typeMatch[1] : "";
  const valueMatch = cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/);
  const inlineMatch = cellXml.match(/<is[^>]*>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);

  if (cellType === "inlineStr" && inlineMatch) {
    return decodeXmlText(inlineMatch[1]);
  }
  if (cellType === "s" && valueMatch) {
    const sharedIndex = Number(valueMatch[1]);
    return sharedStrings[sharedIndex] || "";
  }
  if (valueMatch) {
    return decodeXmlText(valueMatch[1]);
  }
  return "";
}

function parseWorksheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = cellMatch[1] || cellMatch[3] || "";
      const refMatch = attrs.match(/\br="([^"]+)"/);
      const cellRef = refMatch ? refMatch[1] : "";
      const cellIndex = columnIndexFromRef(cellRef);
      const cellXml = cellMatch[0];
      row[cellIndex] = extractCellValue(cellXml, sharedStrings).trim();
    }
    rows.push(row.map((cell) => String(cell || "").trim()));
  }
  return rows;
}

function parseXlsxTables(buffer) {
  const zip = readZipEntries(buffer);
  const workbookXml = zip.getText("xl/workbook.xml");
  const relsXml = zip.getText("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) {
    throw new Error("Invalid xlsx workbook metadata");
  }

  const sharedStrings = parseSharedStrings(zip.getText("xl/sharedStrings.xml"));
  const sheets = parseWorkbookSheets(workbookXml, relsXml);

  return sheets.map((sheet) => ({
    sheet_name: sheet.name,
    rows: parseWorksheetRows(zip.getText(sheet.path) || "", sharedStrings)
  }));
}

function parseJsonProfiles(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed?.items)) {
    return parsed.items;
  }
  return [];
}

function pickHeaderRow(rows) {
  const candidates = rows.slice(0, 3);
  let bestIndex = 0;
  let bestScore = -1;

  candidates.forEach((row, index) => {
    const score = row.reduce((total, cell) => {
      const text = String(cell || "").trim();
      if (!text) {
        return total;
      }
      return total + Object.values(HEADER_PATTERNS).reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function toPriorityScore(value) {
  const text = String(value || "").trim();
  if (!text) {
    return 0;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  if (/高|核心|重要|优先|推荐|recommended/i.test(text)) {
    return 3;
  }
  if (/中|一般|normal/i.test(text)) {
    return 2;
  }
  if (/低|备选|low/i.test(text)) {
    return 1;
  }
  return 0;
}

function inferConnectorIdFromHint(hint) {
  const blob = normalizeText([hint.name, hint.domain, hint.url, hint.category, ...(hint.tags || [])].join(" "));
  if (/douyin\.com|iesdouyin\.com|抖音/.test(blob)) return "douyin";
  if (/bilibili\.com|bilibili|哔哩/.test(blob)) return "bilibili";
  if (/segmentfault\.com|segmentfault/.test(blob)) return "segmentfault";
  if (/ithome\.com|it之家|ithome/.test(blob)) return "ithome";
  if (/arxiv\.org|arxiv/.test(blob)) return "arxiv";
  if (/ted\.com|ted\b/.test(blob)) return "ted";
  if (/news\.ycombinator\.com|hacker news|\bhn\b/.test(blob)) return "hacker_news";
  return "bing_web";
}

function normalizeProfile(record, context = {}) {
  const values = Object.values(record || {}).map((item) => String(item || "").trim()).filter(Boolean);
  if (!values.length) {
    return null;
  }

  const entries = Object.entries(record || {});
  const matchValue = (pattern) => entries.find(([key]) => pattern.test(key))?.[1] || "";
  const domains = extractDomains(values);
  const domain = toHostname(matchValue(HEADER_PATTERNS.domain)) || domains[0] || "";
  const urlValue = String(matchValue(HEADER_PATTERNS.domain) || domains[0] || "").trim();
  const name = String(matchValue(HEADER_PATTERNS.name) || values[0] || domain || "").trim();
  const category = String(matchValue(HEADER_PATTERNS.category) || "").trim();
  const tagText = String(matchValue(HEADER_PATTERNS.tags) || "").trim();
  const tags = Array.from(new Set([
    ...tagText.split(/[;,，、|]/).map((item) => item.trim()).filter(Boolean),
    ...values.slice(1, 4).flatMap((item) => String(item || "").split(/[;,，、|]/).map((part) => part.trim()).filter(Boolean))
  ])).slice(0, 8);
  const priority = toPriorityScore(matchValue(HEADER_PATTERNS.priority));

  if (!name && !domain) {
    return null;
  }

  const normalized = {
    name,
    domain,
    url: urlValue,
    category,
    tags,
    notes: values.join(" | "),
    priority,
    sheet_name: context.sheet_name || null,
    row_number: context.row_number || null
  };

  return {
    ...normalized,
    connector_id: inferConnectorIdFromHint(normalized)
  };
}

function profilesFromTableRows(rows, sheetName = null) {
  const normalizedRows = rows.map((row) => row.map((cell) => String(cell || "").trim()));
  const headerIndex = pickHeaderRow(normalizedRows);
  const headers = normalizedRows[headerIndex].map((cell, index) => String(cell || `column_${index + 1}`).trim() || `column_${index + 1}`);

  return normalizedRows
    .slice(headerIndex + 1)
    .map((row, index) => {
      const record = Object.fromEntries(headers.map((header, columnIndex) => [header, row[columnIndex] || ""]));
      return normalizeProfile(record, {
        sheet_name: sheetName,
        row_number: headerIndex + index + 2
      });
    })
    .filter(Boolean);
}

function loadProfilesFromFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") {
    return parseJsonProfiles(fs.readFileSync(filePath, "utf8")).map((item, index) => normalizeProfile(item, { row_number: index + 1 })).filter(Boolean);
  }
  if (extension === ".csv" || extension === ".tsv") {
    const delimiter = extension === ".tsv" ? "\t" : ",";
    const rows = parseDelimitedTable(fs.readFileSync(filePath, "utf8"), delimiter);
    return profilesFromTableRows(rows);
  }
  if (extension === ".xlsx") {
    const tables = parseXlsxTables(fs.readFileSync(filePath));
    return tables.flatMap((table) => profilesFromTableRows(table.rows, table.sheet_name));
  }
  return [];
}

function getAllSiteProfiles(options = {}) {
  const siteHintsPath = resolveSiteHintsPath(options.path);
  if (!siteHintsPath) {
    return {
      file_path: null,
      profiles: [],
      error: null
    };
  }

  let stat = null;
  try {
    stat = fs.statSync(siteHintsPath);
  } catch (error) {
    return {
      file_path: siteHintsPath,
      profiles: [],
      error: error.message
    };
  }

  const cacheKey = `${siteHintsPath}:${stat.mtimeMs}:${stat.size}`;
  if (siteHintCache.cacheKey === cacheKey) {
    return {
      file_path: siteHintsPath,
      profiles: siteHintCache.profiles,
      error: siteHintCache.error
    };
  }

  try {
    const profiles = loadProfilesFromFile(siteHintsPath);
    siteHintCache = {
      cacheKey,
      profiles,
      error: null
    };
    return {
      file_path: siteHintsPath,
      profiles,
      error: null
    };
  } catch (error) {
    siteHintCache = {
      cacheKey,
      profiles: [],
      error: error.message
    };
    return {
      file_path: siteHintsPath,
      profiles: [],
      error: error.message
    };
  }
}

function scoreSiteHint(question, hint) {
  const questionTokens = tokenize(question);
  const blob = normalizeText([hint.name, hint.domain, hint.url, hint.category, ...(hint.tags || []), hint.notes].join(" "));
  let score = 0;
  let matched = false;

  for (const token of questionTokens) {
    if (blob.includes(token)) {
      score += 1.2;
      matched = true;
    }
  }

  if (/视频|直播|采访|演讲|发布会|video|talk|interview/i.test(question) && /video|talk|直播|视频|短视频|采访/.test(blob)) {
    score += 1.5;
    matched = true;
  }
  if (/论文|研究|paper|research/i.test(question) && /paper|research|论文|研究/.test(blob)) {
    score += 1.5;
    matched = true;
  }
  if (/新闻|最新|动态|update|news|official/i.test(question) && /news|official|官网|新闻|资讯/.test(blob)) {
    score += 1.5;
    matched = true;
  }

  if (!matched) {
    return 0;
  }

  return Number((score + (hint.priority || 0) * 0.25).toFixed(2));
}

function getRelevantSearchSiteHints(question, options = {}) {
  const dataset = getAllSiteProfiles(options);
  const items = dataset.profiles
    .map((profile) => ({
      ...profile,
      score: scoreSiteHint(question, profile)
    }))
    .filter((profile) => profile.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit || 6);

  return {
    file_path: dataset.file_path,
    error: dataset.error,
    items,
    domains: Array.from(new Set(items.map((item) => item.domain).filter(Boolean)))
  };
}

function inferConnectorIdsFromSiteHints(siteHints) {
  return Array.from(new Set((siteHints?.items || []).map((item) => item.connector_id).filter(Boolean)));
}

function buildSiteSeedQueries(question, siteHints, limit = 2) {
  const baseQuestion = String(question || "").trim();
  if (!baseQuestion) {
    return [];
  }

  return Array.from(new Set((siteHints?.items || [])
    .slice(0, limit)
    .map((item) => item.name || item.domain)
    .filter(Boolean)
    .map((item) => `${baseQuestion} ${item}`)));
}

function buildBingSiteQueries(queries, siteHints, limit = 4) {
  const baseQuery = Array.isArray(queries) ? String(queries[0] || "").trim() : "";
  if (!baseQuery) {
    return [];
  }

  const queryVariants = [];
  for (const hint of siteHints?.items || []) {
    const domain = toHostname(hint.domain || hint.url);
    if (domain) {
      queryVariants.push(`${baseQuery} site:${domain}`);
    } else if (hint.name) {
      queryVariants.push(`${baseQuery} ${hint.name}`);
    }
    if (queryVariants.length >= limit) {
      break;
    }
  }

  return Array.from(new Set(queryVariants));
}

module.exports = {
  resolveSiteHintsPath,
  getAllSiteProfiles,
  getRelevantSearchSiteHints,
  inferConnectorIdsFromSiteHints,
  buildSiteSeedQueries,
  buildBingSiteQueries,
  __internal: {
    normalizeText,
    tokenize,
    toHostname,
    extractDomains,
    parseDelimitedTable,
    parseXlsxTables,
    profilesFromTableRows,
    normalizeProfile,
    scoreSiteHint,
    inferConnectorIdFromHint
  }
};
