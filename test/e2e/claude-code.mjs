// End-to-end: the real Claude Code CLI, launched with `freeflow claude`, completes a
// task that needs a tool call, against a scripted OpenAI-compatible provider.
//
// The first provider in the chain is rate limited, so the run also proves fallback.
// Requires the `claude` CLI on PATH (npm install -g @anthropic-ai/claude-code).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const log = (...a) => console.log("[e2e]", ...a);
const seen = [];

// ---- scripted provider: asks for a Write tool call, then reports success
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    seen.push({ model: j.model, tools: (j.tools || []).map((t) => t.function.name), last: j.messages?.at(-1)?.role });
    if (j.model === "limited") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
      return res.end(JSON.stringify({ error: { message: "free tier limit reached" } }));
    }
    const hasWrite = (j.tools || []).some((t) => t.function.name === "Write");
    const toolDone = j.messages?.some((m) => m.role === "tool");
    const send = (chunks) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    };
    const d = (delta, finish = null) => ({ id: "e", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
    if (hasWrite && !toolDone) {
      const file = path.join(work, "hello.txt");
      return send([
        d({ role: "assistant", reasoning_content: "The user wants a file. I will write it." }),
        d({ content: "Creating the file now." }),
        d({ tool_calls: [{ index: 0, id: "call_write_1", type: "function", function: { name: "Write", arguments: "" } }] }),
        d({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: file, content: "written through freeflow\n" }).slice(0, 25) } }] }),
        d({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: file, content: "written through freeflow\n" }).slice(25) } }] }),
        d({}, "tool_calls"),
        { id: "e", choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40 } },
      ]);
    }
    send([d({ content: toolDone ? "FREEFLOW_E2E_DONE: hello.txt was created." : "ok" }), d({}, "stop"), { id: "e", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;

// ---- isolated freeflow home and workspace
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-e2e-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ff-e2e-work-"));
const port = await new Promise((r) => {
  const s = http.createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({
    port,
    custom: [{ id: "free1", name: "Free one", baseUrl: providerUrl }, { id: "free2", name: "Free two", baseUrl: providerUrl }],
    routes: { default: { model: "free1/limited" } },
    fallbacks: [{ model: "free2/coder" }],
  }),
);
const env = { ...process.env, FREEFLOW_HOME: home, E2E_DIR: work, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "ff-e2e-userhome-")), CI: "1" };
delete env.ANTHROPIC_API_KEY;

let code = 1;
try {
  log("claude", execFileSync("claude", ["--version"], { encoding: "utf8" }).trim());
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bin/freeflow.js"), "claude", "-p", "Create hello.txt in the current directory.", "--output-format", "json", "--permission-mode", "acceptEdits"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => { child.kill(); reject(new Error(`timed out\n${stdout}\n${stderr}`)); }, 180_000);
    child.on("exit", (c) => { clearTimeout(t); resolve({ c, stdout, stderr }); });
  });
  log("exit", out.c);
  if (out.stderr.trim()) log("stderr:", out.stderr.trim().slice(0, 800));
  const result = JSON.parse(out.stdout.trim().split("\n").at(-1));
  log("result:", result.result);
  const file = path.join(work, "hello.txt");
  const checks = {
    "claude exited 0": out.c === 0,
    "result is not an error": result.is_error === false,
    "final answer came from the provider": /FREEFLOW_E2E_DONE/.test(result.result || ""),
    "the Write tool really created the file": fs.existsSync(file) && fs.readFileSync(file, "utf8") === "written through freeflow\n",
    "rate-limited free1 was tried": seen.some((s) => s.model === "limited"),
    "fallback free2 served the turn": seen.some((s) => s.model === "coder" && s.tools.includes("Write")),
    "tool result was sent back": seen.some((s) => s.last === "tool"),
  };
  for (const [k, v] of Object.entries(checks)) log(v ? "PASS" : "FAIL", k);
  // Phase 2: pick a model directly, as `/model` or `--model` would.
  seen.length = 0;
  const direct = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bin/freeflow.js"), "claude", "-p", "Say hi.", "--model", "free2/direct-pick", "--output-format", "json"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", (c) => resolve({ c, stdout }));
  });
  checks["--model provider/model is honoured"] = direct.c === 0 && seen.length > 0 && seen.every((s) => s.model === "direct-pick" || s.model === "coder" || s.model === "limited") && seen.some((s) => s.model === "direct-pick");
  log("phase 2 models seen:", [...new Set(seen.map((s) => s.model))].join(", "));
  log(checks["--model provider/model is honoured"] ? "PASS" : "FAIL", "--model provider/model is honoured");
  code = Object.values(checks).every(Boolean) ? 0 : 1;
  const st = await fetch(`http://127.0.0.1:${port}/admin/api/state`, { headers: { "x-freeflow-admin": JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).adminToken } }).then((r) => r.json());
  log(`gateway saw ${st.activity.length} request(s); ${st.activity.filter((a) => a.attempts.some((x) => x.error)).length} rescued by fallback`);
} catch (e) {
  console.error(e);
} finally {
  await fetch(`http://127.0.0.1:${port}/admin/api/shutdown`, { method: "POST", headers: { "x-freeflow-admin": JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).adminToken } }).catch(() => {});
  provider.close();
  provider.closeAllConnections?.();
}
log(code === 0 ? "ALL CHECKS PASSED" : "FAILED");
process.exit(code);
