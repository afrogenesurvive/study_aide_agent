import { createEmptyCard, Rating as FsrsRating, State as FsrsState } from "ts-fsrs";
import type { Card, RecordLogItem, ReviewLog } from "ts-fsrs";

import type {
  CardSchedulePatch,
  CardState,
  FlashcardRow,
  Rating,
  ReviewLogEntry,
} from "../../src/shared/review-types";
import { RATING_VALUES } from "../../src/shared/review-types";
import { isoOf, parseIso } from "../time";

/**
 * Translation between our persisted rows and ts-fsrs' in-memory shapes.
 *
 * Everything here is pure: no database, no clock of its own. That is what lets
 * the whole FSRS surface be unit-tested without a SQLite instance.
 *
 * Two conversions are worth calling out:
 *  - State is stored as readable text (`"new"`, `"review"`) rather than the
 *    library's integers, because the column predates ts-fsrs and `'new'` is its
 *    declared default.
 *  - Every Date is stored as ISO-8601 UTC with a trailing `Z`. ts-fsrs compares
 *    dates by instant, so a stored `YYYY-MM-DD HH:MM:SS` (SQLite's own format)
 *    would be read back as *local* time and shift every interval by the machine's
 *    UTC offset.
 */

const RATING_TO_FSRS: Record<Rating, FsrsRating> = {
  again: FsrsRating.Again,
  hard: FsrsRating.Hard,
  good: FsrsRating.Good,
  easy: FsrsRating.Easy,
};

const FSRS_TO_RATING = new Map<number, Rating>(
  Object.entries(RATING_TO_FSRS).map(([rating, value]) => [value, rating as Rating]),
);

const STATE_TO_TEXT = new Map<number, CardState>([
  [FsrsState.New, "new"],
  [FsrsState.Learning, "learning"],
  [FsrsState.Review, "review"],
  [FsrsState.Relearning, "relearning"],
]);

const TEXT_TO_STATE = new Map<CardState, FsrsState>(
  [...STATE_TO_TEXT.entries()].map(([value, text]) => [text, value]),
);

export function toFsrsRating(rating: Rating): FsrsRating {
  return RATING_TO_FSRS[rating];
}

export function fromFsrsRating(value: number): Rating {
  return FSRS_TO_RATING.get(Number(value)) ?? "again";
}

/** Accepts either a ts-fsrs numeric state or an already-textual one. */
export function toCardState(value: number | string | null | undefined): CardState {
  if (typeof value === "number") return STATE_TO_TEXT.get(value) ?? "new";
  if (typeof value === "string") {
    return TEXT_TO_STATE.has(value as CardState) ? (value as CardState) : "new";
  }
  return "new";
}

export function fromCardState(state: CardState): FsrsState {
  return TEXT_TO_STATE.get(state) ?? FsrsState.New;
}

/**
 * Rebuild the in-memory card FSRS needs from its persisted row.
 *
 * A card that has never been graded is reconstructed from `created_at` so its
 * "due" lands where it would have on creation, rather than jumping to now.
 */
export function cardFromRow(row: FlashcardRow, now: Date = new Date()): Card {
  const lastReview = parseIso(row.last_review);
  const due = parseIso(row.next_review);
  const created = parseIso(row.created_at) ?? now;

  if (!lastReview && !due) {
    return createEmptyCard(created);
  }

  const card: Card = {
    due: due ?? created,
    stability: row.stability ?? 0,
    difficulty: row.difficulty ?? 0,
    elapsed_days: row.elapsed_days ?? 0,
    scheduled_days: row.scheduled_days ?? 0,
    learning_steps: row.learning_steps ?? 0,
    reps: row.reps ?? 0,
    lapses: row.lapses ?? 0,
    state: fromCardState(row.state),
  };
  if (lastReview) card.last_review = lastReview;
  return card;
}

/**
 * The card columns FSRS writes back after a review.
 *
 * `rating` is the grade to record as "last rating" and is nullable because undo
 * rewrites the card into its pre-review state, where the last rating is that of
 * the review *before* the one being undone (or none at all).
 */
export function schedulePatch(
  card: Card,
  rating: Rating | null,
  now: Date,
): CardSchedulePatch {
  return {
    difficulty: card.difficulty,
    stability: card.stability,
    last_review: card.last_review ? isoOf(card.last_review) : null,
    next_review: isoOf(card.due),
    review_count: card.reps,
    lapses: card.lapses,
    state: toCardState(card.state),
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    last_rating: rating ? RATING_VALUES[rating] : null,
    updated_at: isoOf(now),
  };
}

/** JSON-encode a `ReviewLog`, flattening its Dates to ISO strings. */
export function serializeLog(log: ReviewLog): string {
  return JSON.stringify({ ...log, due: isoOf(log.due), review: isoOf(log.review) });
}

/** Inverse of `serializeLog`. Throws only on corrupt input. */
export function deserializeLog(json: string): ReviewLog {
  const raw = JSON.parse(json) as ReviewLog;
  return {
    ...raw,
    due: new Date(raw.due),
    review: new Date(raw.review),
  };
}

export interface ReviewLogContext {
  flashcardId: number;
  sessionId?: number | null;
  rating: Rating;
  durationMs?: number | null;
  retrievability?: number | null;
}

/**
 * Flatten a ts-fsrs result into a `card_reviews` row.
 *
 * Note the two directions: `log.state` is the state the card was in *before*
 * grading, while `card.state` is where it ended up. `scheduled_days` is taken
 * from the card (the interval just assigned) rather than the log (the interval
 * that was in force), because the UI wants to show the new one.
 */
export function reviewEntryFromItem(
  item: RecordLogItem,
  context: ReviewLogContext,
): ReviewLogEntry {
  return {
    flashcardId: context.flashcardId,
    sessionId: context.sessionId ?? null,
    rating: context.rating,
    stateBefore: toCardState(item.log.state),
    stateAfter: toCardState(item.card.state),
    elapsedDays: item.log.elapsed_days,
    scheduledDays: item.card.scheduled_days,
    stability: item.card.stability,
    difficulty: item.card.difficulty,
    retrievability: context.retrievability ?? null,
    durationMs: context.durationMs ?? null,
    reviewedAt: isoOf(item.log.review),
    logJson: serializeLog(item.log),
  };
}

/**
 * Short human label for an interval, e.g. `"10 min"`, `"3 h"`, `"6 d"`.
 *
 * FSRS learning steps are sub-day, so minutes and hours matter as much as days.
 */
export function intervalLabel(due: Date, now: Date): string {
  const ms = due.getTime() - now.getTime();
  if (ms <= 0) return "now";
  const minutes = ms / 60_000;
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = ms / 86_400_000;
  if (days < 31) return `${Math.round(days)} d`;
  const months = days / 30.44;
  if (months < 12) return `${Math.round(months)} mo`;
  return `${(days / 365.25).toFixed(1)} y`;
}
