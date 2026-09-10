import type { Database } from "../database/db";
import type {
  CanonicalSyllabus,
  ImportFormat,
  SyllabusDiff,
  SyllabusImportRow,
  SyllabusRow,
  SyllabusSummary,
  SyllabusTopicRow,
  Subject,
  TopicStatus,
  Valence,
} from "../../src/shared/syllabus-types";

/**
 * Syllabus persistence.
 *
 * All SQL for the syllabus subsystem lives here so `diff.ts`, `coverage.ts` and
 * `import.ts` can stay pure and unit-testable.
 */

interface SyllabusKey {
  subject: Subject;
  board: string;
  level: string;
}

export interface SyllabusPatch {
  title?: string;
  examDate?: string | null;
  sourceFile?: string | null;
}

// ── syllabus ─────────────────────────────────────────────────────────────────

export function listSyllabi(db: Database): SyllabusSummary[] {
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM syllabus_topics t
                WHERE t.syllabus_id = s.id AND t.archived_at IS NULL) AS topic_count,
              (SELECT COUNT(*) FROM syllabus_topics t
                WHERE t.syllabus_id = s.id AND t.archived_at IS NOT NULL) AS archived_count,
              (SELECT COUNT(*) FROM syllabus_topics t
                WHERE t.syllabus_id = s.id AND t.archived_at IS NULL
                  AND t.status IN ('introduced','learning','mastered')) AS active_or_learning
         FROM syllabus s
        ORDER BY s.is_active DESC, s.imported_at DESC`,
    )
    .all() as unknown as SyllabusSummary[];
}

export function findSyllabus(db: Database, key: SyllabusKey): SyllabusRow | null {
  return (
    (db
      .prepare("SELECT * FROM syllabus WHERE subject = ? AND board = ? AND level = ?")
      .get(key.subject, key.board, key.level) as SyllabusRow | undefined) ?? null
  );
}

export function getSyllabus(db: Database, id: number): SyllabusRow | null {
  return (
    (db.prepare("SELECT * FROM syllabus WHERE id = ?").get(id) as SyllabusRow | undefined) ?? null
  );
}

/** The syllabus the app should default to. */
export function getActiveSyllabus(db: Database, preferredId?: number | null): SyllabusRow | null {
  if (preferredId) {
    const preferred = getSyllabus(db, preferredId);
    if (preferred) return preferred;
  }
  return (
    (db
      .prepare("SELECT * FROM syllabus WHERE is_active = 1 ORDER BY imported_at DESC LIMIT 1")
      .get() as SyllabusRow | undefined) ??
    (db.prepare("SELECT * FROM syllabus ORDER BY imported_at DESC LIMIT 1").get() as
      | SyllabusRow
      | undefined) ??
    null
  );
}

export function createSyllabus(
  db: Database,
  key: SyllabusKey & { title?: string; examDate?: string | null; sourceFile?: string | null },
): number {
  const result = db
    .prepare(
      `INSERT INTO syllabus (subject, board, level, title, exam_date, source_file, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      key.subject,
      key.board,
      key.level,
      key.title ?? "",
      key.examDate ?? null,
      key.sourceFile ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function updateSyllabus(db: Database, id: number, patch: SyllabusPatch): void {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.title !== undefined) {
    sets.push("title = ?");
    values.push(patch.title);
  }
  if (patch.examDate !== undefined) {
    sets.push("exam_date = ?");
    values.push(patch.examDate);
  }
  if (patch.sourceFile !== undefined) {
    sets.push("source_file = ?");
    values.push(patch.sourceFile);
  }
  if (!sets.length) return;

  values.push(id);
  db.prepare(`UPDATE syllabus SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
}

export function setActiveSyllabus(db: Database, id: number, active = true): void {
  db.prepare("UPDATE syllabus SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function deleteSyllabus(db: Database, id: number): void {
  db.prepare("DELETE FROM syllabus WHERE id = ?").run(id);
}

// ── topics ───────────────────────────────────────────────────────────────────

export function getTopics(
  db: Database,
  syllabusId: number,
  options: { includeArchived?: boolean } = {},
): SyllabusTopicRow[] {
  const where = options.includeArchived
    ? "syllabus_id = ?"
    : "syllabus_id = ? AND archived_at IS NULL";
  return db
    .prepare(`SELECT * FROM syllabus_topics WHERE ${where} ORDER BY order_index, id`)
    .all(syllabusId) as unknown as SyllabusTopicRow[];
}

export function getTopicByCode(
  db: Database,
  syllabusId: number,
  code: string,
): SyllabusTopicRow | null {
  return (
    (db
      .prepare("SELECT * FROM syllabus_topics WHERE syllabus_id = ? AND code = ?")
      .get(syllabusId, code) as SyllabusTopicRow | undefined) ?? null
  );
}

export function getTopic(db: Database, id: number): SyllabusTopicRow | null {
  return (
    (db.prepare("SELECT * FROM syllabus_topics WHERE id = ?").get(id) as
      | SyllabusTopicRow
      | undefined) ?? null
  );
}

export interface TopicWrite {
  code: string;
  title: string;
  section?: string | null;
  parentId?: number | null;
  orderIndex: number;
  estHours?: number | null;
  /** Only applied when non-null, so a re-import cannot reset progress. */
  status?: TopicStatus | null;
  valence?: Valence | null;
}

/**
 * Insert or update a topic, keyed on `(syllabus_id, code)`.
 *
 * Progress columns (`status`, `valence`) are deliberately *not* touched on
 * update — that is the whole point of matching on code. Re-adding a previously
 * archived topic clears `archived_at`.
 */
export function upsertTopic(db: Database, syllabusId: number, topic: TopicWrite): number {
  const existing = getTopicByCode(db, syllabusId, topic.code);

  if (!existing) {
    const result = db
      .prepare(
        `INSERT INTO syllabus_topics
           (syllabus_id, parent_id, code, title, section, order_index, est_hours, status, valence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        syllabusId,
        topic.parentId ?? null,
        topic.code,
        topic.title,
        topic.section ?? null,
        topic.orderIndex,
        topic.estHours ?? null,
        topic.status ?? "not_started",
        topic.valence ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  db.prepare(
    `UPDATE syllabus_topics
        SET title = ?, section = ?, order_index = ?, est_hours = ?, parent_id = ?,
            archived_at = NULL, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    topic.title,
    topic.section ?? null,
    topic.orderIndex,
    topic.estHours ?? null,
    topic.parentId ?? null,
    existing.id,
  );
  return existing.id;
}

export function archiveTopic(db: Database, id: number): void {
  db.prepare(
    "UPDATE syllabus_topics SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).run(id);
}

export function restoreTopic(db: Database, id: number): void {
  db.prepare(
    "UPDATE syllabus_topics SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(id);
}

export function updateTopicProgress(
  db: Database,
  id: number,
  patch: { status?: TopicStatus; valence?: Valence | null },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.valence !== undefined) {
    sets.push("valence = ?");
    values.push(patch.valence);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE syllabus_topics SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
}

export function updateTopicFields(
  db: Database,
  id: number,
  patch: { title?: string; section?: string | null; estHours?: number | null; code?: string },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.code !== undefined) {
    sets.push("code = ?");
    values.push(patch.code);
  }
  if (patch.title !== undefined) {
    sets.push("title = ?");
    values.push(patch.title);
  }
  if (patch.section !== undefined) {
    sets.push("section = ?");
    values.push(patch.section);
  }
  if (patch.estHours !== undefined) {
    sets.push("est_hours = ?");
    values.push(patch.estHours);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE syllabus_topics SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
}

export function deleteTopic(db: Database, id: number): void {
  db.prepare("DELETE FROM syllabus_topics WHERE id = ?").run(id);
}

export function reorderTopic(db: Database, id: number, orderIndex: number): void {
  db.prepare("UPDATE syllabus_topics SET order_index = ? WHERE id = ?").run(orderIndex, id);
}

export function nextOrderIndex(db: Database, syllabusId: number): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(order_index), -1) AS max FROM syllabus_topics WHERE syllabus_id = ?")
    .get(syllabusId) as { max: number } | undefined;
  return Number(row?.max ?? -1) + 1;
}

// ── imports ──────────────────────────────────────────────────────────────────

export interface ImportWrite {
  syllabusId: number;
  format: ImportFormat;
  sourceFile?: string | null;
  rawPayload: string;
  priorSnapshot: string;
  diff: SyllabusDiff;
  topicCount: number;
}

export function createImportRecord(db: Database, write: ImportWrite): number {
  const result = db
    .prepare(
      `INSERT INTO syllabus_imports
         (syllabus_id, format, source_file, raw_payload, prior_snapshot_json, diff_json, topic_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'applied')`,
    )
    .run(
      write.syllabusId,
      write.format,
      write.sourceFile ?? null,
      write.rawPayload,
      write.priorSnapshot,
      JSON.stringify(write.diff),
      write.topicCount,
    );
  return Number(result.lastInsertRowid);
}

export function listImports(db: Database, syllabusId?: number): SyllabusImportRow[] {
  const base = `
    SELECT i.id, i.syllabus_id, i.format, i.source_file, i.topic_count, i.status,
           i.created_at, i.rolled_back_at,
           s.subject, s.board, s.level
      FROM syllabus_imports i
      JOIN syllabus s ON s.id = i.syllabus_id`;
  if (syllabusId) {
    return db
      .prepare(`${base} WHERE i.syllabus_id = ? ORDER BY i.created_at DESC, i.id DESC`)
      .all(syllabusId) as unknown as SyllabusImportRow[];
  }
  return db
    .prepare(`${base} ORDER BY i.created_at DESC, i.id DESC LIMIT 200`)
    .all() as unknown as SyllabusImportRow[];
}

export function getImportRecord(
  db: Database,
  importId: number,
): (SyllabusImportRow & { raw_payload: string; prior_snapshot_json: string | null }) | null {
  return (
    (db
      .prepare(
        `SELECT i.*, s.subject, s.board, s.level
           FROM syllabus_imports i
           JOIN syllabus s ON s.id = i.syllabus_id
          WHERE i.id = ?`,
      )
      .get(importId) as
      | (SyllabusImportRow & { raw_payload: string; prior_snapshot_json: string | null })
      | undefined) ?? null
  );
}

export function markImportRolledBack(db: Database, importId: number): void {
  db.prepare(
    "UPDATE syllabus_imports SET status = 'rolled_back', rolled_back_at = datetime('now') WHERE id = ?",
  ).run(importId);
}

export function countTopics(db: Database, syllabusId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM syllabus_topics WHERE syllabus_id = ?")
    .get(syllabusId) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

export function canonicalOf(canonical: CanonicalSyllabus): string {
  return JSON.stringify(canonical);
}

/** Snapshot used for rollback: the full topic set, archived rows included. */
export function snapshotTopics(db: Database, syllabusId: number): string {
  return JSON.stringify(db
    .prepare("SELECT * FROM syllabus_topics WHERE syllabus_id = ? ORDER BY id")
    .all(syllabusId));
}
