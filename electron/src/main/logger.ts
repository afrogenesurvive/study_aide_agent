import fs from "node:fs";
import path from "node:path";
import { logsDir } from "./paths";
import type { LogEntry, LogLevel, LogSource } from "../shared/ipc-types";

/**
 * In-process log ring buffer plus a JSONL file per day.
 *
 * The renderer subscribes via `subscribe()` (wired to the `log` push channel in
 * `index.ts`) and can page back through `getLogs()` from the Dev panel.
 */

const MAX_ENTRIES = 50_000;
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const buffer: LogEntry[] = [];
let subscribers: Array<(entry: LogEntry) => void> = [];
let minLevel: LogLevel = "info";
let fileStreamReady = false;
let fileStamp = "";

export function setLogLevel(level: LogLevel): void {
  minLevel = LEVEL_WEIGHT[level] === undefined ? "info" : level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

/**
 * Append a log entry. Never throws — logging must not be able to break a caller.
 */
export function addLog(
  source: LogSource,
  level: LogLevel,
  message: string,
  subSource?: string,
): LogEntry | null {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return null;

  const entry: LogEntry = {
    timestamp: Date.now(),
    source,
    level,
    message: stripEmoji(String(message ?? "")),
  };
  if (subSource) entry.subSource = subSource;

  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);

  appendToFile(entry);

  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // A broken subscriber must not take down the process.
    }
  }
  return entry;
}

export function getLogs(limit = 500): LogEntry[] {
  if (limit <= 0) return [...buffer];
  return buffer.slice(-limit);
}

export function clearLogs(): void {
  buffer.length = 0;
}

/** Register a listener; the returned function unsubscribes. */
export function subscribe(fn: (entry: LogEntry) => void): () => void {
  subscribers.push(fn);
  return () => {
    subscribers = subscribers.filter((candidate) => candidate !== fn);
  };
}

export function unsubscribeAll(): void {
  subscribers = [];
}

/** Current log file path, or null if nothing has been written yet. */
export function currentLogFile(): string | null {
  if (!fileStamp) return null;
  return path.join(logsDir(), "live", `${fileStamp}.jsonl`);
}

// ── internals ────────────────────────────────────────────────────────────────

/** Emoji in log lines wrecks alignment in the Dev panel; strip them. */
function stripEmoji(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2700}-\u{27BF}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function appendToFile(entry: LogEntry): void {
  try {
    const dir = path.join(logsDir(), "live");
    const stamp = new Date().toISOString().slice(0, 10);
    if (!fileStreamReady || fileStamp !== stamp) {
      fs.mkdirSync(dir, { recursive: true });
      fileStamp = stamp;
      fileStreamReady = true;
    }
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(path.join(dir, `${stamp}.jsonl`), line, "utf8");
  } catch {
    fileStreamReady = false;
  }
}
