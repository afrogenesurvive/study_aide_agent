/**
 * Shared config loader (CommonJS).
 *
 * Resolution order per key:  config.json  >  .env  >  DEFAULTS
 *
 * This module is consumed by *standalone* Node entry points (scripts, future MCP
 * servers, feed generators). The Electron main process deliberately does NOT use
 * it: there, `<userData>/config.json` is the source of truth (see
 * `electron/src/main/config.ts`) and values are pushed into `process.env` by
 * `syncConfigToEnv()` before any child process or provider call.
 *
 * Files are anchored to the repo root via `__dirname`, never to `process.cwd()`,
 * so a script started from a subfolder still finds them.
 *
 * Kept as .cjs so it can be `require`d from CommonJS and default-imported from ESM.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(REPO, "config.json");
const ENV_PATH = path.join(REPO, ".env");

/** Hardcoded fallbacks — the lowest layer of the config stack. */
const DEFAULTS = {
  // LLM
  LLM_PROVIDER: "deepseek",
  LLM_TEMPERATURE: "0.1",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  OPENAI_MODEL: "gpt-4o",
  ANTHROPIC_MODEL: "claude-sonnet-4-5",
  ANTHROPIC_MAX_TOKENS: "4096",
  OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  OLLAMA_NUM_CTX: "32768",
  // Google
  GMAIL_USER: "me",
  GOOGLE_CALENDAR_ID: "primary",
  // Notifications
  NOTIFY_CHANNELS: "email,calendar,push",
  NOTIFY_AUTOSEND: "false",
  REMINDER_OFFSETS: "1440,60,10",
  DAILY_DIGEST_TIME: "08:00",
  WEEKLY_REVIEW_DAY: "saturday",
  // Study
  DAILY_STUDY_TARGET: "90",
  SESSION_LENGTH: "20",
  BREAK_LENGTH: "5",
  TIMEZONE: "America/Jamaica",
  // FSRS
  FSRS_DESIRED_RETENTION: "0.9",
  FSRS_MAX_INTERVAL: "365",
  NEW_CARDS_PER_DAY: "20",
  // Syllabus
  SYLLABUS_IMPORT_FORMAT: "auto",
  // Appearance
  APPEARANCE_THEME: "system",
  APPEARANCE_ACCENT_COLOR: "#2f81f7",
  APPEARANCE_FONT_SIZE: "medium",
  APPEARANCE_SIDEBAR_WIDTH: "260",
  // Ops
  LOG_LEVEL: "info",
  USAGE_TRACKING_ENABLED: "true",
};

function hasConfigJson() {
  return fs.existsSync(CONFIG_PATH);
}

/** Parse a .env blob. Tolerates `export `, blank lines, `#` comments and quotes. */
function parseEnv(text) {
  const out = {};
  if (typeof text !== "string") return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

function readEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) return {};
    return parseEnv(fs.readFileSync(ENV_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Read config.json. Throws on syntactically bad JSON or a non-flat object. */
function readConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.json must contain a flat JSON object");
  }
  const values = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("_")) continue; // `_comment` and friends
    if (value === null || value === undefined) continue;
    values[key] = String(value);
  }
  return values;
}

/**
 * Effective config for a CLI entry point.
 * @returns {{present:boolean, source:"config.json"|".env"|"defaults", values:object, error?:string}}
 */
function readEffective() {
  const env = readEnv();
  let file = null;
  let error;
  try {
    file = readConfigFile();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  if (file) {
    return { present: true, source: "config.json", values: { ...DEFAULTS, ...env, ...file }, error };
  }
  const present = Object.keys(env).length > 0;
  return {
    present,
    source: present ? ".env" : "defaults",
    values: { ...DEFAULTS, ...env },
    error,
  };
}

/**
 * Per-key source annotation, for a settings UI.
 * @returns {{present:boolean, source:string, configPath:string, count:number, values:Record<string,{value:string,source:string}>, error?:string}}
 */
function readWithSources(defaults = DEFAULTS) {
  const env = readEnv();
  let file = null;
  let error;
  try {
    file = readConfigFile();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const keys = new Set([
    ...Object.keys(defaults),
    ...Object.keys(env),
    ...Object.keys(file || {}),
  ]);
  const values = {};
  for (const key of keys) {
    if (file && Object.prototype.hasOwnProperty.call(file, key)) {
      values[key] = { value: file[key], source: "user_config" };
    } else if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== "") {
      values[key] = { value: env[key], source: "environment" };
    } else {
      values[key] = { value: defaults[key] ?? "", source: "default" };
    }
  }
  return {
    present: Boolean(file) || Object.keys(env).length > 0,
    source: file ? "config.json" : Object.keys(env).length ? ".env" : "defaults",
    configPath: CONFIG_PATH,
    count: keys.size,
    values,
    error,
  };
}

/** Non-destructive merge into `target` (defaults to process.env). */
function loadEnvInto(target = process.env) {
  const env = readEnv();
  const loadedKeys = [];
  for (const [key, value] of Object.entries(env)) {
    if (!(key in target)) {
      target[key] = value;
      loadedKeys.push(key);
    }
  }
  return { source: ".env", loadedKeys };
}

/** Destructive overlay into `target`. */
function applyValues(values, target = process.env) {
  for (const [key, value] of Object.entries(values || {})) {
    if (value === null || value === undefined) continue;
    target[key] = String(value);
  }
}

/** Write the whole config.json (pretty, trailing newline). */
function saveConfig(values) {
  try {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(values, null, 2)}\n`, "utf8");
    return { ok: true, path: CONFIG_PATH, count: Object.keys(values || {}).length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Merge into config.json, preserving on-disk keys.
 * Empty strings / null / undefined mean "revert to .env or default" and are skipped.
 */
function mergeConfig(values) {
  let current = {};
  try {
    current = readConfigFile() || {};
  } catch {
    current = {};
  }
  let changed = 0;
  for (const [key, value] of Object.entries(values || {})) {
    if (value === null || value === undefined || value === "") continue;
    const next = String(value);
    if (current[key] !== next) changed += 1;
    current[key] = next;
  }
  const result = saveConfig(current);
  return { ...result, changed };
}

/** Set one key, writing to config.json when present, else appending to .env. */
function setKey(key, value) {
  if (hasConfigJson()) {
    const result = mergeConfig({ [key]: value });
    return result.ok
      ? { ok: true, target: "config.json" }
      : { ok: false, target: "config.json", error: result.error };
  }
  try {
    let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, line);
    else text = `${text.replace(/\s*$/, "")}\n${line}\n`;
    fs.writeFileSync(ENV_PATH, text, "utf8");
    return { ok: true, target: ".env" };
  } catch (err) {
    return { ok: false, target: ".env", error: err instanceof Error ? err.message : String(err) };
  }
}

function exportConfig() {
  return `${JSON.stringify(readEffective().values, null, 2)}\n`;
}

/** Import a JSON blob: persist it and apply it to `target`. */
function importConfig(raw, target = process.env) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Config must be a flat JSON object" };
  }
  const flat = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("_") || value === null || value === undefined) continue;
    flat[key] = String(value);
  }
  const result = saveConfig(flat);
  if (!result.ok) return result;
  applyValues(flat, target);
  return { ok: true, path: CONFIG_PATH, count: Object.keys(flat).length, source: "config.json" };
}

module.exports = {
  REPO,
  CONFIG_PATH,
  ENV_PATH,
  DEFAULTS,
  hasConfigJson,
  parseEnv,
  readEnv,
  readConfigFile,
  readEffective,
  readWithSources,
  loadEnvInto,
  applyValues,
  saveConfig,
  mergeConfig,
  setKey,
  exportConfig,
  importConfig,
};
