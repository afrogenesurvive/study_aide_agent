import { checkConfigValues } from "../../src/shared/config-defaults";
import type { AppConfig } from "../../src/shared/ipc-types";
import type { Database } from "../database/db";
import { withTransaction } from "../database/migrations";
import { createCard } from "../fsrs/repo";
import { createQuiz, insertQuestion } from "../quiz/repo";
import { getTopicByCode } from "../syllabus/repo";
import type { SyllabusTopicRow } from "../../src/shared/syllabus-types";
import type { LlmUsageRecord, ServiceLogger } from "../types";
import type { RunnerEvent, RunnerJobPayload } from "../../agent-runner/protocol";
import type {
  GenerationActionResult,
  GenerationCommitResult,
  GenerationJobInput,
  GenerationOutput,
  GenerationProgress,
  GenerationRequest,
  GenerationRunOutcome,
  GenerationTopicInput,
} from "../../src/shared/generation-types";
import { groupQuestionsByTopic } from "./candidates";
import { runPreTools, type GoogleToolRunner, type ToolOutcome } from "./dispatch";
import {
  MATERIAL_GENERATION,
  resolveRunPlan,
  selectPipeline,
  type PipelineFile,
  type PlaceholderVars,
  type RunPlan,
} from "./pipeline";
import { resolveGenerationOptions } from "./options";
import {
  createJob,
  deleteJob,
  getJob,
  getJobInput,
  markAwaitingReview,
  markCancelled,
  markCommitted,
  markFailed,
  markRejected,
  markRunning,
  markStaleFailed,
  normalizeStatus,
} from "./repo";
import { resolveScope } from "./scope";
import type { RunnerTransport } from "./transport";
import type { ToolDef } from "./tools";
import { QUESTIONS_PER_TOPIC, buildUnits } from "./units";

/**
 * Orchestration: the one place the pipeline, the scope, the runner and the
 * database meet.
 *
 * The child process makes model calls and nothing else. Every write — the job
 * row, the review gate, the commit — happens here, in the main process, which is
 * what keeps SQLite single-writer and makes the whole flow testable against an
 * in-memory database with a fake transport.
 *
 * Two halves, and the split matters:
 *
 *  - `prepareGeneration` is pure planning: scope + pipeline + tool registry, no
 *    side effects, no model. The Generate panel calls it to explain what *would*
 *    happen, and `startGeneration` calls it before doing anything.
 *  - `startGeneration` / `commitGeneration` are the two writes. A run always goes
 *    through `awaiting_review`; there is no path from "candidates exist" to
 *    "saved" that skips the gate.
 */

// ── planning ─────────────────────────────────────────────────────────────────

export interface PrepareGenerationInput {
  request: GenerationRequest;
  file: PipelineFile;
  tools: ToolDef[];
  /** Global grounding prompt from `agent-config/system-prompt.md`. */
  systemPrompt: string;
}

export interface PreparedGeneration {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Null when no pipeline by that name exists. */
  plan: RunPlan | null;
  topics: GenerationTopicInput[];
}

/**
 * Resolve a request into topics and an executable plan, without running anything.
 *
 * Both halves are reported together on purpose: "no topics matched" and "the
 * pipeline has no commit step" are the same user-facing problem (this run would
 * not work), and showing them one at a time would mean two round trips.
 */
export function prepareGeneration(
  db: Database,
  input: PrepareGenerationInput,
): PreparedGeneration {
  const scope = resolveScope(db, input.request);
  const errors = [...scope.errors];
  const warnings = [...scope.warnings];

  const pipeline = selectPipeline(input.file, MATERIAL_GENERATION);
  if (!pipeline) {
    errors.push(
      `agent-config/pipeline.json has no "${MATERIAL_GENERATION}" pipeline, so there is nothing to run.`,
    );
    return { ok: false, errors, warnings, plan: null, topics: scope.topics };
  }

  const plan = resolveRunPlan(pipeline, input.tools, {
    maxSteps: input.file.maxPipelineSteps,
  });
  errors.push(...plan.errors);
  warnings.push(...plan.warnings);

  if (plan.work.length === 0) {
    errors.push(`Pipeline "${plan.pipeline}" has no generation steps, so no material would be produced.`);
  }
  if (!plan.commit) {
    errors.push(`Pipeline "${plan.pipeline}" has no save step, so nothing could be written.`);
  }

  return { ok: errors.length === 0, errors, warnings, plan, topics: scope.topics };
}

/**
 * Everything that must be true before a run may start.
 *
 * Separate from `startGeneration` because the Generate panel asks the same
 * question on load — it disables the Run button and names the missing setting
 * rather than letting the user click through to a failure.
 */
export function generationPreflight(
  config: AppConfig,
  plan: RunPlan | null,
  topics: GenerationTopicInput[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (String(config.AGENT_RUNNER_ENABLED ?? "").trim().toLowerCase() !== "true") {
    errors.push("Generation is switched off. Turn on “Agent runner” in Settings to enable it.");
  }

  // The provider check is provider-aware: a local model needs no key, so an
  // Ollama setup passes this without any special-casing.
  const configCheck = checkConfigValues(config);
  if (!configCheck.ok) {
    errors.push(
      `The language model is not configured. Set ${configCheck.missing.join(", ")} in Settings — the current provider is ${configCheck.activeProvider}.`,
    );
  }

  if (!plan) {
    errors.push("No run plan could be built from the pipeline config.");
    return { ok: false, errors };
  }

  if (errors.length === 0) {
    if (plan.work.length === 0) errors.push("The pipeline has no generation steps.");
    if (!plan.commit) errors.push("The pipeline has no save step.");
    if (topics.length === 0) errors.push("No topics matched this scope, so there is nothing to generate.");
  }

  return { ok: errors.length === 0, errors };
}

// ── running ──────────────────────────────────────────────────────────────────

export interface GenerationHooks {
  /** Progress for the renderer. Called for every runner event that means something to the UI. */
  onProgress?: (progress: GenerationProgress) => void;
  /**
   * One recorded model call.
   *
   * Injected rather than written here: pricing the record needs the main
   * process's rate table, and a service that reached for it would drag Electron
   * placeholders into the test suite.
   */
  onUsage?: (record: LlmUsageRecord) => void;
  log?: ServiceLogger;
}

export interface StartGenerationInput {
  request: GenerationRequest;
  config: AppConfig;
  plan: RunPlan;
  topics: GenerationTopicInput[];
  systemPrompt: string;
  /**
   * When supplied, the plan's `pre` Google steps run before the model calls and
   * their output becomes `{{toolContext}}` in every rendered prompt.
   *
   * Optional so that a pipeline with no Google reads — which is every shipped
   * pipeline — behaves exactly as it did in phase 3.
   */
  google?: GoogleToolRunner;
}

/**
 * The placeholders a `pre` Google step can use.
 *
 * A pre step runs once for the whole scope rather than once per topic, so the
 * per-topic placeholders are filled with the joined values instead of a single
 * topic's.
 */
function preVars(topics: GenerationTopicInput[], options: { maxCardsPerTopic: number }): PlaceholderVars {
  const unique = (values: (string | number)[]): string => [...new Set(values)].join(", ");
  return {
    topicCode: topics.map((topic) => topic.code).join(", "),
    topicTitle: topics.map((topic) => topic.title).join("; "),
    subject: unique(topics.map((topic) => topic.subject)),
    section: unique(topics.map((topic) => topic.section ?? "—")),
    overlayThemes: unique(topics.flatMap((topic) => topic.themes)) || "none",
    topicList: topics.map((topic) => `${topic.code} ${topic.title}`).join("; "),
    topicCount: topics.length,
    syllabusIds: unique(topics.map((topic) => topic.syllabusId)),
    maxCards: options.maxCardsPerTopic,
    questionCount: QUESTIONS_PER_TOPIC,
    // Nothing has been gathered yet while the reads themselves are being walked.
    toolContext: "",
  };
}

/**
 * Run the plan's `pre` Google reads and collect their context.
 *
 * A failure is a warning rather than a refusal: not being able to read the
 * calendar is no reason to refuse to generate cards.
 */
async function collectPreContext(
  input: StartGenerationInput,
  options: { maxCardsPerTopic: number },
  hooks: GenerationHooks,
): Promise<{ context: string; warnings: string[] }> {
  if (!input.google) return { context: "", warnings: [] };

  const result = await runPreTools(input.google, input.plan, preVars(input.topics, options), hooks.log);
  for (const outcome of result.outcomes) {
    hooks.log?.(outcome.ok ? "info" : "warn", `${outcome.tool}: ${outcome.summary}`);
  }

  return {
    context: result.context,
    warnings: result.outcomes
      .filter((outcome) => !outcome.ok)
      .map((outcome) => `${outcome.label}: ${outcome.error ?? "failed"}`),
  };
}

/**
 * Plan a run, hand it to the child, and park it at the review gate.
 *
 * Nothing here writes a flashcard. A successful return means the candidates are
 * in `generation_jobs.output_json` with status `awaiting_review`, and the user
 * decides what happens next.
 */
export async function startGeneration(
  db: Database,
  runner: RunnerTransport,
  input: StartGenerationInput,
  hooks: GenerationHooks = {},
  now: Date = new Date(),
): Promise<GenerationRunOutcome> {
  const preflight = generationPreflight(input.config, input.plan, input.topics);
  if (!preflight.ok) {
    return {
      ok: false,
      jobId: null,
      status: null,
      cards: 0,
      questions: 0,
      warnings: [],
      errors: preflight.errors,
    };
  }

  const options = resolveGenerationOptions(input.config, input.request);
  const syllabusIds = [...new Set(input.topics.map((topic) => topic.syllabusId))];
  const jobInput: GenerationJobInput = {
    request: input.request,
    topics: input.topics,
    syllabusIds,
    maxCardsPerTopic: options.maxCardsPerTopic,
  };

  // Runs before the job row exists: these are reads, and a pipeline that gathers
  // context should not leave a half-started job behind when a calendar is
  // unreachable. A failed read is a warning, not a refusal — not being able to
  // see the calendar is no reason to refuse to generate cards.
  const pre = await collectPreContext(input, options, hooks);

  const jobId = createJob(db, { pipeline: input.plan.pipeline, jobInput }, now);
  markRunning(db, jobId, now);

  const built = buildUnits(input.plan, input.topics, {
    maxCardsPerTopic: options.maxCardsPerTopic,
    systemPrompt: input.systemPrompt,
    context: pre.context,
  });
  // Both exit paths below read `built.warnings`, so a context-gathering failure
  // is reported whichever way the run goes.
  built.warnings.unshift(...pre.warnings);

  if (built.units.length === 0) {
    const error = "No work units: the pipeline produced no model calls for this scope.";
    markFailed(db, jobId, error, now);
    report(hooks, { jobId, phase: "done", fraction: 1, label: error, step: 0, totalSteps: 0, done: true });
    return {
      ok: false,
      jobId,
      status: "failed",
      cards: 0,
      questions: 0,
      warnings: [...built.warnings],
      errors: [error],
    };
  }

  const totalUnits = built.units.length;
  report(hooks, {
    jobId,
    phase: "starting",
    fraction: 0,
    label: `Starting — ${totalUnits} model call${totalUnits === 1 ? "" : "s"} queued`,
    step: 0,
    totalSteps: totalUnits,
    done: false,
  });

  /**
   * What the child reported, collected on the side.
   *
   * A holder object rather than separate `let`s because these are written from
   * an event callback: TypeScript's flow analysis would still believe a `let`
   * held its initializer after the call, whereas a property read is invalidated
   * by the call and keeps its declared type.
   */
  const captured: {
    output: GenerationOutput | null;
    error: string | null;
    warnings: string[];
    /** Unit labels by position, so `unit-done` can name the step it finished. */
    labels: Map<number, string>;
    /** Warnings already reported, so the merged copy does not repeat them. */
    seen: Set<string>;
  } = {
    output: null,
    error: null,
    warnings: [...built.warnings],
    labels: new Map(),
    seen: new Set(),
  };

  const payload: RunnerJobPayload = {
    jobId,
    pipeline: input.plan.pipeline,
    units: built.units,
    systemPrompt: input.systemPrompt,
    temperature: options.temperature,
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    timeoutMs: options.timeoutMs,
  };

  const outcome = await runner.start(payload, (event) => {
    switch (event.type) {
      case "ready":
        report(hooks, {
          jobId,
          phase: "starting",
          fraction: 0,
          label: `Runner ready — ${event.totalUnits} call${event.totalUnits === 1 ? "" : "s"}`,
          step: 0,
          totalSteps: event.totalUnits,
          done: false,
        });
        break;
      case "unit-start":
        captured.labels.set(event.index, event.label);
        report(hooks, {
          jobId,
          phase: "running",
          fraction: event.total > 0 ? (event.index - 1) / event.total : 0,
          label: `${event.label} · ${event.topicCode}`,
          step: event.index,
          totalSteps: event.total,
          done: false,
        });
        break;
      case "unit-done": {
        // The child reports each unit's coercion warnings here, where they can be
        // attributed to a topic, and the merged set again on `candidates`.
        // Remember what has been said so the merged copy only adds the genuinely
        // new notes — the duplicate-detection ones — instead of repeating lines.
        for (const warning of event.warnings) {
          if (captured.seen.has(warning)) continue;
          captured.seen.add(warning);
          captured.warnings.push(`${event.topicCode}: ${warning}`);
        }
        const label = captured.labels.get(event.index) ?? event.toolName;
        report(hooks, {
          jobId,
          phase: "running",
          fraction: event.total > 0 ? event.index / event.total : 1,
          label: `${label} finished · ${event.topicCode}`,
          step: event.index,
          totalSteps: event.total,
          done: false,
        });
        break;
      }
      case "usage":
        hooks.onUsage?.(event.record);
        break;
      case "candidates":
        // The runner's own outcome carries only ok/error, so the payload it is
        // meant to have produced is captured here instead.
        captured.output = event.output;
        for (const warning of event.output.warnings) {
          if (captured.seen.has(warning)) continue;
          captured.seen.add(warning);
          captured.warnings.push(warning);
        }
        break;
      case "error":
        captured.error = event.message;
        hooks.log?.("warn", `Generation run ${jobId}: ${event.message}`);
        break;
      case "done":
        break;
    }
  });

  if (!outcome.ok) {
    const error = outcome.error ?? captured.error ?? "The run failed without saying why.";
    markFailed(db, jobId, error, now);
    report(hooks, { jobId, phase: "done", fraction: 1, label: error, step: 0, totalSteps: totalUnits, done: true });
    return {
      ok: false,
      jobId,
      status: "failed",
      cards: 0,
      questions: 0,
      warnings: captured.warnings,
      errors: [error],
    };
  }

  const candidates = captured.output;
  if (!candidates || (candidates.cards.length === 0 && candidates.questions.length === 0)) {
    const error =
      captured.error ??
      "The run finished without producing any usable cards or questions. Check the prompt and the model in Settings.";
    markFailed(db, jobId, error, now);
    report(hooks, { jobId, phase: "done", fraction: 1, label: error, step: 0, totalSteps: totalUnits, done: true });
    return {
      ok: false,
      jobId,
      status: "failed",
      cards: 0,
      questions: 0,
      warnings: captured.warnings,
      errors: [error],
    };
  }

  if (!markAwaitingReview(db, jobId, candidates, now)) {
    // The row moved on under us — the user cancelled while the child was still
    // finishing. Say so rather than claiming a gate that no longer exists.
    const status = normalizeStatus(getJob(db, jobId)?.status ?? "");
    return {
      ok: false,
      jobId,
      status,
      cards: 0,
      questions: 0,
      warnings: captured.warnings,
      errors: ["The run was stopped before its results reached the review gate."],
    };
  }

  report(hooks, {
    jobId,
    phase: "review",
    fraction: 1,
    label: "Waiting for your review",
    step: totalUnits,
    totalSteps: totalUnits,
    done: true,
  });

  return {
    ok: true,
    jobId,
    status: "awaiting_review",
    cards: candidates.cards.length,
    questions: candidates.questions.length,
    warnings: captured.warnings,
    errors: [],
  };
}

function report(hooks: GenerationHooks, progress: GenerationProgress): void {
  hooks.onProgress?.(progress);
}

// ── the gate ─────────────────────────────────────────────────────────────────

/**
 * Write accepted candidates to `flashcards` / `quizzes` / `quiz_questions`.
 *
 * One transaction, and `markCommitted` runs *first* so the gate is closed before
 * anything is written: if the row is not `awaiting_review` — an already-committed
 * job, a rejected one, a tampered with id — the throw rolls the whole savepoint
 * back and the caller gets a refusal rather than duplicate cards.
 */
export function commitGeneration(
  db: Database,
  jobId: number,
  output: GenerationOutput,
  now: Date = new Date(),
): GenerationCommitResult {
  try {
    return withTransaction(db, () => {
      if (!markCommitted(db, jobId, output, now)) {
        throw new Error("This run is no longer waiting for review, so nothing was saved.");
      }

      const warnings: string[] = [];
      const jobInput = getJobInput(db, jobId);
      const syllabusIds = jobInput?.syllabusIds ?? [];

      // A code can exist in more than one syllabus, so resolution is scoped to
      // the syllabi this run actually covered — never a global "first match".
      const resolveTopic = (code: string | null): SyllabusTopicRow | null => {
        if (!code) return null;
        for (const syllabusId of syllabusIds) {
          const row = getTopicByCode(db, syllabusId, code);
          if (row) return row;
        }
        return null;
      };

      let cards = 0;
      for (const card of output.cards) {
        const topic = resolveTopic(card.topicCode);
        if (!topic) {
          warnings.push(
            card.topicCode
              ? `“${excerpt(card.question)}” was saved without a topic: no syllabus topic has the code ${card.topicCode}.`
              : `“${excerpt(card.question)}” was saved without a topic.`,
          );
        }
        createCard(
          db,
          {
            question: card.question,
            answer: card.answer,
            topicId: topic?.id ?? null,
            source: "generated",
          },
          now,
        );
        cards += 1;
      }

      let quizzes = 0;
      let questions = 0;

      for (const [code, group] of groupQuestionsByTopic(output.questions)) {
        if (!code) {
          warnings.push(
            `${group.length} question${group.length === 1 ? "" : "s"} had no topic and could not be saved as a quiz.`,
          );
          continue;
        }
        const topic = resolveTopic(code);
        if (!topic) {
          warnings.push(`The quiz for ${code} was skipped: no syllabus topic has that code.`);
          continue;
        }

        const title = topic.title || code;
        const quizId = createQuiz(
          db,
          { title, topicId: topic.id, jobId, source: "generated" },
          now,
        );
        quizzes += 1;

        group.forEach((question, index) => {
          insertQuestion(
            db,
            {
              quizId,
              topicId: topic.id,
              question: question.question,
              choices: question.choices,
              answerIndex: question.answerIndex,
              explanation: question.explanation,
              // Explicit: the column defaults to 0, which would stack every item
              // at the same position and scramble the quiz order.
              orderIndex: index,
            },
            now,
          );
          questions += 1;
        });
      }

      return { success: true, cards, quizzes, questions, warnings };
    });
  } catch (err) {
    return {
      success: false,
      cards: 0,
      quizzes: 0,
      questions: 0,
      warnings: [],
      error: describe(err),
    };
  }
}

/** Answer the gate with "no". The candidates stay on the row as a record. */
export function rejectGeneration(
  db: Database,
  jobId: number,
  now: Date = new Date(),
): GenerationActionResult {
  return refused(markRejected(db, jobId, now), "That run is no longer waiting for review.");
}

/**
 * Answer the gate by throwing the whole thing away.
 *
 * Distinct from `rejectGeneration`: a rejection keeps the row so History can show
 * what was declined, whereas discarding removes it. `deleteJob` refuses a
 * committed row, so this can never orphan saved material.
 */
export function discardGeneration(db: Database, jobId: number): GenerationActionResult {
  return refused(deleteJob(db, jobId), "That run has already been saved, so it cannot be discarded.");
}

/** Stop a run that is in flight. Safe to call when nothing is running. */
export function cancelGeneration(
  db: Database,
  runner: { cancel(): void },
  jobId: number,
  now: Date = new Date(),
): GenerationActionResult {
  runner.cancel();
  return refused(markCancelled(db, jobId, now), "That run has already finished.");
}

/**
 * Mark runs that were interrupted by a crash or a force-quit as failed.
 *
 * Called once at boot, before anything can ask which run is in flight.
 */
export function markStaleJobsFailed(db: Database, now: Date = new Date()): number {
  return markStaleFailed(db, now);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function refused(ok: boolean, message: string): GenerationActionResult {
  return ok ? { success: true } : { success: false, error: message };
}

function excerpt(text: string, max = 60): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
