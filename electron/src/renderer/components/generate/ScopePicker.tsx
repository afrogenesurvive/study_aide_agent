import { useMemo, useState } from "react";

import { Icon } from "../../icons";
import type { GenerationScopeKind } from "../../../shared/generation-types";
import type { GenerationApi } from "../../hooks/useGeneration";

/**
 * Step 1: what to generate from.
 *
 * All three scope kinds in one place, because they are three answers to one
 * question rather than three features. Topics are always chosen from the
 * syllabus — there is no free-text topic box — which is what keeps generated
 * material anchored to a code the scheduler can later interleave.
 */

const SCOPE_KINDS: Array<{ id: GenerationScopeKind; label: string; hint: string }> = [
  { id: "syllabus", label: "Whole syllabus", hint: "Every topic in the chosen syllabi." },
  { id: "section", label: "One section", hint: "Every topic under a single section heading." },
  { id: "topic", label: "Selected topics", hint: "Only the topics you tick." },
];

export function ScopePicker({ api, disabled }: { api: GenerationApi; disabled: boolean }) {
  const [filter, setFilter] = useState("");
  const { draft, topics, syllabi } = api;

  const sections = useMemo(
    () => [...new Set(topics.map((topic) => topic.section).filter((s): s is string => !!s))].sort(),
    [topics],
  );

  const visibleTopics = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return topics;
    return topics.filter(
      (topic) =>
        topic.code.toLowerCase().includes(needle) || topic.title.toLowerCase().includes(needle),
    );
  }, [filter, topics]);

  const grouped = useMemo(() => {
    const bySection = new Map<string, typeof visibleTopics>();
    for (const topic of visibleTopics) {
      const key = topic.section ?? "Ungrouped";
      const bucket = bySection.get(key);
      if (bucket) bucket.push(topic);
      else bySection.set(key, [topic]);
    }
    return [...bySection.entries()];
  }, [visibleTopics]);

  const toggleSyllabus = (id: number) => {
    const next = draft.syllabusIds.includes(id)
      ? draft.syllabusIds.filter((current) => current !== id)
      : [...draft.syllabusIds, id];
    void api.chooseSyllabi(next);
  };

  const toggleCode = (code: string) => {
    const next = draft.codes.includes(code)
      ? draft.codes.filter((current) => current !== code)
      : [...draft.codes, code];
    api.setDraft({ codes: next });
  };

  const setAllVisible = (selected: boolean) => {
    const visible = new Set(visibleTopics.map((topic) => topic.code));
    const kept = draft.codes.filter((code) => !visible.has(code));
    api.setDraft({ codes: selected ? [...kept, ...visible] : kept });
  };

  return (
    <>
      <div className="field">
        <span className="field__label">Syllabi</span>
        {syllabi.length === 0 ? (
          <p className="muted">
            No syllabus has been imported yet. Import one in the Syllabus section first.
          </p>
        ) : (
          <div className="chip-row">
            {syllabi.map((syllabus) => {
              const chosen = draft.syllabusIds.includes(syllabus.id);
              return (
                <button
                  key={syllabus.id}
                  type="button"
                  className={`chip chip--button${chosen ? " chip--active" : ""}`}
                  aria-pressed={chosen}
                  disabled={disabled}
                  onClick={() => toggleSyllabus(syllabus.id)}
                >
                  {chosen ? <Icon name="check" size={12} /> : null}
                  {syllabus.title || `${syllabus.subject} — ${syllabus.level}`}
                  <span className="muted">{syllabus.topic_count} topics</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="field">
        <span className="field__label">Scope</span>
        <div className="chip-row">
          {SCOPE_KINDS.map((kind) => (
            <button
              key={kind.id}
              type="button"
              className={`chip chip--button${draft.scope === kind.id ? " chip--active" : ""}`}
              aria-pressed={draft.scope === kind.id}
              disabled={disabled}
              title={kind.hint}
              onClick={() => api.setDraft({ scope: kind.id })}
            >
              {kind.label}
            </button>
          ))}
        </div>
        <p className="muted">{SCOPE_KINDS.find((kind) => kind.id === draft.scope)?.hint}</p>
      </div>

      {draft.scope === "section" ? (
        <div className="field">
          <label className="field__label" htmlFor="generate-section">
            Section
          </label>
          <select
            id="generate-section"
            className="input"
            value={draft.section}
            disabled={disabled || sections.length === 0}
            onChange={(event) => api.setDraft({ section: event.target.value })}
          >
            <option value="">Choose a section…</option>
            {sections.map((section) => (
              <option key={section} value={section}>
                {section}
              </option>
            ))}
          </select>
          {sections.length === 0 ? (
            <p className="muted">Choose at least one syllabus to list its sections.</p>
          ) : null}
        </div>
      ) : null}

      {draft.scope === "topic" ? (
        <div className="field">
          <div className="generate-topic__head">
            <span className="field__label">
              Topics{draft.codes.length ? ` · ${draft.codes.length} selected` : ""}
            </span>
            <div className="toolbar">
              <input
                className="input"
                placeholder="Filter by code or title"
                value={filter}
                disabled={disabled}
                onChange={(event) => setFilter(event.target.value)}
              />
              <button
                type="button"
                className="btn btn--small"
                disabled={disabled || visibleTopics.length === 0}
                onClick={() => setAllVisible(true)}
              >
                Select all
              </button>
              <button
                type="button"
                className="btn btn--small"
                disabled={disabled || draft.codes.length === 0}
                onClick={() => setAllVisible(false)}
              >
                Clear
              </button>
            </div>
          </div>

          {topics.length === 0 ? (
            <p className="muted">Choose at least one syllabus to list its topics.</p>
          ) : (
            <div className="generate-topics">
              {grouped.map(([section, entries]) => (
                <div key={section} className="section-block">
                  <div className="section-block__header">
                    <span className="section-block__title">{section}</span>
                    <span className="badge badge--muted">{entries.length}</span>
                  </div>
                  <div className="check-list">
                    {entries.map((topic) => (
                      <label key={topic.id} className="check-row">
                        <input
                          type="checkbox"
                          checked={draft.codes.includes(topic.code)}
                          disabled={disabled}
                          onChange={() => toggleCode(topic.code)}
                        />
                        <span className="mono-note">{topic.code}</span>
                        <span>{topic.title}</span>
                        {topic.themes.length ? (
                          <span className="muted">· {topic.themes.join(", ")}</span>
                        ) : null}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {visibleTopics.length === 0 ? (
                <p className="muted">No topic matches “{filter}”.</p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor="generate-max-cards">
          Cards per topic
        </label>
        <input
          id="generate-max-cards"
          className="input input--compact"
          type="number"
          min={1}
          max={50}
          placeholder="Use the setting"
          value={draft.maxCardsPerTopic}
          disabled={disabled}
          onChange={(event) => api.setDraft({ maxCardsPerTopic: event.target.value })}
        />
        <p className="muted">
          Leave blank to use Generation → cards per topic from Settings.
        </p>
      </div>
    </>
  );
}
