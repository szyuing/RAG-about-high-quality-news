const http = require("http");
const fs = require("fs");
const path = require("path");
const researchEngine = require("./src/research-engine");

const publicDir = path.join(__dirname, "public");
const port = process.env.PORT || 3000;

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendSseEvent(res, eventName, payload) {
  if (res.writableEnded) {
    return;
  }

  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon"
  };

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "not_found", message: "Not found" });
      return;
    }

    res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain; charset=utf-8" });
    res.end(content);
  });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) {
        return;
      }
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        aborted = true;
        reject(new HttpError(413, "request_body_too_large", "Request body too large"));
      }
    });
    req.on("end", () => {
      if (!aborted) {
        resolve(body);
      }
    });
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  const body = await collectBody(req);
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (_) {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_request", `${fieldName} is required`);
  }
  return value.trim();
}

function normalizeMode(value) {
  if (value === undefined || value === null || value === "") {
    return "deep";
  }
  if (value === "quick" || value === "deep") {
    return value;
  }
  throw new HttpError(400, "invalid_request", "mode must be either quick or deep");
}

function normalizeSearchProfile(value) {
  if (value === undefined || value === null || value === "") {
    return "quality";
  }
  if (value === "speed" || value === "balanced" || value === "quality") {
    return value;
  }
  throw new HttpError(400, "invalid_request", "search_profile must be one of speed, balanced, quality");
}

function modeForSearchProfile(profile) {
  if (profile === "speed") {
    return "quick";
  }
  return "deep";
}

function resolveSearchExecution(input) {
  const hasMode = input.mode !== undefined && input.mode !== null && input.mode !== "";
  const rawProfile = input.search_profile ?? input.profile;
  const hasProfile = rawProfile !== undefined && rawProfile !== null && rawProfile !== "";

  if (hasMode) {
    const mode = normalizeMode(input.mode);
    const searchProfile = hasProfile
      ? normalizeSearchProfile(rawProfile)
      : (mode === "quick" ? "speed" : "quality");
    return { mode, searchProfile, mode_source: "mode" };
  }

  const searchProfile = normalizeSearchProfile(rawProfile);
  return {
    mode: modeForSearchProfile(searchProfile),
    searchProfile,
    mode_source: "search_profile"
  };
}

function validateArrayField(value, fieldName) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", `${fieldName} must be an array`);
  }
  return value;
}

function validateOptionalObject(value, fieldName) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new HttpError(400, "invalid_request", `${fieldName} must be an object`);
  }
  return value;
}

function validateToolSynthesisInput(input) {
  if (!isPlainObject(input)) {
    throw new HttpError(400, "invalid_request", "Request body must be a JSON object");
  }

  return {
    goal: requireNonEmptyString(input.goal, "goal"),
    target: validateOptionalObject(input.target, "target"),
    constraints: validateArrayField(input.constraints, "constraints")
  };
}

function validateEphemeralToolInput(input) {
  if (!isPlainObject(input)) {
    throw new HttpError(400, "invalid_request", "Request body must be a JSON object");
  }

  const tool = validateOptionalObject(input.tool, "tool");
  const sandbox = validateOptionalObject(input.sandbox, "sandbox") || {};

  if (tool) {
    return { tool, sandbox };
  }

  return {
    ...validateToolSynthesisInput(input),
    sandbox
  };
}

function normalizeSearchResult(result, query, mode, searchProfile, modeSource = null) {
  const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  const citations = evidence
    .slice(0, 10)
    .map((item) => ({
      source_id: item.source_id || null,
      title: item.title || null,
      url: item.source_metadata?.url || null,
      connector: item.source_metadata?.connector || null,
      platform: item.source_metadata?.platform || null,
      published_at: item.source_metadata?.published_at || null,
      snippet: (item.key_points || [])[0] || null
    }));

  const deepSummary = result?.final_answer?.deep_research_summary || {};
  return {
    response_schema_version: "search_response.v1",
    schema_version: "search.v1",
    query,
    mode,
    search_profile: searchProfile || null,
    task_id: result?.task_id || null,
    answer: result?.final_answer?.quick_answer || "",
    summary: deepSummary.conclusion || "",
    confidence: deepSummary.confidence ?? null,
    uncertainty: Array.isArray(deepSummary.uncertainty) ? deepSummary.uncertainty : [],
    citations,
    stop_state: result?.evaluation?.stop_state || null,
    diagnostics: {
      rounds: Array.isArray(result?.rounds) ? result.rounds.length : 0,
      evidence_units: evidence.length,
      evaluator_mode: result?.evaluation?.evaluator_mode || null,
      mode_source: modeSource
    }
  };
}

function normalizeResearchResponse(result) {
  if (!isPlainObject(result)) {
    return {
      response_schema_version: "research_response.v1",
      result
    };
  }

  return {
    response_schema_version: "research_response.v1",
    ...result
  };
}

function sendError(res, error, fallbackCode, fallbackMessage) {
  if (error instanceof HttpError) {
    sendJson(res, error.statusCode, {
      error: error.code,
      message: error.message
    });
    return;
  }

  sendJson(res, 500, {
    error: fallbackCode,
    message: error?.message || fallbackMessage
  });
}

function createServer(deps = {}) {
  const {
    runResearch = researchEngine.runResearch,
    getSamples = researchEngine.getSamples,
    getExperienceMemory = researchEngine.getExperienceMemory,
    getToolMemory = researchEngine.getToolMemory,
    getToolAuditLog = researchEngine.getToolAuditLog,
    getSourceCapabilities = researchEngine.getSourceCapabilities,
    synthesizeTool = researchEngine.synthesizeTool,
    runEphemeralTool = researchEngine.runEphemeralTool
  } = deps;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "deep-web-search-mvp" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/samples") {
      sendJson(res, 200, {
        prompts: getSamples(),
        experience_memory: getExperienceMemory(),
        tool_memory: getToolMemory(),
        tool_audit_recent: getToolAuditLog(20),
        source_capabilities: getSourceCapabilities()
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/search/capabilities") {
      sendJson(res, 200, {
        schema_version: "search-capabilities.v1",
        modes: ["quick", "deep"],
        default_mode: "deep",
        search_profiles: {
          values: ["speed", "balanced", "quality"],
          default: "quality",
          mode_mapping: {
            speed: "quick",
            balanced: "deep",
            quality: "deep"
          }
        },
        limits: {
          max_citations: 10
        },
        source_capabilities: getSourceCapabilities()
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tools/audit") {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
      sendJson(res, 200, {
        entries: getToolAuditLog(limit)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tools/synthesize") {
      try {
        const input = validateToolSynthesisInput(await parseJsonBody(req));
        const tool = await synthesizeTool(input);
        sendJson(res, 200, tool);
      } catch (error) {
        sendError(res, error, "tool_synthesis_failed", "Tool synthesis failed");
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tools/run-ephemeral") {
      try {
        const input = validateEphemeralToolInput(await parseJsonBody(req));
        const tool = input.tool || await synthesizeTool({
          goal: input.goal,
          target: input.target,
          constraints: input.constraints
        });
        const result = await runEphemeralTool(tool, input.sandbox);
        sendJson(res, 200, result);
      } catch (error) {
        sendError(res, error, "ephemeral_tool_failed", "Ephemeral tool execution failed");
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/research/stream") {
      const question = String(url.searchParams.get("question") || "").trim();
      const mode = url.searchParams.get("mode") === "quick" ? "quick" : "deep";

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      if (!question) {
        sendSseEvent(res, "failed", {
          type: "failed",
          error: "invalid_request",
          message: "question is required"
        });
        res.end();
        return;
      }

      let closed = false;
      const heartbeat = setInterval(() => {
        if (!closed && !res.writableEnded) {
          res.write(": keep-alive\n\n");
        }
      }, 15000);

      const closeStream = () => {
        closed = true;
        clearInterval(heartbeat);
      };

      req.on("close", closeStream);

      try {
        const result = await runResearch({
          question,
          mode,
          onProgress: async (event) => {
            if (!closed) {
              sendSseEvent(res, event.type || "progress", event);
            }
          }
        });

        if (!closed) {
          sendSseEvent(res, "done", { type: "done", result: normalizeResearchResponse(result) });
          res.end();
        }
      } catch (error) {
        if (!closed) {
          sendSseEvent(res, "failed", {
            type: "failed",
            error: "research_failed",
            message: error.message
          });
          res.end();
        }
      } finally {
        closeStream();
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/research") {
      try {
        const input = await parseJsonBody(req);
        if (!isPlainObject(input)) {
          throw new HttpError(400, "invalid_request", "Request body must be a JSON object");
        }

        const question = requireNonEmptyString(input.question, "question");
        const mode = normalizeMode(input.mode);
        const result = await runResearch({ question, mode });
        sendJson(res, 200, normalizeResearchResponse(result));
      } catch (error) {
        sendError(res, error, "research_failed", "Research failed");
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/search") {
      try {
        const input = await parseJsonBody(req);
        if (!isPlainObject(input)) {
          throw new HttpError(400, "invalid_request", "Request body must be a JSON object");
        }

        const query = requireNonEmptyString(input.query ?? input.question, "query");
        const execution = resolveSearchExecution(input);
        const mode = execution.mode;
        const result = await runResearch({ question: query, mode });
        sendJson(res, 200, normalizeSearchResult(result, query, mode, execution.searchProfile, execution.mode_source));
      } catch (error) {
        sendError(res, error, "search_failed", "Search failed");
      }
      return;
    }

    const assetPath = url.pathname === "/"
      ? path.resolve(publicDir, "index.html")
      : path.resolve(publicDir, `.${url.pathname}`);
    if (assetPath.startsWith(publicDir)) {
      sendFile(res, assetPath);
      return;
    }

    sendJson(res, 404, { error: "not_found", message: "Not found" });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(port, () => {
    console.log(`Deep Web Search MVP listening on http://localhost:${port}`);
  });
}

module.exports = {
  HttpError,
  collectBody,
  createServer,
  normalizeSearchProfile,
  normalizeResearchResponse,
  resolveSearchExecution,
  normalizeSearchResult,
  parseJsonBody,
  sendJson,
  sendSseEvent
};
