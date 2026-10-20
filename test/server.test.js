import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startMock, tempHome, parseSSE } from "./helpers/mock.js";
import { clearLearned, learnedRepairs } from "../src/upstream.js";

let mock, srv, base, home;
const lines = [];

async function boot(config) {
  if (srv) await new Promise((r) => { srv.server.closeAllConnections?.(); srv.server.close(r); });
  home = tempHome({
    custom: [
      { id: "m1", name: "Mock one", baseUrl: `${mock.url}/v1` },
      { id: "m2", name: "Mock two", baseUrl: `${mock.url}/v1` },
      { id: "m3", name: "Mock three", baseUrl: `${mock.url}/v1` },
      { id: "nat", name: "Native", baseUrl: mock.url, format: "anthropic" },
    ],
    providers: { nat: { key: "sk-ant-test" } },
    timeouts: { firstByteMs: 1500, idleMs: 1500 },
    ...config,
  });
  const { startServer } = await import("../src/server.js");
  srv = await startServer({ port: 0, host: "127.0.0.1", log: (l) => lines.push(l) });
  base = `http://127.0.0.1:${srv.port}`;
  clearLearned();
  mock.requests.length = 0;
}

async function messages(body, headers = {}) {
  const r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers }, body: JSON.stringify({ max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...body }) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text), events: () => parseSSE(text) };
}

const admin = (p, body) => fetch(`${base}/admin/api${p}`, body === undefined ? { headers: { "x-freeflow-admin": "admintoken" } } : { method: "POST", headers: { "x-freeflow-admin": "admintoken", "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  mock = await startMock();
});
after(async () => {
  await new Promise((r) => { srv.server.closeAllConnections?.(); srv.server.close(r); });
  await mock.close();
});
beforeEach(() => (lines.length = 0));

test("streams a translated reply with the requested model name", async () => {
  await boot({ routes: { default: { model: "m1/ok" } } });
  const r = await messages({ model: "claude-sonnet-4-6", stream: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  assert.equal(r.headers.get("x-freeflow-model"), "m1/ok");
  const ev = r.events();
  assert.equal(ev[0].type, "message_start");
  assert.equal(ev[0].event, "message_start");
  assert.equal(ev[0].message.model, "claude-sonnet-4-6");
  assert.equal(ev.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join(""), "Hello world");
  assert.equal(ev.at(-1).type, "message_stop");
  assert.deepEqual(ev.at(-2).usage, { input_tokens: 10, output_tokens: 2 });
  assert.equal(mock.requests[0].body.model, "ok");
  assert.equal(mock.requests[0].body.stream, true);
});

test("non-streaming requests get a complete Message", async () => {
  await boot({ routes: { default: { model: "m1/tools" } } });
  const r = await messages({ model: "claude-haiku-4-5" });
  assert.equal(r.status, 200);
  const m = r.json();
  assert.equal(m.type, "message");
  assert.equal(m.stop_reason, "tool_use");
  assert.deepEqual(m.content.map((b) => b.type), ["text", "tool_use", "tool_use"]);
  assert.deepEqual(m.content[1].input, { file_path: "a.txt" });
});

test("falls back past a rate-limited model, then skips it while it cools down", async () => {
  await boot({ routes: { default: { model: "m1/rate" } }, fallbacks: [{ model: "m2/down" }, { model: "m3/ok" }] });
  const r = await messages({ model: "claude-sonnet-4-6", stream: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-freeflow-model"), "m3/ok");
  assert.deepEqual(mock.requests.map((q) => q.body.model), ["rate", "down", "ok"]);
  const st = (await admin("/state")).body;
  const keys = st.health.map((h) => h.key).sort();
  assert.deepEqual(keys, ["m1", "m2"]);
  assert.equal(st.health.find((h) => h.key === "m1").secondsLeft, 7, "Retry-After honoured");
  assert.equal(st.activity.at(-1).attempts.length, 3);
  mock.requests.length = 0;
  await messages({ model: "claude-sonnet-4-6" });
  assert.equal(mock.requests[0].body.model, "ok", "cooling providers are tried last");
  assert.match(lines.join("\n"), /fell back past: m1\/rate/);
});

test("when everything is rate limited the client gets a 429; mixed failures give 529", async () => {
  await boot({ routes: { default: { model: "m1/rate" } }, fallbacks: [{ model: "m2/rate" }] });
  const r = await messages({});
  assert.equal(r.status, 429);
  assert.equal(r.json().error.type, "rate_limit_error");
  await boot({ routes: { default: { model: "m1/rate" } }, fallbacks: [{ model: "m2/down" }, { model: "m3/authbad" }] });
  const r2 = await messages({});
  assert.equal(r2.status, 529);
  assert.equal(r2.json().error.type, "overloaded_error");
  assert.match(r2.json().error.message, /m3\/authbad: Invalid API key/);
});

test("a request every provider rejects comes back as 400 with the provider's reason", async () => {
  await boot({ routes: { default: { model: "m1/badreq" } } });
  const r = await messages({});
  assert.equal(r.status, 400);
  assert.match(r.json().error.message, /prompt is too long/);
  assert.equal((await admin("/state")).body.health.length, 0, "a bad request does not cool the provider");
});

test("no model configured: a clear message pointing at the admin page", async () => {
  await boot({});
  const r = await messages({});
  assert.equal(r.status, 400);
  assert.match(r.json().error.message, /no model is set up yet/);
});

test("rejected parameters are removed, retried and remembered", async () => {
  await boot({ routes: { default: { model: "m1/picky" } } });
  const r = await messages({ stream: true });
  assert.equal(r.status, 200);
  assert.equal(mock.requests.length, 2);
  assert.ok(mock.requests[0].body.stream_options);
  assert.equal(mock.requests[1].body.stream_options, undefined);
  assert.deepEqual(learnedRepairs()["m1/picky"], ["stream_options"]);
  mock.requests.length = 0;
  await messages({ stream: true });
  assert.equal(mock.requests.length, 1, "lesson applied up front next time");
});

test("a provider that ignores stream:true and returns JSON still works", async () => {
  await boot({ routes: { default: { model: "m1/json" } } });
  const r = await messages({ stream: true });
  assert.equal(r.events().filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join(""), "Plain JSON reply");
});

test("empty stream and a stream that dies before any content fall back silently", async () => {
  await boot({ routes: { default: { model: "m1/empty" } }, fallbacks: [{ model: "m2/streamerror" }, { model: "m3/ok" }] });
  const r = await messages({ stream: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-freeflow-model"), "m3/ok");
});

test("a stream that dies after content ends with an Anthropic error event", async () => {
  await boot({ routes: { default: { model: "m1/midfail" } }, fallbacks: [{ model: "m2/ok" }] });
  const r = await messages({ stream: true });
  assert.equal(r.status, 200);
  const ev = r.events();
  assert.equal(ev.find((e) => e.delta?.type === "text_delta").delta.text, "partial");
  assert.equal(ev.at(-1).type, "error");
  assert.equal(ev.at(-1).error.type, "overloaded_error");
});

test("a provider that never answers times out and falls back", async () => {
  await boot({ routes: { default: { model: "m1/hang" } }, fallbacks: [{ model: "m2/ok" }], timeouts: { firstByteMs: 300, idleMs: 300 } });
  const t0 = Date.now();
  const r = await messages({});
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 3000);
  assert.match((await admin("/state")).body.activity.at(-1).attempts[0].error, /no response within/);
});

test("long tool names survive the round trip", async () => {
  await boot({ routes: { default: { model: "m1/longname" } } });
  const long = "mcp__a_very_long_server_name_for_testing__with_an_equally_long_tool_name_x";
  const r = await messages({ tools: [{ name: long, input_schema: { type: "object" } }] });
  assert.ok(mock.requests[0].body.tools[0].function.name.length <= 64);
  assert.equal(r.json().content[0].name, long);
});

test("Gemini thought signatures are stored and sent back on the next turn", async () => {
  await boot({ providers: { gemini: { key: "g-key", baseUrl: `${mock.url}/v1` } }, routes: { default: { model: "gemini/signature" } } });
  const tools = [{ name: "Read", input_schema: { type: "object" } }];
  const first = (await messages({ tools })).json();
  assert.equal(first.content[0].id, "g1");
  mock.requests.length = 0;
  await messages({ tools, messages: [{ role: "user", content: "x" }, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "g1", content: "done" }] }] });
  const sent = mock.requests[0].body.messages[1].tool_calls[0];
  assert.deepEqual(sent.extra_content, { google: { thought_signature: "SIG123" } });
  assert.equal(mock.requests[0].headers.authorization, "Bearer g-key");
});

test("count_tokens and models endpoints", async () => {
  await boot({ routes: { default: { model: "m1/ok" }, opus: { model: "m2/big" } }, fallbacks: [{ model: "m3/ok" }] });
  const c = await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(400) }] }) }).then((r) => r.json());
  assert.ok(c.input_tokens >= 100);
  const a = await fetch(`${base}/v1/models`, { headers: { "anthropic-version": "2023-06-01" } }).then((r) => r.json());
  assert.deepEqual(a.data.map((m) => m.id), ["default", "m1/ok", "m2/big", "m3/ok"]);
  assert.equal(a.data[0].type, "model");
  const o = await fetch(`${base}/v1/models`).then((r) => r.json());
  assert.equal(o.object, "list");
  assert.equal(o.data[1].owned_by, "m1");
});

test("OpenAI-compatible endpoint: aliases, passthrough streaming and fallback", async () => {
  await boot({ routes: { default: { model: "m1/rate" } }, fallbacks: [{ model: "m2/ok" }] });
  const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "default", stream: true, messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-freeflow-model"), "m2/ok");
  const text = await r.text();
  assert.match(text, /"content":"Hello"/);
  const j = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m3/jsontools", messages: [{ role: "user", content: "hi" }] }) }).then((x) => x.json());
  assert.equal(j.choices[0].message.tool_calls[0].function.name, "Read");
  const bad = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "nope/x", messages: [] }) });
  assert.equal(bad.status, 200, "unknown provider prefix falls through to the default route");
});

test("Anthropic as a provider: forwarded natively, freeflow thinking stripped", async () => {
  await boot({ routes: { default: { model: "nat/claude-sonnet-4-6" } } });
  const r = await messages({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "freeflow:v1" }, { type: "text", text: "b" }] }, { role: "user", content: "c" }] });
  assert.equal(r.status, 200);
  assert.equal(r.json().content[0].text, "native:3");
  const sent = mock.requests[0];
  assert.equal(sent.url, "/v1/messages");
  assert.equal(sent.headers["x-api-key"], "sk-ant-test");
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(sent.body.model, "claude-sonnet-4-6");
  assert.equal(sent.body.messages[1].content.length, 1);
});

test("security: foreign Host headers are refused (DNS rebinding)", async () => {
  await boot({ routes: { default: { model: "m1/ok" } } });
  const http = await import("node:http");
  const status = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: srv.port, path: "/health", headers: { host: "evil.example.com" } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
});

test("security: admin API needs the token and a same-origin request; keys are masked", async () => {
  await boot({ providers: { groq: { key: "gsk_supersecretkey1234" } } });
  assert.equal((await fetch(`${base}/admin/api/state`)).status, 401);
  const cross = await fetch(`${base}/admin/api/state`, { headers: { "x-freeflow-admin": "admintoken", origin: "http://evil.example.com" } });
  assert.equal(cross.status, 401);
  const st = (await admin("/state")).body;
  const groq = st.providers.find((p) => p.id === "groq");
  assert.equal(groq.key, "gsk_…1234");
  assert.ok(!JSON.stringify(st).includes("supersecret"));
  const html = await fetch(base).then((r) => r.text());
  assert.match(html, /const TOKEN = "admintoken"/);
  assert.ok(!html.includes("__FREEFLOW_"));
});

test("security: optional proxy token protects /v1", async () => {
  await boot({ routes: { default: { model: "m1/ok" } }, proxyToken: "pt-123" });
  assert.equal((await messages({})).status, 401);
  assert.equal((await messages({}, { authorization: "Bearer pt-123" })).status, 200);
  assert.equal((await messages({}, { "x-api-key": "pt-123" })).status, 200);
});

test("admin: save keys, routes and custom endpoints; validation; config file is private", async () => {
  await boot({});
  let r = await admin("/provider", { id: "groq", key: "  gsk_new_key_000000 " });
  assert.equal(r.body.providers.find((p) => p.id === "groq").ready, true);
  r = await admin("/routes", { routes: { default: { model: "groq/llama", effort: "low" }, sonnet: { model: "" } }, fallbacks: [{ model: "m1/ok", effort: "client" }] });
  assert.deepEqual(r.body.routes, { default: { model: "groq/llama", effort: "low" } });
  assert.deepEqual(r.body.fallbacks, [{ model: "m1/ok" }]);
  r = await admin("/routes", { routes: { default: { model: "not-a-ref" } } });
  assert.equal(r.status, 400);
  r = await admin("/custom", { id: "lab", name: "Lab", baseUrl: `${mock.url}/v1` });
  assert.ok(r.body.providers.some((p) => p.id === "lab" && p.ready));
  assert.equal((await admin("/custom", { id: "groq", baseUrl: "http://x" })).status, 400, "cannot shadow a built-in");
  const models = await admin("/models?provider=lab");
  assert.deepEqual(models.body.models, ["gem", "ok", "tools"]);
  const t = await admin("/test", { model: "lab/ok" });
  assert.equal(t.body.ok, true);
  assert.equal(t.body.reply, "Hello world");
  const saved = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(saved.providers.groq.key, "gsk_new_key_000000");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(home, "config.json")).mode & 0o777, 0o600);
  r = await admin("/provider", { id: "groq", key: "" });
  assert.equal(r.body.providers.find((p) => p.id === "groq").ready, false);
});

test("admin events stream delivers activity live", async () => {
  await boot({ routes: { default: { model: "m1/ok" } } });
  const ctrl = new AbortController();
  const res = await fetch(`${base}/admin/api/events`, { headers: { "x-freeflow-admin": "admintoken" }, signal: ctrl.signal });
  const reader = res.body.getReader();
  await messages({});
  let buf = "";
  while (!buf.includes("event: activity")) buf += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  assert.match(buf, /"served":"m1\/ok"/);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a client that hangs up mid-stream cancels the provider's stream (Anthropic API)", async () => {
  await boot({ routes: { default: { model: "m1/slow" } } });
  mock.slow.length = 0;
  const ctrl = new AbortController();
  const r = await fetch(`${base}/v1/messages`, { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ max_tokens: 10, stream: true, messages: [{ role: "user", content: "x" }] }) });
  const reader = r.body.getReader();
  await reader.read();
  ctrl.abort();
  await wait(300);
  assert.equal(mock.slow[0].closedEarly, true);
  assert.ok(mock.slow[0].sent < 60, `provider kept streaming: ${mock.slow[0].sent} chunks`);
});

test("a client that hangs up cancels the provider's stream (OpenAI passthrough)", async () => {
  await boot({ routes: { default: { model: "m1/slow" } } });
  mock.slow.length = 0;
  const ctrl = new AbortController();
  const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "default", stream: true, messages: [{ role: "user", content: "x" }] }) });
  await r.body.getReader().read();
  ctrl.abort();
  await wait(300);
  assert.equal(mock.slow[0].closedEarly, true);
});

test("a stalled stream is closed upstream after the idle timeout", async () => {
  await boot({ routes: { default: { model: "m1/stall" } }, timeouts: { firstByteMs: 1000, idleMs: 300 } });
  mock.slow.length = 0;
  const r = await messages({ stream: true });
  assert.equal(r.events().at(-1).type, "error");
  await wait(100);
  assert.equal(mock.slow[0].closed, true);
  mock.slow.length = 0;
  const c = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "default", stream: true, messages: [{ role: "user", content: "x" }] }) });
  await c.text().catch(() => {});
  await wait(100);
  assert.equal(mock.slow[0].closed, true, "passthrough also times out");
});

test("security: cross-site requests from web pages are refused on /v1", async () => {
  await boot({ routes: { default: { model: "m1/ok" } } });
  const r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "text/plain", origin: "https://evil.example.com" }, body: JSON.stringify({ max_tokens: 5, messages: [{ role: "user", content: "x" }] }) });
  assert.equal(r.status, 403);
  assert.equal(mock.requests.length, 0);
  const same = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ max_tokens: 5, messages: [{ role: "user", content: "x" }] }) });
  assert.equal(same.status, 200);
});
