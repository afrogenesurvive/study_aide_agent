import type { Database } from "../database/db";
import { isoOf } from "../time";
import {
  EMPTY_GENERATION_OUTPUT,
  isGateState,
  isGenerationStatus,
  type GateState,
  type GenerationJobInput,
  type GenerationJobRow,
  type GenerationJobSummary,
  type GenerationOutput,
  type GenerationStatus,
} from "../../src/shared/generation-types";

/**
 * `generation_jobs` persistence.
 *
 * One row per pipeline run. The row is created before the runner is spawned and
 * is the only thing the renderer needs to follow a run: `input_json` says what
 * was asked for, `output_json` holds the candidates the review gate is showing,
 * and `status` / `gate_state` say where the run got to.
 *
 * Timestamps are ISO-8601 UTC written from JavaScript (the phase 2 convention),
 * so the `datetime('now')` defaults inherited from migration 001 are never used.
 */

const JOB_SELECT = `
  SELECT id, pipeline, input_json, output_json, status, gate_state, error,
         committed_at, created_at, updated_at
    FROM generation_jobs
`;

interface JobPatch {
  status?: GenerationStatus;
  gateState?: GateState;
  error?: string | null;
  outputJson?: string | null;
  committedAt?: string | null;
}

// ── writes ───────────────────────────────────────────────────────────────────

export function createJob(
  db: Database,
  input: { pipeline: string; jobInput: GenerationJobInput },
  now: Date = new Date(),
): number {
  const stamp = isoOf(now);
  const result = db
    .prepare(
      `INSERT INTO generation_jobs
         (pipeline, input_json, output_json, status, gate_state, error, committed_at, created_at, updated_at)
       VALUES (?, ?, NULL, 'pending', 'pending', NULL, NULL, ?, ?)`,
    )
    .run(input.pipeline, JSON.stringify(input.jobInput), stamp, stamp);
  return Number(result.lastInsertRowid);
}

/** `pending` → `running`, once the child process is actually up. */
export function markRunning(db: Database, id: number, now: Date = new Date()): boolean {
  return updateJob(db, id, { status: "running" }, ["pending"], now);
}

/**
 * The run finished producing candidates.
 *
 * This is the gate: nothing is written to `flashcards` / `quizzes` until the
 * user answers it, so the candidates live only in `output_json` from here on.
 */
export function markAwaitingReview(
  db: Database,
  id: number,
  output: GenerationOutput,
  now: Date = new Date(),
): boolean {
  return updateJob(
    db,
    id,
    { status: "awaiting_review", gateState: "pending", outputJson: JSON.stringify(output), error: null },
    ["pending", "running"],
    now,
  );
}

/**
 * The user approved the gate and the cards/quizzes were written.
 *
 * `output` is the *edited* set, so the row records exactly what was saved rather
 * than what the model first proposed.
 */
export function markCommitted(
  db: Database,
  id: number,
  output: GenerationOutput,
  now: Date = new Date(),
): boolean {
  return updateJob(
    db,
    id,
    {
      status: "committed",
      gateState: "approved",
      outputJson: JSON.stringify(output),
      committedAt: isoOf(now),
      error: null,
    },
    ["awaiting_review"],
    now,
  );
}

export function markRejected(db: Database, id: number, now: Date = new Date()): boolean {
  return updateJob(db, id, { status: "rejected", gateState: "rejected" }, ["awaiting_review"], now);
}

export function markFailed(
  db: Database,
  id: number,
  error: string,
  now: Date = new Date(),
): boolean {
  return updateJob(db, id, { status: "failed", error }, ["pending", "running", "awaiting_review"], now);
}

export function markCancelled(db: Database, id: number, now: Date = new Date()): boolean {
  return updateJob(db, id, { status: "cancelled" }, ["pending", "running", "awaiting_review"], now);
}

/** Hard delete, for discarding a run that was never committed. */
export function deleteJob(db: Database, id: number): boolean {
  const result = db
    .prepare("DELETE FROM generation_jobs WHERE id = ? AND committed_at IS NULL")
    .run(id);
  return Number(result.changes) > 0;
}

// ── reads ────────────────────────────────────────────────────────────────────

export function getJob(db: Database, id: number): GenerationJobRow | null {
  const row = db.prepare(`${JOB_SELECT} WHERE id = ?`).get(id);
  return (row as unknown as GenerationJobRow) ?? null;
}

export function listJobs(db: Database, limit = 50): GenerationJobRow[] {
  return db
    .prepare(`${JOB_SELECT} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(Math.max(1, Math.floor(limit))) as unknown as GenerationJobRow[];
}

/** Runs still waiting on the review gate, newest first. */
export function listPendingReview(db: Database): GenerationJobRow[] {
  return db
    .prepare(`${JOB_SELECT} WHERE status = 'awaiting_review' ORDER BY created_at DESC, id DESC`)
    .all() as unknown as GenerationJobRow[];
}

export function countJobs(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM generation_jobs").get() as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}

export function getJobInput(db: Database, id: number): GenerationJobInput | null {
  const row = getJob(db, id);
  return row ? parseGenerationInput(row.input_json) : null;
}

export function getJobOutput(db: Database, id: number): GenerationOutput | null {
  const row = getJob(db, id);
  if (!row?.output_json) return null;
  return parseGenerationOutput(row.output_json);
}

// ── parsing ──────────────────────────────────────────────────────────────────

/**
 * Decode stored candidates.
 *
 * Never throws: `output_json` was written by a previous version of the app (or
 * by a model), so a malformed payload degrades to an empty set with a warning
 * rather than breaking the whole Generate panel.
 */
export function parseGenerationOutput(raw: string | null | undefined): GenerationOutput {
  if (!raw) return { ...EMPTY_GENERATION_OUTPUT };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      cards: [],
      questions: [],
      warnings: ["Stored candidates could not be read back as JSON."],
    };
  }
  if (!parsed || typeof parsed !== "object") return { ...EMPTY_GENERATION_OUTPUT };

  const source = parsed as Record<string, unknown>;
  return {
    cards: Array.isArray(source.cards) ? (source.cards as GenerationOutput["cards"]) : [],
    questions: Array.isArray(source.questions)
      ? (source.questions as GenerationOutput["questions"])
      : [],
    warnings: Array.isArray(source.warnings)
      ? (source.warnings as unknown[]).filter((w): w is string => typeof w === "string")
      : [],
  };
}

export function parseGenerationInput(raw: string | null | undefined): GenerationJobInput | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const source = parsed as Partial<GenerationJobInput>;
    if (!Array.isArray(source.topics)) return null;
    return source as GenerationJobInput;
  } catch {
    return null;
  }
}

/** Narrow the unconstrained `status` / `gate_state` text columns. */
export function normalizeStatus(value: string, fallback: GenerationStatus = "failed"): GenerationStatus {
  return isGenerationStatus(value) ? value : fallback;
}

export function normalizeGateState(value: string, fallback: GateState = "pending"): GateState {
  return isGateState(value) ? value : fallback;
}

export function toSummary(row: GenerationJobRow): GenerationJobSummary {
  const output = parseGenerationOutput(row.output_json);
  const input = parseGenerationInput(row.input_json);
  return {
    id: row.id,
    pipeline: row.pipeline,
    status: normalizeStatus(row.status),
    gateState: normalizeGateState(row.gate_state),
    topicCount: input?.topics.length ?? 0,
    cardCount: output.cards.length,
    questionCount: output.questions.length,
    warningCount: output.warnings.length,
    error: row.error,
    createdAt: row.created_at,
    committedAt: row.committed_at,
  };
}

// ── internals ────────────────────────────────────────────────────────────────

/**
 * Apply a patch, but only from one of `allowedFrom`.
 *
 * The `status IN (…)` guard is what stops a late event from a child process
 * reviving a run the user already cancelled, or double-committing a job.
 * Returns false when the row was not in an allowed state (or does not exist).
 */
function updateJob(
  db: Database,
  id: number,
  patch: JobPatch,
  allowedFrom: GenerationStatus[],
  now: Date,
): boolean {
  const sets = ["updated_at = ?"];
  const params: Array<string | number | null> = [isoOf(now)];

  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.gateState !== undefined) {
    sets.push("gate_state = ?");
    params.push(patch.gateState);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    params.push(patch.error);
  }
  if (patch.outputJson !== undefined) {
    sets.push("output_json = ?");
    params.push(patch.outputJson);
  }
  if (patch.committedAt !== undefined) {
    sets.push("committed_at = ?");
    params.push(patch.committedAt);
  }

  params.push(id, ...allowedFrom);
  const placeholders = allowedFrom.map(() => "?").join(", ");
  const result = db
    .prepare(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`)
    .run(...params);
  return Number(result.changes) > 0;
}
