import type { Database } from "../database/db";
import type {
  CardInput,
  CardPatch,
  CardReviewRow,
  CardSchedulePatch,
  CardState,
  DueCard,
  DueCounts,
  FlashcardRow,
  ReviewFilter,
  ReviewLogEntry,
  ReviewStats,
  SubjectDue,
  TopicCardCount,
  Valence,
} from "../../src/shared/review-types";
import { CARD_STATES, RATING_VALUES } from "../../src/shared/review-types";
import { isoOf } from "../time";

/**
 * Flashcard + review-log persistence.
 *
 * All SQL for the FSRS subsystem lives here so `card.ts` and `scheduler.ts` can
 * stay pure. Every function takes an explicit `now` rather than reading the
 * clock, which is what makes the due-queue queries deterministic under test.
 */

/** Cards joined to their syllabus topic, so scheduling can group by subject. */
const CARD_SELECT = `
  SELECT c.*,
         t.code        AS topic_code,
         t.title       AS topic_title,
         t.syllabus_id AS syllabus_id,
         s.subject     AS subject
    FROM flashcards c
    LEFT JOIN syllabus_topics t ON t.id = c.topic_id
    LEFT JOIN syllabus        s ON s.id = t.syllabus_id
`;

const MS_PER_DAY = 86_400_000;

interface WhereParts {
  sql: string[];
  params: Array<string | number | null>;
}

function newWhereParts(includeArchived: boolean): WhereParts {
  const parts: WhereParts = { sql: [], params: [] };
  if (!includeArchived) parts.sql.push("c.archived_at IS NULL");
  return parts;
}

function applyFilter(parts: WhereParts, filter?: ReviewFilter | null): void {
  if (!filter) return;
  if (filter.topicId) {
    parts.sql.push("c.topic_id = ?");
    parts.params.push(filter.topicId);
  }
  if (filter.subject) {
    parts.sql.push("s.subject = ?");
    parts.params.push(filter.subject);
  }
  if (filter.syllabusId) {
    parts.sql.push("t.syllabus_id = ?");
    parts.params.push(filter.syllabusId);
  }
}

function whereClause(parts: WhereParts): string {
  return parts.sql.length ? ` WHERE ${parts.sql.join(" AND ")}` : "";
}

/**
 * A card counts as "new" until it has been graded once. The `state` check is
 * primary; the null `next_review` check catches any row written before the FSRS
 * columns existed.
 */
function isNewRow(row: DueCard): boolean {
  return row.state === "new" || !row.next_review;
}

function decorate(row: DueCard, now: Date): DueCard {
  const due = row.next_review ? Date.parse(row.next_review) : NaN;
  const overdue = Number.isFinite(due)
    ? Math.max(0, Math.floor((now.getTime() - due) / MS_PER_DAY))
    : 0;
  return { ...row, overdue_days: overdue, retrievability: null, subject: row.subject ?? null };
}

// ── flashcards ───────────────────────────────────────────────────────────────

/**
 * Create a card that is immediately due.
 *
 * `next_review` is set to now rather than left null so "is this card due?" is a
 * single date comparison for every card, new or otherwise.
 */
export function createCard(db: Database, input: CardInput, now: Date = new Date()): number {
  const stamp = isoOf(now);
  const result = db
    .prepare(
      `INSERT INTO flashcards
         (topic_id, question, answer, source, valence, next_review, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    )
    .run(
      input.topicId ?? null,
      input.question,
      input.answer,
      input.source ?? "manual",
      input.valence ?? null,
      stamp,
      stamp,
      stamp,
    );
  return Number(result.lastInsertRowid);
}

export function getCard(db: Database, id: number): FlashcardRow | null {
  return (
    (db.prepare("SELECT * FROM flashcards WHERE id = ?").get(id) as FlashcardRow | undefined) ??
    null
  );
}

/** A card plus its topic/subject context, for the review view. */
export function getDueCard(db: Database, id: number, now: Date = new Date()): DueCard | null {
  const row = db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(id) as unknown as
    | DueCard
    | undefined;
  return row ? decorate(row, now) : null;
}

export function updateCard(db: Database, id: number, patch: CardPatch): boolean {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];

  if (patch.question !== undefined) {
    sets.push("question = ?");
    values.push(patch.question);
  }
  if (patch.answer !== undefined) {
    sets.push("answer = ?");
    values.push(patch.answer);
  }
  if (patch.topicId !== undefined) {
    sets.push("topic_id = ?");
    values.push(patch.topicId);
  }
  if (patch.valence !== undefined) {
    sets.push("valence = ?");
    values.push(patch.valence);
  }
  if (!sets.length) return false;

  sets.push("updated_at = ?");
  values.push(isoOf(new Date()), id);
  const result = db.prepare(`UPDATE flashcards SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return Number(result.changes) > 0;
}

/** Write back the columns FSRS owns after a grade. */
export function applySchedule(db: Database, id: number, patch: CardSchedulePatch): void {
  db.prepare(
    `UPDATE flashcards
        SET difficulty = ?, stability = ?, last_review = ?, next_review = ?,
            review_count = ?, lapses = ?, state = ?, elapsed_days = ?,
            scheduled_days = ?, learning_steps = ?, reps = ?, last_rating = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.difficulty,
    patch.stability,
    patch.last_review,
    patch.next_review,
    patch.review_count,
    patch.lapses,
    patch.state,
    patch.elapsed_days,
    patch.scheduled_days,
    patch.learning_steps,
    patch.reps,
    patch.last_rating,
    patch.updated_at,
    id,
  );
}

export function archiveCard(db: Database, id: number, archived = true): boolean {
  const result = db
    .prepare("UPDATE flashcards SET archived_at = ?, updated_at = ? WHERE id = ?")
    .run(archived ? isoOf(new Date()) : null, isoOf(new Date()), id);
  return Number(result.changes) > 0;
}

export function setCardValence(db: Database, id: number, valence: Valence | null): boolean {
  const result = db
    .prepare("UPDATE flashcards SET valence = ?, updated_at = ? WHERE id = ?")
    .run(valence, isoOf(new Date()), id);
  return Number(result.changes) > 0;
}

export function deleteCard(db: Database, id: number): boolean {
  const result = db.prepare("DELETE FROM flashcards WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

// ── queries ──────────────────────────────────────────────────────────────────

/** Every card matching the filter, regardless of due date. */
export function listCards(db: Database, filter?: ReviewFilter | null): DueCard[] {
  const parts = newWhereParts(filter?.includeArchived ?? false);
  applyFilter(parts, filter);
  const rows = db
    .prepare(`${CARD_SELECT}${whereClause(parts)} ORDER BY c.next_review ASC, c.id ASC`)
    .all(...parts.params) as unknown as DueCard[];
  const now = new Date();
  return rows.map((row) => decorate(row, now));
}

export interface QueueOptions {
  now: Date;
  filter?: ReviewFilter | null;
  /**
   * How many new cards to admit. `null` means "no cap" (used for counting);
   * a number enforces `NEW_CARDS_PER_DAY`.
   */
  newLimit?: number | null;
}

/**
 * Cards that are due right now.
 *
 * Review cards come first — they represent knowledge already in flight, and
 * letting a backlog of new cards bury them is the classic way to wreck a
 * retention schedule. New cards follow, capped by the remaining daily
 * allowance.
 */
export function listQueue(db: Database, options: QueueOptions): DueCard[] {
  const { now, filter, newLimit = null } = options;
  const parts = newWhereParts(filter?.includeArchived ?? false);
  applyFilter(parts, filter);
  parts.sql.push("(c.next_review IS NULL OR c.next_review <= ?)");
  parts.params.push(isoOf(now));

  const rows = db
    .prepare(`${CARD_SELECT}${whereClause(parts)} ORDER BY c.next_review ASC, c.id ASC`)
    .all(...parts.params) as unknown as DueCard[];

  const decorated = rows.map((row) => decorate(row, now));
  const review = decorated.filter((row) => !isNewRow(row));
  const fresh = decorated.filter(isNewRow);

  const admitted =
    newLimit === null || newLimit === undefined ? fresh : fresh.slice(0, Math.max(0, newLimit));

  return [...review, ...admitted];
}

export function countDue(db: Database, options: QueueOptions): DueCounts {
  const queue = listQueue(db, { ...options, newLimit: null });
  const counts = { new: 0, learning: 0, due: 0, total: 0 };

  for (const card of queue) {
    if (isNewRow(card)) counts.new += 1;
    else if (card.state === "learning" || card.state === "relearning") counts.learning += 1;
    else counts.due += 1;
  }
  counts.total = counts.new + counts.learning + counts.due;
  return counts;
}

/**
 * Due cards grouped by subject.
 *
 * Cards with no syllabus topic are counted in the totals but not here: the
 * interleaved scheduler is driven by subjects, and an untethered card cannot be
 * placed in a block.
 */
export function countDueBySubject(db: Database, options: QueueOptions): SubjectDue[] {
  const queue = listQueue(db, { ...options, newLimit: null });
  const bySubject = new Map<string, SubjectDue>();

  for (const card of queue) {
    if (!card.subject) continue;
    const bucket =
      bySubject.get(card.subject) ??
      { subject: card.subject, new: 0, learning: 0, due: 0, total: 0 };
    if (isNewRow(card)) bucket.new += 1;
    else if (card.state === "learning" || card.state === "relearning") bucket.learning += 1;
    else bucket.due += 1;
    bucket.total += 1;
    bySubject.set(card.subject, bucket);
  }

  return [...bySubject.values()].sort((a, b) => b.total - a.total);
}

/**
 * Distinct cards introduced for the first time at or after `since`.
 *
 * Derived from the review log rather than a counter column, so it stays correct
 * after an undo removes a review.
 */
export function countIntroducedToday(db: Database, since: Date): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT flashcard_id) AS n
         FROM card_reviews
        WHERE state_before = 'new' AND reviewed_at >= ?`,
    )
    .get(isoOf(since)) as { n: number | bigint } | undefined;
  return Number(row?.n ?? 0);
}

export interface ReviewStatsOptions {
  now: Date;
  /** Start of the local day, for the "today" figures. */
  dayStart: Date;
  filter?: ReviewFilter | null;
}

export function reviewStats(db: Database, options: ReviewStatsOptions): ReviewStats {
  const { now, dayStart, filter } = options;

  const totalRow = db
    .prepare("SELECT COUNT(*) AS n FROM flashcards WHERE archived_at IS NULL")
    .get() as { n: number | bigint } | undefined;

  const byState = Object.fromEntries(CARD_STATES.map((state) => [state, 0])) as Record<
    CardState,
    number
  >;
  const stateRows = db
    .prepare(
      `SELECT state, COUNT(*) AS n FROM flashcards
        WHERE archived_at IS NULL GROUP BY state`,
    )
    .all() as unknown as Array<{ state: string; n: number | bigint }>;
  for (const row of stateRows) {
    if (row.state in byState) byState[row.state as CardState] = Number(row.n);
  }

  const todayRow = db
    .prepare(
      `SELECT COUNT(*) AS reviewed,
              AVG(CASE WHEN rating > 1 THEN 1.0 ELSE 0.0 END) AS retention
         FROM card_reviews
        WHERE reviewed_at >= ?`,
    )
    .get(isoOf(dayStart)) as { reviewed: number | bigint; retention: number | null } | undefined;

  return {
    totalCards: Number(totalRow?.n ?? 0),
    byState,
    dueNow: countDue(db, { now, filter }).total,
    reviewedToday: Number(todayRow?.reviewed ?? 0),
    retentionToday: todayRow?.retention ?? null,
  };
}

// ── review log ───────────────────────────────────────────────────────────────

export function logReview(db: Database, entry: ReviewLogEntry): number {
  const result = db
    .prepare(
      `INSERT INTO card_reviews
         (flashcard_id, session_id, rating, state_before, state_after, elapsed_days,
          scheduled_days, stability, difficulty, retrievability, duration_ms,
          reviewed_at, log_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.flashcardId,
      entry.sessionId ?? null,
      RATING_VALUES[entry.rating],
      entry.stateBefore,
      entry.stateAfter,
      entry.elapsedDays,
      entry.scheduledDays,
      entry.stability,
      entry.difficulty,
      entry.retrievability,
      entry.durationMs ?? null,
      entry.reviewedAt,
      entry.logJson,
    );
  return Number(result.lastInsertRowid);
}

export function latestReview(db: Database, cardId: number): CardReviewRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM card_reviews WHERE flashcard_id = ? ORDER BY reviewed_at DESC, id DESC LIMIT 1",
      )
      .get(cardId) as CardReviewRow | undefined) ?? null
  );
}

export function listReviews(db: Database, cardId: number, limit = 50): CardReviewRow[] {
  return db
    .prepare(
      `SELECT * FROM card_reviews
        WHERE flashcard_id = ?
        ORDER BY reviewed_at DESC, id DESC
        LIMIT ?`,
    )
    .all(cardId, limit) as unknown as CardReviewRow[];
}

/** Remove a review row. Used by undo, which re-derives "new cards today". */
export function deleteReview(db: Database, id: number): boolean {
  const result = db.prepare("DELETE FROM card_reviews WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

/** Reviews recorded in a session, newest first. */
export function listSessionReviews(db: Database, sessionId: number): CardReviewRow[] {
  return db
    .prepare(
      "SELECT * FROM card_reviews WHERE session_id = ? ORDER BY reviewed_at ASC, id ASC",
    )
    .all(sessionId) as unknown as CardReviewRow[];
}

// ── per-topic counts ─────────────────────────────────────────────────────────

interface TopicCardCountRow {
  topic_id: number;
  code: string;
  title: string;
  status: string;
  card_count: number | bigint;
  due_count: number | bigint;
}

/**
 * Card and due counts per syllabus topic.
 *
 * Drives the "which topics have cards, and which are waiting" view in the review
 * panel, and shows the gaps where a topic has no material yet.
 */
export function countCardsByTopic(
  db: Database,
  syllabusId: number | null | undefined,
  now: Date,
): TopicCardCount[] {
  const rows = db
    .prepare(
      `SELECT t.id AS topic_id, t.code, t.title, t.status,
              COUNT(c.id) AS card_count,
              COALESCE(SUM(CASE WHEN c.id IS NOT NULL
                                 AND (c.next_review IS NULL OR c.next_review <= ?)
                           THEN 1 ELSE 0 END), 0) AS due_count
         FROM syllabus_topics t
         LEFT JOIN flashcards c ON c.topic_id = t.id AND c.archived_at IS NULL
        WHERE t.archived_at IS NULL
          ${syllabusId ? "AND t.syllabus_id = ?" : ""}
        GROUP BY t.id
        ORDER BY t.order_index, t.id`,
    )
    .all(...(syllabusId ? [isoOf(now), syllabusId] : [isoOf(now)])) as unknown as TopicCardCountRow[];

  return rows.map((row) => ({
    topicId: Number(row.topic_id),
    code: row.code,
    title: row.title,
    status: row.status,
    cardCount: Number(row.card_count),
    dueCount: Number(row.due_count),
  }));
}
