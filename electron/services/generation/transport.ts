import type { ServiceLogger } from "../types";
import type { RunnerEvent, RunnerJobPayload } from "../../agent-runner/protocol";

/**
 * The runner transport, and the policy that wraps it.
 *
 * `RunnerTransport` is the seam: the real implementation spawns a child process
 * (see `src/main/runner.ts`), and tests substitute a fake so that no test ever
 * spawns anything. Everything in this file is pure — no Electron, no filesystem —
 * which is what makes the single-run guard and the timeout testable at all.
 *
 * The policy the manager enforces:
 *
 *  - **one run at a time.** The child is I/O-bound on a network call, two
 *    concurrent runs would contend for one progress channel, and the review gate
 *    is sequential by nature. A second start is refused with a reason rather than
 *    queued, so the interface can explain itself.
 *  - **a whole-run ceiling**, separate from the per-attempt timeout in the
 *    provider. A run that overruns is cancelled rather than left hanging.
 */

export interface RunnerOutcome {
  ok: boolean;
  error?: string;
}

export interface RunnerTransport {
  /** Run one job to completion. Resolves when the child has exited. */
  start(payload: RunnerJobPayload, onEvent: (event: RunnerEvent) => void): Promise<RunnerOutcome>;
  /** Ask the current run to stop. Safe to call when idle. */
  cancel(): void;
}

export interface RunnerManager extends RunnerTransport {
  isRunning(): boolean;
  activeJobId(): number | null;
  /** Kill immediately, for app shutdown. */
  shutdown(): void;
}

export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

export interface CreateRunnerOptions {
  transport: RunnerTransport;
  /** Whole-run ceiling. Re-read per run so a Settings change applies immediately. */
  getTimeoutMs?: () => number;
  log?: ServiceLogger;
}

export function createRunner(options: CreateRunnerOptions): RunnerManager {
  const { transport, log } = options;
  const getTimeoutMs = options.getTimeoutMs ?? (() => DEFAULT_RUN_TIMEOUT_MS);

  let running = false;
  let jobId: number | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const clearTimeoutTimer = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = null;
  };

  return {
    async start(payload, onEvent) {
      if (running) {
        return {
          ok: false,
          error: `A generation run is already in progress (job ${jobId}). Wait for it to finish or stop it first.`,
        };
      }

      running = true;
      jobId = payload.jobId;

      const limit = getTimeoutMs();
      if (limit > 0) {
        timeoutTimer = setTimeout(() => {
          log?.("warn", `Run exceeded ${limit} ms; stopping it.`);
          transport.cancel();
        }, limit);
      }

      try {
        return await transport.start(payload, onEvent);
      } catch (err) {
        // A transport that throws is a bug in the transport, not a failed run —
        // report it rather than letting it escape into an unhandled rejection.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeoutTimer();
        running = false;
        jobId = null;
      }
    },

    cancel() {
      if (!running) return;
      transport.cancel();
    },

    isRunning: () => running,
    activeJobId: () => jobId,

    shutdown() {
      clearTimeoutTimer();
      if (running) transport.cancel();
      running = false;
      jobId = null;
    },
  };
}
