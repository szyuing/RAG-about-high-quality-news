function extractTextFromResponsePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  for (const item of payload.output || []) {
    if (item?.type !== "message") {
      continue;
    }
    for (const content of item.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        chunks.push(content.text.trim());
      }
    }
  }
  return chunks.join("\n").trim();
}

function normalizeResponsesInput(input) {
  if (input === undefined || input === null) {
    return input;
  }
  if (Array.isArray(input)) {
    return input;
  }
  if (typeof input === "string") {
    return [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: input
          }
        ]
      }
    ];
  }
  if (typeof input === "object") {
    return [input];
  }
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: String(input)
        }
      ]
    }
  ];
}

function normalizeResponsesRequestBody(body, options = {}) {
  if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "input")) {
    return body;
  }

  const normalized = {
    ...body,
    input: normalizeResponsesInput(body.input)
  };

  if (options.forceStream && normalized.stream === undefined) {
    normalized.stream = true;
  }

  return normalized;
}

function getResponseContentType(response) {
  if (!response || !response.headers) {
    return "";
  }
  if (typeof response.headers.get === "function") {
    return String(response.headers.get("content-type") || "").toLowerCase();
  }
  return String(response.headers["content-type"] || response.headers["Content-Type"] || "").toLowerCase();
}

function parseEventStream(text) {
  return String(text || "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      let event = null;
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      const dataText = dataLines.join("\n");
      let data = null;
      if (dataText && dataText !== "[DONE]") {
        try {
          data = JSON.parse(dataText);
        } catch (_) {
          data = null;
        }
      }
      return { event, dataText, data };
    });
}

function buildPayloadFromEventStream(events) {
  let responsePayload = null;
  let outputText = "";
  const outputItems = new Map();

  for (const event of events) {
    const data = event.data;
    if (!data || typeof data !== "object") {
      continue;
    }

    if (data.response && typeof data.response === "object") {
      responsePayload = data.response;
    }

    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
      outputText += data.delta;
    }

    if (data.type === "response.output_text.done" && !outputText && typeof data.text === "string") {
      outputText = data.text;
    }

    if (data.type === "response.output_item.done" && data.item && data.output_index !== undefined) {
      outputItems.set(Number(data.output_index), data.item);
    }
  }

  const payload = responsePayload && typeof responsePayload === "object"
    ? { ...responsePayload }
    : {};

  if (!Array.isArray(payload.output) && outputItems.size > 0) {
    payload.output = Array.from(outputItems.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([, item]) => item);
  }

  if (!payload.output_text && outputText) {
    payload.output_text = outputText;
  }

  return payload;
}

async function readResponsesApiPayload(response) {
  const contentType = getResponseContentType(response);

  if (contentType.includes("text/event-stream")) {
    const rawText = typeof response.text === "function" ? await response.text() : "";
    return {
      rawText,
      payload: buildPayloadFromEventStream(parseEventStream(rawText))
    };
  }

  if (typeof response.text === "function") {
    const rawText = await response.text();
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch (_) {
        payload = null;
      }
    }
    return { rawText, payload };
  }

  if (typeof response.json === "function") {
    const payload = await response.json();
    return {
      rawText: payload ? JSON.stringify(payload) : "",
      payload
    };
  }

  return { rawText: "", payload: null };
}

module.exports = {
  extractTextFromResponsePayload,
  normalizeResponsesInput,
  normalizeResponsesRequestBody,
  parseEventStream,
  buildPayloadFromEventStream,
  readResponsesApiPayload
};
