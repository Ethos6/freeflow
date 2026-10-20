// @ts-check
import crypto from "node:crypto";
import { FF_SIGNATURE } from "./request.js";

/**
 * OpenAI Chat Completions output  ->  Anthropic Messages output.
 *
 * `StreamTranslator` turns a sequence of OpenAI stream chunks into Anthropic SSE events.
 * The non-streaming path feeds the single response through the same machine, so both
 * paths share one implementation of every edge case.
 *
 * Edge cases handled:
 *  - reasoning in `reasoning_content` or `reasoning` (string) -> thinking blocks
 *  - reasoning wrapped in <think>...</think> at the start of `content`, split across chunks
 *  - tool calls without an `index`, with arguments split anywhere, or sent all at once
 *  - empty or invalid tool arguments
 *  - tool calls reported with finish_reason "stop"
 *  - usage in a trailing chunk with no choices
 *  - Gemini thought signatures on tool calls (kept for the next request)
 */

const OPEN = "<think>";
const CLOSE = "</think>";

export function messageId() {
  return `msg_ff${crypto.randomBytes(12).toString("hex")}`;
}

/** @param {string} s @param {string} tag  length of the longest suffix of s that is a prefix of tag */
function partialSuffix(s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
  return 0;
}

/**
 * Parse tool arguments. Accept the common ways models get JSON slightly wrong.
 * @param {string} raw
 */
export function parseArgs(raw) {
  const s = (raw || "").trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    // markdown fences or trailing junk after the closing brace
    const unfenced = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const end = unfenced.lastIndexOf("}");
    if (end > 0) {
      try {
        return JSON.parse(unfenced.slice(0, end + 1));
      } catch {
        /* fall through */
      }
    }
    return { _unparsed_arguments: s };
  }
}

export class StreamTranslator {
  /**
   * @param {object} opts
   * @param {string} opts.model                 Model name reported to the client.
   * @param {number} [opts.inputEstimate]
   * @param {Map<string,string>} [opts.toolNames] safe name -> original
   * @param {Map<string, any>} [opts.signatures]  filled with Gemini thought signatures
   */
  constructor(opts) {
    this.model = opts.model;
    this.id = messageId();
    this.inputEstimate = opts.inputEstimate || 0;
    this.toolNames = opts.toolNames || new Map();
    this.signatures = opts.signatures;
    this.index = -1;
    /** @type {null | "text" | "thinking"} */
    this.open = null;
    this.started = false;
    this.thinkState = /** @type {"detect"|"think"|"text"} */ ("detect");
    this.pending = "";
    this.stripLead = false;
    /** @type {Map<string|number, {id: string, generated: boolean, name: string, args: string, extra?: any}>} */
    this.tools = new Map();
    /** @type {Map<number, string>} */
    this.alias = new Map();
    this.lastToolKey = /** @type {string|number|null} */ (null);
    this.finish = /** @type {string|null} */ (null);
    this.usage = /** @type {any} */ (null);
    this.emittedContent = false;
    /** @type {{text: string, thinking: string}} */
    this.totals = { text: "", thinking: "" };
  }

  /** @returns {any[]} */
  start() {
    if (this.started) return [];
    this.started = true;
    return [
      {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputEstimate, output_tokens: 0 },
        },
      },
    ];
  }

  /** @param {"text"|"thinking"} kind @param {string} chunk @param {any[]} out */
  emit(kind, chunk, out) {
    if (!chunk) return;
    if (this.open !== kind) {
      this.closeBlock(out);
      this.index++;
      this.open = kind;
      out.push({
        type: "content_block_start",
        index: this.index,
        content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" },
      });
    }
    this.emittedContent = true;
    this.totals[kind] += chunk;
    out.push({
      type: "content_block_delta",
      index: this.index,
      delta: kind === "text" ? { type: "text_delta", text: chunk } : { type: "thinking_delta", thinking: chunk },
    });
  }

  /** @param {any[]} out */
  closeBlock(out) {
    if (this.open === null) return;
    if (this.open === "thinking") out.push({ type: "content_block_delta", index: this.index, delta: { type: "signature_delta", signature: FF_SIGNATURE } });
    out.push({ type: "content_block_stop", index: this.index });
    this.open = null;
  }

  /** Route `content` text through the <think> detector. @param {string} s @param {any[]} out */
  content(s, out) {
    this.pending += s;
    for (;;) {
      if (this.thinkState === "detect") {
        const t = this.pending.trimStart();
        if (t.length < OPEN.length && OPEN.startsWith(t)) return; // need more input
        if (t.startsWith(OPEN)) {
          this.thinkState = "think";
          this.pending = t.slice(OPEN.length);
          continue;
        }
        this.thinkState = "text";
        continue;
      }
      if (this.thinkState === "think") {
        const end = this.pending.indexOf(CLOSE);
        if (end >= 0) {
          this.emit("thinking", this.pending.slice(0, end), out);
          this.pending = this.pending.slice(end + CLOSE.length);
          this.thinkState = "text";
          this.stripLead = true;
          continue;
        }
        const keep = partialSuffix(this.pending, CLOSE);
        this.emit("thinking", this.pending.slice(0, this.pending.length - keep), out);
        this.pending = this.pending.slice(this.pending.length - keep);
        return;
      }
      if (this.stripLead) {
        // drop the blank lines models put between </think> and the answer
        this.pending = this.pending.replace(/^\s+/, "");
        if (!this.pending) return;
        this.stripLead = false;
      }
      this.emit("text", this.pending, out);
      this.pending = "";
      return;
    }
  }

  /**
   * Feed one parsed OpenAI stream chunk (or a full non-stream response's message as a delta).
   * @param {any} chunk
   * @returns {any[]} Anthropic events
   */
  feed(chunk) {
    const out = this.start();
    if (chunk?.usage) this.usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return out;
    const d = choice.delta || choice.message || {};

    const reasoning = typeof d.reasoning_content === "string" ? d.reasoning_content : typeof d.reasoning === "string" ? d.reasoning : "";
    if (reasoning) this.emit("thinking", reasoning, out);
    if (typeof d.content === "string" && d.content) this.content(d.content, out);

    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        // Prefer the index. Some providers omit it, and some reuse index 0 for every call,
        // so a new id always starts a new call; chunks with neither go to the last call.
        /** @type {string|number} */
        let key;
        if (typeof tc.index === "number") {
          key = this.alias.get(tc.index) ?? tc.index;
          const e = this.tools.get(key);
          if (e && tc.id && !e.generated && tc.id !== e.id) {
            key = `id:${tc.id}`;
            this.alias.set(tc.index, key);
          }
        } else if (tc.id) key = `id:${tc.id}`;
        else key = this.lastToolKey ?? 0;
        let entry = this.tools.get(key);
        if (!entry) {
          entry = { id: tc.id || `toolu_ff${crypto.randomBytes(8).toString("hex")}`, generated: !tc.id, name: "", args: "" };
          this.tools.set(key, entry);
        } else if (tc.id && entry.generated) {
          entry.id = tc.id;
          entry.generated = false;
        }
        if (tc.function?.name) entry.name = entry.name || tc.function.name;
        if (tc.function?.arguments != null) {
          const a = tc.function.arguments;
          entry.args += typeof a === "string" ? a : JSON.stringify(a);
        }
        if (tc.extra_content) entry.extra = tc.extra_content;
        this.lastToolKey = key;
      }
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
    return out;
  }

  /** @returns {any[]} closing events */
  end() {
    const out = this.start();
    // flush anything held back by the <think> detector
    if (this.pending) {
      const rest = this.pending;
      this.pending = "";
      this.emit(this.thinkState === "think" ? "thinking" : "text", rest, out);
    }
    for (const t of this.tools.values()) {
      if (!t.name) continue;
      this.closeBlock(out);
      this.index++;
      const input = parseArgs(t.args);
      const name = this.toolNames.get(t.name) || t.name;
      if (t.extra && this.signatures) this.signatures.set(t.id, t.extra);
      out.push({ type: "content_block_start", index: this.index, content_block: { type: "tool_use", id: t.id, name, input: {} } });
      out.push({ type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      out.push({ type: "content_block_stop", index: this.index });
      this.emittedContent = true;
    }
    this.closeBlock(out);
    const hasTools = [...this.tools.values()].some((t) => t.name);
    const stop = hasTools ? "tool_use" : this.finish === "length" ? "max_tokens" : "end_turn";
    const u = this.usage || {};
    /** @type {any} */
    const usage = {
      input_tokens: u.prompt_tokens ?? this.inputEstimate,
      output_tokens: u.completion_tokens ?? Math.ceil((this.totals.text.length + this.totals.thinking.length) / 4),
    };
    const cached = u.prompt_tokens_details?.cached_tokens;
    if (cached) {
      usage.cache_read_input_tokens = cached;
      usage.input_tokens = Math.max(0, usage.input_tokens - cached);
    }
    this.stopReason = stop;
    this.finalUsage = usage;
    out.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage });
    out.push({ type: "message_stop" });
    return out;
  }
}

/**
 * Collapse a list of Anthropic stream events into a non-streaming Message object.
 * @param {any[]} events
 */
export function eventsToMessage(events) {
  /** @type {any} */
  let msg = null;
  /** @type {any[]} */
  const blocks = [];
  /** @type {string[]} */
  const json = [];
  for (const e of events) {
    if (e.type === "message_start") msg = { ...e.message, content: [] };
    else if (e.type === "content_block_start") {
      blocks[e.index] = { ...e.content_block };
      json[e.index] = "";
    } else if (e.type === "content_block_delta") {
      const b = blocks[e.index];
      if (e.delta.type === "text_delta") b.text += e.delta.text;
      else if (e.delta.type === "thinking_delta") b.thinking += e.delta.thinking;
      else if (e.delta.type === "signature_delta") b.signature = e.delta.signature;
      else if (e.delta.type === "input_json_delta") json[e.index] += e.delta.partial_json;
    } else if (e.type === "content_block_stop") {
      const b = blocks[e.index];
      if (b.type === "tool_use") b.input = json[e.index] ? JSON.parse(json[e.index]) : {};
    } else if (e.type === "message_delta") {
      msg.stop_reason = e.delta.stop_reason;
      msg.stop_sequence = e.delta.stop_sequence ?? null;
      msg.usage = { ...msg.usage, ...e.usage };
    }
  }
  msg.content = blocks.filter(Boolean);
  return msg;
}
