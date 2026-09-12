/**
 * Material generation: persisted shapes, the request the UI sends, and the
 * candidate payload the pipeline produces.
 *
 * Self-contained on purpose — `tsconfig.json` type-checks `src/shared` for the
 * renderer, which cannot see anything under `services/`. The runner's
 * main↔child NDJSON protocol is deliberately *not* here: the renderer never sees
 * it, so it lives beside the runner in `agent-runner/protocol.ts`.
 */

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
  /** Skip the review gate and write straight through. Off by default. */
  autoCommit?: boolean;
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

export interface GenerationRunResult {
  jobId: number;
  status: GenerationStatus;
  cards: number;
  questions: number;
  warnings: string[];
  error?: string;
}
