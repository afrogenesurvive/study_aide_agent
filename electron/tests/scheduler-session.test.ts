import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../services/database/db";
import * as repo from "../services/fsrs/repo";
import {
  advanceTopicStatuses,
  completeSession,
  computeStreak,
  countSessionReviews,
  deriveTopicStatus,
  getSession,
  listSessions,
  MIN_SESSION_MINUTES,
  recomputeTopicStatus,
  sessionContextFromConfig,
  startSession,
  todaySummary,
  topicCardStats,
  type SessionContext,
} from "../services/scheduler/session";
import { resolveOptions } from "../services/fsrs/service";
import type { TopicStatus } from "../src/shared/syllabus-types";
import { createTestDb } from "./helpers/test-db";
import { insertCard, NOW, seedSyllabus } from "./helpers/review-fixtures";

const CONTEXT: SessionContext = { date: "2026-09-10", timeZone: "UTC" };

const CONFIG = { TIMEZONE: "UTC", NEW_CARDS_PER_DAY: "20" };

describe("sessionContextFromConfig", () => {
  it("derives the local day from the configured timezone", () => {
    // 02:30 UTC is still the previous day in Jamaica.
    const lateUtc = new Date("2026-09-10T02:30:00.000Z");
    expect(sessionContextFromConfig({ TIMEZONE: "UTC" }, lateUtc).date).toBe("2026-09-10");
    expect(sessionContextFromConfig({ TIMEZONE: "America/Jamaica" }, lateUtc).date).toBe(
      "2026-09-09",
    );
  });

  it("falls back to UTC with no timezone configured", () => {
    expect(sessionContextFromConfig({}, NOW).timeZone).toBe("UTC");
  });
});

describe("deriveTopicStatus", () => {
  it("promotes a covered topic to introduced", () => {
    expect(deriveTopicStatus("not_started", { covered: true })).toBe("introduced");
  });

  it("promotes a topic with a graded card to introduced", () => {
    expect(deriveTopicStatus("not_started", { reviewedCards: 1 })).toBe("introduced");
  });

  it("promotes a topic with a card reviewed twice to learning", () => {
    expect(deriveTopicStatus("introduced", { matureCards: 1 })).toBe("learning");
    expect(deriveTopicStatus("not_started", { matureCards: 2 })).toBe("learning");
  });

  it("never moves a topic backwards", () => {
    expect(deriveTopicStatus("learning", { covered: true })).toBeNull();
    expect(deriveTopicStatus("mastered", { matureCards: 5 })).toBeNull();
  });

  it("never claims mastery on the user's behalf", () => {
    expect(deriveTopicStatus("learning", { matureCards: 50 })).toBeNull();
  });

  it("does nothing without evidence", () => {
    expect(deriveTopicStatus("not_started", {})).toBeNull();
    expect(deriveTopicStatus("not_started", { totalCards: 3 })).toBeNull();
  });
});

describe("advanceTopicStatuses", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("moves every matching topic forward one rung", () => {
    const { topicIds } = seedSyllabus(db, "chemistry", ["7", "8"]);
    expect(advanceTopicStatuses(db, ["7", "8"])).toBe(2);
    for (const id of topicIds) {
      const row = db.prepare("SELECT status FROM syllabus_topics WHERE id = ?").get(id) as {
        status: TopicStatus;
      };
      expect(row.status).toBe("introduced");
    }
  });

  it("does not move a topic that is already further along", () => {
    const { syllabusId } = seedSyllabus(db, "chemistry", ["7"]);
    db.prepare("UPDATE syllabus_topics SET status = 'learning' WHERE syllabus_id = ?").run(syllabusId);
    expect(advanceTopicStatuses(db, ["7"])).toBe(0);
  });

  it("ignores archived topics and unknown codes", () => {
    const { topicIds } = seedSyllabus(db, "chemistry", ["7"]);
    db.prepare("UPDATE syllabus_topics SET archived_at = '2026-09-10' WHERE id = ?").run(topicIds[0]);
    expect(advanceTopicStatuses(db, ["7", "nope"])).toBe(0);
  });

  it("handles an empty code list", () => {
    expect(advanceTopicStatuses(db, [])).toBe(0);
  });
});

describe("recomputeTopicStatus", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("promotes from real review evidence", () => {
    const { topicIds } = seedSyllabus(db, "chemistry", ["7"]);
    const cardId = insertCard(db, {
      question: "q",
      answer: "A",
      topicId: topicIds[0],
      state: "learning",
      reps: 1,
    });
    // Reviewed once: the topic has been introduced.
    expect(recomputeTopicStatus(db, topicIds[0])).toBe("introduced");

    // Reviewed twice: it has survived a second pass, so it is being learned.
    db.prepare("UPDATE flashcards SET reps = 2 WHERE id = ?").run(cardId);
    expect(recomputeTopicStatus(db, topicIds[0])).toBe("learning");
  });

  it("ignores archived cards", () => {
    const { topicIds } = seedSyllabus(db, "chemistry", ["7"]);
    insertCard(db, {
      question: "q",
      answer: "A",
      topicId: topicIds[0],
      state: "review",
      reps: 5,
      archivedAt: NOW.toISOString(),
    });
    expect(recomputeTopicStatus(db, topicIds[0])).toBeNull();
  });

  it("returns null for a topic that does not exist", () => {
    expect(recomputeTopicStatus(db, 999)).toBeNull();
  });

  it("counts only cards belonging to the topic", () => {
    const { topicIds } = seedSyllabus(db, "chemistry", ["7", "8"]);
    insertCard(db, { question: "q", answer: "A", topicId: topicIds[0], state: "review", reps: 4 });
    expect(topicCardStats(db, topicIds[1])).toEqual({
      covered: false,
      totalCards: 0,
      reviewedCards: 0,
      matureCards: 0,
    });
  });
});

describe("session lifecycle", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("starts a session with no duration yet", () => {
    const started = startSession(db, CONTEXT, "EQUILIBRIUM");
    expect(started.success).toBe(true);
    const session = getSession(db, started.sessionId as number);
    expect(session?.duration).toBe(0);
    expect(session?.themes).toBe("EQUILIBRIUM");
    expect(session?.session_date).toBe("2026-09-10");
  });

  it("records duration, topics and notes on completion", () => {
    const { topicIds } = seedSyllabus(db, "chemistry", ["7"]);
    const { sessionId } = startSession(db, CONTEXT);
    const summary = completeSession(
      db,
      {
        sessionId: sessionId as number,
        durationMinutes: 42,
        topicCodes: ["7"],
        themes: ["EQUILIBRIUM"],
        notes: "went well",
      },
      CONTEXT,
    );

    const session = getSession(db, summary.sessionId);
    expect(session?.duration).toBe(42);
    expect(session?.topic_codes).toBe("7");
    expect(session?.themes).toBe("EQUILIBRIUM");
    expect(session?.notes).toBe("went well");

    const topic = db.prepare("SELECT status FROM syllabus_topics WHERE id = ?").get(
      topicIds[0],
    ) as { status: TopicStatus };
    expect(topic.status).toBe("introduced");
    expect(summary.topicsAdvanced).toBe(1);
  });

  it("counts the cards reviewed against the session", () => {
    const cardId = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    const { sessionId } = startSession(db, CONTEXT);
    repo.logReview(db, {
      flashcardId: cardId,
      sessionId: sessionId as number,
      rating: "good",
      stateBefore: "new",
      stateAfter: "learning",
      elapsedDays: 0,
      scheduledDays: 0,
      stability: 2,
      difficulty: 4,
      retrievability: null,
      reviewedAt: NOW.toISOString(),
      logJson: "{}",
    });

    const summary = completeSession(
      db,
      { sessionId: sessionId as number, durationMinutes: 30 },
      CONTEXT,
    );
    expect(summary.cardsReviewed).toBe(1);
    expect(countSessionReviews(db, summary.sessionId)).toBe(1);
  });

  it("de-duplicates topic codes and themes", () => {
    seedSyllabus(db, "chemistry", ["7"]);
    const { sessionId } = startSession(db, CONTEXT);
    completeSession(
      db,
      {
        sessionId: sessionId as number,
        durationMinutes: 20,
        topicCodes: ["7", "7", ""],
        themes: ["EQUILIBRIUM", "EQUILIBRIUM"],
      },
      CONTEXT,
    );
    expect(getSession(db, sessionId as number)?.topic_codes).toBe("7");
    expect(getSession(db, sessionId as number)?.themes).toBe("EQUILIBRIUM");
  });

  it("never records a negative duration", () => {
    const { sessionId } = startSession(db, CONTEXT);
    completeSession(db, { sessionId: sessionId as number, durationMinutes: -5 }, CONTEXT);
    expect(getSession(db, sessionId as number)?.duration).toBe(0);
  });

  it("reports the streak after the session", () => {
    const { sessionId } = startSession(db, CONTEXT);
    const summary = completeSession(
      db,
      { sessionId: sessionId as number, durationMinutes: 45 },
      CONTEXT,
    );
    expect(summary.streak).toBe(1);
  });

  it("lists sessions newest first", () => {
    startSession(db, { ...CONTEXT, date: "2026-09-08" });
    startSession(db, { ...CONTEXT, date: "2026-09-10" });
    expect(listSessions(db).map((session) => session.session_date)).toEqual([
      "2026-09-10",
      "2026-09-08",
    ]);
  });
});

describe("computeStreak", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  function sessionOn(date: string, duration = 30): void {
    db.prepare("INSERT INTO study_sessions (session_date, duration) VALUES (?, ?)").run(
      date,
      duration,
    );
  }

  it("is empty with no sessions", () => {
    expect(computeStreak(db, { today: "2026-09-10" })).toEqual({
      current: 0,
      longest: 0,
      lastSessionDate: null,
      activeToday: false,
    });
  });

  it("counts consecutive days ending today", () => {
    sessionOn("2026-09-08");
    sessionOn("2026-09-09");
    sessionOn("2026-09-10");
    const streak = computeStreak(db, { today: "2026-09-10" });
    expect(streak.current).toBe(3);
    expect(streak.activeToday).toBe(true);
    expect(streak.lastSessionDate).toBe("2026-09-10");
  });

  it("does not break the streak just because today is not done yet", () => {
    sessionOn("2026-09-08");
    sessionOn("2026-09-09");
    const streak = computeStreak(db, { today: "2026-09-10" });
    expect(streak.current).toBe(2);
    expect(streak.activeToday).toBe(false);
  });

  it("breaks the streak on a missed day", () => {
    sessionOn("2026-09-05");
    sessionOn("2026-09-06");
    sessionOn("2026-09-09");
    const streak = computeStreak(db, { today: "2026-09-10" });
    // Yesterday (the 9th) counts, but the gap on the 7th and 8th stops there.
    expect(streak.current).toBe(1);
  });

  it("remembers the longest run even after it ends", () => {
    sessionOn("2026-08-01");
    sessionOn("2026-08-02");
    sessionOn("2026-08-03");
    sessionOn("2026-09-10");
    expect(computeStreak(db, { today: "2026-09-10" }).longest).toBe(3);
  });

  it("counts several sessions on one day once", () => {
    sessionOn("2026-09-10", 20);
    sessionOn("2026-09-10", 40);
    expect(computeStreak(db, { today: "2026-09-10" }).current).toBe(1);
  });

  it("ignores sessions shorter than the minimum", () => {
    sessionOn("2026-09-09", MIN_SESSION_MINUTES - 1);
    sessionOn("2026-09-10", MIN_SESSION_MINUTES);
    expect(computeStreak(db, { today: "2026-09-10" }).current).toBe(1);
  });

  it("accepts a caller-supplied minimum", () => {
    sessionOn("2026-09-10", 5);
    expect(computeStreak(db, { today: "2026-09-10", minMinutes: 5 }).current).toBe(1);
    expect(computeStreak(db, { today: "2026-09-10", minMinutes: 10 }).current).toBe(0);
  });

  it("ignores session dates that are not calendar days", () => {
    db.prepare("INSERT INTO study_sessions (session_date, duration) VALUES ('nonsense', 30)").run();
    expect(computeStreak(db, { today: "2026-09-10" }).current).toBe(0);
  });
});

describe("todaySummary", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("reports an empty day", () => {
    const summary = todaySummary(db, resolveOptions(CONFIG, NOW));
    expect(summary.dateKey).toBe("2026-09-10");
    expect(summary.cardsReviewedToday).toBe(0);
    expect(summary.minutesToday).toBe(0);
    expect(summary.bySubject).toEqual([]);
    expect(summary.struggling).toEqual([]);
    expect(summary.streak.current).toBe(0);
  });

  it("summarises reviews, minutes and per-subject counts", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    const cardId = insertCard(db, {
      question: "Q",
      answer: "A",
      topicId: chemistry.topicIds[0],
    });

    const { sessionId } = startSession(db, CONTEXT);
    repo.logReview(db, {
      flashcardId: cardId,
      sessionId: sessionId as number,
      rating: "good",
      stateBefore: "new",
      stateAfter: "learning",
      elapsedDays: 0,
      scheduledDays: 0,
      stability: 2,
      difficulty: 4,
      retrievability: null,
      reviewedAt: NOW.toISOString(),
      logJson: "{}",
    });
    completeSession(db, { sessionId: sessionId as number, durationMinutes: 35 }, CONTEXT);

    const summary = todaySummary(db, resolveOptions(CONFIG, NOW));
    expect(summary.cardsReviewedToday).toBe(1);
    expect(summary.minutesToday).toBe(35);
    expect(summary.bySubject).toEqual([{ subject: "chemistry", reviewed: 1 }]);
    expect(summary.streak.current).toBe(1);
  });

  it("excludes reviews from earlier days", () => {
    const cardId = repo.createCard(db, { question: "Q", answer: "A" }, NOW);
    repo.logReview(db, {
      flashcardId: cardId,
      rating: "good",
      stateBefore: "new",
      stateAfter: "learning",
      elapsedDays: 0,
      scheduledDays: 0,
      stability: 2,
      difficulty: 4,
      retrievability: null,
      reviewedAt: "2026-09-09T12:00:00.000Z",
      logJson: "{}",
    });
    expect(todaySummary(db, resolveOptions(CONFIG, NOW)).cardsReviewedToday).toBe(0);
  });

  it("lists the topics flagged as struggling", () => {
    const { topicIds } = seedSyllabus(db, "chemistry", ["7", "8"]);
    db.prepare("UPDATE syllabus_topics SET valence = 'red' WHERE id = ?").run(topicIds[0]);

    const summary = todaySummary(db, resolveOptions(CONFIG, NOW));
    expect(summary.struggling).toHaveLength(1);
    expect(summary.struggling[0]).toMatchObject({
      topicId: topicIds[0],
      code: "7",
      subject: "chemistry",
    });
  });
});
