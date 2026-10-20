// @ts-check

/**
 * Talking to providers: HTTP, SSE parsing, error classification and request repair.
 */

export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {object} info
   * @param {number} [info.status]        HTTP status, 0 for network errors
   * @param {"auth"|"rate"|"transient"|"model"|"request"|"aborted"} info.kind
   * @param {number} [info.retryAfterMs]
   * @param {string} [info.body]
   */
  constructor(message, info) {
    super(message);
    this.status = info.status ?? 0;
    this.kind = info.kind;
    this.retryAfterMs = info.retryAfterMs;
    this.body = info.body;
  }
}

/** @param {string|null} h */
export function parseRetryAfter(h) {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

/**
 * @param {number} status
 * @param {string} body
 */
export function classify(status, body) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate";
  if (status === 404) return "model";
  if (status === 408 || status === 409 || status === 425 || status >= 500) return "transient";
  if (status === 400 && /model.{0,40}(not (found|exist|available|supported)|does not exist|invalid model|unknown model)/i.test(body)) return "model";
  if (/rate.?limit|quota|too many requests|resource.?exhausted/i.test(body)) return "rate";
  return "request";
}

/** Short human message from a provider error body. @param {string} body */
export function errorText(body) {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error ?? j;
    const m = typeof e === "string" ? e : e?.message || j.message || j.detail;
    if (m) return String(m).slice(0, 400);
  } catch {
    /* not JSON */
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 400) || "(empty response)";
}

/**
 * Parameters a provider may reject. When a 400 names one of them, freeflow removes it,
 * retries, and remembers the lesson for this provider and model.
 * @type {Array<{param: string, match: RegExp, fix: (req: any) => boolean}>}
 */
export const REPAIRS = [
  { param: "stream_options", match: /stream_options|include_usage/i, fix: (r) => delete r.stream_options },
  { param: "parallel_tool_calls", match: /parallel_tool_calls/i, fix: (r) => delete r.parallel_tool_calls },
  { param: "reasoning_effort", match: /reasoning_effort|reasoning effort/i, fix: (r) => delete r.reasoning_effort },
  { param: "reasoning", match: /\breasoning\b/i, fix: (r) => delete r.reasoning },
  { param: "tool_choice", match: /tool_choice/i, fix: (r) => delete r.tool_choice },
  { param: "top_p", match: /top_p/i, fix: (r) => delete r.top_p },
  { param: "temperature", match: /temperature/i, fix: (r) => delete r.temperature },
  { param: "stop", match: /\bstop\b.*(not supported|unsupported|invalid)|(unsupported|invalid).*\bstop\b/i, fix: (r) => delete r.stop },
  {
    param: "max_tokens",
    match: /max_tokens.*(not supported|unsupported|use max_completion_tokens)/i,
    fix: (r) => {
      if (!("max_tokens" in r)) return false;
      r.max_completion_tokens = r.max_tokens;
      delete r.max_tokens;
      return true;
    },
  },
  {
    param: "max_completion_tokens",
    match: /max_completion_tokens.*(not supported|unsupported|unrecognized|unknown)|unrecognized.*max_completion_tokens/i,
    fix: (r) => {
      if (!("max_completion_tokens" in r)) return false;
      r.max_tokens = r.max_completion_tokens;
      delete r.max_completion_tokens;
      return true;
    },
  },
  {
    param: "extra_content",
    match: /extra_content/i,
    fix: (r) => {
      let changed = false;
      for (const m of r.messages || []) for (const c of m.tool_calls || []) if (c.extra_content) changed = delete c.extra_content;
      return changed;
    },
  },
  {
    param: "reasoning_content",
    match: /reasoning_content/i,
    fix: (r) => {
      let changed = false;
      for (const m of r.messages || []) if ("reasoning_content" in m) changed = delete m.reasoning_content;
      return changed;
    },
  },
];

/** provider/model -> params to strip up front */
const learned = new Map();

/** @param {string} key @param {any} req */
export function applyLearned(key, req) {
  for (const p of learned.get(key) || []) REPAIRS.find((r) => r.param === p)?.fix(req);
}
export function learnedRepairs() {
  return Object.fromEntries([...learned].map(([k, v]) => [k, [...v]]));
}
export function clearLearned() {
  learned.clear();
}

/**
 * Parse an SSE byte stream into JSON payloads.
 * @param {ReadableStream<Uint8Array>} body
 * @param {number} idleMs
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<any>}
 */
export async function* sse(body, idleMs, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let data = "";
  let finished = false;
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const idle = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new UpstreamError(`no data for ${Math.round(idleMs / 1000)}s`, { kind: "transient" })), idleMs);
      });
      let r;
      try {
        r = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      const { done, value } = /** @type {ReadableStreamReadResult<Uint8Array>} */ (r);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (data) {
            const payload = data;
            data = "";
            if (payload.trim() === "[DONE]") {
              finished = true;
              return;
            }
            yield parsePayload(payload);
          }
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
      }
    }
    const last = buf.replace(/\r$/, "");
    if (last.startsWith("data:")) data += (data ? "\n" : "") + last.slice(5).replace(/^ /, "");
    finished = true;
    if (data && data.trim() !== "[DONE]") yield parsePayload(data);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Errors, timeouts, an abandoned iterator or a client that left: close the provider's stream.
    if (!finished || signal?.aborted) await reader.cancel().catch(() => {});
    else reader.releaseLock?.();
  }
}

/** @param {string} payload */
function parsePayload(payload) {
  let j;
  try {
    j = JSON.parse(payload);
  } catch {
    throw new UpstreamError(`provider sent invalid stream data: ${payload.slice(0, 120)}`, { kind: "transient" });
  }
  if (j && j.error && !j.choices) {
    const msg = typeof j.error === "string" ? j.error : j.error.message || JSON.stringify(j.error);
    const code = Number(j.error.code || j.error.status) || 0;
    throw new UpstreamError(msg, { kind: classify(code || 500, msg), status: code });
  }
  return j;
}

/**
 * POST a Chat Completions request and return an async iterator of chunks.
 * The promise resolves once the provider has accepted the request (2xx headers).
 *
 * @param {object} p
 * @param {string} p.baseUrl
 * @param {string} p.key
 * @param {string} p.learnKey          provider/model, for remembered repairs
 * @param {any} p.request
 * @param {AbortSignal} p.signal
 * @param {number} p.firstByteMs
 * @param {number} p.idleMs
 * @param {Record<string,string>} [p.headers]
 * @param {(note: string) => void} [p.onNote]
 */
export async function chatCompletions(p) {
  const res = await openChat(p);
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    // Some providers ignore stream:true; wrap the whole response as a single chunk.
    const j = await res.json();
    if (j.error && !j.choices) throw new UpstreamError(errorText(JSON.stringify(j)), { kind: "transient" });
    return (async function* () {
      yield j;
    })();
  }
  if (!res.body) throw new UpstreamError("empty response body", { kind: "transient" });
  return sse(res.body, p.idleMs, p.signal);
}

/**
 * POST to {base}/chat/completions, repairing rejected parameters. Resolves with the
 * successful Response; throws UpstreamError otherwise.
 * @param {Parameters<typeof chatCompletions>[0]} p
 * @returns {Promise<Response>}
 */
export async function openChat(p) {
  const req = structuredClone(p.request);
  applyLearned(p.learnKey, req);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await post(`${p.baseUrl}/chat/completions`, req, p);
    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    if (res.status === 400 || res.status === 422) {
      const msg = errorText(body);
      const repair = REPAIRS.find((r) => r.match.test(msg) && r.fix(req));
      if (repair) {
        const set = learned.get(p.learnKey) || new Set();
        set.add(repair.param);
        learned.set(p.learnKey, set);
        p.onNote?.(`removed unsupported "${repair.param}" and retried`);
        continue;
      }
    }
    throw new UpstreamError(errorText(body), {
      status: res.status,
      kind: classify(res.status, body),
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      body,
    });
  }
  throw new UpstreamError("request could not be repaired", { kind: "request", status: 400 });
}

/**
 * @param {string} url
 * @param {any} payload
 * @param {{key: string, signal: AbortSignal, firstByteMs: number, headers?: Record<string,string>}} p
 */
export async function post(url, payload, p) {
  const ctrl = new AbortController();
  // The link stays in place after the headers arrive, so a client that hangs up also
  // cancels the provider's response body instead of letting it stream on unread.
  const onAbort = () => ctrl.abort();
  p.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error("first-byte timeout")), p.firstByteMs);
  try {
    /** @type {Record<string,string>} */
    const headers = { "content-type": "application/json", accept: "text/event-stream, application/json", ...(p.headers || {}) };
    if (p.key && !headers["x-api-key"]) headers.authorization = `Bearer ${p.key}`;
    return await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal });
  } catch (e) {
    p.signal.removeEventListener("abort", onAbort);
    if (p.signal.aborted) throw new UpstreamError("client disconnected", { kind: "aborted" });
    const err = /** @type {any} */ (e);
    const why = ctrl.signal.aborted ? `no response within ${Math.round(p.firstByteMs / 1000)}s` : err?.cause?.code || err?.message || "network error";
    throw new UpstreamError(`cannot reach provider: ${why}`, { kind: "transient" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List a provider's models via GET {base}/models.
 * @param {string} baseUrl
 * @param {string} key
 * @param {Record<string,string>} [headers]
 * @returns {Promise<string[]>}
 */
export async function listModels(baseUrl, key, headers = {}) {
  /** @type {Record<string,string>} */
  const h = { accept: "application/json", ...headers };
  if (key && !h["x-api-key"]) h.authorization = `Bearer ${key}`;
  const res = await fetch(`${baseUrl}/models`, { headers: h, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) throw new UpstreamError(errorText(text), { status: res.status, kind: classify(res.status, text) });
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : j.data || j.models || [];
  return list
    .map((/** @type {any} */ m) => (typeof m === "string" ? m : m.id || m.name))
    .filter(Boolean)
    .map((/** @type {string} */ id) => id.replace(/^models\//, ""))
    .sort();
}

/**
 * Copy a provider's response body to the client unchanged, with the idle timeout, and
 * cancel the provider's stream if the client goes away.
 * @param {ReadableStream<Uint8Array>} body
 * @param {import("node:http").ServerResponse} res
 * @param {number} idleMs
 */
export async function pipeBody(body, res, idleMs) {
  const reader = body.getReader();
  const stop = () => reader.cancel().catch(() => {});
  res.on("close", stop);
  try {
    for (;;) {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const idle = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new UpstreamError(`no data for ${Math.round(idleMs / 1000)}s`, { kind: "transient" })), idleMs);
      });
      let r;
      try {
        r = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      const { done, value } = /** @type {ReadableStreamReadResult<Uint8Array>} */ (r);
      if (done) return;
      if (res.destroyed) return void stop();
      res.write(value);
    }
  } catch (e) {
    stop();
    throw e;
  } finally {
    res.off("close", stop);
  }
}
