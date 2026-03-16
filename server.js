const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  runResearch,
  getSamples,
  getExperienceMemory,
  getToolMemory,
  getSourceCapabilities,
  synthesizeTool,
  runEphemeralTool
} = require("./src/research-engine");

const publicDir = path.join(__dirname, "public");
const port = process.env.PORT || 3000;

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
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain; charset=utf-8" });
    res.end(content);
  });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
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
      source_capabilities: getSourceCapabilities()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tools/synthesize") {
    try {
      const body = await collectBody(req);
      const input = body ? JSON.parse(body) : {};
      const tool = await synthesizeTool({
        goal: input.goal,
        target: input.target,
        constraints: input.constraints || []
      });
      sendJson(res, 200, tool);
    } catch (error) {
      sendJson(res, 500, {
        error: "tool_synthesis_failed",
        message: error.message
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tools/run-ephemeral") {
    try {
      const body = await collectBody(req);
      const input = body ? JSON.parse(body) : {};
      const tool = input.tool || await synthesizeTool({
        goal: input.goal,
        target: input.target,
        constraints: input.constraints || []
      });
      const result = await runEphemeralTool(tool, input.sandbox || {});
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {
        error: "ephemeral_tool_failed",
        message: error.message
      });
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
        error: "question is required"
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
        sendSseEvent(res, "done", { type: "done", result });
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
      const body = await collectBody(req);
      const input = body ? JSON.parse(body) : {};
      const question = String(input.question || "").trim();
      const mode = input.mode === "quick" ? "quick" : "deep";

      if (!question) {
        sendJson(res, 400, { error: "question is required" });
        return;
      }

      const result = await runResearch({ question, mode });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {
        error: "research_failed",
        message: error.message
      });
    }
    return;
  }

  const assetPath = url.pathname === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, url.pathname);
  if (assetPath.startsWith(publicDir)) {
    sendFile(res, assetPath);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(port, () => {
  console.log(`Deep Web Search MVP listening on http://localhost:${port}`);
});
