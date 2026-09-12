import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunner,
  DEFAULT_RUN_TIMEOUT_MS,
  type RunnerOutcome,
  type RunnerTransport,
} from "../services/generation/transport";
import type { RunnerEvent } from "../agent-runner/protocol";
import { buildRunnerPayload } from "./helpers/runner-fixtures";

/**
 * The manager's policy, with the process spawn replaced by a fake.
 *
 * This is the whole reason `RunnerTransport` exists as a seam: the real
 * implementation needs Electron, a child process and a network, none of which
 * belong in a unit test.
 */

interface FakeTransport extends RunnerTransport {
  starts: number;
  cancels: number;
  lastEvents: RunnerEvent[];
  /** Resolve the pending `start` with this outcome. */
  release: (outcome: RunnerOutcome) => void;
  emit: (event: RunnerEvent) => void;
}

function fakeTransport(): FakeTransport {
  let resolveCurrent: ((outcome: RunnerOutcome) => void) | null = null;
  let onEventCurrent: ((event: RunnerEvent) => void) | null = null;

  const transport: FakeTransport = {
    starts: 0,
    cancels: 0,
    lastEvents: [],
    release(outcome) {
      resolveCurrent?.(outcome);
    },
    emit(event) {
      transport.lastEvents.push(event);
      onEventCurrent?.(event);
    },
    start(_payload, onEvent) {
      transport.starts += 1;
      onEventCurrent = onEvent;
      return new Promise<RunnerOutcome>((resolve) => {
        resolveCurrent = resolve;
      });
    },
    cancel() {
      transport.cancels += 1;
    },
  };

  return transport;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createRunner", () => {
  it("delegates a run to the transport and returns its outcome", async () => {
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 0 });

    const outcome = runner.start(buildRunnerPayload(), () => undefined);
    transport.release({ ok: true });

    await expect(outcome).resolves.toEqual({ ok: true });
    expect(transport.starts).toBe(1);
  });

  it("returns a failure outcome rather than rejecting", async () => {
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 0 });

    const outcome = runner.start(buildRunnerPayload(), () => undefined);
    transport.release({ ok: false, error: "no api key" });

    await expect(outcome).resolves.toEqual({ ok: false, error: "no api key" });
  });

  it("turns a throwing transport into a failure outcome", async () => {
    const transport: RunnerTransport = {
      start: () => Promise.reject(new Error("spawn failed")),
      cancel: () => undefined,
    };
    const runner = createRunner({ transport, getTimeoutMs: () => 0 });

    await expect(runner.start(buildRunnerPayload(), () => undefined)).resolves.toEqual({
      ok: false,
      error: "spawn failed",
    });
  });

  it("refuses a second run while one is in flight", async () => {
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 0 });

    const first = runner.start(buildRunnerPayload({ jobId: 1 }), () => undefined);
    const second = await runner.start(buildRunnerPayload({ jobId: 2 }), () => undefined);

    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already in progress/);
    expect(second.error).toContain("job 1");
    // The refusal must not have reached the transport.
    expect(transport.starts).toBe(1);

    transport.release({ ok: true });
    await first;
  });

  it("frees the slot once a run finishes", async () => {
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 0 });

    const first = runner.start(buildRunnerPayload(), () => undefined);
    transport.release({ ok: true });
    await first;

    const second = runner.start(buildRunnerPayload(), () => undefined);
    transport.release({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(transport.starts).toBe(2);
  });

  it("reports whether it is running and which job", async () => {
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 0 });

    expect(runner.isRunning()).toBe(false);
    expect(runner.activeJobId()).toBeNull();

    const run = runner.start(buildRunnerPayload({ jobId: 42 }), () => undefined);
    expect(runner.isRunning()).toBe(true);
    expect(runner.activeJobId()).toBe(42);

    transport.release({ ok: true });
    await run;

    expect(runner.isRunning()).toBe(false);
    expect(runner.activeJobId()).toBeNull();
  });

  it("forwards events straight through", async () => {
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 0 });
    const seen: RunnerEvent[] = [];

    const run = runner.start(buildRunnerPayload(), (event) => seen.push(event));
    transport.emit({ type: "ready", jobId: 1, totalUnits: 2 });
    transport.release({ ok: true });
    await run;

    expect(seen).toEqual([{ type: "ready", jobId: 1, totalUnits: 2 }]);
  });

  it("delegates cancel only while a run is active", async () => {
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 0 });

    runner.cancel();
    expect(transport.cancels).toBe(0);

    const run = runner.start(buildRunnerPayload(), () => undefined);
    runner.cancel();
    expect(transport.cancels).toBe(1);

    transport.release({ ok: false, error: "Run cancelled." });
    await run;
  });

  it("cancels the transport when the whole-run timeout elapses", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 1_000 });

    const run = runner.start(buildRunnerPayload(), () => undefined);
    expect(transport.cancels).toBe(0);

    vi.advanceTimersByTime(1_000);
    expect(transport.cancels).toBe(1);

    transport.release({ ok: false, error: "Run cancelled." });
    await run;
  });

  it("does not arm a timeout when the limit is zero", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 0 });

    const run = runner.start(buildRunnerPayload(), () => undefined);
    vi.advanceTimersByTime(10_000_000);
    expect(transport.cancels).toBe(0);

    transport.release({ ok: true });
    await run;
  });

  it("does not fire a stale timeout after the run finished", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 1_000 });

    const run = runner.start(buildRunnerPayload(), () => undefined);
    transport.release({ ok: true });
    await run;

    vi.advanceTimersByTime(5_000);
    expect(transport.cancels).toBe(0);
  });

  it("shutdown cancels an active run and clears the slot", async () => {
    const transport = fakeTransport();
    const runner = createRunner({ transport, getTimeoutMs: () => 0 });

    const run = runner.start(buildRunnerPayload(), () => undefined);
    runner.shutdown();

    expect(transport.cancels).toBe(1);
    expect(runner.isRunning()).toBe(false);
    expect(runner.activeJobId()).toBeNull();

    transport.release({ ok: false, error: "Run cancelled." });
    await run;
  });

  it("defaults the timeout when none is supplied", async () => {
    const transport = fakeTransport();
    const runner = createRunner({ transport });
    const run = runner.start(buildRunnerPayload(), () => undefined);
    transport.release({ ok: true });
    await expect(run).resolves.toEqual({ ok: true });
    expect(DEFAULT_RUN_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
