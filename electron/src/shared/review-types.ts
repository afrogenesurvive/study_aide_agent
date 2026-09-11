/**
 * Review + spaced-repetition domain types.
 *
 * Shared by `services/fsrs`, `services/scheduler`, the main process and the
 * renderer — the same role `syllabus-types.ts` plays for phase 1.
 *
 * The persisted row shapes mirror the SQLite columns exactly (snake_case), while
 * everything the UI passes around uses camelCase, so the boundary between
 * "database row" and "app value" stays obvious.
 */

import type { Subject, Valence } from "./syllabus-types";

/** Re-exported so consumers need only import from `review-types`. */
export type { Subject, Valence } from "./syllabus-types";

// ── ratings ──────────────────────────────────────────────────────────────────

/** The four FSRS grades, in escalating order. */
export type Rating = "again" | "hard" | "good" | "easy";

export const RATINGS: Rating[] = ["again", "hard", "good", "easy"];

export const RATING_LABELS: Record<Rating, string> = {
  again: "Again",
  hard: "Hard",
  good: "Good",
  easy: "Easy",
};

/** Single-key shortcuts used by the review view. */
export const RATING_KEYS: Record<Rating, string> = {
  again: "1",
  hard: "2",
  good: "3",
  easy: "4",
};

/** Numeric grades as stored in `card_reviews.rating` (matches ts-fsrs). */
export const RATING_VALUES: Record<Rating, number> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};

export const RATING_DESCRIPTIONS: Record<Rating, string> = {
  again: "Forgot it — show it again today",
  hard: "Recalled with real effort",
  good: "Recalled correctly",
  easy: "Instant, effortless recall",
};

// ── card state ───────────────────────────────────────────────────────────────

/** Mirrors ts-fsrs' `State` enum, stored as readable text. */
export type CardState = "new" | "learning" | "review" | "relearning";

export const CARD_STATES: CardState[] = ["new", "learning", "review", "relearning"];

export const CARD_STATE_LABELS: Record<CardState, string> = {
  new: "New",
  learning: "Learning",
  review: "Review",
  relearning: "Relearning",
};

/** Where a card came from. Phase 3 fills `generated`; imports use `imported`. */
export type CardSource = "manual" | "generated" | "imported";

export const CARD_SOURCES: CardSource[] = ["manual", "generated", "imported"];

// ── rows ─────────────────────────────────────────────────────────────────────

/** A persisted `flashcards` row (including the 002 FSRS columns). */
export interface FlashcardRow {
  id: number;
  topic_id: number | null;
  question: string;
  answer: string;
  source: string;
  valence: Valence | null;
  difficulty: number | null;
  stability: number | null;
  last_review: string | null;
  next_review: string | null;
  review_count: number;
  lapses: number;
  state: CardState;
  elapsed_days: number;
  scheduled_days: number;
  /** Position within the ts-fsrs (re)learning steps; 0 when not in a step. */
  learning_steps: number;
  reps: number;
  last_rating: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string | null;
}

/** A persisted `card_reviews` row. Append-only. */
export interface CardReviewRow {
  id: number;
  flashcard_id: number;
  session_id: number | null;
  rating: number;
  state_before: string | null;
  state_after: string | null;
  elapsed_days: number;
  scheduled_days: number;
  stability: number | null;
  difficulty: number | null;
  retrievability: number | null;
  duration_ms: number | null;
  reviewed_at: string;
  /**
   * The exact ts-fsrs `ReviewLog` that produced this row, JSON-encoded with
   * Dates as ISO strings. Kept verbatim because `rollback()` needs the original
   * log field-for-field, and because future ts-fsrs versions may add fields we
   * would otherwise lose.
   */
  log_json: string;
  created_at: string;
}

// ── inputs ───────────────────────────────────────────────────────────────────

export interface CardInput {
  question: string;
  answer: string;
  topicId?: number | null;
  source?: CardSource | string;
  valence?: Valence | null;
}

export interface CardPatch {
  question?: string;
  answer?: string;
  topicId?: number | null;
  valence?: Valence | null;
}

/** The subset of columns FSRS itself writes. */
export interface CardSchedulePatch {
  difficulty: number | null;
  stability: number | null;
  last_review: string | null;
  next_review: string | null;
  review_count: number;
  lapses: number;
  state: CardState;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  last_rating: number | null;
  updated_at: string;
}

export interface ReviewLogEntry {
  flashcardId: number;
  sessionId?: number | null;
  rating: Rating;
  stateBefore: CardState;
  stateAfter: CardState;
  elapsedDays: number;
  scheduledDays: number;
  stability: number | null;
  difficulty: number | null;
  retrievability: number | null;
  durationMs?: number | null;
  reviewedAt: string;
  /** Serialized ts-fsrs `ReviewLog`, for exact rollback. */
  logJson: string;
}

// ── view models ──────────────────────────────────────────────────────────────

/** What each rating button would do, previewed before the user commits. */
export interface RatingPreview {
  rating: Rating;
  /** ISO-8601 UTC. */
  due: string;
  intervalDays: number;
  state: CardState;
  /** Human label, e.g. "6d" or "10 min". */
  intervalLabel: string;
}

/** A due card joined to its syllabus topic + subject. */
export interface DueCard extends FlashcardRow {
  topic_code: string | null;
  topic_title: string | null;
  syllabus_id: number | null;
  subject: Subject | null;
  /** Whole days past due; 0 when due today or not yet due. */
  overdue_days: number;
  /** FSRS retrievability at the time of the query, 0–1. Null for new cards. */
  retrievability: number | null;
}

export interface DueCounts {
  new: number;
  learning: number;
  due: number;
  total: number;
}

export interface SubjectDue extends DueCounts {
  subject: Subject;
}

export interface DueSummary {
  /** ISO-8601 UTC instant the summary was computed for. */
  asOf: string;
  /** Local calendar day, `YYYY-MM-DD`. */
  dateKey: string;
  counts: DueCounts;
  bySubject: SubjectDue[];
  /** New cards still allowed today after `NEW_CARDS_PER_DAY`. */
  newRemaining: number;
  newLimit: number;
  introducedToday: number;
  /** Cards in the queue right now, i.e. due + allowed new. */
  queueSize: number;
}

export interface ReviewFilter {
  /** Restrict to one syllabus. Omitted = every syllabus. */
  syllabusId?: number | null;
  subject?: Subject | null;
  topicId?: number | null;
  includeArchived?: boolean;
  includeNew?: boolean;
  limit?: number;
}

export interface ReviewStats {
  totalCards: number;
  byState: Record<CardState, number>;
  dueNow: number;
  reviewedToday: number;
  retentionToday: number | null;
}

// ── service results ──────────────────────────────────────────────────────────

export interface GradeResult {
  success: boolean;
  error?: string;
  /** The card as it stands after the grade. */
  card?: DueCard;
  reviewId?: number;
  /**
   * What the four buttons would do *from the card's new state*, e.g. what a
   * second pass over the same card would schedule. Identical to calling
   * `previewForCard` again, so an undo can refresh its buttons from one round trip.
   */
  preview?: RatingPreview[];
}

export interface UndoResult {
  success: boolean;
  error?: string;
  card?: DueCard;
}

/** One row of the per-topic coverage-vs-cards breakdown. */
export interface TopicCardCount {
  topicId: number;
  code: string;
  title: string;
  status: string;
  cardCount: number;
  dueCount: number;
}
