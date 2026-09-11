import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../services/database/db";
import * as repo from "../services/fsrs/repo";
import type { ReviewLogEntry } from "../src/shared/review-types";
import { createTestDb } from "./helpers/test-db";
import { insertCard, NOW, NOW_ISO, seedSyllabus } from "./helpers/review-fixtures";

function reviewEntry(overrides: Partial<ReviewLogEntry> = {}): ReviewLogEntry {
  return {
    flashcardId: 1,
    rating: "good",
    stateBefore: "new",
    stateAfter: "learning",
    elapsedDays: 0,
    scheduledDays: 0,
    stability: 2.3,
    difficulty: 4.1,
    retrievability: null,
    reviewedAt: NOW_ISO,
    logJson: "{}",
    ...overrides,
  };
}

describe("flashcard persistence", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("creates a card that is immediately due and marked new", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    const card = repo.getCard(db, id);
    expect(card?.state).toBe("new");
    expect(card?.next_review).toBe(NOW_ISO);
    expect(card?.reps).toBe(0);
    expect(card?.source).toBe("manual");
  });

  it("returns null for a card that does not exist", () => {
    expect(repo.getCard(db, 999)).toBeNull();
  });

  it("edits the authoring fields and stamps updated_at", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    expect(repo.updateCard(db, id, { question: "Q2", valence: "red" })).toBe(true);
    const card = repo.getCard(db, id);
    expect(card?.question).toBe("Q2");
    expect(card?.answer).toBe("A");
    expect(card?.valence).toBe("red");
  });

  it("reports no change when there is nothing to update", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    expect(repo.updateCard(db, id, {})).toBe(false);
  });

  it("joins the topic and subject onto a card", () => {
    const { syllabusId, topicIds } = seedSyllabus(db, "chemistry", ["7"]);
    const id = repo.createCard(db, { question: "Q", answer: "A", topicId: topicIds[0] }, NOW);
    const card = repo.getDueCard(db, id, NOW);
    expect(card?.topic_code).toBe("7");
    expect(card?.topic_title).toBe("Topic 7");
    expect(card?.syllabus_id).toBe(syllabusId);
    expect(card?.subject).toBe("chemistry");
  });

  it("leaves the subject null for a card with no topic", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    expect(repo.getDueCard(db, id, NOW)?.subject).toBeNull();
  });

  it("writes back every FSRS column", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    repo.applySchedule(db, id, {
      difficulty: 5.1,
      stability: 12.5,
      last_review: NOW_ISO,
      next_review: "2026-09-16T12:00:00.000Z",
      review_count: 3,
      lapses: 1,
      state: "review",
      elapsed_days: 6,
      scheduled_days: 6,
      learning_steps: 2,
      reps: 3,
      last_rating: 4,
      updated_at: NOW_ISO,
    });

    const card = repo.getCard(db, id);
    expect(card).toMatchObject({
      difficulty: 5.1,
      stability: 12.5,
      next_review: "2026-09-16T12:00:00.000Z",
      review_count: 3,
      lapses: 1,
      state: "review",
      elapsed_days: 6,
      scheduled_days: 6,
      learning_steps: 2,
      reps: 3,
      last_rating: 4,
    });
  });

  it("archives and restores a card", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    expect(repo.archiveCard(db, id)).toBe(true);
    expect(repo.getCard(db, id)?.archived_at).not.toBeNull();
    expect(repo.listQueue(db, { now: NOW, newLimit: null })).toHaveLength(0);
    repo.archiveCard(db, id, false);
    expect(repo.listQueue(db, { now: NOW, newLimit: null })).toHaveLength(1);
  });

  it("deletes review rows along with the card", () => {
    const id = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    repo.logReview(db, reviewEntry({ flashcardId: id }));
    repo.deleteCard(db, id);
    const count = db.prepare("SELECT COUNT(*) AS n FROM card_reviews").get() as { n: number };
    expect(Number(count.n)).toBe(0);
  });
});

describe("the due queue", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("excludes cards that are not due yet", () => {
    insertCard(db, { question: "future", answer: "A", dueAt: "2026-09-20T12:00:00.000Z" });
    expect(repo.listQueue(db, { now: NOW, newLimit: null })).toHaveLength(0);
  });

  it("includes a card due exactly now", () => {
    insertCard(db, { question: "now", answer: "A", dueAt: NOW_ISO });
    expect(repo.listQueue(db, { now: NOW, newLimit: null })).toHaveLength(1);
  });

  it("puts review cards ahead of new ones", () => {
    insertCard(db, { question: "new", answer: "A" });
    insertCard(db, {
      question: "review",
      answer: "A",
      state: "review",
      dueAt: "2026-09-01T12:00:00.000Z",
      lastReview: "2026-08-01T12:00:00.000Z",
      reps: 2,
    });

    const queue = repo.listQueue(db, { now: NOW, newLimit: null });
    expect(queue.map((card) => card.question)).toEqual(["review", "new"]);
  });

  it("caps how many new cards are admitted", () => {
    for (let i = 0; i < 5; i += 1) insertCard(db, { question: `new-${i}`, answer: "A" });
    expect(repo.listQueue(db, { now: NOW, newLimit: 2 })).toHaveLength(2);
  });

  it("never caps review cards, only new ones", () => {
    insertCard(db, { question: "new", answer: "A" });
    for (let i = 0; i < 3; i += 1) {
      insertCard(db, {
        question: `review-${i}`,
        answer: "A",
        state: "review",
        dueAt: "2026-09-01T12:00:00.000Z",
        reps: 1,
      });
    }
    expect(repo.listQueue(db, { now: NOW, newLimit: 0 })).toHaveLength(3);
  });

  it("filters by subject through the topic join", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    const biology = seedSyllabus(db, "biology", ["14"]);
    insertCard(db, { question: "chem", answer: "A", topicId: chemistry.topicIds[0] });
    insertCard(db, { question: "bio", answer: "A", topicId: biology.topicIds[0] });

    const queue = repo.listQueue(db, { now: NOW, filter: { subject: "biology" }, newLimit: null });
    expect(queue.map((card) => card.question)).toEqual(["bio"]);
  });

  it("filters by syllabus and by topic", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7", "8"]);
    insertCard(db, { question: "seven", answer: "A", topicId: chemistry.topicIds[0] });
    insertCard(db, { question: "eight", answer: "A", topicId: chemistry.topicIds[1] });

    expect(
      repo.listQueue(db, {
        now: NOW,
        filter: { syllabusId: chemistry.syllabusId },
        newLimit: null,
      }),
    ).toHaveLength(2);
    expect(
      repo.listQueue(db, {
        now: NOW,
        filter: { topicId: chemistry.topicIds[1] },
        newLimit: null,
      })[0].question,
    ).toBe("eight");
  });

  it("counts whole days overdue", () => {
    insertCard(db, {
      question: "late",
      answer: "A",
      state: "review",
      dueAt: "2026-09-07T12:00:00.000Z",
      reps: 1,
    });
    const [card] = repo.listQueue(db, { now: NOW, newLimit: null });
    expect(card.overdue_days).toBe(3);
  });

  it("reports zero overdue for a card due today", () => {
    insertCard(db, { question: "today", answer: "A" });
    expect(repo.listQueue(db, { now: NOW, newLimit: null })[0].overdue_days).toBe(0);
  });

  it("includes archived cards only when asked", () => {
    insertCard(db, { question: "gone", answer: "A", archivedAt: NOW_ISO });
    expect(repo.listQueue(db, { now: NOW, newLimit: null })).toHaveLength(0);
    expect(
      repo.listQueue(db, { now: NOW, filter: { includeArchived: true }, newLimit: null }),
    ).toHaveLength(1);
  });
});

describe("due counts", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    insertCard(db, { question: "new", answer: "A" });
    insertCard(db, { question: "learning", answer: "A", state: "learning", reps: 1 });
    insertCard(db, { question: "relearning", answer: "A", state: "relearning", reps: 4 });
    insertCard(db, { question: "review", answer: "A", state: "review", reps: 3 });
    insertCard(db, {
      question: "not-due",
      answer: "A",
      state: "review",
      dueAt: "2026-10-01T12:00:00.000Z",
      reps: 1,
    });
  });

  afterEach(() => close());

  it("separates new, learning and review cards", () => {
    expect(repo.countDue(db, { now: NOW, newLimit: null })).toEqual({
      new: 1,
      learning: 2,
      due: 1,
      total: 4,
    });
  });

  it("groups by subject and ignores cards with no topic", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    insertCard(db, { question: "chem", answer: "A", topicId: chemistry.topicIds[0] });

    const bySubject = repo.countDueBySubject(db, { now: NOW, newLimit: null });
    expect(bySubject).toHaveLength(1);
    expect(bySubject[0]).toMatchObject({ subject: "chemistry", new: 1, total: 1 });
  });

  it("counts only the first-time introductions recorded today", () => {
    repo.logReview(db, reviewEntry({ flashcardId: 1, stateBefore: "new" }));
    repo.logReview(db, reviewEntry({ flashcardId: 2, stateBefore: "learning" }));
    repo.logReview(
      db,
      reviewEntry({
        flashcardId: 3,
        stateBefore: "new",
        reviewedAt: "2026-09-09T12:00:00.000Z",
      }),
    );

    const since = new Date("2026-09-10T05:00:00.000Z");
    expect(repo.countIntroducedToday(db, since)).toBe(1);
  });

  it("stops counting a card once its introduction is undone", () => {
    const id = repo.logReview(db, reviewEntry({ flashcardId: 1, stateBefore: "new" }));
    const since = new Date("2026-09-10T05:00:00.000Z");
    expect(repo.countIntroducedToday(db, since)).toBe(1);
    repo.deleteReview(db, id);
    expect(repo.countIntroducedToday(db, since)).toBe(0);
  });
});

describe("the review log", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    repo.createCard(db, { question: "Q", answer: "A" }, NOW);
  });

  afterEach(() => close());

  it("appends and reads back a review", () => {
    const id = repo.logReview(db, reviewEntry({ logJson: '{"rating":3}' }));
    const latest = repo.latestReview(db, 1);
    expect(latest?.id).toBe(id);
    expect(latest?.rating).toBe(3);
    expect(latest?.log_json).toBe('{"rating":3}');
  });

  it("returns the most recent review first", () => {
    repo.logReview(db, reviewEntry({ reviewedAt: "2026-09-01T12:00:00.000Z" }));
    repo.logReview(db, reviewEntry({ reviewedAt: "2026-09-05T12:00:00.000Z" }));
    repo.logReview(db, reviewEntry({ reviewedAt: "2026-09-03T12:00:00.000Z" }));

    const history = repo.listReviews(db, 1);
    expect(history.map((row) => row.reviewed_at)).toEqual([
      "2026-09-05T12:00:00.000Z",
      "2026-09-03T12:00:00.000Z",
      "2026-09-01T12:00:00.000Z",
    ]);
  });

  it("reports no review for a card that has never been graded", () => {
    expect(repo.latestReview(db, 1)).toBeNull();
    expect(repo.listReviews(db, 1)).toEqual([]);
  });

  it("deletes a single review without touching the others", () => {
    const first = repo.logReview(db, reviewEntry({ reviewedAt: "2026-09-01T12:00:00.000Z" }));
    repo.logReview(db, reviewEntry({ reviewedAt: "2026-09-05T12:00:00.000Z" }));
    expect(repo.deleteReview(db, first)).toBe(true);
    expect(repo.listReviews(db, 1)).toHaveLength(1);
  });

  it("lists the reviews belonging to a session", () => {
    const session = db.prepare(
      "INSERT INTO study_sessions (session_date, duration) VALUES ('2026-09-10', 20)",
    );
    session.run();
    session.run();
    repo.logReview(db, reviewEntry({ sessionId: 1 }));
    repo.logReview(db, reviewEntry({ sessionId: 2 }));
    expect(repo.listSessionReviews(db, 1)).toHaveLength(1);
    expect(repo.listSessionReviews(db, 1)[0].session_id).toBe(1);
  });
});

describe("reviewStats", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("summarises the collection and today's activity", () => {
    insertCard(db, { question: "new", answer: "A" });
    insertCard(db, { question: "review", answer: "A", state: "review", reps: 2 });
    repo.logReview(db, reviewEntry({ flashcardId: 1, rating: "good" }));
    repo.logReview(db, reviewEntry({ flashcardId: 2, rating: "again" }));

    const stats = repo.reviewStats(db, {
      now: NOW,
      dayStart: new Date("2026-09-10T05:00:00.000Z"),
    });

    expect(stats.totalCards).toBe(2);
    expect(stats.byState.new).toBe(1);
    expect(stats.byState.review).toBe(1);
    expect(stats.reviewedToday).toBe(2);
    // One "good" out of two grades.
    expect(stats.retentionToday).toBeCloseTo(0.5, 5);
  });

  it("reports no retention figure on a day with no reviews", () => {
    insertCard(db, { question: "new", answer: "A" });
    const stats = repo.reviewStats(db, {
      now: NOW,
      dayStart: new Date("2026-09-10T05:00:00.000Z"),
    });
    expect(stats.reviewedToday).toBe(0);
    expect(stats.retentionToday).toBeNull();
  });

  it("excludes archived cards from the collection total", () => {
    insertCard(db, { question: "live", answer: "A" });
    insertCard(db, { question: "gone", answer: "A", archivedAt: NOW_ISO });
    const stats = repo.reviewStats(db, {
      now: NOW,
      dayStart: new Date("2026-09-10T05:00:00.000Z"),
    });
    expect(stats.totalCards).toBe(1);
  });
});
