import { useMemo, useState } from "react";
import type {
  SyllabusDetail,
  TopicStatus,
  Valence,
} from "../../../shared/syllabus-types";
import { TOPIC_STATUS_LABELS, TOPIC_STATUSES } from "../../../shared/syllabus-types";

const VALENCE_MARKS: Array<{ value: Valence; label: string }> = [
  { value: "red", label: "Struggling" },
  { value: "yellow", label: "Curious" },
  { value: "green", label: "Mastered" },
];

/**
 * Active syllabus: the topic list with inline progress and valence tagging.
 *
 * Valence is the emotional read on a topic (red = avoidance, yellow = curiosity,
 * green = mastered) and drives how the Socratic prompt pitches its questions, so
 * tagging needs to be one click, not a dialog.
 */
export function ActiveTab({
  detail,
  counts,
  onChanged,
  onSaved,
}: {
  detail: SyllabusDetail;
  counts: { topics: number; covered: number; mastered: number };
  onChanged: () => Promise<void>;
  onSaved: (message: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [busyTopic, setBusyTopic] = useState<number | null>(null);

  const sections = useMemo(() => {
    const map = new Map<string, typeof detail.topics>();
    for (const topic of detail.topics) {
      const key = (topic.section ?? "Unsorted").trim() || "Unsorted";
      const bucket = map.get(key) ?? [];
      bucket.push(topic);
      map.set(key, bucket);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [detail]);

  const mutate = async (
    topicId: number,
    patch: { status?: TopicStatus; valence?: Valence | null },
  ) => {
    setBusyTopic(topicId);
    try {
      await window.electronAPI?.setTopicProgress(topicId, patch);
      await onChanged();
    } finally {
      setBusyTopic(null);
    }
  };

  const setStatusForSection = async (sectionTopics: typeof detail.topics, status: TopicStatus) => {
    await Promise.all(
      sectionTopics.map((topic) => window.electronAPI?.setTopicProgress(topic.id, { status })),
    );
    onSaved(`Marked ${sectionTopics.length} topic(s) as ${TOPIC_STATUS_LABELS[status].toLowerCase()}.`);
    await onChanged();
  };

  return (
    <div className="syllabus-active">
      <div className="stat-grid">
        <div className="stat">
          <span className="stat__value">{counts.topics}</span>
          <span className="stat__label">Topics</span>
        </div>
        <div className="stat">
          <span className="stat__value">{counts.covered}</span>
          <span className="stat__label">Covered</span>
        </div>
        <div className="stat">
          <span className="stat__value">{counts.mastered}</span>
          <span className="stat__label">Mastered</span>
        </div>
        <div className="stat">
          <span className="stat__value">
            {detail.syllabus.exam_date ?? "—"}
          </span>
          <span className="stat__label">Exam date</span>
        </div>
      </div>

      {sections.map(([section, topics]) => {
        const isCollapsed = collapsed[section];
        return (
          <div key={section} className="section-block">
            <div className="section-block__header">
              <button
                type="button"
                className="section-block__toggle"
                onClick={() => setCollapsed((current) => ({ ...current, [section]: !current[section] }))}
              >
                <span className={`disclosure${isCollapsed ? " disclosure--closed" : ""}`} />
                <span className="section-block__title">{section}</span>
                <span className="badge badge--muted">{topics.length}</span>
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => void setStatusForSection(topics, "mastered")}
                title="Mark every topic in this section as mastered"
              >
                Mark section mastered
              </button>
            </div>

            {!isCollapsed ? (
              <table className="table table--topics">
                <thead>
                  <tr>
                    <th className="table__code">Code</th>
                    <th>Topic</th>
                    <th className="table__number">Est. h</th>
                    <th className="table__status">Status</th>
                    <th className="table__valence">Valence</th>
                  </tr>
                </thead>
                <tbody>
                  {topics.map((topic) => (
                    <tr key={topic.id} className={busyTopic === topic.id ? "row--busy" : undefined}>
                      <td className="mono-note">{topic.code}</td>
                      <td>{topic.title}</td>
                      <td className="table__number">{topic.est_hours ?? "—"}</td>
                      <td>
                        <select
                          className="input input--compact"
                          value={topic.status}
                          onChange={(event) =>
                            void mutate(topic.id, { status: event.target.value as TopicStatus })
                          }
                        >
                          {TOPIC_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {TOPIC_STATUS_LABELS[status]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <div className="valence-row">
                          {VALENCE_MARKS.map((mark) => (
                            <button
                              key={mark.value}
                              type="button"
                              title={mark.label}
                              aria-label={`${mark.label}: ${topic.title}`}
                              aria-pressed={topic.valence === mark.value}
                              className={`valence valence--${mark.value}${
                                topic.valence === mark.value ? " valence--active" : ""
                              }`}
                              onClick={() =>
                                void mutate(topic.id, {
                                  valence: topic.valence === mark.value ? null : mark.value,
                                })
                              }
                            />
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
