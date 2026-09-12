import type { LlmUsageRecord } from "../services/types";
import type { GenerationUnit } from "../services/generation/units";
import type { GenerationOutput } from "../src/shared/generation-types";

/**
 * The main ↔ child protocol.
 *
 * The agent runner is a separate process, so the two sides agree on exactly two
 * things: one JSON job payload written to the child's stdin, and a stream of
 * newline-delimited JSON events written back to its stdout.
 *
 * This file deliberately does *not* live in `src/shared/`. The renderer never sees
 * any of it, and the renderer tsconfig cannot see `services/`, which this imports
 * for the usage-record shape.
 *
 * Rules the transport depends on:
 *
 *  - one JSON object per line on stdout, and nothing else (see the `console.log`
 *    reassignment in `index.ts` — a stray dependency log would corrupt the stream)
 *  - every event carries `jobId`, so an event from an already-finished run can be
 *    recognised and ignored rather than applied to the wrong job
 *  - the child exits when it is done; there is no long-lived connection to manage
 */

/**
 * The whole job, serialised to the child's stdin.
 *
 * `units` carries prompts that are already fully rendered (see
 * `services/generation/units.ts`), which is what keeps the child small enough to
 * be obviously correct: it makes the calls it was handed and reports what came
 * back, doing no templating and reading no config.
 */
export interface RunnerJobPayload {
  jobId: number;
  pipeline: string;
  units: GenerationUnit[];
  /** Global grounding prompt from `agent-config/system-prompt.md`; may be empty. */
  systemPrompt: string;
  temperature: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  /** Per-attempt ceiling, passed straight through to the provider. */
  timeoutMs: number;
}

export const RUNNER_EVENT_TYPES = [
  "ready",
  "unit-start",
  "unit-done",
  "usage",
  "candidates",
  "error",
  "done",
] as const;

export type RunnerEventType = (typeof RUNNER_EVENT_TYPES)[number];

export interface RunnerReadyEvent {
  type: "ready";
  jobId: number;
  totalUnits: number;
}

export interface RunnerUnitStartEvent {
  type: "unit-start";
  jobId: number;
  /** 1-based position in the unit list. */
  index: number;
  total: number;
  stepId: string;
  toolName: string;
  label: string;
  topicCode: string;
}

export interface RunnerUnitDoneEvent {
  type: "unit-done";
  jobId: number;
  index: number;
  total: number;
  stepId: string;
  toolName: string;
  topicCode: string;
  cards: number;
  questions: number;
  ms: number;
  warnings: string[];
}

/**
 * A recorded model call.
 *
 * The child has no database and no usage sink of its own, so it forwards each
 * record here and the main process writes the `llm_usage` row. That keeps one
 * writer and means costs are priced exactly once, in main.
 */
export interface RunnerUsageEvent {
  type: "usage";
  jobId: number;
  record: LlmUsageRecord;
}

export interface RunnerCandidatesEvent {
  type: "candidates";
  jobId: number;
  output: GenerationOutput;
}

export interface RunnerErrorEvent {
  type: "error";
  jobId: number;
  message: string;
  stepId?: string;
}

export interface RunnerDoneEvent {
  type: "done";
  jobId: number;
  ok: boolean;
  cards: number;
  questions: number;
  warnings: string[];
}

export type RunnerEvent =
  | RunnerReadyEvent
  | RunnerUnitStartEvent
  | RunnerUnitDoneEvent
  | RunnerUsageEvent
  | RunnerCandidatesEvent
  | RunnerErrorEvent
  | RunnerDoneEvent;

/** Serialise one event as a single NDJSON line. */
export function encodeEvent(event: RunnerEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Parse one stdout line.
 *
 * Returns null for a blank line, malformed JSON, or a `type` this build does not
 * know. Unknown lines are tolerated rather than fatal: a dependency printing to
 * stdout is a real possibility, and losing an informational line is much better
 * than failing a run that is otherwise working.
 */
export function parseEventLine(line: string): RunnerEvent | null {
  const text = line.trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  if (!(RUNNER_EVENT_TYPES as readonly string[]).includes(type)) return null;

  const jobId = (parsed as { jobId?: unknown }).jobId;
  if (typeof jobId !== "number" || !Number.isFinite(jobId)) return null;

  return parsed as RunnerEvent;
}
