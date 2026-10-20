// @ts-check
import crypto from "node:crypto";

/**
 * Anthropic Messages request  ->  OpenAI Chat Completions request.
 *
 * Coding agents speak the Anthropic Messages API; nearly every other provider speaks
 * OpenAI Chat Completions. This module converts one request, applying the provider's
 * quirks. It is pure apart from the signature cache passed in by the caller.
 */

export const FF_SIGNATURE = "freeflow:v1";
const MAX_TOOL_NAME = 64;

/**
 * Tool names must match ^[a-zA-Z0-9_-]{1,64}$ at most providers; MCP tools are often longer.
 * Long or unusual names are shortened deterministically and mapped back on the way out.
 * @param {string} name
 */
export function safeToolName(name) {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (clean === name && name.length <= MAX_TOOL_NAME) return name;
  const h = crypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${clean.slice(0, MAX_TOOL_NAME - 9)}_${h}`;
}

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** Mistral requires tool call ids of exactly nine letters or digits. @param {string} id */
export function alnum9(id) {
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  const bytes = crypto.createHash("sha256").update(id).digest();
  let out = "";
  for (let i = 0; i < 9; i++) out += ALNUM[bytes[i] % ALNUM.length];
  return out;
}

/** Remove JSON Schema keywords that strict providers reject. @param {any} schema @returns {any} */
export function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== "object") return schema;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema" || k === "$id" || k === "$comment") continue;
    out[k] = typeof v === "object" ? cleanSchema(v) : v;
  }
  return out;
}

/**
 * Map the agent's thinking request to an effort level.
 * @param {any} body
 * @param {import("../config.js").Effort | undefined} routeEffort
 * @returns {"off"|"low"|"medium"|"high"|undefined}
 */
export function resolveEffort(body, routeEffort) {
  if (routeEffort && routeEffort !== "client") return routeEffort;
  const explicit = body?.output_config?.effort;
  if (typeof explicit === "string") {
    if (explicit === "low" || explicit === "medium" || explicit === "high") return explicit;
    if (explicit === "max" || explicit === "xhigh") return "high";
  }
  const t = body?.thinking;
  if (!t || typeof t !== "object") return undefined;
  if (t.type === "disabled") return "off";
  if (t.type === "adaptive") return "medium";
  if (t.type === "enabled") {
    const b = Number(t.budget_tokens) || 0;
    return b < 4096 ? "low" : b < 16384 ? "medium" : "high";
  }
  return undefined;
}

/** @param {any} content @returns {string} */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b?.type === "text" ? b.text : b?.type === "document" && b.source?.type === "text" ? b.source.data : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** @param {any} block */
function imagePart(block) {
  const src = block.source || {};
  if (src.type === "base64") return { type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  if (src.type === "url") return { type: "image_url", image_url: { url: src.url } };
  return null;
}

/**
 * @typedef {object} TranslateContext
 * @property {import("../catalog.js").Quirks} quirks
 * @property {string} model                         Upstream model id.
 * @property {import("../config.js").Effort} [effort]
 * @property {Map<string, any>} [signatures]       tool_use id -> Gemini extra_content
 * @property {boolean} [stream]
 */

/**
 * @param {any} body Anthropic Messages request
 * @param {TranslateContext} ctx
 * @returns {{ request: any, toolNames: Map<string, string> }}
 */
export function toOpenAI(body, ctx) {
  const q = ctx.quirks || {};
  const mapId = q.toolIdStyle === "alnum9" ? alnum9 : (/** @type {string} */ id) => id;
  /** @type {Map<string, string>} safe name -> original name */
  const toolNames = new Map();
  /** @type {any[]} */
  const messages = [];

  const system = textOf(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const msg of body.messages || []) {
    const content = msg.content;
    if (typeof content === "string") {
      messages.push({ role: msg.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (msg.role === "assistant") {
      let text = "";
      let reasoning = "";
      /** @type {any[]} */
      const calls = [];
      for (const b of content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "thinking") reasoning += b.thinking || "";
        else if (b.type === "tool_use") {
          const name = safeToolName(b.name);
          toolNames.set(name, b.name);
          /** @type {any} */
          const call = { id: mapId(b.id), type: "function", function: { name, arguments: JSON.stringify(b.input ?? {}) } };
          if (q.thoughtSignatures) {
            const extra = ctx.signatures?.get(b.id);
            if (extra) call.extra_content = extra;
            else if (calls.length === 0) call.extra_content = { google: { thought_signature: "skip_thought_signature_validator" } };
          }
          calls.push(call);
        }
      }
      /** @type {any} */
      const out = { role: "assistant", content: text || null };
      if (calls.length) out.tool_calls = calls;
      if (q.echoReasoning && reasoning) out.reasoning_content = reasoning;
      if (out.content === null && !calls.length) out.content = "";
      messages.push(out);
      continue;
    }

    // user turn: tool results must come first, directly after the assistant's tool calls
    /** @type {any[]} */
    const parts = [];
    /** @type {any[]} */
    const toolImages = [];
    for (const b of content) {
      if (b.type === "tool_result") {
        let resultText = "";
        if (typeof b.content === "string") resultText = b.content;
        else if (Array.isArray(b.content)) {
          for (const c of b.content) {
            if (c.type === "text") resultText += (resultText ? "\n" : "") + c.text;
            else if (c.type === "image") {
              const img = imagePart(c);
              if (img) toolImages.push(img);
            }
          }
        }
        if (b.is_error) resultText = `[tool error] ${resultText}`;
        messages.push({ role: "tool", tool_call_id: mapId(b.tool_use_id), content: resultText || "(no output)" });
      } else if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") {
        const img = imagePart(b);
        if (img) parts.push(img);
      } else if (b.type === "document") {
        const t = textOf([b]);
        parts.push({ type: "text", text: t || "[a document was attached but this model cannot read it]" });
      }
    }
    if (toolImages.length) parts.unshift({ type: "text", text: "Images returned by the tool call:" }, ...toolImages);
    if (parts.length) {
      const onlyText = parts.every((p) => p.type === "text");
      messages.push({ role: "user", content: onlyText ? parts.map((p) => p.text).join("\n\n") : parts });
    }
  }

  /** @type {any} */
  const req = { model: ctx.model, messages, stream: ctx.stream !== false };
  if (req.stream && !q.noStreamUsage) req.stream_options = { include_usage: true };
  if (body.max_tokens) req[q.maxTokensField || "max_tokens"] = body.max_tokens;
  if (typeof body.temperature === "number") req.temperature = body.temperature;
  if (typeof body.top_p === "number") req.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) req.stop = body.stop_sequences.slice(0, 4);

  const tools = (body.tools || []).filter((/** @type {any} */ t) => t && t.input_schema && (!t.type || t.type === "custom"));
  if (tools.length) {
    req.tools = tools.map((/** @type {any} */ t) => {
      const name = safeToolName(t.name);
      toolNames.set(name, t.name);
      return { type: "function", function: { name, description: t.description || "", parameters: cleanSchema(t.input_schema) } };
    });
    const tc = body.tool_choice;
    if (tc?.type === "any") req.tool_choice = "required";
    else if (tc?.type === "none") req.tool_choice = "none";
    else if (tc?.type === "tool") req.tool_choice = { type: "function", function: { name: safeToolName(tc.name) } };
    if (tc?.disable_parallel_tool_use) req.parallel_tool_calls = false;
  }

  const effort = resolveEffort(body, ctx.effort);
  if (effort && q.reasoning === "effort" && effort !== "off") req.reasoning_effort = effort;
  if (effort && q.reasoning === "openrouter") req.reasoning = effort === "off" ? { enabled: false } : { effort };

  return { request: req, toolNames };
}

/**
 * Before forwarding to Anthropic itself, drop thinking blocks that freeflow invented for
 * other providers: their signatures would be rejected.
 * @param {any} body
 */
export function stripForeignThinking(body) {
  if (!Array.isArray(body?.messages)) return body;
  return {
    ...body,
    messages: body.messages.map((/** @type {any} */ m) =>
      Array.isArray(m.content)
        ? { ...m, content: m.content.filter((/** @type {any} */ b) => !(b?.type === "thinking" && b.signature === FF_SIGNATURE)) }
        : m,
    ),
  };
}

/** Rough token estimate (about four characters per token) for count_tokens. @param {any} body */
export function estimateTokens(body) {
  let chars = textOf(body.system).length;
  for (const m of body.messages || []) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content))
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_use") chars += JSON.stringify(b.input ?? {}).length;
        else if (b.type === "tool_result") chars += typeof b.content === "string" ? b.content.length : JSON.stringify(b.content ?? "").length;
        else if (b.type === "image") chars += 6000;
        else if (b.type === "thinking") chars += (b.thinking || "").length;
      }
  }
  for (const t of body.tools || []) chars += JSON.stringify(t).length;
  return Math.max(1, Math.ceil(chars / 4));
}
