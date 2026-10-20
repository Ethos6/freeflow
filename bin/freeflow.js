#!/usr/bin/env node
// @ts-check
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, resolveProvider, homeDir, configPath } from "../src/config.js";
import { PROVIDERS, parseModelRef } from "../src/catalog.js";

const SELF = fileURLToPath(import.meta.url);
const [cmd = "help", ...rest] = process.argv.slice(2);
const isWin = process.platform === "win32";

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { g: (/** @type {string} */ s) => `\x1b[32m${s}\x1b[0m`, y: (/** @type {string} */ s) => `\x1b[33m${s}\x1b[0m`, r: (/** @type {string} */ s) => `\x1b[31m${s}\x1b[0m`, d: (/** @type {string} */ s) => `\x1b[2m${s}\x1b[0m`, b: (/** @type {string} */ s) => `\x1b[1m${s}\x1b[0m` }
  : { g: String, y: String, r: String, d: String, b: String };

/** @param {string} msg */
function die(msg) {
  console.error(c.r("freeflow: ") + msg);
  process.exit(1);
}

/** @param {string[]} args @param {string} name */
function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
/** @param {string[]} args @param {string} name */
function bool(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function baseUrl() {
  const cfg = loadConfig();
  const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${cfg.port}`;
}

async function health() {
  try {
    const r = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j.name === "freeflow" ? j : { foreign: true };
  } catch {
    return null;
  }
}

/** Start the server in the background unless it is already running. */
async function ensureServer() {
  const h = await health();
  if (h && !("foreign" in h)) return;
  if (h) die(`port ${loadConfig().port} is used by another program. Set another port with: freeflow config port <number>`);
  fs.mkdirSync(homeDir(), { recursive: true });
  const logFile = path.join(homeDir(), "server.log");
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [SELF, "start", "--no-open"], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await health()) return;
  }
  die(`the server did not start; see ${logFile}`);
}

function token() {
  return loadConfig().proxyToken || "freeflow";
}

/** @param {string} url */
function openBrowser(url) {
  const [bin, args] = process.platform === "darwin" ? ["open", [url]] : isWin ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(bin, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* no browser available */
  }
}

/**
 * Run an agent with freeflow's environment and exit with its code.
 * @param {string} bin @param {string[]} args @param {Record<string,string|undefined>} env @param {string} install
 */
function runAgent(bin, args, env, install) {
  // With shell:true Windows never reports a missing command, so look it up first.
  if (isWin && spawnSync("where", [bin], { stdio: "ignore" }).status !== 0) die(`"${bin}" is not installed. Install it with:\n  ${install}`);
  const merged = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  // npm installs agents as .cmd shims on Windows, which need a shell; quote args ourselves.
  const winArgs = args.map((a) => (/^[\w\-./:=@]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`));
  const child = spawn(bin, isWin ? winArgs : args, { stdio: "inherit", env: merged, shell: isWin });
  child.on("error", (e) => {
    if (/** @type {any} */ (e).code === "ENOENT") die(`"${bin}" is not installed. Install it with:\n  ${install}`);
    die(e.message);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

function warnIfNoRoute() {
  const cfg = loadConfig();
  if (!cfg.routes.default?.model) console.error(c.y("freeflow: no default model is set yet. Open ") + baseUrl() + c.y(" to add a provider and pick a model."));
}

const commands = {
  async start() {
    const args = [...rest];
    const port = flag(args, "--port");
    const host = flag(args, "--host");
    const noOpen = bool(args, "--no-open");
    const { startServer } = await import("../src/server.js");
    let started;
    try {
      started = await startServer({ port: port ? Number(port) : undefined, host });
    } catch (e) {
      if (/** @type {any} */ (e).code === "EADDRINUSE") {
        const h = await health();
        die(h && !("foreign" in h) ? `already running at ${baseUrl()}` : `port ${port || loadConfig().port} is in use by another program`);
      }
      throw e;
    }
    const { server, app } = started;
    const url = `http://${started.host === "0.0.0.0" ? "127.0.0.1" : started.host}:${started.port}`;
    const cfg = app.config;
    console.log(`${c.g("●")} ${c.b("freeflow")} is running at ${c.b(url)}`);
    console.log(c.d(`  admin:   ${url}`));
    console.log(c.d(`  config:  ${configPath()}`));
    console.log(c.d(`  default: ${cfg.routes.default?.model || "(not set: open the admin page)"}`));
    if (!noOpen && process.stdout.isTTY && !process.env.CI) openBrowser(url);
    const stop = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  },

  async claude() {
    await ensureServer();
    warnIfNoRoute();
    runAgent("claude", rest, { ANTHROPIC_BASE_URL: baseUrl(), ANTHROPIC_AUTH_TOKEN: token(), ANTHROPIC_API_KEY: undefined }, "npm install -g @anthropic-ai/claude-code");
  },

  async opencode() {
    await ensureServer();
    warnIfNoRoute();
    const cfg = loadConfig();
    /** @type {Record<string, {name: string}>} */
    const models = { default: { name: "freeflow default route" } };
    for (const r of [...Object.values(cfg.routes), ...cfg.fallbacks]) if (r?.model) models[r.model] = { name: r.model };
    const content = {
      $schema: "https://opencode.ai/config.json",
      provider: { freeflow: { npm: "@ai-sdk/openai-compatible", name: "freeflow", options: { baseURL: `${baseUrl()}/v1`, apiKey: token() }, models } },
      model: "freeflow/default",
    };
    runAgent("opencode", rest, { OPENCODE_CONFIG_CONTENT: JSON.stringify(content) }, "npm install -g opencode-ai");
  },

  async aider() {
    await ensureServer();
    warnIfNoRoute();
    const args = rest.includes("--model") ? rest : ["--model", "openai/default", "--no-show-model-warnings", ...rest];
    runAgent("aider", args, { OPENAI_API_BASE: `${baseUrl()}/v1`, OPENAI_API_KEY: token() }, "python -m pip install aider-install && aider-install");
  },

  async env() {
    const args = [...rest];
    const shell = flag(args, "--shell") || (isWin ? "powershell" : "sh");
    const vars = {
      ANTHROPIC_BASE_URL: baseUrl(),
      ANTHROPIC_AUTH_TOKEN: token(),
      OPENAI_BASE_URL: `${baseUrl()}/v1`,
      OPENAI_API_BASE: `${baseUrl()}/v1`,
      OPENAI_API_KEY: token(),
    };
    for (const [k, v] of Object.entries(vars)) {
      if (shell === "powershell") console.log(`$env:${k} = "${v}"`);
      else if (shell === "cmd") console.log(`set ${k}=${v}`);
      else if (shell === "fish") console.log(`set -gx ${k} "${v}"`);
      else console.log(`export ${k}="${v}"`);
    }
    if (process.stdout.isTTY) console.error(c.d(`\n# Apply with: eval "$(freeflow env)"   (PowerShell: freeflow env | Invoke-Expression)\n# OpenAI-style clients: use model "default", or any provider/model.`));
  },

  async status() {
    const h = await health();
    if (!h || "foreign" in h) {
      console.log(`${c.d("○")} freeflow is not running ${c.d(`(${baseUrl()})`)}`);
      return;
    }
    const cfg = loadConfig();
    const r = await fetch(`${baseUrl()}/admin/api/state`, { headers: { "x-freeflow-admin": cfg.adminToken } });
    const s = await r.json();
    const ready = s.providers.filter((/** @type {any} */ p) => p.ready);
    console.log(`${c.g("●")} freeflow ${s.version} at ${baseUrl()}`);
    console.log(`  providers ready: ${ready.map((/** @type {any} */ p) => p.id).join(", ") || "none"}`);
    for (const [k, v] of Object.entries(s.routes)) console.log(`  ${k.padEnd(8)} ${/** @type {any} */ (v).model}`);
    s.fallbacks.forEach((/** @type {any} */ f, /** @type {number} */ i) => console.log(`  ${`fb ${i + 1}`.padEnd(8)} ${f.model}`));
    for (const h of s.health) console.log(c.y(`  cooling  ${h.key} for ${h.secondsLeft}s: ${h.reason}`));
    console.log(`  requests this session: ${s.activity.length}`);
  },

  async stop() {
    const h = await health();
    if (!h || "foreign" in h) return console.log("freeflow is not running");
    await fetch(`${baseUrl()}/admin/api/shutdown`, { method: "POST", headers: { "x-freeflow-admin": loadConfig().adminToken } }).catch(() => {});
    console.log("freeflow stopped");
  },

  async open() {
    await ensureServer();
    openBrowser(baseUrl());
    console.log(baseUrl());
  },

  async providers() {
    const cfg = loadConfig();
    const only = rest[0];
    const groups = /** @type {const} */ (["free", "plan", "paid", "local"]);
    const names = { free: "Free tiers and free models", plan: "Subscriptions and coding plans", paid: "Pay as you go", local: "Local" };
    for (const g of groups) {
      if (only && only !== g) continue;
      console.log(c.b(`\n${names[g]}`));
      for (const p of PROVIDERS.filter((x) => x.tier === g)) {
        const r = resolveProvider(cfg, p.id);
        const mark = r?.ready ? c.g("✓") : " ";
        console.log(` ${mark} ${p.id.padEnd(18)} ${p.name.padEnd(28)} ${c.d(p.env || "")}`);
      }
    }
    for (const cp of cfg.custom) console.log(` ${resolveProvider(cfg, cp.id)?.ready ? c.g("✓") : " "} ${cp.id.padEnd(18)} ${cp.name} ${c.d("(custom)")}`);
    console.log(c.d(`\n✓ = ready. Keys can come from the admin page, "freeflow key <id>", or the environment variable shown.`));
  },

  async key() {
    const [id, value] = rest;
    if (!id) die("usage: freeflow key <provider> [key]   (omit the key to read it from stdin)");
    const cfg = loadConfig();
    if (!resolveProvider(cfg, id)) die(`unknown provider "${id}". See: freeflow providers`);
    let key = value;
    if (!key) {
      if (process.stdin.isTTY) process.stderr.write(`Paste the ${id} key and press Enter: `);
      key = await new Promise((resolve) => {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (d) => {
          buf += d;
          if (buf.includes("\n")) {
            process.stdin.pause();
            resolve(buf.split("\n")[0]);
          }
        });
        process.stdin.on("end", () => resolve(buf));
      });
    }
    key = String(key).trim();
    if (key) (cfg.providers[id] ||= {}).key = key;
    else if (cfg.providers[id]) delete cfg.providers[id].key;
    saveConfig(cfg);
    console.log(key ? `${c.g("✓")} saved the ${id} key` : `removed the ${id} key`);
  },

  async use() {
    const args = [...rest];
    const tier = flag(args, "--tier") || "default";
    const effort = flag(args, "--effort");
    const model = args[0];
    if (!["default", "opus", "sonnet", "haiku", "fable"].includes(tier)) die("--tier must be default, opus, sonnet, haiku or fable");
    const cfg = loadConfig();
    if (!model) die("usage: freeflow use <provider/model> [--tier sonnet] [--effort low|medium|high|off]");
    if (model === "none") delete cfg.routes[/** @type {"default"} */ (tier)];
    else {
      const ref = parseModelRef(model);
      if (!ref || !resolveProvider(cfg, ref.provider)) die(`"${model}" is not provider/model with a known provider`);
      cfg.routes[/** @type {"default"} */ (tier)] = effort ? { model, effort: /** @type {any} */ (effort) } : { model };
    }
    saveConfig(cfg);
    console.log(`${c.g("✓")} ${tier} → ${model}`);
  },

  async fallback() {
    const [sub, model] = rest;
    const cfg = loadConfig();
    if (sub === "add") {
      const ref = model && parseModelRef(model);
      if (!ref || !resolveProvider(cfg, ref.provider)) die("usage: freeflow fallback add <provider/model>");
      if (!cfg.fallbacks.some((f) => f.model === model)) cfg.fallbacks.push({ model });
    } else if (sub === "rm" || sub === "remove") cfg.fallbacks = cfg.fallbacks.filter((f) => f.model !== model);
    else if (sub === "clear") cfg.fallbacks = [];
    else if (sub && sub !== "list") die("usage: freeflow fallback [list|add <model>|rm <model>|clear]");
    saveConfig(cfg);
    if (!cfg.fallbacks.length) console.log("no fallbacks");
    cfg.fallbacks.forEach((f, i) => console.log(`${i + 1}. ${f.model}`));
  },

  async models() {
    const id = rest[0];
    if (!id) die("usage: freeflow models <provider>");
    await ensureServer();
    const r = await fetch(`${baseUrl()}/admin/api/models?provider=${encodeURIComponent(id)}&refresh=1`, { headers: { "x-freeflow-admin": loadConfig().adminToken } });
    const j = await r.json();
    if (!r.ok) die(j.error);
    for (const m of j.models) console.log(`${id}/${m}`);
  },

  async doctor() {
    await ensureServer();
    const cfg = loadConfig();
    const refs = [...new Set([...Object.values(cfg.routes), ...cfg.fallbacks].map((r) => r?.model).filter(Boolean))];
    if (!refs.length) die("no models configured yet; open the admin page or use: freeflow use <provider/model>");
    let bad = 0;
    for (const model of refs) {
      const r = await fetch(`${baseUrl()}/admin/api/test`, { method: "POST", headers: { "x-freeflow-admin": cfg.adminToken, "content-type": "application/json" }, body: JSON.stringify({ model }) });
      const j = await r.json();
      if (j.ok) console.log(`${c.g("✓")} ${model} ${c.d(`${j.ms} ms`)}`);
      else {
        bad++;
        console.log(`${c.r("✗")} ${model} ${c.d(`${j.kind || "error"}: ${j.error}`)}`);
      }
    }
    process.exit(bad ? 1 : 0);
  },

  async config() {
    const [key, value] = rest;
    const cfg = loadConfig();
    if (key === "port" && value) cfg.port = Number(value);
    else if (key === "host" && value) cfg.host = value;
    else if (key === "path") return console.log(configPath());
    else die("usage: freeflow config port <number> | host <address> | path");
    saveConfig(cfg);
    console.log(`${c.g("✓")} ${key} = ${value} (restart freeflow to apply)`);
  },

  async version() {
    const { VERSION } = await import("../src/server.js");
    console.log(VERSION);
  },

  async help() {
    console.log(`${c.b("freeflow")}: one local gateway, 58 model providers, any coding agent.

${c.b("Run an agent")} ${c.d("(starts freeflow in the background if needed)")}
  freeflow claude [args]        Claude Code
  freeflow opencode [args]      OpenCode
  freeflow aider [args]         Aider
  eval "$(freeflow env)"        any other tool: sets Anthropic and OpenAI base URLs

${c.b("Set up")}
  freeflow open                 open the admin page (keys, models, fallbacks, live activity)
  freeflow providers [free]     list providers; ✓ marks the ready ones
  freeflow key <provider>       save a key (read from stdin)
  freeflow use <p/model> [--tier opus|sonnet|haiku|fable] [--effort low|medium|high|off]
  freeflow fallback add <p/model> | rm <p/model> | list | clear
  freeflow models <provider>    list a provider's models
  freeflow doctor               send a tiny request to every configured model

${c.b("Server")}
  freeflow start [--port N] [--host H] [--no-open]
  freeflow status | stop | version
  freeflow config port <N> | host <addr> | path

Docs: https://github.com/Ethos6/freeflow`);
  },
};

const fn = /** @type {Record<string, () => Promise<any>>} */ (commands)[cmd] || (["-h", "--help"].includes(cmd) ? commands.help : ["-v", "--version"].includes(cmd) ? commands.version : null);
if (!fn) die(`unknown command "${cmd}". Run: freeflow help`);
fn().catch((/** @type {any} */ e) => die(e?.message || String(e)));
