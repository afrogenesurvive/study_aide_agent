import { fsrs, generatorParameters, State as FsrsState } from "ts-fsrs";
import type { Card, FSRS, FSRSParameters, Grade, RecordLogItem, ReviewLog } from "ts-fsrs";

import type { DueCard, Rating, RatingPreview } from "../../src/shared/review-types";
import { RATINGS } from "../../src/shared/review-types";
import { isoOf } from "../time";
import { intervalLabel, toCardState, toFsrsRating } from "./card";

/**
 * The FSRS engine adapter.
 *
 * Nothing outside this module imports `ts-fsrs` directly, so the scheduling
 * library stays swappable and every call site keeps working in terms of our own
 * `Rating` / `FsrsSettings` types.
 *
 * `enable_fuzz` is pinned off. Fuzz spreads intervals randomly to stop cards
 * clumping, but it also makes scheduling non-reproducible — and a study app
 * whose next-due date changes between two identical test runs is untestable.
 */

export interface FsrsSettings {
  /** Target probability of recall at review time. `FSRS_DESIRED_RETENTION`. */
  desiredRetention: number;
  /** Hard cap on the interval in days. `FSRS_MAX_INTERVAL`. */
  maximumInterval: number;
  enableFuzz: boolean;
}

export const DEFAULT_FSRS_SETTINGS: FsrsSettings = {
  desiredRetention: 0.9,
  maximumInterval: 365,
  enableFuzz: false,
};

const RETENTION_RANGE = { min: 0.7, max: 0.97 };
const INTERVAL_RANGE = { min: 1, max: 36_500 };
const PRECISION = 2;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  // An empty string means "unset", not zero. `Number("")` is 0, which would
  // quietly turn a blank interval cap into "one day".
  if (typeof value === "string" && value.trim() === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Read FSRS settings out of the flat string config, clamping unsafe values. */
export function settingsFromConfig(
  config: Record<string, string | undefined | null>,
): FsrsSettings {
  const retention = clampNumber(
    config.FSRS_DESIRED_RETENTION,
    RETENTION_RANGE.min,
    RETENTION_RANGE.max,
    DEFAULT_FSRS_SETTINGS.desiredRetention,
  );
  const interval = Math.round(
    clampNumber(
      config.FSRS_MAX_INTERVAL,
      INTERVAL_RANGE.min,
      INTERVAL_RANGE.max,
      DEFAULT_FSRS_SETTINGS.maximumInterval,
    ),
  );
  return {
    desiredRetention: Number(retention.toFixed(PRECISION)),
    maximumInterval: interval,
    enableFuzz: false,
  };
}

/** The ts-fsrs parameter set implied by our settings. Exported for diagnostics. */
export function parametersFor(settings: FsrsSettings): FSRSParameters {
  const base = generatorParameters();
  return {
    ...base,
    request_retention: settings.desiredRetention,
    maximum_interval: settings.maximumInterval,
    enable_fuzz: settings.enableFuzz,
  };
}

const schedulerCache = new Map<string, FSRS>();

/**
 * Build (or reuse) a scheduler for the given settings.
 *
 * `fsrs()` allocates the weight vector each call, and the review queue calls
 * this once per card, so instances are memoised on their parameter set. Settings
 * changes produce a new key, which means a Settings-panel edit takes effect on
 * the next call with no restart.
 */
export function buildScheduler(settings: FsrsSettings = DEFAULT_FSRS_SETTINGS): FSRS {
  const key = `${settings.desiredRetention}|${settings.maximumInterval}|${settings.enableFuzz}`;
  const cached = schedulerCache.get(key);
  if (cached) return cached;
  const created = fsrs(parametersFor(settings));
  schedulerCache.set(key, created);
  return created;
}

/**
 * All four outcomes for a card, so the review UI can show what each button does
 * before the user commits to one.
 */
export function previewRatings(
  card: Card,
  now: Date,
  settings: FsrsSettings = DEFAULT_FSRS_SETTINGS,
): RatingPreview[] {
  const preview = buildScheduler(settings).repeat(card, now);
  return RATINGS.map((rating) => {
    const item = preview[toFsrsRating(rating) as Grade];
    return {
      rating,
      due: isoOf(item.card.due),
      intervalDays: item.card.scheduled_days,
      state: toCardState(item.card.state),
      intervalLabel: intervalLabel(item.card.due, now),
    };
  });
}

/** Apply a grade. Returns the new card plus the log that produced it. */
export function applyRating(
  card: Card,
  rating: Rating,
  now: Date,
  settings: FsrsSettings = DEFAULT_FSRS_SETTINGS,
): RecordLogItem {
  const grade = toFsrsRating(rating) as Grade;
  return buildScheduler(settings).next(card, now, grade);
}

/**
 * Undo a grade, returning the card as it was before.
 *
 * Requires the *exact* log that was recorded, which is why `card_reviews` keeps
 * the serialized ts-fsrs log rather than a reconstructed one. Returns null when
 * ts-fsrs cannot roll the card back.
 */
export function rollbackRating(
  card: Card,
  log: ReviewLog,
  settings: FsrsSettings = DEFAULT_FSRS_SETTINGS,
): Card | null {
  // ts-fsrs will happily reverse a log that belongs to a different review, and
  // the result is a silently corrupted schedule. Refuse the mismatch instead.
  const cardReviewedAt = card.last_review?.getTime();
  const logReviewedAt = log.review?.getTime();
  if (cardReviewedAt !== undefined && logReviewedAt !== undefined && cardReviewedAt !== logReviewedAt) {
    return null;
  }
  try {
    return buildScheduler(settings).rollback(card, log);
  } catch {
    return null;
  }
}

/**
 * Current recall probability, 0–1, or null for cards with no memory state yet.
 *
 * A brand-new card has zero stability, and the forgetting curve is undefined
 * there, so reporting null is more honest than reporting 0 or NaN.
 */
export function retrievability(
  card: Card,
  now: Date,
  settings: FsrsSettings = DEFAULT_FSRS_SETTINGS,
): number | null {
  if (card.state === FsrsState.New || card.stability <= 0) return null;
  try {
    const value = buildScheduler(settings).get_retrievability(card, now, false);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function isDue(card: Card, now: Date): boolean {
  return card.due.getTime() <= now.getTime();
}

/** Whether a card is "new" as far as the daily intake cap is concerned. */
export function isNewCard(card: Card): boolean {
  return card.state === FsrsState.New;
}

/**
 * Fill in per-card retrievability for a due queue.
 *
 * Kept out of the repository on purpose: `repo.ts` stays pure SQL, and all of
 * the memory-model maths lives here where it can be tested with plain objects.
 */
export function annotateRetrievability(
  cards: DueCard[],
  now: Date,
  cardLookup: (card: DueCard) => Card,
  settings: FsrsSettings = DEFAULT_FSRS_SETTINGS,
): DueCard[] {
  return cards.map((card) => ({
    ...card,
    retrievability: retrievability(cardLookup(card), now, settings),
  }));
}
