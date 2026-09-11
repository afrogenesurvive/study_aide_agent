import type { Database } from "../database/db";
import { withTransaction } from "../database/db";
import type {
  CanonicalSyllabus,
  ImportCommitResult,
  ImportFormat,
  ImportPreview,
  SyllabusDiff,
} from "../../src/shared/syllabus-types";
import { diffTopics } from "./diff";
import {
  archiveTopic,
  createImportRecord,
  createSyllabus,
  findSyllabus,
  getSyllabus,
  getTopics,
  markImportRolledBack,
  getImportRecord,
  nextOrderIndex,
  snapshotTopics,
  updateSyllabus,
  upsertTopic,
} from "./repo";

/**
 * Import orchestration: preview → apply → rollback.
 *
 * Two invariants matter more than anything else here:
 *
 *  1. **Progress is preserved.** Topics are matched on `(syllabus_id, code)` and
 *     only the descriptive columns are written, so status/valence/review history
 *     survive a re-import.
 *  2. **Nothing is hard-deleted.** Topics that disappear from a new import are
 *     archived instead, so their review history stays referentially intact.
 *
 * Every write happens inside one transaction, so a partial import is impossible.
 */

export interface ImportArgs {
  canonical: CanonicalSyllabus;
  format: ImportFormat;
  sourceFile?: string | null;
  /** Force a specific syllabus instead of matching on (subject, board, level). */
  syllabusId?: number | null;
  /** Overrides stored on the syllabus row, when provided. */
  examDate?: string | null;
  title?: string | null;
}

interface ResolvedTarget {
  syllabusId: number | null;
  isNewSyllabus: boolean;
  existingTopics: ReturnType<typeof getTopics>;
  diff: SyllabusDiff;
}

function resolveTarget(db: Database, args: ImportArgs): ResolvedTarget {
  const { canonical } = args;

  let existing = args.syllabusId ? getSyllabus(db, args.syllabusId) : null;
  if (!existing) {
    existing = findSyllabus(db, {
      subject: canonical.subject,
      board: canonical.board,
      level: canonical.level,
    });
  }

  if (!existing) {
    return {
      syllabusId: null,
      isNewSyllabus: true,
      existingTopics: [],
      diff: diffTopics(
        [],
        canonical.topics,
      ),
    };
  }

  const existingTopics = getTopics(db, existing.id, { includeArchived: true });
  return {
    syllabusId: existing.id,
    isNewSyllabus: false,
    existingTopics,
    diff: diffTopics(existingTopics, canonical.topics),
  };
}

/** Compute what an import would change, without writing anything. */
export function previewImport(db: Database, args: ImportArgs): ImportPreview {
  const target = resolveTarget(db, args);
  return {
    syllabusId: target.syllabusId,
    isNewSyllabus: target.isNewSyllabus,
    subject: args.canonical.subject,
    board: args.canonical.board,
    level: args.canonical.level,
    topicCount: args.canonical.topics.length,
    diff: target.diff,
  };
}

/**
 * Apply an import.
 *
 * `parent` is resolved in a second pass, once every code has an id, so an
 * outline can reference a parent that appears later in the file.
 */
export function applyImport(db: Database, args: ImportArgs): ImportCommitResult {
  const { canonical } = args;

  if (!canonical.topics.length) {
    return { success: false, error: "That import contains no topics." };
  }

  return withTransaction(db, () => {
    const target = resolveTarget(db, args);
    const syllabusId =
      target.syllabusId ??
      createSyllabus(db, {
        subject: canonical.subject,
        board: canonical.board,
        level: canonical.level,
        title: args.title ?? canonical.title ?? "",
        examDate: args.examDate ?? canonical.examDate ?? null,
        sourceFile: args.sourceFile ?? null,
      });

    const priorSnapshot = snapshotTopics(db, syllabusId);
    const baseOrder = nextOrderIndex(db, syllabusId);

    // Pass 1: upsert every incoming topic.
    let index = 0;
    for (const topic of canonical.topics) {
      upsertTopic(db, syllabusId, {
        code: topic.code,
        title: topic.title,
        section: topic.section ?? null,
        orderIndex: baseOrder + index,
        estHours: topic.estHours ?? null,
      });
      index += 1;
    }

    // Pass 2: wire up parent_id now that all codes exist.
    //
    // Only topics that explicitly declare a parent are touched. A source that is
    // silent about hierarchy must not flatten one it never described — which is
    // also why pass 1 leaves `parent_id` alone entirely.
    const idByCode = new Map<string, number>();
    // A second, wider lookup for the archival pass below: it needs archived rows
    // too, and doing that query per removed topic made this loop O(n²).
    const rowByCode = new Map<string, { id: number; archived_at: string | null }>();
    for (const row of getTopics(db, syllabusId)) idByCode.set(row.code, row.id);
    for (const row of getTopics(db, syllabusId, { includeArchived: true })) {
      rowByCode.set(row.code, row);
    }

    const setParent = db.prepare("UPDATE syllabus_topics SET parent_id = ? WHERE id = ?");
    for (const topic of canonical.topics) {
      if (!topic.parent) continue;
      const id = idByCode.get(topic.code);
      const parentId = idByCode.get(topic.parent);
      if (id && parentId && parentId !== id) setParent.run(parentId, id);
    }

    // Archive topics that vanished from the new import (never hard-delete).
    for (const entry of target.diff.removed) {
      const row = rowByCode.get(entry.code);
      if (row && !row.archived_at) archiveTopic(db, row.id);
    }

    // Descriptive syllabus metadata can be refreshed by the import.
    updateSyllabus(db, syllabusId, {
      ...(args.title ? { title: args.title } : canonical.title ? { title: canonical.title } : {}),
      ...(args.examDate ?? canonical.examDate
        ? { examDate: args.examDate ?? canonical.examDate ?? null }
        : {}),
      ...(args.sourceFile ? { sourceFile: args.sourceFile } : {}),
    });

    // `target.diff` was computed before any write, so it is the honest summary of
    // what this import changed.
    const importId = createImportRecord(db, {
      syllabusId,
      format: args.format,
      sourceFile: args.sourceFile ?? null,
      rawPayload: JSON.stringify(canonical),
      priorSnapshot,
      diff: target.diff,
      topicCount: canonical.topics.length,
    });

    return { success: true, syllabusId, importId, diff: target.diff };
  });
}

/**
 * Undo an import by restoring the topic table to its pre-import snapshot.
 *
 * Row ids are restored verbatim so anything already pointing at a topic
 * (flashcards, valence tags) keeps pointing at the right place.
 */
export function rollbackImport(db: Database, importId: number): { success: boolean; error?: string } {
  const record = getImportRecord(db, importId);
  if (!record) return { success: false, error: "That import no longer exists." };
  if (record.status === "rolled_back") {
    return { success: false, error: "That import has already been rolled back." };
  }
  if (!record.prior_snapshot_json) {
    return { success: false, error: "That import has no rollback snapshot." };
  }

  let snapshot: Array<Record<string, unknown>>;
  try {
    snapshot = JSON.parse(record.prior_snapshot_json) as Array<Record<string, unknown>>;
  } catch {
    return { success: false, error: "The rollback snapshot is corrupt." };
  }

  try {
    withTransaction(db, () => {
      db.prepare("DELETE FROM syllabus_topics WHERE syllabus_id = ?").run(record.syllabus_id);

      const insert = db.prepare(
        `INSERT INTO syllabus_topics
           (id, syllabus_id, parent_id, code, title, section, order_index, est_hours,
            status, valence, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      // Ascending id keeps self-referencing parents ahead of their children.
      const ordered = [...snapshot].sort((a, b) => Number(a.id) - Number(b.id));
      for (const row of ordered) {
        insert.run(
          row.id as number,
          row.syllabus_id as number,
          (row.parent_id ?? null) as number | null,
          row.code as string,
          row.title as string,
          (row.section ?? null) as string | null,
          Number(row.order_index ?? 0),
          (row.est_hours ?? null) as number | null,
          (row.status ?? "not_started") as string,
          (row.valence ?? null) as string | null,
          (row.archived_at ?? null) as string | null,
          (row.created_at ?? null) as string | null,
          (row.updated_at ?? null) as string | null,
        );
      }

      markImportRolledBack(db, importId);
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
