import { test } from "node:test";
import assert from "node:assert/strict";
import { Health, plan, tierOf, healthKey } from "../src/router.js";
import { UpstreamError, classify, parseRetryAfter, errorText, sse, REPAIRS } from "../src/upstream.js";
import { parseModelRef, PROVIDERS, getProvider } from "../src/catalog.js";
import { resolveProvider, maskKey, defaults } from "../src/config.js";

function cfg(extra = {}) {
  return {
    ...defaults(),
    custom: [{ id: "a", name: "A", baseUrl: "http://a" }, { id: "b", name: "B", baseUrl: "http://b" }, { id: "c", name: "C", baseUrl: "http://c" }],
    providers: {},
    ...extra,
  };
}

test("catalog: unique ids, https bases (except local), every non-local provider has a key variable", () => {
  const ids = new Set();
  for (const p of PROVIDERS) {
    assert.ok(!ids.has(p.id), `duplicate ${p.id}`);
    ids.add(p.id);
    assert.match(p.id, /^[a-z0-9-]+$/);
    if (p.tier === "local") assert.match(p.base, /^http:\/\/localhost/);
    else if (p.base) assert.match(p.base, /^https:\/\//);
    if (p.tier !== "local") assert.ok(p.env, `${p.id} env`);
  }
  assert.equal(PROVIDERS.length, 58);
});

test("model refs split at the first slash only", () => {
  assert.deepEqual(parseModelRef("openrouter/meta-llama/llama-3:free"), { provider: "openrouter", model: "meta-llama/llama-3:free" });
  assert.equal(parseModelRef("claude-sonnet-4-6"), null);
  assert.equal(parseModelRef("/x"), null);
  assert.equal(parseModelRef("x/"), null);
});

test("tiers are detected from Claude model names", () => {
  assert.equal(tierOf("claude-opus-4-7"), "opus");
  assert.equal(tierOf("claude-3-5-haiku-latest"), "haiku");
  assert.equal(tierOf("claude-sonnet-4-6[1m]"), "sonnet");
  assert.equal(tierOf("gpt-4o"), null);
});

test("provider resolution: config key wins over env; cloudflare needs an account; masking", () => {
  process.env.GROQ_API_KEY = "env-key-123456";
  const c = cfg({ providers: { cloudflare: { key: "cf" } } });
  assert.equal(resolveProvider(c, "groq").key, "env-key-123456");
  assert.equal(resolveProvider(c, "groq").keySource, "env:GROQ_API_KEY");
  c.providers.groq = { key: "cfg-key-abcdef" };
  assert.equal(resolveProvider(c, "groq").key, "cfg-key-abcdef");
  delete process.env.GROQ_API_KEY;
  assert.equal(resolveProvider(c, "cloudflare").ready, false);
  c.providers.cloudflare.accountId = "acc1";
  assert.equal(resolveProvider(c, "cloudflare").baseUrl, "https://api.cloudflare.com/client/v4/accounts/acc1/ai/v1");
  assert.equal(resolveProvider(c, "ollama").ready, true, "local needs no key");
  assert.equal(resolveProvider(c, "nvidia").ready, false);
  assert.equal(resolveProvider(c, "nope"), null);
  assert.equal(maskKey("sk-1234567890abcd"), "sk-1…abcd");
  assert.equal(maskKey("short"), "••••");
  assert.equal(getProvider("anthropic").format, "anthropic");
});

test("plan: tier route, then default, then fallbacks, deduplicated; unready ones skipped", () => {
  const c = cfg({ routes: { default: { model: "a/one" }, opus: { model: "b/big" } }, fallbacks: [{ model: "c/x" }, { model: "a/one" }, { model: "nvidia/y" }] });
  const h = new Health();
  const p = plan(c, "claude-opus-4-7", h);
  assert.deepEqual(p.candidates.map((x) => x.ref), ["b/big", "a/one", "c/x"]);
  assert.equal(p.skipped[0], "nvidia/y (no key)");
  assert.deepEqual(plan(c, "claude-haiku", h).candidates.map((x) => x.ref), ["a/one", "c/x"]);
  assert.deepEqual(plan(c, "c/direct", h).candidates.map((x) => x.ref), ["c/direct", "a/one", "c/x"]);
  assert.deepEqual(plan(cfg(), "anything", h).candidates, []);
});

test("cooldown moves a provider to the back and recovers", () => {
  const c = cfg({ routes: { default: { model: "a/one" } }, fallbacks: [{ model: "b/two" }, { model: "c/three" }] });
  const h = new Health();
  h.fail("a", new UpstreamError("429", { kind: "rate", retryAfterMs: 5000 }));
  h.fail("b", new UpstreamError("down", { kind: "transient" }));
  const order = plan(c, "x", h).candidates.map((x) => x.ref);
  assert.deepEqual(order, ["c/three", "a/one", "b/two"], "cooling last, soonest recovery first (a: 5s retry-after, b: 10s backoff)");
  h.ok("a");
  assert.equal(plan(c, "x", h).candidates[0].ref, "a/one");
});

test("health: backoff grows, request errors never cool, retry-after respected", () => {
  const h = new Health();
  const now = 1_000_000;
  h.fail("p", new UpstreamError("x", { kind: "transient" }), now);
  const first = h.remaining("p", now);
  h.fail("p", new UpstreamError("x", { kind: "transient" }), now);
  assert.ok(h.remaining("p", now) > first);
  h.fail("q", new UpstreamError("bad", { kind: "request" }), now);
  assert.equal(h.isCooling("q", now), false);
  h.fail("r", new UpstreamError("rl", { kind: "rate", retryAfterMs: 42_000 }), now);
  assert.equal(h.remaining("r", now), 42_000);
  assert.equal(healthKey("p", "p/m", "model"), "p/m");
  assert.equal(healthKey("p", "p/m", "rate"), "p");
  assert.equal(h.snapshot(now).length, 2);
});

test("error classification", () => {
  assert.equal(classify(401, ""), "auth");
  assert.equal(classify(429, ""), "rate");
  assert.equal(classify(503, ""), "transient");
  assert.equal(classify(404, ""), "model");
  assert.equal(classify(400, "The model `x` does not exist"), "model");
  assert.equal(classify(400, "RESOURCE_EXHAUSTED: quota"), "rate");
  assert.equal(classify(400, "messages: field required"), "request");
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(errorText('{"error":{"message":"nope"}}'), "nope");
  assert.equal(errorText('[{"error":{"message":"gemini style"}}]'), "gemini style");
  assert.equal(errorText("<html> bad gateway </html>"), "<html> bad gateway </html>");
});

test("repairs only fire on the parameter that was named", () => {
  const find = (msg) => REPAIRS.find((r) => r.match.test(msg))?.param;
  assert.equal(find("Unrecognized request argument supplied: stream_options"), "stream_options");
  assert.equal(find("'reasoning_effort' is not supported with this model"), "reasoning_effort");
  assert.equal(find("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), "max_tokens");
  assert.equal(find("property 'reasoning_content' is unsupported"), "reasoning_content");
  assert.equal(find("prompt is too long"), undefined);
});

test("SSE parser: CRLF, comments, multi-line data, missing final blank line, [DONE]", async () => {
  const text = ': keepalive\r\n\r\ndata: {"a":1}\r\n\r\ndata: {"b":\ndata: 2}\n\nevent: x\ndata:{"c":3}\n\ndata: [DONE]\n\ndata: {"never":1}\n\n';
  const body = new Blob([text]).stream();
  const out = [];
  for await (const j of sse(body, 1000)) out.push(j);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  const tail = [];
  for await (const j of sse(new Blob(['data: {"z":9}']).stream(), 1000)) tail.push(j);
  assert.deepEqual(tail, [{ z: 9 }]);
});

test("SSE parser: in-stream errors are thrown and classified", async () => {
  await assert.rejects(async () => {
    for await (const _ of sse(new Blob(['data: {"error":{"message":"quota exceeded","code":429}}\n\n']).stream(), 1000));
  }, (e) => e instanceof UpstreamError && e.kind === "rate");
});
