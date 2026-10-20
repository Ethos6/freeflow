// A fake provider for tests. The model name picks the behaviour.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** @param {any} obj */
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta, extra = {}) => ({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const finish = (reason) => ({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usage = (p, c, cached) => ({ id: "c1", choices: [], usage: { prompt_tokens: p, completion_tokens: c, ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}) } });

export const SCENARIOS = {
  ok: [chunk({ role: "assistant", content: "" }), chunk({ content: "Hello" }), chunk({ content: " world" }), finish("stop"), usage(10, 2)],
  cached: [chunk({ content: "hi" }), finish("stop"), usage(100, 1, 60)],
  reason: [chunk({ reasoning_content: "Let me think." }), chunk({ content: "Answer." }), finish("stop"), usage(5, 5)],
  think: [chunk({ content: "<thi" }), chunk({ content: "nk>plan it</th" }), chunk({ content: "ink>\n\nDone" }), finish("stop")],
  tools: [
    chunk({ content: "Reading." }),
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"file_' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'path":"a.txt"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }] }),
    finish("tool_calls"),
    usage(50, 20),
  ],
  noindex: [
    chunk({ tool_calls: [{ id: "a1", type: "function", function: { name: "Read", arguments: '{"file_path":"x"}' } }] }),
    chunk({ tool_calls: [{ id: "a2", type: "function", function: { name: "Read", arguments: '{"file_path":"y"}' } }] }),
    finish("stop"),
  ],
  longname: [chunk({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "__LONG__", arguments: "{}" } }] }), finish("tool_calls")],
  signature: [chunk({ tool_calls: [{ index: 0, id: "g1", type: "function", function: { name: "Read", arguments: "{}" }, extra_content: { google: { thought_signature: "SIG123" } } }] }), finish("tool_calls")],
  length: [chunk({ content: "cut" }), finish("length")],
};

/**
 * @param {object} [opts]
 * @returns {Promise<{url: string, requests: any[], close: () => Promise<void>, server: http.Server}>}
 */
export async function startMock(opts = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const j = body ? JSON.parse(body) : {};
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: j });
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "ok" }, { id: "tools" }, { id: "models/gem" }] }));
      }
      if (req.url.endsWith("/v1/messages")) return anthropic(j, req, res);
      const model = String(j.model || "");
      if (model === "rate") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
        return res.end(JSON.stringify({ error: { message: "Rate limit reached for requests" } }));
      }
      if (model === "down") {
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "upstream overloaded" } }));
      }
      if (model === "authbad") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
      }
      if (model === "badreq") {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "prompt is too long for this model" } }));
      }
      if (model === "picky" && j.stream_options) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options" } }));
      }
      if (model === "hang") return; // never answers
      if (model === "json" || !j.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        const msg = model === "jsontools"
          ? { role: "assistant", content: null, tool_calls: [{ id: "j1", type: "function", function: { name: "Read", arguments: '{"file_path":"z"}' } }] }
          : { role: "assistant", content: "Plain JSON reply" };
        return res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3 } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (model === "empty") return res.end("data: [DONE]\n\n");
      if (model === "slow") {
        // 100 chunks over ~2s; records whether freeflow hung up early
        const rec = { closedEarly: false, sent: 0 };
        mock.slow.push(rec);
        let i = 0;
        const t = setInterval(() => {
          if (i++ >= 100) {
            clearInterval(t);
            return res.end("data: [DONE]\n\n");
          }
          rec.sent++;
          res.write(sse(chunk({ content: "x" })));
        }, 20);
        res.on("close", () => {
          clearInterval(t);
          if (i < 100) rec.closedEarly = true;
        });
        return;
      }
      if (model === "stall") {
        res.write(sse(chunk({ content: "first" })));
        const rec = { closed: false };
        mock.slow.push(rec);
        res.on("close", () => (rec.closed = true));
        return; // never sends more
      }
      if (model === "midfail") {
        res.write(sse(chunk({ content: "partial" })));
        return setTimeout(() => res.destroy(), 20);
      }
      if (model === "streamerror") {
        res.write(sse({ error: { message: "quota exceeded", code: 429 } }));
        return res.end();
      }
      let events = SCENARIOS[model] || SCENARIOS.ok;
      if (model === "longname") {
        const name = j.tools?.[0]?.function?.name || "x";
        events = JSON.parse(JSON.stringify(events).replace("__LONG__", name));
      }
      for (const e of events) res.write(sse(e));
      res.end("data: [DONE]\n\n");
    });
  });

  /** A fake Anthropic API: echoes what it received so tests can inspect it. */
  function anthropic(j, req, res) {
    if (req.headers["x-api-key"] !== "sk-ant-test") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_native", type: "message", role: "assistant", model: j.model, content: [{ type: "text", text: `native:${j.messages.length}` }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const mock = {
    url,
    requests,
    server,
    slow: [],
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
  return mock;
}

/** Fresh FREEFLOW_HOME with a config pointing custom providers at the mock. */
export function tempHome(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freeflow-test-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ adminToken: "admintoken", ...config }, null, 2));
  process.env.FREEFLOW_HOME = dir;
  return dir;
}

/** Parse an SSE response body into events. */
export function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((b) => {
      const ev = b.match(/^event: (.*)$/m)?.[1];
      const data = JSON.parse(b.slice(b.indexOf("data: ") + 6));
      return { event: ev, ...data };
    });
}
