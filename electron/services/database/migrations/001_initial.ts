import type { Migration } from "./index";

/**
 * 001 — initial schema.
 *
 * Covers every table from the implementation plan (§7) up front, including the
 * ones whose features land in later phases (FSRS cards, sessions, notifications,
 * LLM usage). Creating them now means later phases add behaviour, not migrations,
 * and the coverage/analytics queries have somewhere to read from.
 *
 * Design notes:
 *  - `syllabus_topics` supersedes v1's `topics`: keeping topics inside a syllabus
 *    gives every downstream system a stable `code` to reference.
 *  - Removed topics are archived (`archived_at`), never hard-deleted, so review
 *    history survives a syllabus re-import.
 *  - `syllabus_imports.prior_snapshot_json` stores the pre-import topic set, which
 *    is what makes an exact rollback possible.
 *  - Timestamps are ISO-ish TEXT via `datetime('now')` (UTC), which sorts correctly.
 */

const SQL = `
-- ── users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL DEFAULT '',
  timezone           TEXT    NOT NULL DEFAULT 'America/Jamaica',
  study_goal         TEXT    NOT NULL DEFAULT '',
  daily_study_target INTEGER NOT NULL DEFAULT 90,
  exam_date          TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── syllabus ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS syllabus (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT    NOT NULL,
  board       TEXT    NOT NULL,
  level       TEXT    NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  exam_date   TEXT,
  source_file TEXT,
  is_active   INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subject, board, level)
);

CREATE INDEX IF NOT EXISTS idx_syllabus_active ON syllabus (is_active);
CREATE INDEX IF NOT EXISTS idx_syllabus_subject ON syllabus (subject);

-- ── syllabus_topics ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS syllabus_topics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  syllabus_id INTEGER NOT NULL REFERENCES syllabus (id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES syllabus_topics (id) ON DELETE SET NULL,
  code        TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  section     TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  est_hours   REAL,
  status      TEXT    NOT NULL DEFAULT 'not_started',
  valence     TEXT,
  archived_at TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (syllabus_id, code)
);

CREATE INDEX IF NOT EXISTS idx_topics_syllabus ON syllabus_topics (syllabus_id);
CREATE INDEX IF NOT EXISTS idx_topics_section  ON syllabus_topics (syllabus_id, section);
CREATE INDEX IF NOT EXISTS idx_topics_status   ON syllabus_topics (status);
CREATE INDEX IF NOT EXISTS idx_topics_archived ON syllabus_topics (archived_at);

-- ── syllabus_imports ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS syllabus_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  syllabus_id         INTEGER NOT NULL REFERENCES syllabus (id) ON DELETE CASCADE,
  format              TEXT    NOT NULL,
  source_file         TEXT,
  raw_payload         TEXT    NOT NULL,
  prior_snapshot_json TEXT,
  diff_json           TEXT,
  topic_count         INTEGER NOT NULL DEFAULT 0,
  status              TEXT    NOT NULL DEFAULT 'applied',
  rolled_back_at      TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_imports_syllabus ON syllabus_imports (syllabus_id, created_at DESC);

-- ── flashcards ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flashcards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id     INTEGER REFERENCES syllabus_topics (id) ON DELETE SET NULL,
  question     TEXT    NOT NULL,
  answer       TEXT    NOT NULL,
  source       TEXT    NOT NULL DEFAULT 'manual',
  valence      TEXT,
  difficulty   REAL,
  stability    REAL,
  last_review  TEXT,
  next_review  TEXT,
  review_count INTEGER NOT NULL DEFAULT 0,
  lapses       INTEGER NOT NULL DEFAULT 0,
  state        TEXT    NOT NULL DEFAULT 'new',
  archived_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cards_topic ON flashcards (topic_id);
CREATE INDEX IF NOT EXISTS idx_cards_due   ON flashcards (next_review);

-- ── overlay_connections ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS overlay_connections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  theme       TEXT NOT NULL,
  subject_a   TEXT NOT NULL,
  concept_a   TEXT NOT NULL,
  subject_b   TEXT NOT NULL,
  concept_b   TEXT NOT NULL,
  subject_c   TEXT,
  concept_c   TEXT,
  description TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'derived',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_overlay_theme ON overlay_connections (theme);

-- ── study_sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS study_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date   TEXT    NOT NULL,
  duration       INTEGER NOT NULL DEFAULT 0,
  session_type   TEXT    NOT NULL DEFAULT 'interleaved',
  themes         TEXT    NOT NULL DEFAULT '',
  topic_codes    TEXT    NOT NULL DEFAULT '',
  score          REAL,
  notes          TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_date ON study_sessions (session_date);

-- ── quiz_results ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_results (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  flashcard_id     INTEGER REFERENCES flashcards (id) ON DELETE CASCADE,
  session_id       INTEGER REFERENCES study_sessions (id) ON DELETE SET NULL,
  correct          INTEGER NOT NULL DEFAULT 0,
  confidence       INTEGER,
  response_time_ms INTEGER,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quiz_card    ON quiz_results (flashcard_id);
CREATE INDEX IF NOT EXISTS idx_quiz_session ON quiz_results (session_id);

-- ── valence_tags ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS valence_tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT    NOT NULL,
  target_id   INTEGER NOT NULL,
  tag         TEXT    NOT NULL,
  intensity   INTEGER NOT NULL DEFAULT 3,
  note        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_valence_target ON valence_tags (target_type, target_id);

-- ── study_plans ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS study_plans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,
  plan_json  TEXT    NOT NULL,
  completed  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plans_date ON study_plans (date);

-- ── notifications ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  type              TEXT    NOT NULL,
  channel           TEXT    NOT NULL,
  scheduled_at      TEXT,
  sent_at           TEXT,
  status            TEXT    NOT NULL DEFAULT 'pending',
  message           TEXT    NOT NULL DEFAULT '',
  context_json      TEXT,
  gmail_message_id  TEXT,
  calendar_event_id TEXT,
  error             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_sched ON notifications (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status);

-- ── notification_rules ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT    NOT NULL,
  channel        TEXT    NOT NULL,
  offset_minutes INTEGER,
  enabled        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (type, channel, offset_minutes)
);

-- ── llm_usage ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider          TEXT    NOT NULL,
  model             TEXT    NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  status_code       INTEGER NOT NULL DEFAULT 200,
  cost              REAL,
  source            TEXT    NOT NULL DEFAULT 'app',
  step              TEXT,
  tool              TEXT,
  instance_id       TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_created ON llm_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_model   ON llm_usage (model);

-- ── generation_jobs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS generation_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline    TEXT    NOT NULL,
  input_json  TEXT    NOT NULL DEFAULT '{}',
  output_json TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending',
  gate_state  TEXT    NOT NULL DEFAULT 'pending',
  error       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_genjobs_status ON generation_jobs (status, created_at DESC);
`;

export const migration001Initial: Migration = {
  version: 1,
  name: "initial_schema",
  sql: SQL,
};
