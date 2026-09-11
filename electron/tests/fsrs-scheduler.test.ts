import { describe, expect, it } from "vitest";

import type { FlashcardRow } from "../src/shared/review-types";
import {
  cardFromRow,
  deserializeLog,
  fromCardState,
  fromFsrsRating,
  intervalLabel,
  reviewEntryFromItem,
  schedulePatch,
  serializeLog,
  toCardState,
  toFsrsRating,
} from "../services/fsrs/card";
import {
  applyRating,
  isDue,
  parametersFor,
  previewRatings,
  retrievability,
  rollbackRating,
  settingsFromConfig,
  DEFAULT_FSRS_SETTINGS,
} from "../services/fsrs/scheduler";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const NOW_ISO = "2026-09-10T12:00:00.000Z";

/** A persisted card row with sensible defaults, so each test states one thing. */
function cardRow(overrides: Partial<FlashcardRow> = {}): FlashcardRow {
  return {
    id: 1,
    topic_id: null,
    question: "What is the rate constant?",
    answer: "k",
    source: "manual",
    valence: null,
    difficulty: null,
    stability: null,
    last_review: null,
    next_review: null,
    review_count: 0,
    lapses: 0,
    state: "new",
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    last_rating: null,
    archived_at: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

describe("settingsFromConfig", () => {
  it("falls back to the documented defaults when keys are absent", () => {
    expect(settingsFromConfig({})).toEqual(DEFAULT_FSRS_SETTINGS);
  });

  it("reads retention and max interval from the config", () => {
    const settings = settingsFromConfig({
      FSRS_DESIRED_RETENTION: "0.95",
      FSRS_MAX_INTERVAL: "180",
    });
    expect(settings.desiredRetention).toBe(0.95);
    expect(settings.maximumInterval).toBe(180);
  });

  it("clamps retention into the range ts-fsrs can use", () => {
    expect(settingsFromConfig({ FSRS_DESIRED_RETENTION: "0.4" }).desiredRetention).toBe(0.7);
    expect(settingsFromConfig({ FSRS_DESIRED_RETENTION: "0.999" }).desiredRetention).toBe(0.97);
  });

  it("clamps the interval floor and ceiling", () => {
    expect(settingsFromConfig({ FSRS_MAX_INTERVAL: "0" }).maximumInterval).toBe(1);
    expect(settingsFromConfig({ FSRS_MAX_INTERVAL: "999999" }).maximumInterval).toBe(36_500);
  });

  it("ignores unparseable values instead of producing NaN", () => {
    const settings = settingsFromConfig({
      FSRS_DESIRED_RETENTION: "not-a-number",
      FSRS_MAX_INTERVAL: "",
    });
    expect(settings).toEqual(DEFAULT_FSRS_SETTINGS);
  });

  it("never enables fuzz, so scheduling stays reproducible", () => {
    expect(settingsFromConfig({}).enableFuzz).toBe(false);
    expect(parametersFor(settingsFromConfig({})).enable_fuzz).toBe(false);
  });

  it("passes the settings through to the ts-fsrs parameter set", () => {
    const params = parametersFor(
      settingsFromConfig({ FSRS_DESIRED_RETENTION: "0.8", FSRS_MAX_INTERVAL: "90" }),
    );
    expect(params.request_retention).toBe(0.8);
    expect(params.maximum_interval).toBe(90);
  });
});

describe("state and rating mapping", () => {
  it("round-trips ratings through the ts-fsrs enum", () => {
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      expect(fromFsrsRating(toFsrsRating(rating))).toBe(rating);
    }
  });

  it("round-trips card states through the ts-fsrs enum", () => {
    for (const state of ["new", "learning", "review", "relearning"] as const) {
      expect(toCardState(fromCardState(state))).toBe(state);
    }
  });

  it("maps unknown values to the safest state rather than throwing", () => {
    expect(toCardState(null)).toBe("new");
    expect(toCardState("nonsense")).toBe("new");
    expect(toCardState(99)).toBe("new");
  });
});

describe("cardFromRow", () => {
  it("rebuilds a never-reviewed card from its creation time", () => {
    const created = "2026-09-01T09:00:00.000Z";
    const card = cardFromRow(cardRow({ created_at: created }), NOW);
    expect(card.state).toBe(0);
    expect(card.reps).toBe(0);
    expect(card.due.toISOString()).toBe(created);
    expect(card.last_review).toBeUndefined();
  });

  it("carries every persisted FSRS field across", () => {
    const card = cardFromRow(
      cardRow({
        state: "review",
        difficulty: 5.5,
        stability: 21.25,
        last_review: "2026-09-01T12:00:00.000Z",
        next_review: "2026-09-20T12:00:00.000Z",
        elapsed_days: 9,
        scheduled_days: 19,
        learning_steps: 2,
        reps: 4,
        lapses: 1,
      }),
      NOW,
    );
    expect(card.difficulty).toBe(5.5);
    expect(card.stability).toBe(21.25);
    expect(card.state).toBe(2);
    expect(card.elapsed_days).toBe(9);
    expect(card.scheduled_days).toBe(19);
    expect(card.learning_steps).toBe(2);
    expect(card.reps).toBe(4);
    expect(card.lapses).toBe(1);
    expect(card.due.toISOString()).toBe("2026-09-20T12:00:00.000Z");
    expect(card.last_review?.toISOString()).toBe("2026-09-01T12:00:00.000Z");
  });

  it("treats a stored date as UTC, not as local time", () => {
    const card = cardFromRow(cardRow({ next_review: "2026-09-20T00:00:00.000Z" }), NOW);
    expect(card.due.getTime()).toBe(Date.UTC(2026, 8, 20, 0, 0, 0));
  });
});

describe("previewRatings", () => {
  it("returns all four grades in escalating order", () => {
    const previews = previewRatings(cardFromRow(cardRow(), NOW), NOW);
    expect(previews.map((p) => p.rating)).toEqual(["again", "hard", "good", "easy"]);
  });

  it("schedules Easy further out than Again", () => {
    const previews = previewRatings(cardFromRow(cardRow(), NOW), NOW);
    const again = new Date(previews[0].due).getTime();
    const easy = new Date(previews[3].due).getTime();
    expect(easy).toBeGreaterThan(again);
  });

  it("labels each interval for the button", () => {
    const previews = previewRatings(cardFromRow(cardRow(), NOW), NOW);
    for (const preview of previews) {
      expect(preview.intervalLabel.length).toBeGreaterThan(0);
      expect(new Date(preview.due).getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    }
    expect(previews[0].intervalLabel).toBe("1 min");
  });

  it("is deterministic across calls, because fuzz is off", () => {
    const card = cardFromRow(cardRow(), NOW);
    const first = previewRatings(card, NOW);
    const second = previewRatings(card, NOW);
    expect(second).toEqual(first);
  });

  it("gives a shorter interval when retention is demanded to be higher", () => {
    const card = cardFromRow(
      cardRow({
        state: "review",
        stability: 30,
        difficulty: 5,
        last_review: "2026-09-01T12:00:00.000Z",
        next_review: NOW_ISO,
        reps: 3,
        review_count: 3,
      }),
      NOW,
    );
    const relaxed = previewRatings(card, NOW, settingsFromConfig({ FSRS_DESIRED_RETENTION: "0.75" }));
    const strict = previewRatings(card, NOW, settingsFromConfig({ FSRS_DESIRED_RETENTION: "0.97" }));
    const relaxedGood = new Date(relaxed[2].due).getTime();
    const strictGood = new Date(strict[2].due).getTime();
    expect(strictGood).toBeLessThan(relaxedGood);
  });

  it("pulls long intervals back under the maximum interval cap", () => {
    const card = cardFromRow(
      cardRow({
        state: "review",
        stability: 5000,
        difficulty: 1,
        last_review: "2020-01-01T12:00:00.000Z",
        next_review: NOW_ISO,
        reps: 20,
        review_count: 20,
      }),
      NOW,
    );
    const capped = previewRatings(card, NOW, settingsFromConfig({ FSRS_MAX_INTERVAL: "30" }));
    const uncapped = previewRatings(card, NOW, settingsFromConfig({ FSRS_MAX_INTERVAL: "365" }));

    expect(capped[3].intervalDays).toBeLessThan(uncapped[3].intervalDays);
    // ts-fsrs caps the base interval and then nudges Hard/Good/Easy by a day or
    // two on top, so allow that slack rather than asserting the exact ceiling.
    expect(capped[3].intervalDays).toBeLessThanOrEqual(32);
  });
});

describe("applyRating + schedulePatch", () => {
  it("moves a new card into learning and records the attempt", () => {
    const card = cardFromRow(cardRow(), NOW);
    const { card: graded } = applyRating(card, "good", NOW);
    const patch = schedulePatch(graded, "good", NOW);

    expect(patch.state).toBe("learning");
    expect(patch.reps).toBe(1);
    expect(patch.review_count).toBe(1);
    expect(patch.last_rating).toBe(3);
    expect(patch.last_review).toBe(NOW_ISO);
    expect(patch.updated_at).toBe(NOW_ISO);
    expect(new Date(patch.next_review as string).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("round-trips through the row mapper without drifting", () => {
    const card = cardFromRow(cardRow(), NOW);
    const { card: graded } = applyRating(card, "easy", NOW);
    const patch = schedulePatch(graded, "easy", NOW);

    const reloaded = cardFromRow(cardRow({ ...patch, state: patch.state, id: 1 }), NOW);
    expect(reloaded.due.getTime()).toBe(graded.due.getTime());
    expect(reloaded.stability).toBeCloseTo(graded.stability, 6);
    expect(reloaded.state).toBe(graded.state);
  });

  it("increments lapses when a review card is forgotten", () => {
    const card = cardFromRow(
      cardRow({
        state: "review",
        stability: 20,
        difficulty: 5,
        last_review: "2026-09-01T12:00:00.000Z",
        next_review: NOW_ISO,
        elapsed_days: 9,
        scheduled_days: 20,
        reps: 3,
        review_count: 3,
        lapses: 0,
      }),
      NOW,
    );
    const { card: graded } = applyRating(card, "again", NOW);
    expect(graded.lapses).toBe(1);
    // Lapsing sends the card back to relearning rather than out on a long interval.
    expect(schedulePatch(graded, "again", NOW).state).toBe("relearning");
  });
});

describe("rollbackRating", () => {
  it("restores the card exactly as it was before the grade", () => {
    const before = cardFromRow(cardRow(), NOW);
    const { card: graded, log } = applyRating(before, "good", NOW);

    const restored = rollbackRating(graded, log);
    expect(restored).not.toBeNull();
    expect(restored?.due.getTime()).toBe(before.due.getTime());
    expect(restored?.reps).toBe(before.reps);
    expect(restored?.state).toBe(before.state);
    expect(restored?.stability).toBe(before.stability);
  });

  it("returns null rather than corrupting a card the log does not belong to", () => {
    const { log } = applyRating(cardFromRow(cardRow(), NOW), "good", NOW);
    const otherCard = cardFromRow(
      cardRow({
        state: "review",
        stability: 40,
        difficulty: 4,
        reps: 9,
        last_review: "2026-08-01T12:00:00.000Z",
        next_review: NOW_ISO,
      }),
      NOW,
    );
    expect(rollbackRating(otherCard, log)).toBeNull();
  });
});

describe("serializeLog / deserializeLog", () => {
  it("round-trips a review log with its dates intact", () => {
    const { log } = applyRating(cardFromRow(cardRow(), NOW), "hard", NOW);
    const restored = deserializeLog(serializeLog(log));
    expect(restored.review.getTime()).toBe(log.review.getTime());
    expect(restored.due.getTime()).toBe(log.due.getTime());
    expect(restored.rating).toBe(log.rating);
    expect(restored.state).toBe(log.state);
  });

  it("writes dates as ISO strings so SQLite round-trips them as UTC", () => {
    const { log } = applyRating(cardFromRow(cardRow(), NOW), "good", NOW);
    const raw = JSON.parse(serializeLog(log)) as { review: string; due: string };
    expect(raw.review).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(raw.due).toMatch(/Z$/);
  });
});

describe("reviewEntryFromItem", () => {
  it("records the state before and after the grade separately", () => {
    const { card, log } = applyRating(cardFromRow(cardRow(), NOW), "good", NOW);
    const item = { card, log };
    const entry = reviewEntryFromItem(item, {
      flashcardId: 7,
      sessionId: 3,
      rating: "good",
      durationMs: 4200,
      retrievability: 0.83,
    });

    expect(entry.flashcardId).toBe(7);
    expect(entry.sessionId).toBe(3);
    expect(entry.rating).toBe("good");
    expect(entry.stateBefore).toBe("new");
    expect(entry.stateAfter).toBe("learning");
    expect(entry.durationMs).toBe(4200);
    expect(entry.retrievability).toBe(0.83);
    expect(entry.reviewedAt).toBe(NOW_ISO);
    expect(deserializeLog(entry.logJson).review.getTime()).toBe(NOW.getTime());
  });

  it("defaults the optional context rather than leaving holes", () => {
    const item = applyRating(cardFromRow(cardRow(), NOW), "good", NOW);
    const entry = reviewEntryFromItem(item, { flashcardId: 1, rating: "good" });
    expect(entry.sessionId).toBeNull();
    expect(entry.durationMs).toBeNull();
    expect(entry.retrievability).toBeNull();
  });
});

describe("retrievability", () => {
  it("is undefined for a card with no memory state", () => {
    expect(retrievability(cardFromRow(cardRow(), NOW), NOW)).toBeNull();
  });

  it("is a probability between 0 and 1 once the card has been graded", () => {
    const { card } = applyRating(cardFromRow(cardRow(), NOW), "easy", NOW);
    const value = retrievability(card, new Date("2026-09-14T12:00:00.000Z"));
    expect(value).not.toBeNull();
    expect(value as number).toBeGreaterThan(0);
    expect(value as number).toBeLessThanOrEqual(1);
  });

  it("decays as time passes", () => {
    const { card } = applyRating(cardFromRow(cardRow(), NOW), "easy", NOW);
    const soon = retrievability(card, new Date("2026-09-12T12:00:00.000Z")) as number;
    const later = retrievability(card, new Date("2026-09-30T12:00:00.000Z")) as number;
    expect(later).toBeLessThan(soon);
  });

  it("is certain at the moment of review", () => {
    const { card } = applyRating(cardFromRow(cardRow(), NOW), "easy", NOW);
    expect(retrievability(card, NOW) as number).toBeCloseTo(1, 2);
  });
});

describe("isDue", () => {
  it("compares the due instant against now", () => {
    const card = cardFromRow(cardRow({ next_review: "2026-09-11T12:00:00.000Z" }), NOW);
    expect(isDue(card, NOW)).toBe(false);
    expect(isDue(card, new Date("2026-09-11T12:00:00.000Z"))).toBe(true);
    expect(isDue(card, new Date("2026-09-12T12:00:00.000Z"))).toBe(true);
  });
});

describe("intervalLabel", () => {
  it("uses the smallest sensible unit", () => {
    const at = (ms: number) => intervalLabel(new Date(NOW.getTime() + ms), NOW);
    expect(at(30_000)).toBe("<1 min");
    expect(at(10 * 60_000)).toBe("10 min");
    expect(at(3 * 3_600_000)).toBe("3 h");
    expect(at(6 * 86_400_000)).toBe("6 d");
    expect(at(90 * 86_400_000)).toBe("3 mo");
    expect(at(800 * 86_400_000)).toBe("2.2 y");
  });

  it("says 'now' for an interval that has already elapsed", () => {
    expect(intervalLabel(new Date(NOW.getTime() - 1000), NOW)).toBe("now");
  });
});
