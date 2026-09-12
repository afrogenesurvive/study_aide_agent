import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { addLog } from "./logger";
import { configDefaultsPath, configPath, repoRootPath, sharedDir, userDataPath } from "./paths";
import {
  CONFIG_KEYS,
  DEFAULTS,
  SECRET_CONFIG_KEYS,
  checkConfigValues,
  effectiveProvider,
  maskSecret,
  mergeConfigLayers,
  parseDotEnv,
  pruneEmpty,
} from "../shared/config-defaults";

// Re-exported so callers only need to reach for `main/config`.
export {
  CONFIG_KEYS,
  DEFAULTS,
  SECRET_CONFIG_KEYS,
  checkConfigValues,
  effectiveProvider,
  maskSecret,
} from "../shared/config-defaults";
export type { LlmProvider } from "../shared/config-defaults";

import type {
  AppConfig,
  ConfigCheckResult,
  ConfigFileResult,
  ConfigSourcesPayload,
  ConfigValueSource,
} from "../shared/ipc-types";

/**
 * Three-layer configuration.
 *
 * Precedence (highest → lowest):  <userData>/config.json  >  process.env / .env  >  DEFAULTS
 *
 * Everything is a string so the whole config can round-trip through `config.json`
 * and be handed to child processes as environment variables.
 *
 * Known simplification vs. the reference implementation: no at-rest encryption
 * and no licence gating. `config.json` is plaintext in userData and gitignored.
 */

// ── disk layer ───────────────────────────────────────────────────────────────

let cachedConfig: AppConfig | null = null;
let cachedUserValues: AppConfig | null = null;
let dotEnvLoaded = false;

/**
 * Load `.env` into `process.env` without clobbering anything already set.
 *
 * Dev reads `<repo>/.env`; packaged reads `<userData>/.env`. Inline `#` comments
 * are intentionally NOT stripped — values like `APPEARANCE_ACCENT_COLOR=#2f81f7`
 * would otherwise be truncated.
 */
export function loadDotEnv(): { path: string; loaded: number } {
  if (dotEnvLoaded) return { path: "", loaded: 0 };
  dotEnvLoaded = true;

  const target = app.isPackaged ? userDataPath(".env") : repoRootPath(".env");
  let loaded = 0;
  try {
    if (!fs.existsSync(target)) return { path: target, loaded };
    const parsed = parseDotEnv(fs.readFileSync(target, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loaded += 1;
      }
    }
  } catch (err) {
    addLog("main", "warn", `Could not read ${target}: ${describe(err)}`);
  }
  return { path: target, loaded };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** env layer: only non-empty process.env values that we actually know about. */
export function getEnvOverrides(): AppConfig {
  const out: AppConfig = {};
  for (const key of CONFIG_KEYS) {
    const value = process.env[key];
    if (value === undefined || value === null || String(value) === "") continue;
    out[key] = String(value);
  }
  return out;
}

/** user layer: `<userData>/config.json`. Corrupt or missing → `{}`. */
export function parseUserConfig(): AppConfig {
  if (cachedUserValues) return cachedUserValues;
  const target = configPath();
  try {
    if (!fs.existsSync(target)) {
      cachedUserValues = {};
      return cachedUserValues;
    }
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      addLog("main", "warn", "config.json is not a flat object; ignoring it.");
      cachedUserValues = {};
      return cachedUserValues;
    }
    cachedUserValues = pruneEmpty(parsed);
  } catch (err) {
    addLog("main", "warn", `config.json is unreadable (${describe(err)}); using defaults.`);
    cachedUserValues = {};
  }
  return cachedUserValues;
}

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;
  const user = parseUserConfig();
  const env = getEnvOverrides();
  cachedConfig = mergeConfigLayers(user, env, DEFAULTS);
  return cachedConfig;
}

/** Same merge, but annotated per key so the Settings panel can show provenance. */
export function getConfigWithSources(): ConfigSourcesPayload {
  const user = parseUserConfig();
  const env = getEnvOverrides();
  const values: ConfigSourcesPayload["values"] = {};

  for (const key of CONFIG_KEYS) {
    let source: ConfigValueSource = "default";
    let value = DEFAULTS[key] ?? "";
    if (key in env) {
      source = "environment";
      value = env[key];
    }
    if (key in user) {
      source = "user_config";
      value = user[key];
    }
    values[key] = {
      value: SECRET_CONFIG_KEYS.has(key) ? maskSecret(value) : value,
      source,
      secret: SECRET_CONFIG_KEYS.has(key),
    };
  }

  return {
    values,
    configPath: configPath(),
    defaultsPath: configDefaultsPath(),
    count: CONFIG_KEYS.length,
  };
}

/** Validate the effective config, for the Settings status banner. */
export function checkConfig(): ConfigCheckResult {
  return checkConfigValues(getConfig());
}

export function invalidateConfigCache(): void {
  cachedConfig = null;
  cachedUserValues = null;
}

function writeUserConfig(values: AppConfig): ConfigFileResult {
  try {
    const target = configPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, target);
    invalidateConfigCache();
    return { success: true, filePath: target, count: Object.keys(values).length };
  } catch (err) {
    return { success: false, error: describe(err) };
  }
}

/**
 * Merge values into `config.json`, preserving keys already on disk.
 * Empty strings are treated as "clear this override" and are skipped.
 */
export function saveConfig(values: Record<string, unknown>): ConfigFileResult {
  const current = { ...parseUserConfig() };
  const incoming = pruneEmpty(values);
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in DEFAULTS)) continue; // ignore unknown keys rather than persisting junk
    current[key] = value;
  }
  const result = writeUserConfig(current);
  if (result.success) syncConfigToEnv();
  return result;
}

/** Write exactly the given keys (used by import). Unknown keys are dropped. */
export function replaceConfig(values: Record<string, unknown>): ConfigFileResult {
  const cleaned = pruneEmpty(values);
  const exact: AppConfig = {};
  for (const key of CONFIG_KEYS) {
    if (key in cleaned) exact[key] = cleaned[key];
  }
  const result = writeUserConfig(exact);
  if (result.success) syncConfigToEnv();
  return result;
}

export function clearConfig(): ConfigFileResult {
  const result = writeUserConfig({});
  if (result.success) syncConfigToEnv();
  return result;
}

export function exportConfig(): string {
  const payload = { ...getConfig() };
  for (const key of SECRET_CONFIG_KEYS) delete payload[key];
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function importConfig(raw: string): ConfigFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { success: false, error: `Invalid JSON: ${describe(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { success: false, error: "Config must be a flat JSON object" };
  }
  return replaceConfig(parsed as Record<string, unknown>);
}

// ── shipped defaults snapshot + restore ──────────────────────────────────────

export function readUserConfigDefaults(): AppConfig | null {
  try {
    const target = configDefaultsPath();
    if (!fs.existsSync(target)) return null;
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return pruneEmpty(parsed);
  } catch {
    return null;
  }
}

/** Snapshot the *current* effective config as the restore target. */
export function setUserConfigDefaults(): ConfigFileResult {
  const snapshot: AppConfig = {};
  for (const key of CONFIG_KEYS) {
    if (SECRET_CONFIG_KEYS.has(key)) continue;
    if (key.startsWith("_")) continue;
    snapshot[key] = DEFAULTS[key] ?? "";
  }
  try {
    const target = configDefaultsPath();
    fs.writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return { success: true, filePath: target, count: Object.keys(snapshot).length };
  } catch (err) {
    return { success: false, error: describe(err) };
  }
}

export function restoreUserConfigDefaults(): ConfigFileResult {
  const defaults = readUserConfigDefaults();
  if (!defaults) return { success: false, error: "No defaults snapshot has been written yet." };
  return replaceConfig(defaults);
}

// ── child processes ──────────────────────────────────────────────────────────

/**
 * Environment handed to spawned children (feeds, MCP servers, the agent runner).
 *
 * Uses the raw user layer rather than the merged config so that a non-empty
 * DEFAULTS value (e.g. `"false"`) can't mask a real environment variable.
 */
export function getChildEnv(): Record<string, string> {
  const user = parseUserConfig();
  const merged = getConfig();
  const provider = effectiveProvider(merged);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  for (const key of CONFIG_KEYS) {
    const chosen = user[key] || process.env[key] || DEFAULTS[key] || "";
    if (chosen !== "") env[key] = chosen;
  }

  env.LLM_PROVIDER = provider;
  env.STUDY_DB_PATH = user.STUDY_DB_PATH || process.env.STUDY_DB_PATH || "";
  env.LOG_DIR = userDataPath("logs", "children");
  // Absolute, because the child has no Electron `app` to resolve resources with.
  env.SHARED_DIR = sharedDir();
  env.APP_VERSION = APP_VERSION;
  return env;
}

/**
 * Push the effective config into `process.env` so that modules which resolve
 * their settings per call (notably `shared/model-provider.mjs`) always see what
 * the Settings panel shows — no restart required.
 */
export function syncConfigToEnv(): void {
  const config = getConfig();
  for (const [key, value] of Object.entries(config)) {
    if (value === "" || value === undefined) continue;
    process.env[key] = value;
  }
  process.env.LLM_PROVIDER = effectiveProvider(config);
}

export const APP_VERSION = appVersion();

function appVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return "0.0.0";
  }
}
