import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  coerceCandidates,
  mergeOutputs,
  type CoerceResult,
} from "../services/generation/candidates";
import { parseJsonLoose } from "../services/llm/extract";
import type { LlmUsageRecord } from "../services/types";
import type { GenerationOutput } from "../src/shared/generation-types";
import {
  encodeEvent,
  type RunnerEvent,
  type RunnerJobPayload,
} from "./protocol";

/**
 * The agent runner.
 *
 * A short-lived child process whose only job is to make model calls. It is
 * spawned per run, receives its entire job as JSON on stdin, streams events back
 * as newline-delimited JSON on stdout, and exits.
 *
 * It deliberately has **no database access and no config access**:
 *
 *  - Main owns every write. Two processes writing one SQLite file would need busy
 *    timeouts and would put the persistence logic outside the tested `services/`
 *    tree, so usage records are forwarded to main as `usage` events instead.
 *  - Main renders every prompt. The child reads no files, so there is no path
 *    resolution to get wrong in a packaged build and nothing to keep in sync.
 *
 * The only thing it needs from disk is `shared/model-provider.mjs`, located via
 * `SHARED_DIR` from `getChildEnv()`.
 */

/** See `src/main/llm.ts` for why this indirection is necessary. */
const importEsm = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

interface ChatModule {
  callChat: (options: {
    systemMessage?: string;
    userContext?: string;
    temperature?: number;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    meta?: Record<string, unknown>;
  }) => Promise<{ reply: string | null }>;
}

interface UsageTrackerModule {
  setUsageSink: (fn: (record: LlmUsageRecord) => void) => unknown;
}

async function main(): Promise<number> {
  // stdout is the protocol channel, so anything else that writes to it corrupts
  // the stream. Redirect the console before importing the provider: a dependency
  // that logs on import would otherwise emit a line the parent cannot parse.
  redirectConsole();

  const payload = await readPayload();
  currentJobId = payload.jobId;
  const chat = await loadChatModule();
  await installUsageForwarder(payload.jobId);

  emit({ type: "ready", jobId: payload.jobId, totalUnits: payload.units.length });

  const results: CoerceResult[] = [];
  let cardCount = 0;
  let questionCount = 0;
  const warnings: string[] = [];

  for (const [index, unit] of payload.units.entries()) {
    const position = index + 1;
    emit({
      type: "unit-start",
      jobId: payload.jobId,
      index: position,
      total: payload.units.length,
      stepId: unit.stepId,
      toolName: unit.toolName,
      label: unit.label,
      topicCode: unit.topicCode,
    });

    const startedAt = Date.now();
    const reply = await chat.callChat({
      systemMessage: unit.systemMessage,
      userContext: unit.userContext,
      temperature: payload.temperature,
      timeoutMs: payload.timeoutMs,
      maxRetries: payload.maxRetries,
      retryBaseDelayMs: payload.retryBaseDelayMs,
      meta: { source: "generate", step: unit.stepId, tool: unit.toolName },
    });

    const coerced = coerceCandidates(parseJsonLoose(reply.reply ?? ""), unit.topicCode);
    if (coerced.cards.length === 0 && coerced.questions.length === 0) {
      coerced.warnings.push(
        `${unit.topicCode}: the model returned nothing usable for "${unit.label}".`,
      );
    }

    results.push(coerced);
    cardCount += coerced.cards.length;
    questionCount += coerced.questions.length;
    warnings.push(...coerced.warnings.map((warning) => `${unit.topicCode}: ${warning}`));

    emit({
      type: "unit-done",
      jobId: payload.jobId,
      index: position,
      total: payload.units.length,
      stepId: unit.stepId,
      toolName: unit.toolName,
      topicCode: unit.topicCode,
      cards: coerced.cards.length,
      questions: coerced.questions.length,
      ms: Date.now() - startedAt,
      warnings: coerced.warnings,
    });
  }

  const output: GenerationOutput = mergeOutputs(results);
  emit({ type: "candidates", jobId: payload.jobId, output });
  emit({
    type: "done",
    jobId: payload.jobId,
    ok: true,
    cards: output.cards.length,
    questions: output.questions.length,
    warnings: output.warnings,
  });

  return 0;
}

// ── protocol plumbing ────────────────────────────────────────────────────────

function emit(event: RunnerEvent): void {
  process.stdout.write(encodeEvent(event));
}

/**
 * Flush stdout, then exit.
 *
 * `process.exit()` truncates a pipe that still has buffered writes, so the last
 * event — the one the parent is waiting for — would be the most likely casualty.
 * Waiting for the write callback avoids that.
 */
async function finish(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    if (process.stdout.writableLength === 0) resolve();
    else process.stdout.write("", () => resolve());
  });
  process.exit(code);
}

function redirectConsole(): void {
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(" ")}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
}

// ── input and dependencies ───────────────────────────────────────────────────

async function readPayload(): Promise<RunnerJobPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("No job payload was written to stdin.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Job payload is not valid JSON: ${describe(err)}`);
  }

  const payload = parsed as Partial<RunnerJobPayload>;
  if (typeof payload.jobId !== "number" || !Number.isFinite(payload.jobId)) {
    throw new Error("Job payload has no jobId.");
  }
  if (!Array.isArray(payload.units) || payload.units.length === 0) {
    throw new Error("Job payload has no work units.");
  }

  return {
    jobId: payload.jobId,
    pipeline: String(payload.pipeline ?? ""),
    units: payload.units,
    systemPrompt: String(payload.systemPrompt ?? ""),
    temperature: Number(payload.temperature ?? 0.4),
    maxRetries: Number(payload.maxRetries ?? 3),
    retryBaseDelayMs: Number(payload.retryBaseDelayMs ?? 4000),
    timeoutMs: Number(payload.timeoutMs ?? 120_000),
  };
}

async function loadChatModule(): Promise<ChatModule> {
  const mod = await importEsm(sharedModuleUrl("model-provider.mjs"));
  if (typeof mod.callChat !== "function") {
    throw new Error("shared/model-provider.mjs did not export callChat().");
  }
  return mod as unknown as ChatModule;
}

/**
 * Forward each recorded model call to the parent.
 *
 * The main process installs its own sink that writes the `llm_usage` row and
 * prices it; here we only relay, so costing happens in exactly one place.
 */
async function installUsageForwarder(jobId: number): Promise<void> {
  const mod = await importEsm(sharedModuleUrl("usage-tracker.mjs"));
  const setUsageSink = mod.setUsageSink as ((fn: unknown) => unknown) | undefined;
  if (typeof setUsageSink !== "function") return;
  setUsageSink((record: unknown) => {
    emit({ type: "usage", jobId, record: record as LlmUsageRecord });
  });
}

function sharedModuleUrl(name: string): string {
  const dir = process.env.SHARED_DIR;
  if (!dir) {
    throw new Error(
      "SHARED_DIR is not set — the agent runner was spawned without its environment.",
    );
  }
  return pathToFileURL(path.join(dir, name)).href;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── entry ────────────────────────────────────────────────────────────────────

/**
 * The job this process is running, for failure reporting.
 *
 * Module-level because the entry point is a single sequence with no other state
 * to thread it through. It stays -1 only when the payload itself never parsed,
 * which is the one case where the job id is genuinely unknown.
 */
let currentJobId = -1;

main()
  .then((code) => finish(code))
  .catch(async (err: unknown) => {
    // Report through the protocol as well as the exit code, so the parent has a
    // reason rather than having to interpret a non-zero exit on its own.
    try {
      const message = describe(err);
      emit({ type: "error", jobId: currentJobId, message });
      emit({
        type: "done",
        jobId: currentJobId,
        ok: false,
        cards: 0,
        questions: 0,
        warnings: [],
      });
    } catch {
      // Reporting failed too; the exit code is all that is left.
    }
    await finish(1);
  });
