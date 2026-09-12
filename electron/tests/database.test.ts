import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LATEST_VERSION,
  MIGRATIONS,
  migrate,
  withTransaction,
} from "../services/database/migrations";
import { databaseStatus, listTables, tableColumns, type Database } from "../services/database/db";
import { createTestDb } from "./helpers/test-db";

const EXPECTED_TABLES = [
  "card_reviews",
  "flashcards",
  "generation_jobs",
  "llm_usage",
  "notification_rules",
  "notifications",
  "overlay_connections",
  "overlay_theme_topics",
  "overlay_themes",
  "quiz_questions",
  "quiz_results",
  "quizzes",
  "schema_migrations",
  "study_plans",
  "study_sessions",
  "syllabus",
  "syllabus_imports",
  "syllabus_topics",
  "valence_tags",
  "users",
];

describe("migrations", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("creates every table from the plan", () => {
    const tables = listTables(db);
    for (const expected of EXPECTED_TABLES) expect(tables).toContain(expected);
  });

  it("records the applied version", () => {
    const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
      name: string;
    }>;
    expect(rows).toHaveLength(MIGRATIONS.length);
    expect(rows[0].version).toBe(1);
    expect(rows[0].name).toBe("initial_schema");
    expect(rows[1].version).toBe(2);
    expect(rows[1].name).toBe("fsrs_and_scheduling");
    expect(rows[2].version).toBe(3);
    expect(rows[2].name).toBe("generation_and_quizzes");
    expect(databaseStatus(db, ":memory:").schemaVersion).toBe(LATEST_VERSION);
  });

  it("is idempotent — running it twice applies nothing the second time", () => {
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.from).toBe(LATEST_VERSION);
    expect(second.to).toBe(LATEST_VERSION);
  });

  it("gives syllabus_topics the columns the services rely on", () => {
    const columns = tableColumns(db, "syllabus_topics");
    for (const column of [
      "id",
      "syllabus_id",
      "parent_id",
      "code",
      "title",
      "section",
      "order_index",
      "est_hours",
      "status",
      "valence",
      "archived_at",
    ]) {
      expect(columns).toContain(column);
    }
  });

  it("enforces one topic per (syllabus_id, code)", () => {
    db.prepare("INSERT INTO syllabus (subject, board, level) VALUES ('chemistry','cambridge','a-level')").run();
    const insert = db.prepare(
      "INSERT INTO syllabus_topics (syllabus_id, code, title) VALUES (1, '1.1', 'Atomic structure')",
    );
    insert.run();
    expect(() => insert.run()).toThrow();
  });

  it("gives flashcards the FSRS columns added by migration 002", () => {
    const columns = tableColumns(db, "flashcards");
    for (const column of [
      "difficulty",
      "stability",
      "last_review",
      "next_review",
      "elapsed_days",
      "scheduled_days",
      "learning_steps",
      "reps",
      "lapses",
      "last_rating",
      "updated_at",
    ]) {
      expect(columns).toContain(column);
    }
  });

  it("cascades review-log rows when a card is deleted", () => {
    db.prepare("INSERT INTO flashcards (question, answer) VALUES ('Q', 'A')").run();
    db.prepare(
      `INSERT INTO card_reviews (flashcard_id, rating, reviewed_at, log_json)
       VALUES (1, 1, '2026-09-10T12:00:00.000Z', '{}')`,
    ).run();
    db.prepare("DELETE FROM flashcards WHERE id = 1").run();
    const count = db.prepare("SELECT COUNT(*) AS count FROM card_reviews").get() as {
      count: number;
    };
    expect(Number(count.count)).toBe(0);
  });

  it("enforces one overlay connection per (theme, subject, topic_code)", () => {
    const insert = db.prepare(
      "INSERT INTO overlay_theme_topics (theme, subject, concept, topic_code) VALUES (?, ?, ?, ?)",
    );
    insert.run("EQUILIBRIUM", "chemistry", "Le Chatelier", "7");
    expect(() => insert.run("EQUILIBRIUM", "chemistry", "A different concept", "7")).toThrow();
  });

  it("cascades topic deletion when a syllabus is removed", () => {
    db.prepare("INSERT INTO syllabus (subject, board, level) VALUES ('biology','cambridge','a-level')").run();
    db.prepare("INSERT INTO syllabus_topics (syllabus_id, code, title) VALUES (1, '1', 'Cell structure')").run();
    db.prepare("DELETE FROM syllabus WHERE id = 1").run();
    const count = db.prepare("SELECT COUNT(*) AS count FROM syllabus_topics").get() as { count: number };
    expect(Number(count.count)).toBe(0);
  });
});

describe("withTransaction", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    db.prepare("INSERT INTO syllabus (subject, board, level) VALUES ('math','cambridge','a-level')").run();
  });

  afterEach(() => close());

  it("commits on success", () => {
    withTransaction(db, () => {
      db.prepare("INSERT INTO syllabus_topics (syllabus_id, code, title) VALUES (1, 'a', 'A')").run();
    });
    const count = db.prepare("SELECT COUNT(*) AS count FROM syllabus_topics").get() as { count: number };
    expect(Number(count.count)).toBe(1);
  });

  it("rolls back every write when the body throws", () => {
    expect(() =>
      withTransaction(db, () => {
        db.prepare("INSERT INTO syllabus_topics (syllabus_id, code, title) VALUES (1, 'a', 'A')").run();
        db.prepare("INSERT INTO syllabus_topics (syllabus_id, code, title) VALUES (1, 'b', 'B')").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");

    const count = db.prepare("SELECT COUNT(*) AS count FROM syllabus_topics").get() as { count: number };
    expect(Number(count.count)).toBe(0);
  });

  it("nests without leaking an inner rollback into the outer commit", () => {
    withTransaction(db, () => {
      db.prepare("INSERT INTO syllabus_topics (syllabus_id, code, title) VALUES (1, 'keep', 'K')").run();
      try {
        withTransaction(db, () => {
          db.prepare("INSERT INTO syllabus_topics (syllabus_id, code, title) VALUES (1, 'gone', 'G')").run();
          throw new Error("inner");
        });
      } catch {
        // The inner failure must not abort the outer transaction.
      }
    });

    const codes = (
      db.prepare("SELECT code FROM syllabus_topics ORDER BY code").all() as Array<{ code: string }>
    ).map((row) => row.code);
    expect(codes).toEqual(["keep"]);
  });
});
