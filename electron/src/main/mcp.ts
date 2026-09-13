import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";

import { McpManager, type McpServerSpec, type McpTransport, type McpExit } from "../../services/mcp";
import { APP_VERSION, getChildEnv, getConfig } from "./config";
import { addLog } from "./logger";
import { mcpServerPath, nodeSpawnSpec, userDataPath } from "./paths";

/**
 * Spawn I/O for the MCP servers — and nothing else.
 *
 * The policy (when to start, when to recycle, how calls are ordered) lives in
 * `services/mcp/manager.ts`, which is Electron-free and unit-tested with a fake
 * transport. This file is deliberately the half that cannot be tested: a
 * `spawn` call, line buffering, and killing a child.
 *
 * `nodeSpawnSpec` is reused rather than reimplemented, so a server runs on the
 * same Node as the app (`process.execPath` + `ELECTRON_RUN_AS_NODE`) instead of
 * whatever `node` happens to be on PATH — which on this machine is v18, below
 * what the MCP SDK supports.
 */

/** A child that never emits a newline must not grow the parent's buffer forever. */
const MAX_LINE_BUFFER = 1_000_000;

/** How long a server gets to exit on SIGTERM before it is killed outright. */
const SHUTDOWN_GRACE_MS = 5_000;

/** Split a stream into lines without assuming a chunk boundary. */
function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_LINE_BUFFER) {
      onLine(buffer.slice(0, 200));
      buffer = "";
    }
  };
}

export interface SpawnTransportOptions {
  /** Absolute path to the server entry point. */
  scriptPath: string;
  /** Everything the child should see in `process.env`. */
  env: Record<string, string>;
  /** Each stderr line, for the log. Never the protocol channel. */
  onStderr?: (line: string) => void;
}

/**
 * A stdio MCP transport backed by a child process.
 *
 * stdout is the protocol channel and is line-buffered here; stderr is a log
 * stream and is passed straight through. A child that writes a stray line to
 * stdout produces a parse warning rather than a crash, because one bad line
 * should cost one message.
 */
export function createSpawnTransport(options: SpawnTransportOptions): McpTransport {
  const spec = nodeSpawnSpec(options.scriptPath);
  let child: ChildProcessWithoutNullStreams | null = null;
  let lineHandler: ((line: string) => void) | null = null;
  let exitHandler: ((info: McpExit) => void) | null = null;
  let exited = false;

  const noteExit = (info: McpExit) => {
    if (exited) return;
    exited = true;
    child = null;
    exitHandler?.(info);
  };

  return {
    onLine(handler) {
      lineHandler = handler;
    },

    onExit(handler) {
      exitHandler = handler;
    },

    start() {
      return new Promise<void>((resolve, reject) => {
        if (child) {
          resolve();
          return;
        }

        const proc = spawn(spec.command, spec.args, {
          cwd: path.dirname(options.scriptPath),
          // The child inherits nothing implicitly: MCP's own transport passes a
          // small whitelist, and an Electron main process has a large and
          // irrelevant environment. Ours is built explicitly by the caller.
          env: { ...options.env, ...spec.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        child = proc;
        exited = false;

        proc.stdout.on("data", lineSplitter((line) => lineHandler?.(line)));
        if (options.onStderr) {
          proc.stderr.on("data", lineSplitter(options.onStderr));
        }

        proc.on("error", (err) => {
          // A spawn failure (ENOENT, EACCES) arrives here, not as a throw.
          child = null;
          reject(new Error(`Could not start ${path.basename(path.dirname(options.scriptPath))}: ${err.message}`));
        });

        proc.on("exit", (code, signal) => noteExit({ code, signal }));
        proc.on("close", (code, signal) => noteExit({ code, signal }));

        // `spawn` means the process started; `error` may still arrive later.
        proc.once("spawn", () => resolve());
      });
    },

    send(line) {
      return new Promise<void>((resolve, reject) => {
        const proc = child;
        if (!proc || !proc.stdin || proc.stdin.destroyed) {
          reject(new Error("The server is not running."));
          return;
        }
        // A `false` return means the pipe is full; waiting for the callback keeps
        // a large payload from being silently dropped.
        proc.stdin.write(line, (err) => (err ? reject(err) : resolve()));
      });
    },

    close() {
      return new Promise<void>((resolve) => {
        const proc = child;
        if (!proc) {
          resolve();
          return;
        }
        child = null;

        let settled = false;
        let termTimer: ReturnType<typeof setTimeout> | null = null;
        let killTimer: ReturnType<typeof setTimeout> | null = null;

        const finish = () => {
          if (settled) return;
          settled = true;
          if (termTimer) clearTimeout(termTimer);
          if (killTimer) clearTimeout(killTimer);
          resolve();
        };

        proc.once("exit", finish);
        if (proc.exitCode !== null || proc.signalCode !== null) {
          finish();
          return;
        }

        try {
          proc.stdin.end();
        } catch {
          // Already ended.
        }

        termTimer = setTimeout(() => {
          try {
            proc.kill("SIGTERM");
          } catch {
            // Already gone.
          }
        }, 200);
        killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          // Resolve regardless: a hung close would block quitting.
          finish();
        }, SHUTDOWN_GRACE_MS);
      });
    },
  };
}

// ── the manager ──────────────────────────────────────────────────────────────

let manager: McpManager | null = null;

/**
 * A fingerprint of everything a child reads from its environment.
 *
 * Hashed rather than concatenated so it can never be mistaken for a credential
 * and end up in a log line or an error. It is only ever compared.
 */
function credentialFingerprint(): string {
  const config = getConfig();
  const material = [
    config.GMAIL_CLIENT_ID,
    config.GMAIL_CLIENT_SECRET,
    config.GMAIL_REFRESH_TOKEN,
    config.GMAIL_USER,
    config.GOOGLE_CALENDAR_ID,
  ].join("\u0000");
  return createHash("sha256").update(material).digest("hex");
}

/** The environment a server runs with: the shared child env plus the calendar index. */
function serverEnv(): Record<string, string> {
  return {
    ...getChildEnv(),
    // The calendar server resolves friendly names from here. It has no Electron
    // `app` to ask, so the path is handed to it.
    CALENDARS_FILE: userDataPath("calendars.json"),
  };
}

function serverSpec(name: string): McpServerSpec {
  return {
    name,
    createTransport: () =>
      createSpawnTransport({
        scriptPath: mcpServerPath(name, "index.js"),
        env: serverEnv(),
        onStderr: (line) => addLog("mcp", "debug", `${name}: ${line}`),
      }),
    fingerprint: credentialFingerprint,
  };
}

/**
 * Create the manager.
 *
 * Spawns nothing: a server starts on the first tool call, so an app that never
 * touches Google never starts a child.
 */
export function initMcp(): void {
  if (manager) return;
  manager = new McpManager([serverSpec("gmail"), serverSpec("calendar")], {
    version: APP_VERSION,
    log: (level, message) => addLog("mcp", level, message),
  });
}

/** The manager, or null if `initMcp` has not run (e.g. in a unit test). */
export function tryGetMcp(): McpManager | null {
  return manager;
}

/** Close every child and forget the manager. Called from `before-quit`. */
export async function stopMcp(): Promise<void> {
  const current = manager;
  manager = null;
  if (!current) return;
  try {
    await current.stopAll();
  } catch (err) {
    addLog("mcp", "warn", `Could not stop the MCP servers cleanly: ${(err as Error).message}`);
  }
}
