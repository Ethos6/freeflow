// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PROVIDERS, getProvider } from "./catalog.js";

/**
 * @typedef {object} ProviderSettings
 * @property {string} [key]
 * @property {string} [baseUrl]
 * @property {string} [accountId]
 * @property {boolean} [disabled]
 *
 * @typedef {object} CustomProvider
 * @property {string} id
 * @property {string} name
 * @property {string} baseUrl
 * @property {"openai"|"anthropic"} [format]
 *
 * @typedef {object} Route
 * @property {string} model                 "provider/model"
 * @property {Effort} [effort]
 *
 * @typedef {"client"|"off"|"low"|"medium"|"high"} Effort
 *
 * @typedef {object} Config
 * @property {number} version
 * @property {string} host
 * @property {number} port
 * @property {string} adminToken              Protects the admin API.
 * @property {string} [proxyToken]            Optional: required bearer token for /v1 routes.
 * @property {Record<string, ProviderSettings>} providers
 * @property {CustomProvider[]} custom
 * @property {{default?: Route, opus?: Route, sonnet?: Route, haiku?: Route, fable?: Route}} routes
 * @property {Route[]} fallbacks
 * @property {{firstByteMs: number, idleMs: number}} timeouts
 */

export const DEFAULT_PORT = 4141;

export function homeDir() {
  return process.env.FREEFLOW_HOME || path.join(os.homedir(), ".freeflow");
}

export function configPath() {
  return path.join(homeDir(), "config.json");
}

/** @returns {Config} */
export function defaults() {
  return {
    version: 1,
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    adminToken: crypto.randomBytes(24).toString("base64url"),
    providers: {},
    custom: [],
    routes: {},
    fallbacks: [],
    timeouts: { firstByteMs: 120_000, idleMs: 180_000 },
  };
}

/** @returns {Config} */
export function loadConfig() {
  const file = configPath();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (/** @type {any} */ (e).code !== "ENOENT") throw new Error(`freeflow: cannot read ${file}: ${/** @type {Error} */ (e).message}`);
  }
  const base = defaults();
  const cfg = { ...base, ...raw, timeouts: { ...base.timeouts, ...(raw.timeouts || {}) } };
  cfg.providers ||= {};
  cfg.custom ||= [];
  cfg.routes ||= {};
  cfg.fallbacks ||= [];
  if (!raw.adminToken) saveConfig(cfg);
  return cfg;
}

/** Write atomically with owner-only permissions; keys live in this file. @param {Config} cfg */
export function saveConfig(cfg) {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not supported on every filesystem */
  }
}

/**
 * Resolve everything needed to call one provider, merging the catalog, saved settings
 * and environment variables. Returns null for unknown ids.
 * @param {Config} cfg
 * @param {string} id
 */
export function resolveProvider(cfg, id) {
  const custom = cfg.custom.find((c) => c.id === id);
  const cat = getProvider(id);
  if (!cat && !custom) return null;
  const s = cfg.providers[id] || {};
  const envKey = cat?.env ? process.env[cat.env] : undefined;
  const key = s.key || envKey || "";
  let baseUrl = (s.baseUrl || custom?.baseUrl || cat?.base || "").replace(/\/+$/, "");
  if (id === "cloudflare") {
    const acct = s.accountId || process.env.CLOUDFLARE_ACCOUNT_ID;
    baseUrl = acct ? `${baseUrl}/accounts/${encodeURIComponent(acct)}/ai/v1` : "";
  }
  const format = custom?.format || cat?.format || "openai";
  const keyOptional = Boolean(cat?.keyOptional || (custom && !s.key));
  const ready = !s.disabled && Boolean(baseUrl) && (keyOptional || Boolean(key));
  return {
    id,
    name: custom?.name || cat?.name || id,
    tier: cat?.tier || "custom",
    baseUrl,
    key,
    keySource: s.key ? "config" : envKey ? `env:${cat?.env}` : "",
    format,
    quirks: cat?.quirks || {},
    ready,
    disabled: Boolean(s.disabled),
  };
}

/** @param {Config} cfg */
export function allProviderIds(cfg) {
  return [...PROVIDERS.map((p) => p.id), ...cfg.custom.map((c) => c.id)];
}

/** "sk-abc...wxyz" style masking so keys never leave the machine in full. @param {string} key */
export function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
