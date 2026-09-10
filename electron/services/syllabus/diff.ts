import type {
  CanonicalTopic,
  SyllabusDiff,
  SyllabusTopicRow,
  TopicDiffEntry,
} from "../../src/shared/syllabus-types";

/**
 * Diffing for syllabus re-imports.
 *
 * Matching is on `(syllabus_id, code)` — the same key the database enforces as
 * unique. That is what lets a re-import update titles and time allocations while
 * leaving the user's progress (status, valence, review history) untouched.
 *
 * Pure by design: no database access, so the diff can be previewed before
 * anything is written.
 */

const COMPARED_FIELDS = ["title", "section", "estHours"] as const;

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeHours(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  return String(Math.round(value * 100) / 100);
}

export function diffTopics(
  existing: SyllabusTopicRow[],
  incoming: CanonicalTopic[],
): SyllabusDiff {
  const added: TopicDiffEntry[] = [];
  const changed: TopicDiffEntry[] = [];
  const unchanged: TopicDiffEntry[] = [];
  const removed: TopicDiffEntry[] = [];

  // Archived rows are not diffed: they are invisible to the user and are
  // re-activated (rather than re-added) when their code reappears.
  const byCode = new Map<string, SyllabusTopicRow>();
  for (const row of existing) {
    if (row.archived_at) continue;
    byCode.set(row.code, row);
  }

  const seen = new Set<string>();

  for (const topic of incoming) {
    seen.add(topic.code);
    const current = byCode.get(topic.code);

    if (!current) {
      added.push({ code: topic.code, title: topic.title, kind: "added", fields: [] });
      continue;
    }

    const fields: string[] = [];
    if (normalize(current.title) !== normalize(topic.title)) fields.push("title");
    if (normalize(current.section) !== normalize(topic.section)) fields.push("section");
    if (normalizeHours(current.est_hours) !== normalizeHours(topic.estHours)) fields.push("estHours");

    if (fields.length) {
      changed.push({
        code: topic.code,
        title: topic.title,
        kind: "changed",
        fields,
        previousTitle: current.title !== topic.title ? current.title : undefined,
      });
    } else {
      unchanged.push({ code: topic.code, title: topic.title, kind: "unchanged", fields: [] });
    }
  }

  for (const [code, row] of byCode) {
    if (seen.has(code)) continue;
    removed.push({ code, title: row.title, kind: "removed", fields: [] });
  }

  const sort = (entries: TopicDiffEntry[]) =>
    entries.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  return {
    added: sort(added),
    changed: sort(changed),
    unchanged: sort(unchanged),
    removed: sort(removed),
    counts: {
      added: added.length,
      changed: changed.length,
      unchanged: unchanged.length,
      removed: removed.length,
    },
  };
}

export function isNoopDiff(diff: SyllabusDiff): boolean {
  return diff.counts.added === 0 && diff.counts.changed === 0 && diff.counts.removed === 0;
}

/** One-line summary for the import dialog. */
export function describeDiff(diff: SyllabusDiff): string {
  if (isNoopDiff(diff)) return "No changes — this import would be a no-op.";
  const parts: string[] = [];
  if (diff.counts.added) parts.push(`${diff.counts.added} added`);
  if (diff.counts.changed) parts.push(`${diff.counts.changed} updated`);
  if (diff.counts.removed) parts.push(`${diff.counts.removed} removed`);
  parts.push(`${diff.counts.unchanged} unchanged`);
  return parts.join(" · ");
}
