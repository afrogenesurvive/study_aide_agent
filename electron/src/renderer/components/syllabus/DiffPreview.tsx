import type { SyllabusDiff, TopicDiffEntry } from "../../../shared/syllabus-types";

const KIND_LABELS: Record<TopicDiffEntry["kind"], string> = {
  added: "Added",
  changed: "Updated",
  unchanged: "Unchanged",
  removed: "Will be archived",
};

/**
 * Diff preview shown before an import is committed.
 *
 * This is the review gate for syllabus overwrites: re-importing keeps user
 * progress for matched codes, but the user should still see exactly what is
 * about to be added, changed or archived.
 */
export function DiffPreview({ diff }: { diff: SyllabusDiff }) {
  const groups: Array<[TopicDiffEntry["kind"], TopicDiffEntry[]]> = [
    ["added", diff.added],
    ["changed", diff.changed],
    ["removed", diff.removed],
    ["unchanged", diff.unchanged],
  ];

  return (
    <div className="diff-preview">
      <div className="diff-summary">
        <span className="badge badge--ok">{diff.counts.added} added</span>
        <span className="badge badge--warn">{diff.counts.changed} updated</span>
        <span className="badge badge--bad">{diff.counts.removed} archived</span>
        <span className="badge badge--muted">{diff.counts.unchanged} unchanged</span>
      </div>

      {groups
        .filter(([, entries]) => entries.length > 0)
        .map(([kind, entries]) => (
          <details key={kind} className={`diff-group diff-group--${kind}`} open={kind !== "unchanged"}>
            <summary>
              {KIND_LABELS[kind]} <span className="muted">({entries.length})</span>
            </summary>
            <ul className="diff-list">
              {entries.slice(0, 200).map((entry) => (
                <li key={`${kind}-${entry.code}`}>
                  <span className="mono-note">{entry.code}</span>
                  <span>{entry.title}</span>
                  {entry.fields.length ? (
                    <span className="muted">changed: {entry.fields.join(", ")}</span>
                  ) : null}
                  {entry.previousTitle ? (
                    <span className="muted">was “{entry.previousTitle}”</span>
                  ) : null}
                </li>
              ))}
              {entries.length > 200 ? (
                <li className="muted">…and {entries.length - 200} more.</li>
              ) : null}
            </ul>
          </details>
        ))}
    </div>
  );
}
