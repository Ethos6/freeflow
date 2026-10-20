// @ts-check
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, resolveProvider, allProviderIds, maskKey } from "./config.js";
import { PROVIDERS, getProvider, parseModelRef } from "./catalog.js";
import { Health, plan, healthKey, tierOf } from "./router.js";
import { toOpenAI, stripForeignThinking, estimateTokens, alnum9 } from "./translate/request.js";
import { StreamTranslator, eventsToMessage } from "./translate/response.js";
import { UpstreamError, chatCompletions, openChat, post, listModels, errorText, classify, parseRetryAfter, learnedRepairs, pipeBody } from "./upstream.js";

export const VERSION = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;
const ADMIN_HTML = fileURLToPath(new URL("./admin/ui.html", import.meta.url));
const MAX_BODY = 64 * 1024 * 1024;
const SIGNATURE_CACHE = 5000;

/**
 * @typedef {object} Attempt
 * @property {string} ref
 * @property {string} [error]
 * @property {string} [kind]
 * @property {number} ms
 *
 * @typedef {object} Activity
 * @property {string} id
 * @property {number} at
 * @property {"anthropic"|"openai"} api
 * @property {string} requested
 * @property {string|null} served
 * @property {Attempt[]} attempts
 * @property {number} status
 * @property {number} ms
 * @property {boolean} stream
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {string[]} [notes]
 */

/**
 * @param {object} [opts]
 * @param {() => import("./config.js").Config} [opts.load]   Config loader (tests pass their own).
 * @param {(line: string) => void} [opts.log]
 */
export function createApp(opts = {}) {
  const load = opts.load || loadConfig;
  const log = opts.log || ((/** @type {string} */ l) => process.stdout.write(l + "\n"));
  let cfg = load();
  const health = new Health();
  /** @type {Map<string, any>} */
  const signatures = new Map();
  /** @type {Activity[]} */
  const activity = [];
  /** @type {Set<http.ServerResponse>} */
  const listeners = new Set();
  /** @type {Record<string, {requests: number, failures: number, inputTokens: number, outputTokens: number}>} */
  const stats = {};
  /** @type {Map<string, {at: number, models: string[]}>} */
  const modelCache = new Map();
  const startedAt = Date.now();

  /** @param {string} id */
  const stat = (id) => (stats[id] ||= { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 });

  function reload() {
    cfg = load();
  }

  /** @param {(c: import("./config.js").Config) => void} mutate */
  function update(mutate) {
    cfg = load();
    mutate(cfg);
    saveConfig(cfg);
  }

  /** @param {Activity} a */
  function record(a) {
    activity.push(a);
    if (activity.length > 300) activity.shift();
    const msg = `event: activity\ndata: ${JSON.stringify(a)}\n\n`;
    for (const l of listeners) l.write(msg);
    const hops = a.attempts.filter((t) => t.error).map((t) => `${t.ref}: ${t.error}`);
    const tokens = a.inputTokens != null ? `  in ${a.inputTokens} out ${a.outputTokens}` : "";
    log(
      `${a.status < 400 ? "✓" : "✗"} ${a.requested} → ${a.served || "none"}  ${(a.ms / 1000).toFixed(1)}s${tokens}` +
        (hops.length ? `\n    fell back past: ${hops.join(" | ")}` : ""),
    );
  }

  /** @param {string} id @param {any} extra */
  function rememberSignature(id, extra) {
    signatures.set(id, extra);
    if (signatures.size > SIGNATURE_CACHE) {
      const oldest = signatures.keys().next().value;
      if (oldest !== undefined) signatures.delete(oldest);
    }
  }
  const sigProxy = { get: (/** @type {string} */ k) => signatures.get(k), set: rememberSignature };

  // ---------------------------------------------------------------- helpers

  /** @param {http.IncomingMessage} req @returns {Promise<any>} */
  function readJson(req) {
    return new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error("request body too large"), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(Object.assign(new Error("request body is not valid JSON"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  /** @param {http.ServerResponse} res @param {number} status @param {any} body */
  function json(res, status, body) {
    if (res.headersSent) return void res.end();
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s), "cache-control": "no-store" });
    res.end(s);
  }

  /** @param {number} status */
  function anthropicErrorType(status) {
    return status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : status === 404 ? "not_found_error" : status === 413 ? "request_too_large" : status === 429 ? "rate_limit_error" : status === 529 ? "overloaded_error" : "api_error";
  }

  /** @param {http.ServerResponse} res @param {number} status @param {string} message @param {"anthropic"|"openai"} api */
  function apiError(res, status, message, api) {
    if (api === "anthropic") json(res, status, { type: "error", error: { type: anthropicErrorType(status), message } });
    else json(res, status, { error: { message, type: anthropicErrorType(status), code: status } });
  }

  /**
   * Requests must be addressed to this machine by name: blocks DNS-rebinding attacks
   * from web pages, which could otherwise reach the admin API and your keys.
   * @param {http.IncomingMessage} req
   */
  function hostAllowed(req) {
    const host = (req.headers.host || "").toLowerCase();
    const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
    const allowed = new Set(["127.0.0.1", "localhost", "[::1]", cfg.host.toLowerCase()]);
    for (const extra of (process.env.FREEFLOW_ALLOWED_HOSTS || "").split(",")) if (extra.trim()) allowed.add(extra.trim().toLowerCase());
    return allowed.has(name);
  }

  /** @param {http.IncomingMessage} req */
  function fromLoopback(req) {
    const a = req.socket.remoteAddress || "";
    return a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
  }

  /** Browsers always send Origin on cross-site POSTs; refuse those so web pages cannot spend your quota. @param {http.IncomingMessage} req */
  function sameOriginOrNone(req) {
    const origin = req.headers.origin;
    if (!origin || origin === "null") return !origin;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  /** @param {http.IncomingMessage} req */
  function proxyAuthorized(req) {
    if (!cfg.proxyToken) return true;
    const auth = String(req.headers.authorization || "");
    const given = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : String(req.headers["x-api-key"] || "");
    return safeEqual(given, cfg.proxyToken);
  }

  /** @param {http.IncomingMessage} req */
  function adminAuthorized(req) {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const u = new URL(origin);
        if (u.host !== req.headers.host) return false;
      } catch {
        return false;
      }
    }
    return safeEqual(String(req.headers["x-freeflow-admin"] || ""), cfg.adminToken);
  }

  /** @param {string} a @param {string} b */
  function safeEqual(a, b) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  /** @param {Activity} a @param {any} c @param {UpstreamError} err @param {number} t0 */
  function noteFailure(a, c, err, t0) {
    a.attempts.push({ ref: c.ref, error: err.message.slice(0, 300), kind: err.kind, ms: Date.now() - t0 });
    stat(c.provider).failures++;
    health.fail(healthKey(c.provider, c.ref, err.kind), err);
  }

  /** @param {Activity} a @param {"anthropic"|"openai"} api */
  function finalFailure(a, api) {
    const kinds = a.attempts.map((t) => t.kind);
    const summary = a.attempts.map((t) => `${t.ref}: ${t.error}`).join(" | ");
    if (kinds.length && kinds.every((k) => k === "request")) return { status: 400, message: `freeflow: the provider rejected the request: ${summary}` };
    if (kinds.length && kinds.every((k) => k === "rate")) return { status: 429, message: `freeflow: every model is rate limited right now. ${summary}` };
    return { status: api === "anthropic" ? 529 : 503, message: `freeflow: all ${a.attempts.length} model(s) failed: ${summary}` };
  }

  // ---------------------------------------------------------------- /v1/messages

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function messages(req, res) {
    const body = await readJson(req);
    const t0 = Date.now();
    const requested = String(body.model || "default");
    const stream = body.stream === true;
    /** @type {Activity} */
    const a = { id: crypto.randomUUID(), at: t0, api: "anthropic", requested, served: null, attempts: [], status: 0, ms: 0, stream, notes: [] };
    const { candidates, skipped } = plan(cfg, requested, health);
    if (!candidates.length) {
      const msg = skipped.length
        ? `freeflow: no usable model. Configured but not ready: ${skipped.join(", ")}. Open http://${cfg.host}:${cfg.port} to fix.`
        : `freeflow: no model is set up yet. Open http://${cfg.host}:${cfg.port} to add a provider key and pick a model.`;
      a.status = 400;
      a.ms = Date.now() - t0;
      record(a);
      return apiError(res, 400, msg, "anthropic");
    }
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    const inputEstimate = estimateTokens(body);

    for (const c of candidates) {
      if (ac.signal.aborted) return;
      const t1 = Date.now();
      /** @type {AsyncGenerator<any> | undefined} */
      let openIt;
      try {
        if (c.p.format === "anthropic") {
          await nativeAnthropic(req, res, body, c, ac.signal, a);
        } else {
          const { request, toolNames } = toOpenAI(body, { quirks: c.p.quirks, model: c.model, effort: c.effort, signatures: /** @type {any} */ (sigProxy), stream: true });
          const it = await chatCompletions({
            baseUrl: c.p.baseUrl,
            key: c.p.key,
            learnKey: c.ref,
            request,
            signal: ac.signal,
            firstByteMs: cfg.timeouts.firstByteMs,
            idleMs: cfg.timeouts.idleMs,
            onNote: (n) => a.notes?.push(`${c.ref}: ${n}`),
          });
          openIt = it;
          const tr = new StreamTranslator({ model: requested, inputEstimate, toolNames, signatures: /** @type {any} */ (sigProxy) });
          // Read ahead until the provider has produced something real. Until then a failure
          // can still fall back to the next model without the client noticing.
          /** @type {any[]} */
          const early = [];
          for (;;) {
            const n = await it.next();
            if (n.done) break;
            early.push(n.value);
            const ch = n.value?.choices?.[0];
            const d = ch?.delta || ch?.message || {};
            if (ch?.finish_reason || d.content || d.reasoning_content || d.reasoning || d.tool_calls?.length) break;
          }
          if (!early.length) throw new UpstreamError("provider returned an empty stream", { kind: "transient" });
          if (stream) {
            res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-freeflow-model": c.ref });
            const write = (/** @type {any[]} */ evs) => {
              for (const e of evs) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
            };
            try {
              for (const ch of early) write(tr.feed(ch));
              for await (const ch of { [Symbol.asyncIterator]: () => it }) write(tr.feed(ch));
              write(tr.end());
            } catch (e) {
              if (ac.signal.aborted) return;
              const err = e instanceof UpstreamError ? e : new UpstreamError(String(/** @type {any} */ (e)?.message || e), { kind: "transient" });
              noteFailure(a, c, err, t1);
              res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: `freeflow: ${c.ref} stopped mid-response: ${err.message}` } })}\n\n`);
              res.end();
              a.status = 529;
              a.served = c.ref;
              a.ms = Date.now() - t0;
              record(a);
              return;
            }
            res.end();
          } else {
            /** @type {any[]} */
            const evs = [];
            for (const ch of early) evs.push(...tr.feed(ch));
            for await (const ch of { [Symbol.asyncIterator]: () => it }) evs.push(...tr.feed(ch));
            evs.push(...tr.end());
            json(res, 200, eventsToMessage(evs));
          }
          a.inputTokens = tr.finalUsage?.input_tokens;
          a.outputTokens = tr.finalUsage?.output_tokens;
        }
        health.ok(c.provider);
        health.ok(c.ref);
        const s = stat(c.provider);
        s.requests++;
        s.inputTokens += a.inputTokens || 0;
        s.outputTokens += a.outputTokens || 0;
        a.attempts.push({ ref: c.ref, ms: Date.now() - t1 });
        a.served = c.ref;
        a.status = 200;
        a.ms = Date.now() - t0;
        record(a);
        return;
      } catch (e) {
        await openIt?.return?.(undefined).catch(() => {});
        if (ac.signal.aborted) return;
        if (res.headersSent) {
          res.end();
          return;
        }
        const err = e instanceof UpstreamError ? e : new UpstreamError(String(/** @type {any} */ (e)?.message || e), { kind: "transient" });
        noteFailure(a, c, err, t1);
      }
    }
    const f = finalFailure(a, "anthropic");
    a.status = f.status;
    a.ms = Date.now() - t0;
    record(a);
    apiError(res, f.status, f.message, "anthropic");
  }

  /**
   * Anthropic as a provider: forward the request untouched apart from the model name.
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {any} body
   * @param {any} c @param {AbortSignal} signal @param {Activity} a
   */
  async function nativeAnthropic(req, res, body, c, signal, a) {
    /** @type {Record<string,string>} */
    const headers = { "x-api-key": c.p.key, "anthropic-version": String(req.headers["anthropic-version"] || "2023-06-01") };
    if (req.headers["anthropic-beta"]) headers["anthropic-beta"] = String(req.headers["anthropic-beta"]);
    const up = await post(`${c.p.baseUrl}/v1/messages`, { ...stripForeignThinking(body), model: c.model }, { key: "", signal, firstByteMs: cfg.timeouts.firstByteMs, headers });
    if (!up.ok) {
      const text = await up.text().catch(() => "");
      throw new UpstreamError(errorText(text), { status: up.status, kind: classify(up.status, text), retryAfterMs: parseRetryAfter(up.headers.get("retry-after")) });
    }
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json", "x-freeflow-model": c.ref });
    if (up.body) await pipeBody(up.body, res, cfg.timeouts.idleMs);
    res.end();
    a.notes?.push("forwarded natively to Anthropic");
  }

  // ---------------------------------------------------------------- /v1/chat/completions

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function chat(req, res) {
    const body = await readJson(req);
    const t0 = Date.now();
    const requested = String(body.model || "default");
    /** @type {Activity} */
    const a = { id: crypto.randomUUID(), at: t0, api: "openai", requested, served: null, attempts: [], status: 0, ms: 0, stream: body.stream === true, notes: [] };
    const alias = ["default", "freeflow", "auto"].includes(requested) ? "default" : requested;
    const { candidates, skipped } = plan(cfg, alias, health);
    const usable = candidates.filter((c) => c.p.format === "openai");
    if (!usable.length) {
      a.status = 400;
      record(a);
      return apiError(res, 400, `freeflow: no usable OpenAI-compatible model for "${requested}". ${skipped.length ? `Not ready: ${skipped.join(", ")}.` : ""} Open http://${cfg.host}:${cfg.port}.`, "openai");
    }
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    for (const c of usable) {
      const t1 = Date.now();
      try {
        const request = { ...body, model: c.model };
        const q = c.p.quirks;
        if (q.maxTokensField === "max_completion_tokens" && request.max_tokens != null) {
          request.max_completion_tokens = request.max_tokens;
          delete request.max_tokens;
        }
        if (q.toolIdStyle === "alnum9")
          for (const m of request.messages || []) {
            if (m.tool_call_id) m.tool_call_id = alnum9(m.tool_call_id);
            for (const t of m.tool_calls || []) t.id = alnum9(t.id);
          }
        const up = await openChat({ baseUrl: c.p.baseUrl, key: c.p.key, learnKey: c.ref, request, signal: ac.signal, firstByteMs: cfg.timeouts.firstByteMs, idleMs: cfg.timeouts.idleMs, onNote: (n) => a.notes?.push(`${c.ref}: ${n}`) });
        res.writeHead(200, { "content-type": up.headers.get("content-type") || "application/json", "cache-control": "no-cache", "x-freeflow-model": c.ref });
        if (up.body) await pipeBody(up.body, res, cfg.timeouts.idleMs);
        res.end();
        health.ok(c.provider);
        stat(c.provider).requests++;
        a.attempts.push({ ref: c.ref, ms: Date.now() - t1 });
        a.served = c.ref;
        a.status = 200;
        a.ms = Date.now() - t0;
        record(a);
        return;
      } catch (e) {
        if (ac.signal.aborted) return;
        if (res.headersSent) return void res.end();
        const err = e instanceof UpstreamError ? e : new UpstreamError(String(/** @type {any} */ (e)?.message || e), { kind: "transient" });
        noteFailure(a, c, err, t1);
      }
    }
    const f = finalFailure(a, "openai");
    a.status = f.status;
    a.ms = Date.now() - t0;
    record(a);
    apiError(res, f.status, f.message, "openai");
  }

  // ---------------------------------------------------------------- /v1/models

  function configuredModels() {
    const refs = new Set();
    for (const r of Object.values(cfg.routes)) if (r?.model) refs.add(r.model);
    for (const r of cfg.fallbacks) if (r?.model) refs.add(r.model);
    return [...refs];
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  function models(req, res) {
    const ids = ["default", ...configuredModels()];
    if (req.headers["anthropic-version"]) {
      const data = ids.map((id) => ({ type: "model", id, display_name: id === "default" ? "freeflow default route" : id, created_at: new Date(startedAt).toISOString() }));
      return json(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
    }
    json(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", created: Math.floor(startedAt / 1000), owned_by: parseModelRef(id)?.provider || "freeflow" })) });
  }

  // ---------------------------------------------------------------- admin API

  function state() {
    const providers = [...PROVIDERS.map((p) => p.id), ...cfg.custom.map((c) => c.id)].map((id) => {
      const r = /** @type {NonNullable<ReturnType<typeof resolveProvider>>} */ (resolveProvider(cfg, id));
      const cat = getProvider(id);
      const s = cfg.providers[id] || {};
      return {
        id,
        name: r.name,
        tier: r.tier,
        custom: !cat,
        ready: r.ready,
        disabled: r.disabled,
        key: maskKey(r.key),
        keySource: r.keySource,
        keyUrl: cat?.keyUrl,
        env: cat?.env,
        example: cat?.example,
        note: cat?.note,
        needs: cat?.needs || [],
        keyOptional: Boolean(cat?.keyOptional),
        baseUrl: s.baseUrl || "",
        defaultBaseUrl: cat?.base || cfg.custom.find((c) => c.id === id)?.baseUrl || "",
        accountId: s.accountId || "",
        format: r.format,
        stats: stats[id] || null,
      };
    });
    return {
      version: VERSION,
      host: cfg.host,
      port: cfg.port,
      startedAt,
      proxyToken: Boolean(cfg.proxyToken),
      providers,
      routes: cfg.routes,
      fallbacks: cfg.fallbacks,
      health: health.snapshot(),
      repairs: learnedRepairs(),
      activity: activity.slice(-100),
    };
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {URL} url */
  async function admin(req, res, url) {
    const path = url.pathname.slice("/admin/api".length);
    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        listeners.delete(res);
      });
      return;
    }
    if (req.method === "GET" && path === "/state") return json(res, 200, state());
    if (req.method === "GET" && path === "/models") {
      const id = url.searchParams.get("provider") || "";
      const p = resolveProvider(cfg, id);
      if (!p) return json(res, 404, { error: "unknown provider" });
      if (!p.baseUrl) return json(res, 400, { error: "set the base URL or account id first" });
      const cached = modelCache.get(id);
      if (cached && Date.now() - cached.at < 10 * 60_000 && url.searchParams.get("refresh") !== "1") return json(res, 200, { models: cached.models, cached: true });
      try {
        const list =
          p.format === "anthropic"
            ? await listModels(`${p.baseUrl}/v1`, "", { "x-api-key": p.key, "anthropic-version": "2023-06-01" })
            : await listModels(p.baseUrl, p.key);
        modelCache.set(id, { at: Date.now(), models: list });
        return json(res, 200, { models: list });
      } catch (e) {
        return json(res, 502, { error: /** @type {Error} */ (e).message });
      }
    }
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readJson(req);

    if (path === "/provider") {
      const id = String(body.id || "");
      if (!allProviderIds(cfg).includes(id)) return json(res, 404, { error: "unknown provider" });
      update((c) => {
        const s = (c.providers[id] ||= {});
        if (typeof body.key === "string") body.key.trim() ? (s.key = body.key.trim()) : delete s.key;
        if (typeof body.baseUrl === "string") body.baseUrl.trim() ? (s.baseUrl = body.baseUrl.trim().replace(/\/+$/, "")) : delete s.baseUrl;
        if (typeof body.accountId === "string") body.accountId.trim() ? (s.accountId = body.accountId.trim()) : delete s.accountId;
        if (typeof body.disabled === "boolean") s.disabled = body.disabled || undefined;
        if (!Object.keys(s).some((k) => /** @type {any} */ (s)[k] !== undefined)) delete c.providers[id];
      });
      modelCache.delete(id);
      health.ok(id);
      return json(res, 200, state());
    }
    if (path === "/custom") {
      const id = String(body.id || "").toLowerCase();
      if (body.remove) {
        update((c) => {
          c.custom = c.custom.filter((x) => x.id !== id);
          delete c.providers[id];
        });
        return json(res, 200, state());
      }
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id) || getProvider(id)) return json(res, 400, { error: "pick a short id (letters, digits, dashes) that isn't a built-in provider" });
      let base;
      try {
        base = new URL(String(body.baseUrl)).toString().replace(/\/+$/, "");
      } catch {
        return json(res, 400, { error: "base URL is not a valid URL" });
      }
      update((c) => {
        c.custom = c.custom.filter((x) => x.id !== id);
        c.custom.push({ id, name: String(body.name || id), baseUrl: base, format: body.format === "anthropic" ? "anthropic" : "openai" });
        if (typeof body.key === "string" && body.key.trim()) (c.providers[id] ||= {}).key = body.key.trim();
      });
      return json(res, 200, state());
    }
    if (path === "/routes") {
      const valid = (/** @type {any} */ r) => r && typeof r.model === "string" && parseModelRef(r.model) && resolveProvider(cfg, /** @type {any} */ (parseModelRef(r.model)).provider);
      const efforts = ["client", "off", "low", "medium", "high"];
      const clean = (/** @type {any} */ r) => ({ model: String(r.model).trim(), ...(efforts.includes(r.effort) && r.effort !== "client" ? { effort: r.effort } : {}) });
      /** @type {any} */
      const routes = {};
      for (const k of ["default", "fable", "opus", "sonnet", "haiku"]) {
        const r = body.routes?.[k];
        if (r?.model) {
          if (!valid(r)) return json(res, 400, { error: `${k}: "${r.model}" is not provider/model with a known provider` });
          routes[k] = clean(r);
        }
      }
      const fallbacks = [];
      for (const r of body.fallbacks || []) {
        if (!valid(r)) return json(res, 400, { error: `fallback "${r?.model}" is not provider/model with a known provider` });
        fallbacks.push(clean(r));
      }
      update((c) => {
        c.routes = routes;
        c.fallbacks = fallbacks;
      });
      return json(res, 200, state());
    }
    if (path === "/settings") {
      update((c) => {
        if (body.proxyToken === true) c.proxyToken = crypto.randomBytes(24).toString("base64url");
        if (body.proxyToken === false) delete c.proxyToken;
      });
      return json(res, 200, { ...state(), proxyTokenValue: cfg.proxyToken || null });
    }
    if (path === "/test") {
      const ref = String(body.model || "");
      const r = parseModelRef(ref);
      const p = r && resolveProvider(cfg, r.provider);
      if (!r || !p) return json(res, 400, { error: "give a provider/model to test" });
      const t0 = Date.now();
      const ac = new AbortController();
      try {
        if (p.format === "anthropic") {
          const up = await post(`${p.baseUrl}/v1/messages`, { model: r.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }] }, { key: "", signal: ac.signal, firstByteMs: 60_000, headers: { "x-api-key": p.key, "anthropic-version": "2023-06-01" } });
          const t = await up.text();
          if (!up.ok) throw new UpstreamError(errorText(t), { status: up.status, kind: classify(up.status, t) });
          const j = JSON.parse(t);
          return json(res, 200, { ok: true, ms: Date.now() - t0, reply: (j.content || []).map((/** @type {any} */ b) => b.text || "").join("").slice(0, 200) });
        }
        const { request } = toOpenAI({ max_tokens: 64, messages: [{ role: "user", content: "Reply with the single word OK." }] }, { quirks: p.quirks, model: r.model, stream: true });
        const it = await chatCompletions({ baseUrl: p.baseUrl, key: p.key, learnKey: ref, request, signal: ac.signal, firstByteMs: 60_000, idleMs: 60_000 });
        const tr = new StreamTranslator({ model: ref });
        for await (const ch of it) tr.feed(ch);
        tr.end();
        return json(res, 200, { ok: true, ms: Date.now() - t0, reply: (tr.totals.text || tr.totals.thinking).trim().slice(0, 200) });
      } catch (e) {
        const err = /** @type {any} */ (e);
        return json(res, 200, { ok: false, ms: Date.now() - t0, error: err.message, kind: err.kind || "transient" });
      }
    }
    if (path === "/shutdown") {
      json(res, 200, { ok: true });
      setTimeout(() => process.emit("SIGTERM"), 50);
      return;
    }
    json(res, 404, { error: "not found" });
  }

  // ---------------------------------------------------------------- dispatch

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @returns {Promise<void>} */
  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const api = url.pathname.startsWith("/v1/chat") || (!req.headers["anthropic-version"] && url.pathname === "/v1/models") ? "openai" : "anthropic";
    try {
      if (!hostAllowed(req)) return json(res, 403, { error: "freeflow only answers requests addressed to localhost" });
      if (url.pathname === "/health") return json(res, 200, { ok: true, name: "freeflow", version: VERSION });
      const isAdmin = url.pathname === "/" || url.pathname === "/admin" || url.pathname.startsWith("/admin/");
      // The dashboard holds the admin token, so it is only ever served to this machine,
      // whatever address freeflow listens on and whatever Host header a client sends.
      if (isAdmin && !fromLoopback(req)) return json(res, 403, { error: "the freeflow dashboard is only available on the machine running it" });
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
        const html = fs.readFileSync(ADMIN_HTML, "utf8").replace("__FREEFLOW_ADMIN_TOKEN__", cfg.adminToken).replaceAll("__FREEFLOW_VERSION__", VERSION);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
        });
        res.end(html);
        return;
      }
      if (url.pathname.startsWith("/admin/api/")) {
        if (!adminAuthorized(req)) return json(res, 401, { error: "admin token missing or wrong; reload the admin page" });
        return await admin(req, res, url);
      }
      if (url.pathname.startsWith("/v1/")) {
        if (!sameOriginOrNone(req)) return apiError(res, 403, "freeflow: requests from web pages are not allowed", api);
        if (!fromLoopback(req) && !cfg.proxyToken) return apiError(res, 403, "freeflow: turn on the proxy token to accept requests from other machines", api);
        if (!proxyAuthorized(req)) return apiError(res, 401, "freeflow: wrong or missing proxy token", api);
        if (req.method === "POST" && url.pathname === "/v1/messages") return await messages(req, res);
        if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") return json(res, 200, { input_tokens: estimateTokens(await readJson(req)) });
        if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await chat(req, res);
        if (req.method === "GET" && url.pathname === "/v1/models") return models(req, res);
        return apiError(res, 404, `freeflow does not implement ${req.method} ${url.pathname}`, api);
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (res.headersSent) return void res.end();
      apiError(res, err.status || 500, `freeflow: ${err.message || err}`, api);
    }
  }

  return {
    handle,
    health,
    activity,
    stats,
    reload,
    get config() {
      return cfg;
    },
    tierOf,
  };
}

/**
 * @param {object} [opts]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {(line: string) => void} [opts.log]
 * @param {() => import("./config.js").Config} [opts.load]
 */
export function startServer(opts = {}) {
  const app = createApp({ log: opts.log, load: opts.load });
  const server = http.createServer(app.handle);
  server.keepAliveTimeout = 75_000;
  server.requestTimeout = 0; // long agent turns
  const port = opts.port ?? app.config.port;
  const host = opts.host ?? app.config.host;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({ server, app, port: /** @type {import("node:net").AddressInfo} */ (server.address()).port, host });
    });
  });
}
