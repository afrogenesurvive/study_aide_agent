import { useState } from "react";
import { Icon } from "../../icons";
import type { SyllabusDetail, TopicStatus, Valence } from "../../../shared/syllabus-types";
import {
  TOPIC_STATUS_LABELS,
  TOPIC_STATUSES,
  VALENCE_LABELS,
  VALENCES,
} from "../../../shared/syllabus-types";

/**
 * Topic editor.
 *
 * Supports the corrections that always turn out to be necessary after an import:
 * fixing a title, adding a missing topic, reordering, and retiring one. Deleting
 * archives rather than deletes, so nothing that already references the topic
 * breaks.
 */
export function EditorTab({
  detail,
  onChanged,
  onSaved,
}: {
  detail: SyllabusDetail;
  onChanged: () => Promise<void>;
  onSaved: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<number, Partial<Record<string, string>>>>({});
  const [adding, setAdding] = useState(false);
  const [newTopic, setNewTopic] = useState({ code: "", title: "", section: "", estHours: "" });

  const setDraft = (topicId: number, field: string, value: string) => {
    setDrafts((current) => ({
      ...current,
      [topicId]: { ...(current[topicId] ?? {}), [field]: value },
    }));
  };

  const saveTopic = async (topicId: number) => {
    const patch = drafts[topicId];
    if (!patch) return;
    const payload: { code?: string; title?: string; section?: string | null; estHours?: number | null } = {};
    if (patch.code !== undefined) payload.code = patch.code.trim();
    if (patch.title !== undefined) payload.title = patch.title.trim();
    if (patch.section !== undefined) payload.section = patch.section.trim() || null;
    if (patch.estHours !== undefined) payload.estHours = patch.estHours === "" ? null : Number(patch.estHours);

    const result = await window.electronAPI?.updateTopic(topicId, payload);
    if (result?.success) {
      onSaved("Topic saved.");
      setDrafts((current) => {
        const next = { ...current };
        delete next[topicId];
        return next;
      });
      await onChanged();
    } else {
      onSaved(result?.error ?? "Could not save that topic.");
    }
  };

  const sections = [...new Set(detail.topics.map((topic) => topic.section ?? ""))].filter(Boolean);

  /** id → parent id, so the parent picker can refuse to create a cycle. */
  const parentOf = new Map(detail.topics.map((topic) => [topic.id, topic.parent_id]));

  /** True when `ancestor` sits somewhere above `candidate` in the tree. */
  const isDescendant = (candidate: number, ancestor: number): boolean => {
    const seen = new Set<number>();
    let current = parentOf.get(candidate) ?? null;
    while (current !== null && !seen.has(current)) {
      if (current === ancestor) return true;
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }
    return false;
  };
  return (
    <div className="editor-tab">
      <div className="toolbar">
        <button type="button" className="btn btn--primary" onClick={() => setAdding((value) => !value)}>
          <Icon name={adding ? "close" : "plus"} size={14} />
          {adding ? "Cancel" : "Add topic"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            await window.electronAPI?.saveConfig({ SYLLABUS_ACTIVE_ID: String(detail.syllabus.id) });
            await window.electronAPI?.setActiveSyllabus(detail.syllabus.id, true);
            onSaved("Set as the active syllabus.");
            await onChanged();
          }}
          disabled={Boolean(detail.syllabus.is_active)}
        >
          Set as active
        </button>
      </div>

      {adding ? (
        <div className="fieldset add-topic">
          <div className="field-grid">
            <div className="field">
              <label className="field__label" htmlFor="new-code">
                Code
              </label>
              <input
                id="new-code"
                className="input"
                value={newTopic.code}
                placeholder="1.4"
                onChange={(event) => setNewTopic({ ...newTopic, code: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="new-title">
                Title
              </label>
              <input
                id="new-title"
                className="input"
                value={newTopic.title}
                onChange={(event) => setNewTopic({ ...newTopic, title: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="new-section">
                Section
              </label>
              <input
                id="new-section"
                className="input"
                list="editor-sections"
                value={newTopic.section}
                onChange={(event) => setNewTopic({ ...newTopic, section: event.target.value })}
              />
              <datalist id="editor-sections">
                {sections.map((section) => (
                  <option key={section} value={section} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="new-hours">
                Est. hours
              </label>
              <input
                id="new-hours"
                className="input"
                type="number"
                min={0}
                step={0.5}
                value={newTopic.estHours}
                onChange={(event) => setNewTopic({ ...newTopic, estHours: event.target.value })}
              />
            </div>
          </div>
          <button
            type="button"
            className="btn btn--primary"
            onClick={async () => {
              const result = await window.electronAPI?.createTopic(detail.syllabus.id, {
                code: newTopic.code || undefined,
                title: newTopic.title,
                section: newTopic.section || null,
                estHours: newTopic.estHours === "" ? null : Number(newTopic.estHours),
              });
              if (result?.success) {
                setNewTopic({ code: "", title: "", section: "", estHours: "" });
                setAdding(false);
                onSaved("Topic added.");
                await onChanged();
              } else {
                onSaved(result?.error ?? "Could not add that topic.");
              }
            }}
            disabled={!newTopic.title.trim()}
          >
            Add
          </button>
        </div>
      ) : null}

      <table className="table table--editor">
        <thead>
          <tr>
            <th className="table__code">Code</th>
            <th>Title</th>
            <th>Section</th>
            <th>Parent</th>
            <th className="table__number">Est. h</th>
            <th>Status</th>
            <th>Valence</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {detail.topics.map((topic, index) => {
            const draft = drafts[topic.id] ?? {};
            const dirty = Object.keys(draft).length > 0;
            return (
              <tr key={topic.id} className={dirty ? "row--dirty" : undefined}>
                <td>
                  <input
                    className="input input--cell mono-note"
                    value={draft.code ?? topic.code}
                    onChange={(event) => setDraft(topic.id, "code", event.target.value)}
                  />
                </td>
                <td>
                  <input
                    className="input input--cell"
                    value={draft.title ?? topic.title}
                    onChange={(event) => setDraft(topic.id, "title", event.target.value)}
                  />
                </td>
                <td>
                  <input
                    className="input input--cell"
                    list="editor-sections"
                    value={draft.section ?? topic.section ?? ""}
                    onChange={(event) => setDraft(topic.id, "section", event.target.value)}
                  />
                </td>
                <td>
                  <select
                    className="input input--compact"
                    value={topic.parent_id ?? ""}
                    aria-label={`Parent of ${topic.code}`}
                    onChange={async (event) => {
                      const value = event.target.value;
                      await window.electronAPI?.updateTopic(topic.id, {
                        parentId: value ? Number(value) : null,
                      });
                      await onChanged();
                    }}
                  >
                    <option value="">— none —</option>
                    {detail.topics
                      .filter((candidate) => candidate.id !== topic.id && !isDescendant(candidate.id, topic.id))
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.code} · {candidate.title}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  <input
                    className="input input--cell"
                    type="number"
                    min={0}
                    step={0.5}
                    value={draft.estHours ?? topic.est_hours ?? ""}
                    onChange={(event) => setDraft(topic.id, "estHours", event.target.value)}
                  />
                </td>
                <td>
                  <select
                    className="input input--compact"
                    value={topic.status}
                    onChange={async (event) => {
                      await window.electronAPI?.setTopicProgress(topic.id, {
                        status: event.target.value as TopicStatus,
                      });
                      await onChanged();
                    }}
                  >
                    {TOPIC_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {TOPIC_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className="input input--compact"
                    value={topic.valence ?? ""}
                    onChange={async (event) => {
                      const value = event.target.value as Valence | "";
                      await window.electronAPI?.setTopicProgress(topic.id, {
                        valence: value === "" ? null : value,
                      });
                      await onChanged();
                    }}
                  >
                    <option value="">—</option>
                    {VALENCES.map((valence) => (
                      <option key={valence} value={valence}>
                        {VALENCE_LABELS[valence]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="editor-actions">
                  {dirty ? (
                    <button type="button" className="btn btn--small btn--primary" onClick={() => void saveTopic(topic.id)}>
                      Save
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--small"
                    title="Move up"
                    disabled={index === 0}
                    onClick={async () => {
                      const previous = detail.topics[index - 1];
                      await window.electronAPI?.reorderTopic(topic.id, previous.order_index);
                      await window.electronAPI?.reorderTopic(previous.id, topic.order_index);
                      await onChanged();
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    title="Archive topic"
                    onClick={async () => {
                      await window.electronAPI?.deleteTopic(topic.id);
                      onSaved(`Archived “${topic.title}”. Progress history is kept.`);
                      await onChanged();
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
