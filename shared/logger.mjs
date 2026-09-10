/**
 * Structured logger (ESM) for standalone Node entry points.
 *
 * The Electron main process has its own in-process ring buffer
 * (`electron/src/main/logger.ts`) because it needs to stream to the renderer.
 * This module is for everything else: scripts, feeds and the future MCP servers.
 *
 * Writes JSONL to `logs/live/<UTC date>.jsonl`, appending one line per entry.
 * Logging must never crash the caller, so every write is try/catch swallowed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let cachedDir = null;

/** Absolute log directory. `LOG_DIR` may be absolute or repo-relative. */
export function getLogDir() {
  if (cachedDir) return cachedDir;
  const configured = process.env.LOG_DIR;
  cachedDir = configured
    ? path.isAbsolute(configured)
      ? configured
      : path.resolve(REPO, configured)
    : path.join(REPO, "logs");
  return cachedDir;
}

function threshold() {
  const level = String(process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[level] ?? LEVELS.info;
}

function consoleEchoEnabled() {
  const value = String(process.env.LOG_CONSOLE || "").toLowerCase();
  return value === "1" || value === "true";
}

function dayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function write(record) {
  try {
    const dir = path.join(getLogDir(), "live");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${dayStamp()}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Never let logging break the caller.
  }
}

/**
 * Write one log entry.
 * @param {{source:string, subSource?:string, level?:"debug"|"info"|"warn"|"error", message:string, data?:any}} entry
 */
export function log({ source = "app", subSource, level = "info", message = "", data } = {}) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold()) return null;
  const record = { ts: new Date().toISOString(), source, level, message };
  if (subSource) record.subSource = subSource;
  if (data !== undefined) record.data = clip(data);
  write(record);
  if (consoleEchoEnabled()) process.stderr.write(`[${record.ts}] [${source}] ${message}\n`);
  return record;
}

/**
 * Log a tool invocation and its result.
 * @param {{name:string, args?:any, response?:any, level?:string}} call
 */
export function toolCall(source, subSource, { name, args, response, level = "info" } = {}) {
  return log({
    source,
    subSource,
    level,
    message: `tool ${name}`,
    data: { args: clip(args), response: clip(response) },
  });
}

/** Log a push/notification dispatch. */
export function notify(source, type, data) {
  return log({ source, subSource: "notify", level: "info", message: `notify ${type}`, data });
}

function clip(value, max = 600) {
  if (value === undefined || value === null) return value;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return "[unserializable]";
  }
}

export { REPO, LEVELS };
