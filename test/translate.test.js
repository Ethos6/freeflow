import { test } from "node:test";
import assert from "node:assert/strict";
import { toOpenAI, safeToolName, alnum9, resolveEffort, stripForeignThinking, estimateTokens, FF_SIGNATURE, cleanSchema } from "../src/translate/request.js";
import { StreamTranslator, eventsToMessage, parseArgs } from "../src/translate/response.js";

const tool = { name: "Read", description: "read a file", input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } };

test("system prompt, tools and tool round-trips become Chat Completions messages", () => {
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: [{ type: "text", text: "You are helpful." }, { type: "text", text: "Be brief." }],
    tools: [tool, { type: "web_search_20250305", name: "web_search" }],
    messages: [
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: [{ type: "text", text: "Sure." }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "hello" }] }, { type: "text", text: "thanks" }] },
    ],
  };
  const { request } = toOpenAI(body, { quirks: {}, model: "m" });
  assert.equal(request.model, "m");
  assert.equal(request.max_tokens, 1000);
  assert.deepEqual(request.stream_options, { include_usage: true });
  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages[0].content, "You are helpful.\n\nBe brief.");
  assert.deepEqual(request.messages[2], { role: "assistant", content: "Sure.", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.txt"}' } }] });
  // tool result first, then the user's text
  assert.deepEqual(request.messages[3], { role: "tool", tool_call_id: "toolu_1", content: "hello" });
  assert.deepEqual(request.messages[4], { role: "user", content: "thanks" });
  // server tools are dropped, $schema removed
  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0].function.parameters.$schema, undefined);
});

test("images, documents, errors and tool images are carried over", () => {
  const { request } = toOpenAI(
    {
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }, { type: "text", text: "what is this" }, { type: "document", source: { type: "text", data: "doc body" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Shot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: [{ type: "text", text: "boom" }, { type: "image", source: { type: "url", url: "https://x/y.png" } }] }] },
      ],
    },
    { quirks: {}, model: "m" },
  );
  assert.deepEqual(request.messages[0].content[0], { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
  assert.equal(request.messages[0].content[2].text, "doc body");
  assert.equal(request.messages[1].content, null);
  assert.deepEqual(request.messages[2], { role: "tool", tool_call_id: "t", content: "[tool error] boom" });
  assert.equal(request.messages[3].content[1].image_url.url, "https://x/y.png");
});

test("tool_choice and parallel tool use map across", () => {
  const base = { tools: [tool], messages: [{ role: "user", content: "x" }] };
  assert.equal(toOpenAI({ ...base, tool_choice: { type: "any" } }, { quirks: {}, model: "m" }).request.tool_choice, "required");
  assert.deepEqual(toOpenAI({ ...base, tool_choice: { type: "tool", name: "Read" } }, { quirks: {}, model: "m" }).request.tool_choice, { type: "function", function: { name: "Read" } });
  const r = toOpenAI({ ...base, tool_choice: { type: "auto", disable_parallel_tool_use: true } }, { quirks: {}, model: "m" }).request;
  assert.equal(r.parallel_tool_calls, false);
  assert.equal(r.tool_choice, undefined);
});

test("long MCP tool names are shortened and mapped back", () => {
  const long = "mcp__some_really_long_server_name__and_an_even_longer_tool_name_here_ok";
  const safe = safeToolName(long);
  assert.ok(safe.length <= 64);
  assert.match(safe, /^[a-zA-Z0-9_-]+$/);
  assert.equal(safeToolName(long), safe, "deterministic");
  assert.equal(safeToolName("Read"), "Read");
  const { request, toolNames } = toOpenAI({ tools: [{ ...tool, name: long }], messages: [{ role: "user", content: "x" }] }, { quirks: {}, model: "m" });
  assert.equal(request.tools[0].function.name, safe);
  assert.equal(toolNames.get(safe), long);
});

test("provider quirks: Mistral ids, max_completion_tokens, reasoning echo, effort", () => {
  assert.match(alnum9("toolu_01ABCxyz"), /^[a-zA-Z0-9]{9}$/);
  assert.equal(alnum9("abcDEF123"), "abcDEF123");
  const body = {
    max_tokens: 50,
    thinking: { type: "enabled", budget_tokens: 20000 },
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }, { type: "tool_use", id: "toolu_01ABC", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01ABC", content: "ok" }] },
    ],
  };
  const m = toOpenAI(body, { quirks: { toolIdStyle: "alnum9" }, model: "m" }).request;
  assert.equal(m.messages[1].tool_calls[0].id, m.messages[2].tool_call_id);
  assert.match(m.messages[2].tool_call_id, /^[a-zA-Z0-9]{9}$/);
  assert.equal(m.messages[1].reasoning_content, undefined);
  const o = toOpenAI(body, { quirks: { maxTokensField: "max_completion_tokens", reasoning: "effort", echoReasoning: true }, model: "m" }).request;
  assert.equal(o.max_completion_tokens, 50);
  assert.equal(o.max_tokens, undefined);
  assert.equal(o.reasoning_effort, "high");
  assert.equal(o.messages[1].reasoning_content, "hmm");
  const r = toOpenAI(body, { quirks: { reasoning: "openrouter" }, model: "m", effort: "low" }).request;
  assert.deepEqual(r.reasoning, { effort: "low" });
  const off = toOpenAI(body, { quirks: { reasoning: "effort" }, model: "m", effort: "off" }).request;
  assert.equal(off.reasoning_effort, undefined);
});

test("effort resolution", () => {
  assert.equal(resolveEffort({}, undefined), undefined);
  assert.equal(resolveEffort({ thinking: { type: "enabled", budget_tokens: 1024 } }, "client"), "low");
  assert.equal(resolveEffort({ thinking: { type: "enabled", budget_tokens: 8000 } }), "medium");
  assert.equal(resolveEffort({ thinking: { type: "disabled" } }), "off");
  assert.equal(resolveEffort({ output_config: { effort: "max" } }), "high");
  assert.equal(resolveEffort({ thinking: { type: "enabled", budget_tokens: 1 } }, "high"), "high");
});

test("Gemini thought signatures are replayed, with a placeholder when unknown", () => {
  const sigs = new Map([["g1", { google: { thought_signature: "REAL" } }]]);
  const body = { messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "tool_use", id: "g1", name: "A", input: {} }, { type: "tool_use", id: "g2", name: "B", input: {} }] }, { role: "assistant", content: [{ type: "tool_use", id: "g3", name: "A", input: {} }] }] };
  const r = toOpenAI(body, { quirks: { thoughtSignatures: true }, model: "m", signatures: sigs }).request;
  assert.equal(r.messages[1].tool_calls[0].extra_content.google.thought_signature, "REAL");
  assert.equal(r.messages[1].tool_calls[1].extra_content, undefined);
  assert.equal(r.messages[2].tool_calls[0].extra_content.google.thought_signature, "skip_thought_signature_validator");
});

test("thinking blocks freeflow invented are removed before reaching Anthropic", () => {
  const body = { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: FF_SIGNATURE }, { type: "thinking", thinking: "y", signature: "real" }, { type: "text", text: "t" }] }] };
  const out = stripForeignThinking(body);
  assert.equal(out.messages[0].content.length, 2);
  assert.equal(out.messages[0].content[0].signature, "real");
});

test("token estimate is positive and grows with content", () => {
  const small = estimateTokens({ messages: [{ role: "user", content: "hi" }] });
  const big = estimateTokens({ messages: [{ role: "user", content: "hi".repeat(1000) }], tools: [tool] });
  assert.ok(small >= 1 && big > small * 100);
});

test("cleanSchema keeps structure and removes meta keys deeply", () => {
  assert.deepEqual(cleanSchema({ $schema: "x", type: "object", properties: { a: { $comment: "c", type: "array", items: [{ $id: "i", type: "string" }] } } }), { type: "object", properties: { a: { type: "array", items: [{ type: "string" }] } } });
});

// ------------------------------------------------------------------ responses

/** Run chunks through a translator and return events and the collapsed message. */
function run(chunks, opts = {}) {
  const tr = new StreamTranslator({ model: "claude-sonnet-4-6", inputEstimate: 9, ...opts });
  const events = [];
  for (const c of chunks) events.push(...tr.feed(c));
  events.push(...tr.end());
  return { events, msg: eventsToMessage(events), tr };
}
const ch = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });

test("text stream produces a well-formed Anthropic event sequence", () => {
  const { events, msg } = run([ch({ role: "assistant", content: "" }), ch({ content: "Hel" }), ch({ content: "lo" }), ch({}, "stop"), { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }]);
  assert.deepEqual(events.map((e) => e.type), ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.equal(events[0].message.usage.input_tokens, 9);
  assert.equal(msg.content[0].text, "Hello");
  assert.equal(msg.stop_reason, "end_turn");
  assert.deepEqual(msg.usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(msg.model, "claude-sonnet-4-6");
});

test("reasoning fields become a signed thinking block before the text", () => {
  const { msg } = run([ch({ reasoning_content: "step 1. " }), ch({ reasoning: "step 2." }), ch({ content: "answer" }), ch({}, "stop")]);
  assert.equal(msg.content[0].type, "thinking");
  assert.equal(msg.content[0].thinking, "step 1. step 2.");
  assert.equal(msg.content[0].signature, FF_SIGNATURE);
  assert.equal(msg.content[1].text, "answer");
});

test("<think> tags split across chunks are parsed", () => {
  const { msg } = run([ch({ content: "  <th" }), ch({ content: "ink>a</thi" }), ch({ content: "nk>" }), ch({ content: "\n\nreply" }), ch({}, "stop")]);
  assert.equal(msg.content[0].thinking, "a");
  assert.equal(msg.content[1].text, "reply");
});

test("text that merely mentions <think> later is left alone", () => {
  const { msg } = run([ch({ content: "Use the <think> tag like this" }), ch({}, "stop")]);
  assert.equal(msg.content.length, 1);
  assert.equal(msg.content[0].text, "Use the <think> tag like this");
});

test("unterminated <think> is flushed as thinking at the end", () => {
  const { msg } = run([ch({ content: "<think>still going </th" }), ch({}, "length")]);
  assert.equal(msg.content[0].thinking, "still going </th");
  assert.equal(msg.stop_reason, "max_tokens");
});

test("tool calls: split arguments, multiple calls, stop_reason tool_use even when finish says stop", () => {
  const { msg } = run([
    ch({ tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "" } }] }),
    ch({ tool_calls: [{ index: 0, function: { arguments: '{"file_path"' } }] }),
    ch({ tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] }),
    ch({ tool_calls: [{ index: 1, id: "c2", function: { name: "Bash", arguments: '{"command":"ls"}' } }] }),
    ch({}, "stop"),
  ]);
  assert.deepEqual(msg.content.map((b) => [b.type, b.id, b.name, b.input]), [
    ["tool_use", "c1", "Read", { file_path: "a" }],
    ["tool_use", "c2", "Bash", { command: "ls" }],
  ]);
  assert.equal(msg.stop_reason, "tool_use");
});

test("tool calls without index, and providers that reuse index 0", () => {
  const a = run([ch({ tool_calls: [{ id: "x1", function: { name: "A", arguments: "{}" } }] }), ch({ tool_calls: [{ id: "x2", function: { name: "B", arguments: '{"k":' } }] }), ch({ tool_calls: [{ function: { arguments: "1}" } }] })]).msg;
  assert.deepEqual(a.content.map((b) => [b.id, b.name, b.input]), [["x1", "A", {}], ["x2", "B", { k: 1 }]]);
  const b = run([ch({ tool_calls: [{ index: 0, id: "y1", function: { name: "A", arguments: "{}" } }] }), ch({ tool_calls: [{ index: 0, id: "y2", function: { name: "B", arguments: "{}" } }] })]).msg;
  assert.deepEqual(b.content.map((x) => x.id), ["y1", "y2"]);
});

test("tool names are restored and Gemini signatures captured", () => {
  const sigs = new Map();
  const { msg } = run([ch({ tool_calls: [{ index: 0, id: "g", function: { name: "short_abc", arguments: "{}" }, extra_content: { google: { thought_signature: "S" } } }] })], { toolNames: new Map([["short_abc", "mcp__original__name"]]), signatures: sigs });
  assert.equal(msg.content[0].name, "mcp__original__name");
  assert.deepEqual(sigs.get("g"), { google: { thought_signature: "S" } });
});

test("argument repair", () => {
  assert.deepEqual(parseArgs(""), {});
  assert.deepEqual(parseArgs('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseArgs('{"a":1} trailing'), { a: 1 });
  assert.deepEqual(parseArgs("[1]"), { value: [1] });
  assert.deepEqual(parseArgs("{oops"), { _unparsed_arguments: "{oops" });
});

test("cached prompt tokens are reported as cache reads", () => {
  const { msg } = run([ch({ content: "x" }, "stop"), { choices: [], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 80 } } }]);
  assert.deepEqual(msg.usage, { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 80 });
});

test("a non-streaming response object goes through the same path", () => {
  const { msg } = run([{ choices: [{ message: { role: "assistant", content: "<think>r</think>done", tool_calls: [{ id: "n1", type: "function", function: { name: "A", arguments: '{"q":2}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 5 } }]);
  assert.deepEqual(msg.content.map((b) => b.type), ["thinking", "text", "tool_use"]);
  assert.equal(msg.stop_reason, "tool_use");
});

test("block indexes are sequential and every started block is stopped", () => {
  const { events } = run([ch({ reasoning_content: "r" }), ch({ content: "t" }), ch({ tool_calls: [{ index: 0, id: "a", function: { name: "A", arguments: "{}" } }] }), ch({}, "tool_calls")]);
  const starts = events.filter((e) => e.type === "content_block_start").map((e) => e.index);
  const stops = events.filter((e) => e.type === "content_block_stop").map((e) => e.index);
  assert.deepEqual(starts, [0, 1, 2]);
  assert.deepEqual(stops, [0, 1, 2]);
  for (const e of events.filter((e) => e.type === "content_block_delta")) {
    const open = starts.filter((s) => s <= e.index).length - stops.filter((s) => s < e.index).length;
    assert.ok(open >= 1);
  }
});
