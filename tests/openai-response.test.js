const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeResponsesInput,
  normalizeResponsesRequestBody,
  parseEventStream,
  buildPayloadFromEventStream,
  extractTextFromResponsePayload
} = require("../src/openai-response");

test("normalizeResponsesInput wraps string prompts into a Responses input array", () => {
  assert.deepEqual(normalizeResponsesInput("hello"), [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "hello"
        }
      ]
    }
  ]);
});

test("normalizeResponsesRequestBody keeps array input unchanged", () => {
  const original = {
    model: "gpt-5.4",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "hi" }]
      }
    ]
  };

  assert.deepEqual(normalizeResponsesRequestBody(original), original);
});

test("normalizeResponsesRequestBody can force stream mode", () => {
  const body = normalizeResponsesRequestBody({ model: "gpt-5.4", input: "hi" }, { forceStream: true });
  assert.equal(body.stream, true);
  assert.equal(body.input[0].content[0].text, "hi");
});

test("buildPayloadFromEventStream reconstructs final payload from SSE events", () => {
  const events = parseEventStream([
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"hel"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"lo"}',
    '',
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","content":[{"type":"output_text","text":"hello"}]}}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}}'
  ].join('\n'));

  const payload = buildPayloadFromEventStream(events);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output_text, "hello");
  assert.equal(payload.output[0].content[0].text, "hello");
});

test("extractTextFromResponsePayload reads output_text first", () => {
  assert.equal(extractTextFromResponsePayload({ output_text: "done" }), "done");
});
