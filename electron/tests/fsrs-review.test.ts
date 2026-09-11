import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../services/database/db";
import {
  dueLabel,
  dueSummary,
  gradeCard,
  previewForCard,
  resolveOptions,
  reviewQueue,
  statsFor,
  undoLastReview,
} from "../services/fsrs/service";
import * as repo from "../services/fsrs/repo";
import { createTestDb } from "./helpers/test-db";
import { insertCard, NOW, seedSyllabus } from "./helpers/review-fixtures";

/** Config as the Settings panel would supply it: every value a string. */
const CONFIG = {
  TIMEZONE: "UTC",
  NEW_CARDS_PER_DAY: "2",
  FSRS_DESIRED_RETENTION: "0.9",
  FSRS_MAX_INTERVAL: "365",
};

function options(overrides: Record<string, string> = {}) {
  return resolveOptions({ ...CONFIG, ...overrides }, NOW);
}

describe("resolveOptions", () => {
  it("reads the scheduling knobs out of the config", () => {
    const resolved = options();
    expect(resolved.timeZone).toBe("UTC");
    expect(resolved.newCardsPerDay).toBe(2);
    expect(resolved.settings.desiredRetention).toBe(0.9);
    expect(resolved.settings.maximumInterval).toBe(365);
  });

  it("falls back to a sane new-card allowance when the key is missing or junk", () => {
    expect(resolveOptions({}, NOW).newCardsPerDay).toBe(20);
    expect(resolveOptions({ NEW_CARDS_PER_DAY: "lots" }, NOW).newCardsPerDay).toBe(20);
  });

  it("treats an explicit zero as 'no new cards today' rather than as unset", () => {
    expect(resolveOptions({ NEW_CARDS_PER_DAY: "0" }, NOW).newCardsPerDay).toBe(0);
  });

  it("falls back to UTC when no timezone is configured", () => {
    expect(resolveOptions({}, NOW).timeZone).toBe("UTC");
  });
});

describe("dueSummary", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("reports the queue, the caps and the local day", () => {
    for (let i = 0; i < 5; i += 1) insertCard(db, { question: `q${i}`, answer: "A" });

    const summary = dueSummary(db, options());
    expect(summary.dateKey).toBe("2026-09-10");
    expect(summary.asOf).toBe(NOW.toISOString());
    expect(summary.counts).toEqual({ new: 5, learning: 0, due: 0, total: 5 });
    expect(summary.newLimit).toBe(2);
    expect(summary.introducedToday).toBe(0);
    expect(summary.newRemaining).toBe(2);
    // Five cards are due, but only two of them are new and the cap is two.
    expect(summary.queueSize).toBe(2);
  });

  it("breaks the queue down by subject", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    const biology = seedSyllabus(db, "biology", ["14"]);
    insertCard(db, { question: "chem-1", answer: "A", topicId: chemistry.topicIds[0] });
    insertCard(db, { question: "chem-2", answer: "A", topicId: chemistry.topicIds[0] });
    insertCard(db, { question: "bio-1", answer: "A", topicId: biology.topicIds[0] });

    const summary = dueSummary(db, options({ NEW_CARDS_PER_DAY: "10" }));
    expect(summary.bySubject[0]).toMatchObject({ subject: "chemistry", total: 2 });
    expect(summary.bySubject[1]).toMatchObject({ subject: "biology", total: 1 });
  });

  it("shrinks the remaining allowance as new cards are introduced", () => {
    const ids = [1, 2, 3].map((i) =>
      insertCard(db, { question: `q${i}`, answer: "A" }),
    );
    gradeCard(db, options(), { cardId: ids[0], rating: "good" });

    const summary = dueSummary(db, options());
    expect(summary.introducedToday).toBe(1);
    expect(summary.newRemaining).toBe(1);
  });

  it("does not spend the new-card allowance on a review card", () => {
    insertCard(db, {
      question: "review",
      answer: "A",
      state: "review",
      dueAt: NOW.toISOString(),
      reps: 2,
    });
    const summary = dueSummary(db, options());
    expect(summary.counts.due).toBe(1);
    expect(summary.newRemaining).toBe(2);
    expect(summary.queueSize).toBe(1);
  });

  it("allows no new cards at all when the limit is zero", () => {
    insertCard(db, { question: "q", answer: "A" });
    const summary = dueSummary(db, options({ NEW_CARDS_PER_DAY: "0" }));
    expect(summary.newRemaining).toBe(0);
    expect(summary.queueSize).toBe(0);
  });
});

describe("reviewQueue", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("admits only the remaining new cards", () => {
    for (let i = 0; i < 4; i += 1) insertCard(db, { question: `q${i}`, answer: "A" });
    expect(reviewQueue(db, options())).toHaveLength(2);
  });

  it("still returns review cards once the new-card allowance is spent", () => {
    insertCard(db, { question: "new", answer: "A" });
    insertCard(db, {
      question: "review",
      answer: "A",
      state: "review",
      dueAt: NOW.toISOString(),
      reps: 1,
    });
    const queue = reviewQueue(db, options({ NEW_CARDS_PER_DAY: "0" }));
    expect(queue.map((card) => card.question)).toEqual(["review"]);
  });
});

describe("gradeCard", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("schedules the card, logs the review and returns the updated row", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    const result = gradeCard(db, options(), { cardId: id, rating: "good" });

    expect(result.success).toBe(true);
    expect(result.card?.state).toBe("learning");
    expect(result.card?.reps).toBe(1);
    expect(result.card?.last_rating).toBe(3);
    expect(result.reviewId).toBeGreaterThan(0);

    const history = repo.listReviews(db, id);
    expect(history).toHaveLength(1);
    expect(history[0].state_before).toBe("new");
    expect(history[0].state_after).toBe("learning");
  });

  it("returns the previews for the card's new state", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    const result = gradeCard(db, options(), { cardId: id, rating: "easy" });
    expect(result.preview?.map((p) => p.rating)).toEqual(["again", "hard", "good", "easy"]);
  });

  it("records the grade in the log and on the card", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    gradeCard(db, options(), { cardId: id, rating: "again" });
    // Again is grade 1 in the ts-fsrs enum.
    expect(repo.latestReview(db, id)?.rating).toBe(1);
    expect(repo.getCard(db, id)?.last_rating).toBe(1);
  });

  it("attaches the review to a session when one is running", () => {
    db.prepare(
      "INSERT INTO study_sessions (session_date, duration) VALUES ('2026-09-10', 20)",
    ).run();
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    gradeCard(db, options(), { cardId: id, rating: "good", sessionId: 1, durationMs: 2500 });
    const review = repo.latestReview(db, id);
    expect(review?.session_id).toBe(1);
    expect(review?.duration_ms).toBe(2500);
  });

  it("schedules the card to the interval its grade previewed", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    // The number shown on the button before the click must be the schedule the
    // click actually produces.
    const easy = previewForCard(db, options(), id)?.find((p) => p.rating === "easy");
    const result = gradeCard(db, options(), { cardId: id, rating: "easy" });
    expect(result.card?.next_review).toBe(easy?.due);
  });

  it("returns previews matching a fresh lookup for the card's new state", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    const result = gradeCard(db, options(), { cardId: id, rating: "good" });
    expect(result.preview).toEqual(previewForCard(db, options(), id));
  });

  it("fails cleanly for a card that does not exist", () => {
    const result = gradeCard(db, options(), { cardId: 999, rating: "good" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("999");
  });
});

describe("undoLastReview", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("restores the card to its pre-review state and removes the log row", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    const before = repo.getCard(db, id);
    gradeCard(db, options(), { cardId: id, rating: "good" });

    const undone = undoLastReview(db, options(), id);
    expect(undone.success).toBe(true);
    expect(undone.card?.state).toBe("new");
    expect(undone.card?.next_review).toBe(before?.next_review);
    expect(undone.card?.last_rating).toBeNull();
    expect(repo.listReviews(db, id)).toHaveLength(0);
  });

  it("hands the new-card allowance back", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    expect(dueSummary(db, options()).introducedToday).toBe(0);
    gradeCard(db, options(), { cardId: id, rating: "good" });
    expect(dueSummary(db, options()).introducedToday).toBe(1);

    undoLastReview(db, options(), id);
    expect(dueSummary(db, options()).introducedToday).toBe(0);
  });

  it("restores the previous rating when there is an earlier review to fall back on", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    gradeCard(db, options(), { cardId: id, rating: "again" });
    gradeCard(db, options(), { cardId: id, rating: "easy" });
    expect(repo.getCard(db, id)?.last_rating).toBe(4);

    undoLastReview(db, options(), id);
    expect(repo.getCard(db, id)?.last_rating).toBe(1);
    expect(repo.listReviews(db, id)).toHaveLength(1);
  });

  it("can undo repeatedly back to the start", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    gradeCard(db, options(), { cardId: id, rating: "good" });
    gradeCard(db, options(), { cardId: id, rating: "good" });

    expect(undoLastReview(db, options(), id).success).toBe(true);
    expect(undoLastReview(db, options(), id).success).toBe(true);
    expect(repo.getCard(db, id)?.reps).toBe(0);
    expect(repo.listReviews(db, id)).toHaveLength(0);
  });

  it("fails when there is nothing to undo", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    const result = undoLastReview(db, options(), id);
    expect(result.success).toBe(false);
    expect(result.error).toContain("no reviews");
  });

  it("fails cleanly for a card that does not exist", () => {
    expect(undoLastReview(db, options(), 42).success).toBe(false);
  });
});

describe("previewForCard", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("previews the four grades without modifying the card", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    const previews = previewForCard(db, options(), id);
    expect(previews).toHaveLength(4);
    expect(repo.getCard(db, id)?.reps).toBe(0);
  });

  it("returns null for a card that does not exist", () => {
    expect(previewForCard(db, options(), 999)).toBeNull();
  });
});

describe("statsFor", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("counts today's reviews from the start of the local day", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    gradeCard(db, options(), { cardId: id, rating: "good" });

    const stats = statsFor(db, options());
    expect(stats.totalCards).toBe(1);
    expect(stats.reviewedToday).toBe(1);
    expect(stats.retentionToday).toBe(1);
  });
});

describe("dueLabel", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("describes a new card, a due card and an overdue card", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    const fresh = repo.getDueCard(db, id, NOW);
    expect(fresh && dueLabel(fresh, NOW)).toBe("due now");

    const late = repo.getDueCard(db, id, new Date("2026-09-13T12:00:00.000Z"));
    expect(late && dueLabel(late, NOW)).toBe("3 d overdue");
  });

  it("describes a card scheduled into the future", () => {
    const id = insertCard(db, {
      question: "later",
      answer: "A",
      state: "review",
      dueAt: "2026-09-16T12:00:00.000Z",
      reps: 1,
    });
    const card = repo.getDueCard(db, id, NOW);
    expect(card && dueLabel(card, NOW)).toBe("in 6 d");
  });
});
