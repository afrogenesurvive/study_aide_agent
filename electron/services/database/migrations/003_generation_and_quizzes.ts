import type { Migration } from "./index";

/**
 * 003 — generation jobs and quizzes.
 *
 * Phase 3 materialises two things that phase 1 only reserved space for:
 *
 *  - `generation_jobs` (created by 001, never written) gains `committed_at`.
 *    The table's existing `status` / `gate_state` columns stay unconstrained
 *    text — the allowed values live in `src/shared/generation-types.ts` so the
 *    service layer can narrow them without a CHECK constraint that SQLite would
 *    then refuse to alter.
 *  - `quizzes` + `quiz_questions` hold generated multiple-choice items. They are
 *    separate from `flashcards` because a distractor set has nowhere to live in
 *    `flashcards.question/answer`; `quiz_results` (001) gained a nullable
 *    `quiz_question_id` so an answer can point at either kind of item.
 *
 * Timestamp convention (same rule as 002): any date JavaScript round-trips is
 * written explicitly as ISO-8601 UTC with a trailing `Z` and therefore has **no
 * SQL default**. `generation_jobs.created_at` / `updated_at` are inherited from
 * 001 with a `datetime('now')` default; the repository always supplies values
 * explicitly so that default is never used.
 */

const SQL = `
-- ── generation_jobs ──────────────────────────────────────────────────────────
ALTER TABLE generation_jobs ADD COLUMN committed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_genjobs_committed ON generation_jobs (committed_at DESC);

-- ── quizzes ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quizzes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER REFERENCES generation_jobs (id) ON DELETE SET NULL,
  topic_id    INTEGER REFERENCES syllabus_topics (id) ON DELETE SET NULL,
  title       TEXT    NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'generated',
  archived_at TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quizzes_topic  ON quizzes (topic_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_job    ON quizzes (job_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_active ON quizzes (archived_at, created_at DESC);

-- ── quiz_questions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id      INTEGER NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
  topic_id     INTEGER REFERENCES syllabus_topics (id) ON DELETE SET NULL,
  order_index  INTEGER NOT NULL DEFAULT 0,
  question     TEXT    NOT NULL,
  choices_json TEXT    NOT NULL DEFAULT '[]',
  answer_index INTEGER NOT NULL DEFAULT 0,
  explanation  TEXT,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz  ON quiz_questions (quiz_id, order_index);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_topic ON quiz_questions (topic_id);

-- ── quiz_results: answer either kind of item ─────────────────────────────────
ALTER TABLE quiz_results ADD COLUMN quiz_question_id INTEGER
  REFERENCES quiz_questions (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_quiz_question ON quiz_results (quiz_question_id);
`;

export const migration003GenerationAndQuizzes: Migration = {
  version: 3,
  name: "generation_and_quizzes",
  sql: SQL,
};
