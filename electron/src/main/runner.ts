import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { addLog } from "./logger";
import { getChildEnv, getConfig } from "./config";
import { nodeSpawnSpec } from "./paths";
import {
  parseEventLine,
  type RunnerEvent,
  type RunnerJobPayload,
} from "../../agent-runner/protocol";
import {
  createRunner,
  DEFAULT_RUN_TIMEOUT_MS,
  type RunnerManager,
  type RunnerOutcome,
  type RunnerTransport,
} from "../../services/generation/transport";

/**
 * Spawn manager for the agent runner.
 *
 * Only the I/O lives here: spawn the child, feed it the job, stream its events
 * back, terminate it. The policy — one run at a time, the whole-run timeout — is
 * in `services/generation/transport.ts`, which imports no Electron and is
 * therefore unit-testable. Tests substitute a fake transport, so no test ever
 * spawns a process.
 */

/** How long a child gets to exit on SIGTERM before it is killed outright. */
const DEFAULT_KILL_GRACE_MS = 5_000;
/** Only the tail of stderr is kept, for the failure message. */
const STDERR_TAIL_LINES = 20;

/**
 * Where the compiled child lives.
 *
 * `__dirname` is `dist/src/main` at runtime, so this resolves to
 * `dist/agent-runner/index.js` in a dev build and in a packaged app alike — the
 * relative layout is identical either way.
 */
export function runnerScriptPath(): string {
  return path.join(__dirname, "..", "..", "agent-runner", "index.js");
}

// ── the real transport ───────────────────────────────────────────────────────

export function createSpawnTransport(): RunnerTransport {
  let child: ChildProcess | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let cancelled = false;

  const clearKillTimer = () => {
    if (killTimer) clearTimeout(killTimer);
    killTimer = null;
  };

  /**
   * SIGTERM, then SIGKILL if the child is still alive after the grace period.
   *
   * The provider layer honours cancellation, so a well-behaved child exits on
   * SIGTERM; the escalation is for the case where it is blocked in a way that
   * does not check.
   */
  const terminate = (reason: string) => {
    if (!child || child.exitCode !== null) return;
    addLog("generate", "info", `Stopping the agent runner: ${reason}`);
    child.kill("SIGTERM");
    clearKillTimer();
    killTimer = setTimeout(() => {
      if (child && child.exitCode === null) {
        addLog("generate", "warn", "Agent runner did not exit on SIGTERM; killing it.");
        child.kill("SIGKILL");
      }
    }, DEFAULT_KILL_GRACE_MS);
  };

  return {
    start(payload, onEvent) {
      cancelled = false;

      const spec = nodeSpawnSpec(runnerScriptPath());
      const env = { ...getChildEnv(), ...spec.env };
      const proc = spawn(spec.command, spec.args, { env, stdio: ["pipe", "pipe", "pipe"] });
      child = proc;

      let sawDone = false;
      let failure: string | null = null;
      const stderrTail: string[] = [];

      let outBuffer = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        // Pipes split at arbitrary byte boundaries, so events are reassembled
        // from a line buffer rather than assuming one chunk is one event.
        outBuffer += chunk.toString("utf8");
        const lines = outBuffer.split("\n");
        outBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseEventLine(line);
          if (!event) {
            // A dependency writing to stdout would land here. Losing an
            // informational line beats failing a run that is working.
            if (line.trim()) addLog("generate", "debug", `Unparsed runner output: ${line.slice(0, 200)}`);
            continue;
          }
          if (event.type === "done") sawDone = true;
          if (event.type === "error") failure = event.message;
          onEvent(event);
        }
      });

      let errBuffer = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        errBuffer += chunk.toString("utf8");
        const lines = errBuffer.split("\n");
        errBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const text = line.trim();
          if (!text) continue;
          stderrTail.push(text);
          if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
          addLog("generate", "debug", `runner: ${text.slice(0, 300)}`);
        }
      });

      proc.on("error", (err) => {
        failure = `Could not start the agent runner: ${err.message}`;
      });

      // The payload is the whole job; there is no further input.
      proc.stdin?.on("error", () => {
        // A child that dies before reading stdin makes this write fail; the exit
        // handler below reports the real reason.
      });
      proc.stdin?.end(JSON.stringify(payload));

      return new Promise<RunnerOutcome>((resolve) => {
        proc.on("close", (code, signal) => {
          clearKillTimer();
          child = null;

          if (cancelled) {
            resolve({ ok: false, error: "Run cancelled." });
            return;
          }
          if (sawDone) {
            resolve({ ok: true });
            return;
          }
          if (failure) {
            resolve({ ok: false, error: failure });
            return;
          }

          const tail = stderrTail.length ? ` Last output: ${stderrTail.slice(-3).join(" | ")}` : "";
          resolve({
            ok: false,
            error: `The agent runner exited ${signal ? `on ${signal}` : `with code ${code}`} without finishing.${tail}`,
          });
        });
      });
    },

    cancel() {
      cancelled = true;
      terminate("cancelled by the user");
    },
  };
}

// ── main-process singleton ───────────────────────────────────────────────────

function defaultRunTimeoutMs(): number {
  const parsed = Number.parseInt(getConfig().AGENT_RUNNER_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_TIMEOUT_MS;
}

// ── main-process singleton ───────────────────────────────────────────────────

let runner: RunnerManager | null = null;

/** Create the runner. Idempotent, mirroring `initDatabase()`. */
export function initRunner(): RunnerManager {
  if (!runner) {
    runner = createRunner({
      transport: createSpawnTransport(),
      getTimeoutMs: defaultRunTimeoutMs,
      log: (level, message) => addLog("generate", level, message),
    });
  }
  return runner;
}

export function tryGetRunner(): RunnerManager | null {
  return runner;
}

/** Kill any in-flight run. Called from `before-quit`. */
export function killActiveRun(): void {
  runner?.shutdown();
}
