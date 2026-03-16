const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createServer } = require("../server");

function request(server, options = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: options.path || "/",
      method: options.method || "GET",
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json: body ? JSON.parse(body) : null
        });
      });
    });

    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function withServer(fn) {
  const server = createServer({
    runResearch: async () => ({ ok: true }),
    getSamples: () => [],
    getExperienceMemory: () => [],
    getToolMemory: () => ({}),
    getSourceCapabilities: () => [],
    synthesizeTool: async () => ({ id: "tool-1" }),
    runEphemeralTool: async () => ({ success: true })
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(server);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }));
  }
}

test("POST /api/research should reject invalid JSON with 400", async () => {
  await withServer(async (server) => {
    const response = await request(server, {
      path: "/api/research",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: "{invalid"
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json.error, "invalid_json");
  });
});

test("POST /api/research should reject missing question with 400", async () => {
  await withServer(async (server) => {
    const response = await request(server, {
      path: "/api/research",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ mode: "deep" })
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json.error, "invalid_request");
    assert.match(response.json.message, /question is required/);
  });
});

test("POST /api/tools/synthesize should reject invalid payloads with 400", async () => {
  await withServer(async (server) => {
    const response = await request(server, {
      path: "/api/tools/synthesize",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ constraints: "not-an-array" })
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json.error, "invalid_request");
    assert.match(response.json.message, /goal is required/);
  });
});
