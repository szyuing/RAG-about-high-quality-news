const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { ensureDirectoryExists, resolveDataFile } = require("./data-paths");

const toolMemoryPath = resolveDataFile("ephemeral-tool-memory.json", "OPENSEARCH_TOOL_MEMORY_PATH");

function makeToolId(prefix, value) {
  return `${prefix}:${crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12)}`;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function normalizeList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function chooseStrategy(goal, target, constraints) {
  const blob = `${goal} ${target?.url || ""} ${target?.content_type || ""} ${target?.platform || ""} ${normalizeList(constraints).join(" ")}`.toLowerCase();
  if (/playwright|click|interaction|button|render|hydrate|login|tab|canvas/.test(blob)) {
    return "interactive_probe";
  }
  if (target?.content_type === "video" || /video|bilibili|ted|douyin|youtube|podcast|watch/.test(blob)) {
    return "video_metadata_extractor";
  }
  if (/json|nested|payload|__next_data__|__initial_state__|graphql|script/.test(blob)) {
    return "json_payload_extractor";
  }
  return "html_extractor";
}

function buildNodePrelude() {
  return `
const fs = require("fs");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function extractMeta(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHtmlEntities(match[1]).trim();
    }
  }
  return null;
}

function cleanTextFromHtml(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\\s\\S]*?<\\/script>/gi, " ")
      .replace(/<style[\\s\\S]*?<\\/style>/gi, " ")
      .replace(/<br\\s*\\/?>/gi, "\\n")
      .replace(/<\\/(p|div|article|section|li|h1|h2|h3|h4|h5|h6)>/gi, "\\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[\\t\\r]+/g, " ")
    .replace(/\\n\\s*\\n+/g, "\\n")
    .replace(/\\s+/g, " ")
    .trim();
}

function extractParagraphs(text, limit = 8) {
  return String(text || "")
    .split(/\\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 50)
    .slice(0, limit);
}

function findJsonBlocks(html) {
  return Array.from(String(html || "").matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/gi))
    .map((match) => match[1].trim())
    .filter((content) => content.startsWith("{") || content.startsWith("[") || /__NEXT_DATA__|__INITIAL_STATE__/.test(content))
    .slice(0, 8);
}

function extractJsonPayloads(html) {
  return findJsonBlocks(html)
    .map((block) => {
      const cleaned = block
        .replace(/^window\\.__NEXT_DATA__\\s*=\\s*/i, "")
        .replace(/^window\\.__INITIAL_STATE__\\s*=\\s*/i, "")
        .replace(/;\\s*$/, "");
      try {
        return JSON.parse(cleaned);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, 3);
}

async function loadHtml(target, logs) {
  if (target.html) {
    logs.push("using inline html from target");
    return String(target.html);
  }
  if (!target.url) {
    throw new Error("No target.url or target.html provided");
  }
  logs.push(\`fetching \${target.url}\`);
  const response = await fetch(target.url, {
    headers: {
      "user-agent": "Mozilla/5.0 OpenSearchEphemeralTool/0.1"
    }
  });
  logs.push(\`http status \${response.status}\`);
  const html = await response.text();
  if (!response.ok) {
    throw new Error(\`HTTP \${response.status}\`);
  }
  return html;
}
`;
}

function buildHtmlExtractorCode() {
  return `${buildNodePrelude()}

(async () => {
  const input = await readStdin();
  const target = input.target || {};
  const logs = [];
  try {
    const html = await loadHtml(target, logs);
    const title = extractMeta(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<title>([^<]+)<\\/title>/i
    ]) || target.title || "Untitled page";
    const description = extractMeta(html, [
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
    ]);
    const cleanedText = cleanTextFromHtml(html);
    const paragraphs = extractParagraphs(cleanedText);
    const keyPoints = [description, ...paragraphs.slice(0, 3)].filter(Boolean);
    const payloads = extractJsonPayloads(html);
    const markdown = [
      \`# \${title}\`,
      description || "",
      ...paragraphs
    ].filter(Boolean).join("\\n\\n");

    process.stdout.write(JSON.stringify({
      success: true,
      logs,
      extracted_data: {
        title,
        description,
        markdown,
        paragraphs,
        key_points: keyPoints,
        structured_payloads: payloads
      }
    }, null, 2));
  } catch (error) {
    logs.push(error.message);
    process.stdout.write(JSON.stringify({
      success: false,
      logs,
      error: error.message
    }, null, 2));
  }
})().catch((error) => {
  process.stdout.write(JSON.stringify({ success: false, logs: [error.message], error: error.message }, null, 2));
});
`;
}

function buildJsonPayloadExtractorCode() {
  return `${buildNodePrelude()}

function flattenPreview(value, prefix = "", output = [], limit = 18) {
  if (output.length >= limit) {
    return output;
  }
  if (Array.isArray(value)) {
    value.slice(0, 4).forEach((item, index) => flattenPreview(item, \`\${prefix}[\\\${index}]\`, output, limit));
    return output;
  }
  if (value && typeof value === "object") {
    Object.entries(value).slice(0, 8).forEach(([key, item]) => flattenPreview(item, prefix ? \`\${prefix}.\${key}\` : key, output, limit));
    return output;
  }
  output.push({ path: prefix || "value", value: String(value) });
  return output;
}

(async () => {
  const input = await readStdin();
  const target = input.target || {};
  const logs = [];
  try {
    const html = await loadHtml(target, logs);
    const payloads = extractJsonPayloads(html);
    const flattened = payloads.flatMap((payload) => flattenPreview(payload));
    const markdown = [
      \`# \${target.title || "Structured payload extraction"}\`,
      "",
      ...flattened.slice(0, 12).map((item) => \`- \${item.path}: \${item.value.slice(0, 180)}\`)
    ].join("\\n");

    process.stdout.write(JSON.stringify({
      success: payloads.length > 0,
      logs: [...logs, \`parsed \${payloads.length} JSON payloads\`],
      extracted_data: {
        title: target.title || "Structured payload extraction",
        markdown,
        key_points: flattened.slice(0, 4).map((item) => \`\${item.path}: \${item.value.slice(0, 120)}\`),
        structured_payloads: payloads,
        flattened_preview: flattened.slice(0, 18)
      }
    }, null, 2));
  } catch (error) {
    logs.push(error.message);
    process.stdout.write(JSON.stringify({
      success: false,
      logs,
      error: error.message
    }, null, 2));
  }
})().catch((error) => {
  process.stdout.write(JSON.stringify({ success: false, logs: [error.message], error: error.message }, null, 2));
});
`;
}

function buildVideoExtractorCode() {
  return `${buildNodePrelude()}

function parseTimeline(text) {
  return Array.from(String(text || "").matchAll(/(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s+([^\\n]{6,160})/g))
    .slice(0, 8)
    .map((match) => ({
      start: match[1],
      title: match[2].slice(0, 48),
      summary: match[2].trim()
    }));
}

(async () => {
  const input = await readStdin();
  const target = input.target || {};
  const logs = [];
  try {
    const html = await loadHtml(target, logs);
    const title = extractMeta(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<title>([^<]+)<\\/title>/i
    ]) || target.title || "Untitled video";
    const description = extractMeta(html, [
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
    ]) || "";
    const duration = extractMeta(html, [
      /"duration"\\s*:\\s*"([^"]+)"/i,
      /<meta[^>]+property=["']video:duration["'][^>]+content=["']([^"']+)["']/i
    ]);
    const cleanedText = cleanTextFromHtml(html);
    const timeline = parseTimeline(cleanedText);
    const keyPoints = [description, ...timeline.slice(0, 3).map((item) => item.summary)].filter(Boolean);
    const markdown = [
      \`# \${title}\`,
      duration ? \`Duration: \${duration}\` : "",
      description,
      timeline.length ? "## Timeline" : "",
      ...timeline.map((item) => \`- [\${item.start}] \${item.summary}\`)
    ].filter(Boolean).join("\\n\\n");

    process.stdout.write(JSON.stringify({
      success: true,
      logs,
      extracted_data: {
        title,
        description,
        duration,
        markdown,
        key_points: keyPoints,
        timeline,
        transcript: [],
        key_frames: timeline.slice(0, 3).map((item) => item.summary)
      }
    }, null, 2));
  } catch (error) {
    logs.push(error.message);
    process.stdout.write(JSON.stringify({
      success: false,
      logs,
      error: error.message
    }, null, 2));
  }
})().catch((error) => {
  process.stdout.write(JSON.stringify({ success: false, logs: [error.message], error: error.message }, null, 2));
});
`;
}

function buildInteractiveProbeCode() {
  return `${buildNodePrelude()}

(async () => {
  const input = await readStdin();
  const target = input.target || {};
  const logs = ["playwright-style interactive probe requested"];
  try {
    const html = await loadHtml(target, logs);
    const title = extractMeta(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<title>([^<]+)<\\/title>/i
    ]) || target.title || "Interactive probe fallback";
    const cleanedText = cleanTextFromHtml(html);
    const paragraphs = extractParagraphs(cleanedText, 6);

    process.stdout.write(JSON.stringify({
      success: true,
      logs: [...logs, "falling back to static extraction because Playwright runtime is not bundled"],
      extracted_data: {
        title,
        markdown: [\`# \${title}\`, ...paragraphs].join("\\n\\n"),
        paragraphs,
        key_points: paragraphs.slice(0, 3)
      },
      limitations: ["Interactive browser automation was requested, but this fallback runtime used static HTML extraction."]
    }, null, 2));
  } catch (error) {
    logs.push(error.message);
    process.stdout.write(JSON.stringify({
      success: false,
      logs,
      error: error.message
    }, null, 2));
  }
})().catch((error) => {
  process.stdout.write(JSON.stringify({ success: false, logs: [error.message], error: error.message }, null, 2));
});
`;
}

function buildToolCode(strategy) {
  switch (strategy) {
    case "video_metadata_extractor":
      return buildVideoExtractorCode();
    case "json_payload_extractor":
      return buildJsonPayloadExtractorCode();
    case "interactive_probe":
      return buildInteractiveProbeCode();
    case "html_extractor":
    default:
      return buildHtmlExtractorCode();
  }
}

function summarizeScript(strategy, target) {
  switch (strategy) {
    case "video_metadata_extractor":
      return `Parses page metadata, timestamps, and basic video timeline hints for ${target?.platform || "video sources"}.`;
    case "json_payload_extractor":
      return `Extracts embedded JSON payloads and flattens nested fields for ${hostFromUrl(target?.url) || "structured pages"}.`;
    case "interactive_probe":
      return "Prepares an interactive probing fallback and degrades to static extraction when browser automation is unavailable.";
    case "html_extractor":
    default:
      return `Fetches HTML, strips noisy markup, and produces normalized text paragraphs for ${hostFromUrl(target?.url) || "web pages"}.`;
  }
}

function assessLongTermValue(tool, result) {
  const host = hostFromUrl(tool?.target?.url);
  const structuredPayloads = result?.extracted_data?.structured_payloads?.length || 0;
  const hadTimeline = result?.extracted_data?.timeline?.length || 0;
  const shouldPromote = Boolean(
    result?.success
    && (
      structuredPayloads > 0
      || hadTimeline > 0
      || tool?.strategy === "interactive_probe"
      || /douyin|bilibili|ted|segmentfault/.test(host)
    )
  );

  return {
    should_promote: shouldPromote,
    reason: shouldPromote
      ? "The target required site-specific extraction logic that is likely reusable."
      : "This looked like a one-off fallback and does not yet justify a dedicated connector.",
    candidate_connector: shouldPromote ? host || tool.strategy : null
  };
}

async function synthesizeTool({ goal, target, constraints = [] }) {
  const normalizedGoal = String(goal || "").trim() || "Extract structured data";
  const normalizedTarget = target || {};
  const strategy = chooseStrategy(normalizedGoal, normalizedTarget, constraints);
  const runtime = "node";
  const code = buildToolCode(strategy);

  return {
    tool_id: makeToolId("ephemeral_tool", `${strategy}:${normalizedTarget.url || normalizedTarget.title || normalizedGoal}`),
    synthesis_mode: "heuristic",
    goal: normalizedGoal,
    target: normalizedTarget,
    constraints: normalizeList(constraints),
    runtime,
    strategy,
    description: summarizeScript(strategy, normalizedTarget),
    code,
    input_contract: {
      stdin_json: {
        target: "Target descriptor with url, html, title, content_type, and platform."
      }
    }
  };
}

function resolveRuntimeCommand(runtime) {
  if (runtime === "python") {
    return { command: "python", extension: ".py" };
  }
  return { command: process.execPath, extension: ".js" };
}

function readToolMemory(memoryPath = toolMemoryPath) {
  try {
    return JSON.parse(fs.readFileSync(memoryPath, "utf8"));
  } catch (_) {
    return {
      updated_at: null,
      site_patterns: [],
      reusable_patterns: [],
      avoid_patterns: []
    };
  }
}

function writeToolMemory(memory, memoryPath = toolMemoryPath) {
  ensureDirectoryExists(path.dirname(memoryPath));
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
}

function recordToolExperience(attempts, options = {}) {
  const memoryPath = options.memoryPath || toolMemoryPath;
  const existing = readToolMemory(memoryPath);
  const next = {
    ...existing,
    updated_at: new Date().toISOString(),
    site_patterns: [...(existing.site_patterns || [])],
    reusable_patterns: [...(existing.reusable_patterns || [])],
    avoid_patterns: [...(existing.avoid_patterns || [])]
  };

  for (const attempt of attempts || []) {
    const host = hostFromUrl(attempt?.target?.url || attempt?.tool?.target?.url);
    const key = host || attempt?.tool?.strategy || "unknown";
    const siteEntry = next.site_patterns.find((item) => item.site_key === key);
    if (siteEntry) {
      siteEntry.attempts += 1;
      siteEntry.success_count += attempt?.success ? 1 : 0;
      siteEntry.last_strategy = attempt?.tool?.strategy || siteEntry.last_strategy;
      siteEntry.last_failure = attempt?.success ? siteEntry.last_failure : (attempt?.error || attempt?.execution?.stderr || null);
    } else {
      next.site_patterns.push({
        site_key: key,
        attempts: 1,
        success_count: attempt?.success ? 1 : 0,
        last_strategy: attempt?.tool?.strategy || null,
        last_failure: attempt?.success ? null : (attempt?.error || attempt?.execution?.stderr || null)
      });
    }

    if (attempt?.worth_promoting?.should_promote) {
      const reusableEntry = next.reusable_patterns.find((item) => item.key === `${key}:${attempt.tool.strategy}`);
      if (reusableEntry) {
        reusableEntry.times_recommended += 1;
        reusableEntry.last_reason = attempt.worth_promoting.reason;
      } else {
        next.reusable_patterns.push({
          key: `${key}:${attempt.tool.strategy}`,
          site_key: key,
          strategy: attempt.tool.strategy,
          times_recommended: 1,
          last_reason: attempt.worth_promoting.reason
        });
      }
    }

    if (!attempt?.success) {
      next.avoid_patterns.push({
        created_at: new Date().toISOString(),
        site_key: key,
        strategy: attempt?.tool?.strategy || null,
        failure_mode: attempt?.error || attempt?.execution?.stderr || "unknown failure"
      });
    }
  }

  writeToolMemory(next, memoryPath);
  return next;
}

async function runEphemeralTool(tool, sandbox = {}) {
  const runtime = resolveRuntimeCommand(tool?.runtime);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensearch-tool-"));
  const scriptPath = path.join(tempDir, `tool${runtime.extension}`);
  const inputPath = path.join(tempDir, "input.json");
  const stdoutPath = path.join(tempDir, "stdout.log");
  const stderrPath = path.join(tempDir, "stderr.log");
  const timeoutMs = Number(sandbox.timeout_ms || 15000);
  const input = {
    goal: tool.goal,
    target: tool.target,
    constraints: tool.constraints || []
  };

  fs.writeFileSync(scriptPath, tool.code);
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));

  const startedAt = Date.now();
  const execution = await new Promise((resolve) => {
    const child = spawn(runtime.command, [scriptPath], { cwd: tempDir });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch (_) {
        // Ignore cleanup failures.
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exit_code: -1,
        duration_ms: Date.now() - startedAt,
        stdout: "",
        stderr: error.message,
        timed_out: false
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      fs.writeFileSync(stdoutPath, stdout);
      fs.writeFileSync(stderrPath, stderr);
      resolve({
        exit_code: code,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr,
        timed_out: timedOut
      });
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });

  let parsedOutput = null;
  if (execution.stdout.trim()) {
    try {
      parsedOutput = JSON.parse(execution.stdout);
    } catch (_) {
      parsedOutput = null;
    }
  }

  const result = {
    tool,
    sandbox: {
      timeout_ms: timeoutMs,
      network: sandbox.network !== false,
      temp_dir: tempDir
    },
    execution,
    success: Boolean(parsedOutput?.success && execution.exit_code === 0 && !execution.timed_out),
    logs: normalizeList(parsedOutput?.logs),
    extracted_data: parsedOutput?.extracted_data || null,
    error: parsedOutput?.error || execution.stderr || (execution.timed_out ? "tool timed out" : null)
  };
  result.worth_promoting = assessLongTermValue(tool, result);
  return result;
}

module.exports = {
  synthesizeTool,
  runEphemeralTool,
  readToolMemory,
  recordToolExperience,
  __internal: {
    chooseStrategy,
    summarizeScript,
    assessLongTermValue,
    resolveRuntimeCommand
  }
};
