/**
 * Material generation: persisted shapes, the request the UI sends, and the
 * candidate payload the pipeline produces.
 *
 * Self-contained on purpose — `tsconfig.json` type-checks `src/shared` for the
 * renderer, which cannot see anything under `services/`. The runner's
 * main↔child NDJSON protocol is deliberately *not* here: the renderer never sees
 * it, so it lives beside the runner in `agent-runner/protocol.ts`.
 */

import type { TopicStatus } from "./syllabus-types";

/**
 * Lifecycle of one run.
 *
 * `awaiting_review` is the gate: candidates exist in `output_json` but nothing
 * has been written to `flashcards` / `quizzes` yet. The child process exits at
 * that point and the commit is a main-process write.
 */
export type GenerationStatus =
  | "pending"
  | "running"
  | "awaiting_review"
  | "committed"
  | "rejected"
  | "failed"
  | "cancelled";

export const GENERATION_STATUSES: GenerationStatus[] = [
  "pending",
  "running",
  "awaiting_review",
  "committed",
  "rejected",
  "failed",
  "cancelled",
];

/** Whether the review gate has been answered. */
export type GateState = "pending" | "approved" | "rejected";

export const GATE_STATES: GateState[] = ["pending", "approved", "rejected"];

/** Terminal states never transition again. */
export const TERMINAL_GENERATION_STATUSES: GenerationStatus[] = [
  "committed",
  "rejected",
  "failed",
  "cancelled",
];

export function isGenerationStatus(value: unknown): value is GenerationStatus {
  return typeof value === "string" && (GENERATION_STATUSES as string[]).includes(value);
}

export function isGateState(value: unknown): value is GateState {
  return typeof value === "string" && (GATE_STATES as string[]).includes(value);
}

export function isTerminalStatus(status: GenerationStatus): boolean {
  return TERMINAL_GENERATION_STATUSES.includes(status);
}

/** How much of the syllabus a run covers. */
export type GenerationScopeKind = "topic" | "section" | "syllabus";

export const GENERATION_SCOPE_LABELS: Record<GenerationScopeKind, string> = {
  topic: "Selected topics",
  section: "A whole section",
  syllabus: "Every topic in the syllabus",
};

/** What the renderer asks for. */
export interface GenerationRequest {
  scope: GenerationScopeKind;
  /**
   * One id per subject. Each subject is its own `syllabus` row, so a run that
   * spans chemistry and biology needs more than one id.
   */
  syllabusIds: number[];
  /** Topic codes, used when `scope` is `topic`. */
  codes?: string[];
  /** Section name, used when `scope` is `section`. */
  section?: string | null;
  /** Overrides `GENERATION_MAX_CARDS_PER_TOPIC` for this run. */
  maxCardsPerTopic?: number;
}

/** One topic handed to the child as work. */
export interface GenerationTopicInput {
  topicId: number;
  code: string;
  title: string;
  subject: string;
  section: string | null;
  syllabusId: number;
  /** Cross-subject themes this topic participates in, for the prompt. */
  themes: string[];
}

/** Everything the child needs to run. It never opens the database. */
export interface GenerationJobInput {
  request: GenerationRequest;
  topics: GenerationTopicInput[];
  /** Ids of the syllabus rows in play, for the pipeline's placeholders. */
  syllabusIds: number[];
  maxCardsPerTopic: number;
}

export interface GeneratedCard {
  question: string;
  answer: string;
  /** Resolved back to a `syllabus_topics.id` at commit time. */
  topicCode: string | null;
}

export interface GeneratedQuestion {
  question: string;
  choices: string[];
  answerIndex: number;
  explanation: string | null;
  topicCode: string | null;
}

/** Stored verbatim in `generation_jobs.output_json`. */
export interface GenerationOutput {
  cards: GeneratedCard[];
  questions: GeneratedQuestion[];
  /** Non-fatal problems: a topic that produced nothing, a coerced field, … */
  warnings: string[];
}

export const EMPTY_GENERATION_OUTPUT: GenerationOutput = { cards: [], questions: [], warnings: [] };

/** A raw row of `generation_jobs`. */
export interface GenerationJobRow {
  id: number;
  pipeline: string;
  input_json: string;
  output_json: string | null;
  status: string;
  gate_state: string;
  error: string | null;
  committed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the Generate panel's history list needs, with the JSON already parsed. */
export interface GenerationJobSummary {
  id: number;
  pipeline: string;
  status: GenerationStatus;
  gateState: GateState;
  topicCount: number;
  cardCount: number;
  questionCount: number;
  warningCount: number;
  error: string | null;
  createdAt: string;
  committedAt: string | null;
}

/** Live progress, pushed to the renderer while a run is in flight. */
export interface GenerationProgress {
  jobId: number;
  phase: "starting" | "running" | "review" | "done";
  /** 0–1, derived from completed steps. */
  fraction: number;
  label: string;
  /** Index of the step currently running, 1-based. */
  step: number;
  totalSteps: number;
  done: boolean;
}

/**
 * The outcome of asking for a run.
 *
 * `jobId` is null when the request was refused before a job was created — an
 * unconfigured provider, a pipeline with no generation step, a scope that
 * matched nothing. Those are answers, not errors, so they come back in the same
 * shape as a failed run rather than being thrown.
 */
export interface GenerationRunOutcome {
  ok: boolean;
  jobId: number | null;
  status: GenerationStatus | null;
  cards: number;
  questions: number;
  warnings: string[];
  errors: string[];
}

/**
 * Whether a run could start right now, and what is missing if not.
 *
 * The Generate panel asks for this on load so it can disable Run and name the
 * setting to fix, rather than letting the user click through to a failure. It
 * deliberately reports the *reasons* rather than a bare boolean: "the pipeline
 * config has no material-generation pipeline" and "no API key" need different
 * answers from the user.
 */
export interface GenerationStatusPayload {
  /** `AGENT_RUNNER_ENABLED` in Settings. */
  enabled: boolean;
  provider: string;
  model: string | null;
  /** The model layer would accept a call (a key is present, or none is needed). */
  ready: boolean;
  /** Settings that must be filled in before a call would succeed. */
  missing: string[];
  /** The pipeline config describes a pipeline that could actually run. */
  configOk: boolean;
  configErrors: string[];
  configWarnings: string[];
  /** A run is in flight right now. */
  running: boolean;
  activeJobId: number | null;
  /** Runs parked at the review gate. */
  awaitingReview: number;
}

/** One topic a run could cover, for the scope picker. */
export interface GenerationTopicOption {
  id: number;
  code: string;
  title: string;
  section: string | null;
  status: TopicStatus;
  /** Cross-subject themes this topic participates in; shown, not chosen. */
  themes: string[];
}

/** A job plus its candidates, for the review step. */
export interface GenerationJobDetail {
  summary: GenerationJobSummary;
  /** What was asked for, as stored with the job when it was created. */
  input: GenerationJobInput | null;
  output: GenerationOutput;
}

/** Outcome of saving the candidates the gate was showing. */
export interface GenerationCommitResult {
  success: boolean;
  cards: number;
  quizzes: number;
  questions: number;
  /** Saved, but not exactly as asked: an unresolvable topic code, a skipped bucket. */
  warnings: string[];
  error?: string;
}

/** Outcome of answering the gate, or stopping a run that is still going. */
export interface GenerationActionResult {
  success: boolean;
  error?: string;
}
