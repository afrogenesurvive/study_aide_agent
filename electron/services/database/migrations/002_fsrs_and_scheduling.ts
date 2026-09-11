import type { Migration } from "./index";

/**
 * 002 — FSRS state + overlay theme joins.
 *
 * Adds everything phase 2 needs on top of the phase 1 schema:
 *
 *  - `flashcards` gains the FSRS card fields the 001 table lacked
 *    (`elapsed_days`, `scheduled_days`, `reps`, `last_rating`). The existing
 *    `difficulty` / `stability` / `state` / `lapses` / `next_review` columns are
 *    reused as-is; only the missing ones are appended.
 *  - `card_reviews` is a new append-only review log. It is the source of truth
 *    for "how many new cards did I introduce today", for review history, and for
 *    undoing the last rating (ts-fsrs needs the previous `ReviewLog` to roll a
 *    card back).
 *  - `overlay_themes` + `overlay_theme_topics` hold the cross-subject themes that
 *    drive overlap-based interleaving. They are seeded from the committed
 *    `data/overlap-map.json`, keyed by syllabus topic *code* so the scheduler can
 *    join them to whatever syllabus happens to be imported. The 001
 *    `overlay_connections` table is superseded by these two and left untouched.
 *
 * Timestamp convention: dates FSRS round-trips (`last_review`, `next_review`,
 * `reviewed_at`) are written from JavaScript as ISO-8601 UTC with a trailing `Z`.
 * SQLite's own `datetime('now')` produces `YYYY-MM-DD HH:MM:SS`, which
 * `new Date()` does not parse as UTC — mixing the two silently shifts schedules
 * by the machine's UTC offset, so the new date columns deliberately have no
 * SQL default and must be supplied explicitly.
 */

const SQL = `
-- ── flashcards: FSRS state ─────────────────────────────────────────────────
ALTER TABLE flashcards ADD COLUMN elapsed_days   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flashcards ADD COLUMN scheduled_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flashcards ADD COLUMN learning_steps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flashcards ADD COLUMN reps           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flashcards ADD COLUMN last_rating    INTEGER;
ALTER TABLE flashcards ADD COLUMN updated_at     TEXT;

CREATE INDEX IF NOT EXISTS idx_cards_state ON flashcards (state);

-- ── card_reviews ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS card_reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  flashcard_id   INTEGER NOT NULL REFERENCES flashcards (id) ON DELETE CASCADE,
  session_id     INTEGER REFERENCES study_sessions (id) ON DELETE SET NULL,
  rating         INTEGER NOT NULL,
  state_before   TEXT,
  state_after    TEXT,
  elapsed_days   INTEGER NOT NULL DEFAULT 0,
  scheduled_days INTEGER NOT NULL DEFAULT 0,
  stability      REAL,
  difficulty     REAL,
  retrievability REAL,
  duration_ms    INTEGER,
  reviewed_at    TEXT NOT NULL,
  log_json       TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reviews_card    ON card_reviews (flashcard_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_at      ON card_reviews (reviewed_at);
CREATE INDEX IF NOT EXISTS idx_reviews_session ON card_reviews (session_id);

-- ── overlay_themes ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS overlay_themes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  theme            TEXT NOT NULL UNIQUE,
  common_principle TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT 'seeded',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_overlay_themes_source ON overlay_themes (source);

-- ── overlay_theme_topics ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS overlay_theme_topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  theme      TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  concept    TEXT    NOT NULL DEFAULT '',
  topic_code TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'seeded',
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (theme, subject, topic_code)
);

CREATE INDEX IF NOT EXISTS idx_ott_theme ON overlay_theme_topics (theme);
CREATE INDEX IF NOT EXISTS idx_ott_code  ON overlay_theme_topics (topic_code);
`;

export const migration002FsrsAndScheduling: Migration = {
  version: 2,
  name: "fsrs_and_scheduling",
  sql: SQL,
};
