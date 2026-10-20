// @ts-check
import { parseModelRef } from "./catalog.js";
import { resolveProvider } from "./config.js";

/**
 * Model routing and health.
 *
 * A request names a model. freeflow turns that into an ordered list of candidates:
 * the route for the request's tier (or the exact provider/model it names), then the
 * fallback chain. Providers that recently failed are put in a cooldown and moved to
 * the back of the list, so one dead provider costs one failed attempt, not one per turn.
 */

const TIERS = /** @type {const} */ (["fable", "opus", "sonnet", "haiku"]);

/** @param {string} model @returns {"fable"|"opus"|"sonnet"|"haiku"|null} */
export function tierOf(model) {
  const m = String(model || "").toLowerCase();
  for (const t of TIERS) if (m.includes(t)) return t;
  return null;
}

export class Health {
  constructor() {
    /** @type {Map<string, {until: number, failures: number, reason: string}>} */
    this.cool = new Map();
  }

  /** @param {string} key */
  isCooling(key, now = Date.now()) {
    const c = this.cool.get(key);
    return Boolean(c && c.until > now);
  }

  /** @param {string} key */
  remaining(key, now = Date.now()) {
    const c = this.cool.get(key);
    return c ? Math.max(0, c.until - now) : 0;
  }

  /**
   * @param {string} key
   * @param {import("./upstream.js").UpstreamError} err
   */
  fail(key, err, now = Date.now()) {
    if (err.kind === "aborted" || err.kind === "request") return;
    const prev = this.cool.get(key);
    const failures = (prev?.failures || 0) + 1;
    const base = err.kind === "auth" ? 10 * 60_000 : err.kind === "model" ? 30 * 60_000 : err.kind === "rate" ? 20_000 : 10_000;
    const backoff = Math.min(base * 2 ** (failures - 1), 15 * 60_000);
    const wait = err.retryAfterMs != null ? Math.min(Math.max(err.retryAfterMs, 1000), 30 * 60_000) : backoff;
    this.cool.set(key, { until: now + wait, failures, reason: `${err.kind}: ${err.message}`.slice(0, 200) });
  }

  /** @param {string} key */
  ok(key) {
    this.cool.delete(key);
  }

  snapshot(now = Date.now()) {
    return [...this.cool]
      .filter(([, c]) => c.until > now)
      .map(([key, c]) => ({ key, secondsLeft: Math.ceil((c.until - now) / 1000), failures: c.failures, reason: c.reason }));
  }
}

/**
 * The cooldown key: rate limits and bad keys are per provider; a missing model is per model.
 * @param {string} provider @param {string} ref  provider/model @param {string} [kind]
 */
export function healthKey(provider, ref, kind) {
  return kind === "model" ? ref : provider;
}

/**
 * @typedef {object} Candidate
 * @property {string} ref              provider/model
 * @property {string} provider
 * @property {string} model
 * @property {import("./config.js").Effort} [effort]
 * @property {NonNullable<ReturnType<typeof resolveProvider>>} p
 */

/**
 * @param {import("./config.js").Config} cfg
 * @param {string} requested                 Model id from the client.
 * @param {Health} health
 * @returns {{ candidates: Candidate[], skipped: string[], tier: string | null }}
 */
export function plan(cfg, requested, health) {
  /** @type {import("./config.js").Route[]} */
  const wanted = [];
  const direct = parseModelRef(requested);
  const tier = tierOf(requested);
  if (direct && resolveProvider(cfg, direct.provider)) wanted.push({ model: requested });
  else if (tier && cfg.routes[tier]?.model) wanted.push(/** @type {any} */ (cfg.routes[tier]));
  if (!wanted.length && cfg.routes.default?.model) wanted.push(cfg.routes.default);
  // A tier route that isn't the default still falls back to the default before the chain.
  if (wanted.length && cfg.routes.default?.model && wanted[0].model !== cfg.routes.default.model) wanted.push(cfg.routes.default);
  wanted.push(...cfg.fallbacks);

  /** @type {Candidate[]} */
  const ready = [];
  /** @type {Candidate[]} */
  const cooling = [];
  const skipped = [];
  const seen = new Set();
  for (const r of wanted) {
    if (!r?.model || seen.has(r.model)) continue;
    seen.add(r.model);
    const ref = parseModelRef(r.model);
    if (!ref) continue;
    const p = resolveProvider(cfg, ref.provider);
    if (!p || !p.ready) {
      skipped.push(`${r.model} (${p ? (p.disabled ? "disabled" : "no key") : "unknown provider"})`);
      continue;
    }
    const c = { ref: r.model, provider: ref.provider, model: ref.model, effort: r.effort, p };
    if (health.isCooling(ref.provider) || health.isCooling(r.model)) cooling.push(c);
    else ready.push(c);
  }
  // Cooling candidates are still tried last, soonest-recovering first: better than failing outright.
  cooling.sort((a, b) => Math.max(health.remaining(a.provider), health.remaining(a.ref)) - Math.max(health.remaining(b.provider), health.remaining(b.ref)));
  return { candidates: [...ready, ...cooling], skipped, tier };
}
