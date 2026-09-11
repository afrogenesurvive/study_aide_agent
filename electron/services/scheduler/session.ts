import type { Database } from "../database/db";
import type { Subject } from "../../src/shared/review-types";
import type {
  SessionCompleteInput,
  SessionStartResult,
  SessionSummary,
  StreakInfo,
  StudySessionRow,
  TodaySummary,
} from "../../src/shared/scheduler-types";
import type { TopicStatus } from "../../src/shared/syllabus-types";
import { withTransaction } from "../database/migrations";
import { dueSummary, type ReviewOptions } from "../fsrs/service";
import { addDays, dayKey, dayStart, isoOf } from "../time";

/**
 * Session lifecycle: starting one, running reviews against it, and closing it out.
 *
 * A session row is created *before* any reviews happen, because `card_reviews`
 * carries a `session_id` — attribution has to exist from the first card. An
 * abandoned session therefore leaves a zero-minute row behind, which is a
 * truthful record of an attempt that did not happen.
 */

/** A session shorter than this does not count towards a streak. */
export const MIN_SESSION_MINUTES = 10;

export interface SessionContext {
  /** Local day, `YYYY-MM-DD`. */
  date: string;
  timeZone: string;
  minSessionMinutes?: number;
}

export function sessionContextFromConfig(
  config: Record<string, string | undefined | null>,
  now: Date = new Date(),
): SessionContext {
  const timeZone = config.TIMEZONE?.trim() || "UTC";
  return { date: dayKey(now, timeZone), timeZone };
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export function startSession(
  db: Database,
  context: SessionContext,
  theme?: string | null,
  sessionType = "interleaved",
): SessionStartResult {
  const result = db
    .prepare(
      `INSERT INTO study_sessions (session_date, duration, session_type, themes, topic_codes)
       VALUES (?, 0, ?, ?, '')`,
    )
    .run(context.date, sessionType, theme ?? "");
  return { success: true, sessionId: Number(result.lastInsertRowid) };
}

export function getSession(db: Database, id: number): StudySessionRow | null {
  return (
    (db.prepare("SELECT * FROM study_sessions WHERE id = ?").get(id) as
      | StudySessionRow
      | undefined) ?? null
  );
}

export function listSessions(db: Database, limit = 50): StudySessionRow[] {
  return db
    .prepare(
      "SELECT * FROM study_sessions ORDER BY session_date DESC, id DESC LIMIT ?",
    )
    .all(limit) as unknown as StudySessionRow[];
}

/**
 * Close a session: record how long it ran, which topics it touched, and move
 * those topics along the progress ladder.
 *
 * The duration and the topic advance are committed together so a crash cannot
 * leave a session recorded without its progress, or progress without a session to
 * explain it.
 */
export function completeSession(
  db: Database,
  input: SessionCompleteInput,
  context: SessionContext,
): SessionSummary {
  const topicCodes = [...new Set((input.topicCodes ?? []).filter(Boolean))];
  const themes = [...new Set((input.themes ?? []).filter(Boolean))];
  let topicsAdvanced = 0;

  withTransaction(db, () => {
    db.prepare(
      `UPDATE study_sessions
          SET duration = ?, themes = ?, topic_codes = ?, notes = ?, score = ?
        WHERE id = ?`,
    ).run(
      Math.max(0, Math.round(input.durationMinutes)),
      themes.join(","),
      topicCodes.join(","),
      input.notes ?? "",
      input.score ?? null,
      input.sessionId,
    );
    topicsAdvanced = advanceTopicStatuses(db, topicCodes);
  });

  return {
    sessionId: input.sessionId,
    durationMinutes: Math.max(0, Math.round(input.durationMinutes)),
    cardsReviewed: countSessionReviews(db, input.sessionId),
    topicsAdvanced,
    streak: computeStreak(db, {
      today: context.date,
      minMinutes: context.minSessionMinutes ?? MIN_SESSION_MINUTES,
    }).current,
  };
}

export function countSessionReviews(db: Database, sessionId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM card_reviews WHERE session_id = ?")
    .get(sessionId) as { n: number | bigint } | undefined;
  return Number(row?.n ?? 0);
}

// ── topic progress ───────────────────────────────────────────────────────────

export interface TopicCardStats {
  /** The topic was studied in a session, even if no card was graded. */
  covered?: boolean;
  totalCards?: number;
  reviewedCards?: number;
  matureCards?: number;
}

const LADDER: TopicStatus[] = ["not_started", "introduced", "learning", "mastered"];

/**
 * Where a topic belongs on the progress ladder, or null if it should stay put.
 *
 * Two deliberate limits:
 *  - `mastered` is never set automatically. It is the user's own judgement (and
 *    what the green valence tag means), so a heuristic quietly claiming mastery
 *    would fight the person using the app.
 *  - Progress never moves backwards. Cards lapse, but a topic you have worked
 *    through does not become "not started" again.
 */
export function deriveTopicStatus(
  current: TopicStatus,
  stats: TopicCardStats,
): TopicStatus | null {
  let target: TopicStatus | null = null;
  if ((stats.matureCards ?? 0) >= 1) target = "learning";
  else if ((stats.reviewedCards ?? 0) >= 1 || stats.covered) target = "introduced";

  if (!target) return null;
  return LADDER.indexOf(current) >= LADDER.indexOf(target) ? null : target;
}

/** Move every syllabus topic matching these codes forward one rung. */
export function advanceTopicStatuses(db: Database, codes: string[]): number {
  const unique = [...new Set(codes.filter(Boolean))];
  if (!unique.length) return 0;

  const placeholders = unique.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, status FROM syllabus_topics
        WHERE code IN (${placeholders}) AND archived_at IS NULL`,
    )
    .all(...unique) as unknown as Array<{ id: number; status: TopicStatus }>;

  let advanced = 0;
  const update = db.prepare(
    "UPDATE syllabus_topics SET status = ?, updated_at = datetime('now') WHERE id = ?",
  );
  for (const row of rows) {
    const next = deriveTopicStatus(row.status, { covered: true });
    if (!next) continue;
    update.run(next, row.id);
    advanced += 1;
  }
  return advanced;
}

/** Card counts for a topic, used to derive its status from real review evidence. */
export function topicCardStats(db: Database, topicId: number): Required<TopicCardStats> {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN reps >= 1 THEN 1 ELSE 0 END), 0) AS reviewed,
              COALESCE(SUM(CASE WHEN reps >= 2 THEN 1 ELSE 0 END), 0) AS mature
         FROM flashcards
        WHERE topic_id = ? AND archived_at IS NULL`,
    )
    .get(topicId) as { total: number; reviewed: number; mature: number } | undefined;

  return {
    covered: false,
    totalCards: Number(row?.total ?? 0),
    reviewedCards: Number(row?.reviewed ?? 0),
    matureCards: Number(row?.mature ?? 0),
  };
}

/**
 * Re-derive a topic's status from its cards. Returns the new status, or null when
 * nothing changed.
 */
export function recomputeTopicStatus(db: Database, topicId: number): TopicStatus | null {
  const row = db.prepare("SELECT status FROM syllabus_topics WHERE id = ?").get(topicId) as
    | { status: TopicStatus }
    | undefined;
  if (!row) return null;

  const next = deriveTopicStatus(row.status, topicCardStats(db, topicId));
  if (!next) return null;
  db.prepare("UPDATE syllabus_topics SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
    next,
    topicId,
  );
  return next;
}

// ── streaks ──────────────────────────────────────────────────────────────────

export interface StreakOptions {
  /** Local day, `YYYY-MM-DD`. */
  today: string;
  minMinutes?: number;
}

/**
 * Consecutive days with a recorded session.
 *
 * A session only counts once it reaches `minMinutes`, so opening the app and
 * immediately closing it does not preserve a streak. Today is allowed to be
 * missing without breaking the streak — the day is not over yet.
 */
export function computeStreak(db: Database, options: StreakOptions): StreakInfo {
  const minMinutes = options.minMinutes ?? MIN_SESSION_MINUTES;
  const rows = db
    .prepare(
      `SELECT DISTINCT session_date FROM study_sessions
        WHERE duration >= ?
        ORDER BY session_date DESC`,
    )
    .all(minMinutes) as unknown as Array<{ session_date: string }>;

  const dates = rows
    .map((row) => row.session_date)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));

  if (!dates.length) {
    return { current: 0, longest: 0, lastSessionDate: null, activeToday: false };
  }

  const days = new Set(dates);
  const activeToday = days.has(options.today);

  let current = 0;
  let cursor = activeToday ? options.today : addDays(options.today, -1);
  while (days.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  for (const date of dates) {
    if (days.has(addDays(date, -1))) continue; // not the start of a run
    let run = 0;
    let walk = date;
    while (days.has(walk)) {
      run += 1;
      walk = addDays(walk, 1);
    }
    longest = Math.max(longest, run);
  }

  return { current, longest, lastSessionDate: dates[0], activeToday };
}

// ── dashboard summary ────────────────────────────────────────────────────────

export function todaySummary(db: Database, options: ReviewOptions): TodaySummary {
  const { now, timeZone } = options;
  const today = dayKey(now, timeZone);
  const since = isoOf(dayStart(now, timeZone));

  const reviewed = db
    .prepare("SELECT COUNT(*) AS n FROM card_reviews WHERE reviewed_at >= ?")
    .get(since) as { n: number | bigint } | undefined;

  const minutes = db
    .prepare("SELECT COALESCE(SUM(duration), 0) AS n FROM study_sessions WHERE session_date = ?")
    .get(today) as { n: number | bigint } | undefined;

  const bySubject = db
    .prepare(
      `SELECT s.subject AS subject, COUNT(*) AS reviewed
         FROM card_reviews r
         JOIN flashcards c      ON c.id = r.flashcard_id
         JOIN syllabus_topics t ON t.id = c.topic_id
         JOIN syllabus s        ON s.id = t.syllabus_id
        WHERE r.reviewed_at >= ?
        GROUP BY s.subject
        ORDER BY reviewed DESC`,
    )
    .all(since) as unknown as Array<{ subject: Subject; reviewed: number | bigint }>;

  const struggling = db
    .prepare(
      `SELECT t.id AS topicId, t.code AS code, t.title AS title, s.subject AS subject
         FROM syllabus_topics t
         JOIN syllabus s ON s.id = t.syllabus_id
        WHERE t.valence = 'red' AND t.archived_at IS NULL
        ORDER BY t.updated_at DESC
        LIMIT 5`,
    )
    .all() as unknown as Array<{
    topicId: number;
    code: string;
    title: string;
    subject: Subject | null;
  }>;

  return {
    dateKey: today,
    due: dueSummary(db, options),
    streak: computeStreak(db, { today }),
    cardsReviewedToday: Number(reviewed?.n ?? 0),
    minutesToday: Number(minutes?.n ?? 0),
    bySubject: bySubject.map((row) => ({
      subject: row.subject,
      reviewed: Number(row.reviewed),
    })),
    struggling,
  };
}
