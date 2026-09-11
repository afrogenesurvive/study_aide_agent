import type { Database } from "../database/db";
import type {
  DueCard,
  DueSummary,
  GradeResult,
  Rating,
  RatingPreview,
  ReviewFilter,
  ReviewStats,
  UndoResult,
} from "../../src/shared/review-types";
import { withTransaction } from "../database/migrations";
import { dayKey, dayStart, isoOf } from "../time";
import {
  cardFromRow,
  deserializeLog,
  fromFsrsRating,
  intervalLabel,
  reviewEntryFromItem,
  schedulePatch,
} from "./card";
import * as repo from "./repo";
import {
  applyRating,
  previewRatings,
  retrievability,
  rollbackRating,
  settingsFromConfig,
  type FsrsSettings,
} from "./scheduler";

/**
 * The review workflow: everything that needs the config, the clock *and* the
 * database at once.
 *
 * `repo.ts` is pure SQL, `card.ts` and `scheduler.ts` are pure maths. This module
 * is the only place they meet, which keeps the interesting logic testable in
 * isolation and gives the IPC layer one obvious entry point per operation.
 */

export interface ReviewOptions {
  now: Date;
  timeZone: string;
  settings: FsrsSettings;
  newCardsPerDay: number;
}

/**
 * Resolve options from the flat string config.
 *
 * `now` is injected rather than read here so a whole review session can be
 * driven from a fixed instant in tests.
 */
export function resolveOptions(
  config: Record<string, string | undefined | null>,
  now: Date = new Date(),
): ReviewOptions {
  const parsedLimit = Number(config.NEW_CARDS_PER_DAY);
  return {
    now,
    timeZone: config.TIMEZONE?.trim() || "UTC",
    settings: settingsFromConfig(config),
    newCardsPerDay: Number.isFinite(parsedLimit) ? Math.max(0, Math.round(parsedLimit)) : 20,
  };
}

/** Cards due right now, with the daily new-card cap applied. */
export function reviewQueue(
  db: Database,
  options: ReviewOptions,
  filter?: ReviewFilter | null,
): DueCard[] {
  const since = dayStart(options.now, options.timeZone);
  const introducedToday = repo.countIntroducedToday(db, since);
  const newRemaining = Math.max(0, options.newCardsPerDay - introducedToday);
  return repo.listQueue(db, { now: options.now, filter, newLimit: newRemaining });
}

/** The dashboard's numbers: what is due, broken down by subject. */
export function dueSummary(
  db: Database,
  options: ReviewOptions,
  filter?: ReviewFilter | null,
): DueSummary {
  const { now, timeZone } = options;
  const introducedToday = repo.countIntroducedToday(db, dayStart(now, timeZone));
  const newRemaining = Math.max(0, options.newCardsPerDay - introducedToday);

  const counts = repo.countDue(db, { now, filter, newLimit: null });
  const bySubject = repo.countDueBySubject(db, { now, filter, newLimit: null });

  return {
    asOf: isoOf(now),
    dateKey: dayKey(now, timeZone),
    counts,
    bySubject,
    newRemaining,
    newLimit: options.newCardsPerDay,
    introducedToday,
    queueSize: counts.due + counts.learning + Math.min(counts.new, newRemaining),
  };
}

/** What each rating button would schedule. Previewed before the user commits. */
export function previewForCard(
  db: Database,
  options: ReviewOptions,
  cardId: number,
): RatingPreview[] | null {
  const row = repo.getCard(db, cardId);
  if (!row) return null;
  return previewRatings(cardFromRow(row, options.now), options.now, options.settings);
}

export interface GradeInput {
  cardId: number;
  rating: Rating;
  sessionId?: number | null;
  /** Milliseconds spent on the card, for the analytics that land in phase 6. */
  durationMs?: number | null;
}

/**
 * Grade a card and persist the whole consequence in one transaction.
 *
 * Three writes have to agree — the card's new schedule, the review log, and the
 * "new cards introduced today" count that is *derived* from that log — so they
 * are committed together or not at all.
 */
export function gradeCard(
  db: Database,
  options: ReviewOptions,
  input: GradeInput,
): GradeResult {
  const row = repo.getCard(db, input.cardId);
  if (!row) return { success: false, error: `No card with id ${input.cardId}.` };

  const { now, settings } = options;
  const card = cardFromRow(row, now);
  const retrievabilityBefore = retrievability(card, now, settings);
  const item = applyRating(card, input.rating, now, settings);

  const entry = reviewEntryFromItem(item, {
    flashcardId: input.cardId,
    sessionId: input.sessionId ?? null,
    rating: input.rating,
    durationMs: input.durationMs ?? null,
    retrievability: retrievabilityBefore,
  });

  let reviewId = 0;
  withTransaction(db, () => {
    repo.applySchedule(db, input.cardId, schedulePatch(item.card, input.rating, now));
    reviewId = repo.logReview(db, entry);
  });

  return {
    success: true,
    reviewId,
    card: repo.getDueCard(db, input.cardId, now) ?? undefined,
    preview: previewRatings(item.card, now, settings),
  };
}

/**
 * Undo the most recent grade on a card.
 *
 * ts-fsrs' `rollback()` needs the exact log that produced the current state, so
 * the serialized log is read back from `card_reviews` rather than rebuilt. The
 * log row is deleted as part of the same transaction, which also hands the
 * "new card" allowance back if the review was the card's first.
 */
export function undoLastReview(
  db: Database,
  options: ReviewOptions,
  cardId: number,
): UndoResult {
  const row = repo.getCard(db, cardId);
  if (!row) return { success: false, error: `No card with id ${cardId}.` };

  const review = repo.latestReview(db, cardId);
  if (!review) return { success: false, error: "This card has no reviews to undo." };

  const { now, settings } = options;
  let log;
  try {
    log = deserializeLog(review.log_json);
  } catch {
    return { success: false, error: "The stored review log is unreadable." };
  }

  const previous = rollbackRating(cardFromRow(row, now), log, settings);
  if (!previous) return { success: false, error: "FSRS could not roll this review back." };

  // `last_rating` should describe the review that is still standing.
  const remaining = repo
    .listReviews(db, cardId, 2)
    .filter((entry) => entry.id !== review.id)[0];
  const lastRating = remaining ? fromFsrsRating(remaining.rating) : null;

  withTransaction(db, () => {
    repo.deleteReview(db, review.id);
    repo.applySchedule(db, cardId, schedulePatch(previous, lastRating, now));
  });

  return { success: true, card: repo.getDueCard(db, cardId, now) ?? undefined };
}

export function statsFor(
  db: Database,
  options: ReviewOptions,
  filter?: ReviewFilter | null,
): ReviewStats {
  return repo.reviewStats(db, {
    now: options.now,
    dayStart: dayStart(options.now, options.timeZone),
    filter,
  });
}

/**
 * Human label for when a card is next due, e.g. `"in 6 d"`.
 *
 * Lives here rather than in the renderer because the interval maths belongs next
 * to the scheduling code.
 */
export function dueLabel(card: DueCard, now: Date): string {
  const due = card.next_review ? new Date(card.next_review) : null;
  if (!due) return "new";
  if (due.getTime() <= now.getTime()) {
    return card.overdue_days > 0 ? `${card.overdue_days} d overdue` : "due now";
  }
  return `in ${intervalLabel(due, now)}`;
}
