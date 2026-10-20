// The official SDKs are strict about event shapes; if they accept freeflow's output,
// real clients will too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { startMock, tempHome } from "../helpers/mock.js";

let mock, srv, base;
before(async () => {
  mock = await startMock();
  tempHome({
    custom: [{ id: "m", name: "Mock", baseUrl: `${mock.url}/v1` }],
    routes: { default: { model: "m/tools" }, haiku: { model: "m/reason" }, opus: { model: "m/think" } },
  });
  const { startServer } = await import("../../src/server.js");
  srv = await startServer({ port: 0, host: "127.0.0.1", log: () => {} });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => {
  srv.server.closeAllConnections?.();
  await new Promise((r) => srv.server.close(r));
  await mock.close();
});

const client = () => new Anthropic({ baseURL: base, apiKey: "freeflow", maxRetries: 0 });
const tools = [{ name: "Read", description: "read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }, { name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }];

test("Anthropic SDK: streaming tool calls assemble into the final message", async () => {
  const stream = client().messages.stream({ model: "claude-sonnet-4-6", max_tokens: 200, tools, messages: [{ role: "user", content: "read a.txt" }] });
  const seen = [];
  stream.on("inputJson", (_d, snap) => seen.push(snap));
  const msg = await stream.finalMessage();
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content.map((b) => b.type), ["text", "tool_use", "tool_use"]);
  assert.deepEqual(msg.content[1].input, { file_path: "a.txt" });
  assert.deepEqual(msg.content[2].input, { command: "ls" });
  assert.equal(msg.usage.output_tokens, 20);
  assert.ok(seen.length >= 2);
});

test("Anthropic SDK: thinking blocks from reasoning fields and <think> tags", async () => {
  const a = await client().messages.stream({ model: "claude-haiku-4-5", max_tokens: 200, messages: [{ role: "user", content: "x" }] }).finalMessage();
  assert.equal(a.content[0].type, "thinking");
  assert.equal(a.content[0].thinking, "Let me think.");
  assert.equal(a.content[1].text, "Answer.");
  const b = await client().messages.stream({ model: "claude-opus-4-7", max_tokens: 200, messages: [{ role: "user", content: "x" }] }).finalMessage();
  assert.deepEqual(b.content.map((x) => x.type), ["thinking", "text"]);
  assert.equal(b.content[1].text, "Done");
});

test("Anthropic SDK: non-streaming create, countTokens and models.list", async () => {
  const c = client();
  const m = await c.messages.create({ model: "claude-sonnet-4-6", max_tokens: 100, tools, messages: [{ role: "user", content: "x" }] });
  assert.equal(m.type, "message");
  const n = await c.messages.countTokens({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hello there" }] });
  assert.ok(n.input_tokens > 0);
  const ids = [];
  for await (const model of c.models.list()) ids.push(model.id);
  assert.ok(ids.includes("m/tools"));
});

test("Anthropic SDK: errors arrive as typed API errors", async () => {
  const bad = new Anthropic({ baseURL: base, apiKey: "x", maxRetries: 0 });
  tempHome({ custom: [{ id: "m", name: "Mock", baseUrl: `${mock.url}/v1` }], routes: { default: { model: "m/rate" } } });
  srv.app.reload();
  await assert.rejects(bad.messages.create({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "x" }] }), (e) => e instanceof Anthropic.RateLimitError && /rate limited/.test(e.message));
});

test("OpenAI SDK: streaming chat completions through the gateway", async () => {
  tempHome({ custom: [{ id: "m", name: "Mock", baseUrl: `${mock.url}/v1` }], routes: { default: { model: "m/ok" } } });
  srv.app.reload();
  const oa = new OpenAI({ baseURL: `${base}/v1`, apiKey: "freeflow", maxRetries: 0 });
  const stream = await oa.chat.completions.create({ model: "default", stream: true, messages: [{ role: "user", content: "hi" }] });
  let text = "";
  for await (const chunk of stream) text += chunk.choices[0]?.delta?.content || "";
  assert.equal(text, "Hello world");
  const list = await oa.models.list();
  assert.ok(list.data.some((m) => m.id === "m/ok"));
});
