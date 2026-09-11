import { useEffect, useMemo, useState } from "react";

import { Icon } from "../../icons";
import type { CardInput, TopicCardCount, Valence } from "../../../shared/review-types";
import type { SyllabusDetail, SyllabusTopicRow } from "../../../shared/syllabus-types";
import { VALENCES, VALENCE_LABELS } from "../../../shared/syllabus-types";

/**
 * Manual card authoring.
 *
 * Phase 3 will generate cards from the syllabus with an LLM; until then this is
 * the only way to get material into the review loop, and it stays useful
 * afterwards for cards the generator would never think of.
 *
 * A card is always attached to a syllabus topic. That is what lets the scheduler
 * place it in a subject block and what makes coverage analytics count it.
 */

interface Props {
  onChanged: () => Promise<void>;
  onSaved: (message: string) => void;
}

export function AddCardForm({ onChanged, onSaved }: Props) {
  const [detail, setDetail] = useState<SyllabusDetail | null>(null);
  const [topicCounts, setTopicCounts] = useState<TopicCardCount[]>([]);
  const [topicId, setTopicId] = useState<string>("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [valence, setValence] = useState<Valence | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [syllabus, counts] = await Promise.all([
      window.electronAPI?.getActiveSyllabus(),
      window.electronAPI?.getTopicCardCounts(),
    ]);
    setDetail(syllabus ?? null);
    setTopicCounts(counts ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  const countsByTopic = useMemo(() => {
    const map = new Map<number, TopicCardCount>();
    for (const entry of topicCounts) map.set(entry.topicId, entry);
    return map;
  }, [topicCounts]);

  /** Topics grouped by section, the way the syllabus presents them. */
  const grouped = useMemo(() => {
    const groups = new Map<string, SyllabusTopicRow[]>();
    for (const topic of detail?.topics ?? []) {
      const key = topic.section ?? "Unsorted";
      const bucket = groups.get(key) ?? [];
      bucket.push(topic);
      groups.set(key, bucket);
    }
    return [...groups.entries()];
  }, [detail]);

  const dirty = question.trim().length > 0 && answer.trim().length > 0;

  const submit = async () => {
    if (!dirty || saving) return;
    setSaving(true);

    const input: CardInput = {
      question: question.trim(),
      answer: answer.trim(),
      topicId: topicId ? Number(topicId) : null,
      source: "manual",
      valence,
    };
    const result = await window.electronAPI?.createCard(input);
    setSaving(false);

    if (!result?.success) {
      onSaved(result?.error ?? "Could not save the card.");
      return;
    }

    // Keep the topic selected: cards tend to come in batches for one topic.
    setQuestion("");
    setAnswer("");
    setValence(null);
    await Promise.all([onChanged(), load()]);
    onSaved("Card added.");
  };

  if (!detail) {
    return (
      <div className="empty-state">
        <h3>No active syllabus</h3>
        <p>Cards are attached to syllabus topics, so import one first.</p>
      </div>
    );
  }

  return (
    <div className="add-card">
      <div className="field">
        <label className="field__label" htmlFor="card-topic">
          Topic
        </label>
        <select
          id="card-topic"
          className="input"
          value={topicId}
          onChange={(event) => setTopicId(event.target.value)}
        >
          <option value="">No topic</option>
          {grouped.map(([section, topics]) => (
            <optgroup key={section} label={section}>
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.code} · {topic.title}
                  {countsByTopic.get(topic.id)?.cardCount
                    ? ` (${countsByTopic.get(topic.id)?.cardCount} cards)`
                    : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="field__hint">
          {detail.syllabus.title || `${detail.syllabus.subject} · ${detail.syllabus.board}`} ·{" "}
          {detail.topics.length} topics
        </p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="card-question">
          Question
        </label>
        <textarea
          id="card-question"
          className="input"
          rows={3}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="What is the effect of increasing pressure on an equilibrium with fewer moles of gas on the right?"
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="card-answer">
          Answer
        </label>
        <textarea
          id="card-answer"
          className="input"
          rows={3}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
      </div>

      <div className="field">
        <span className="field__label">Valence</span>
        <div className="valence-row">
          {VALENCES.map((option) => (
            <button
              key={option}
              type="button"
              className={`valence valence--${option}${valence === option ? " valence--active" : ""}`}
              onClick={() => setValence(valence === option ? null : option)}
            >
              {VALENCE_LABELS[option]}
            </button>
          ))}
        </div>
        <p className="field__hint">Optional — red cards surface in the dashboard's attention list.</p>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void submit()}
          disabled={!dirty || saving}
        >
          <Icon name="plus" size={14} />
          {saving ? "Saving…" : "Add card"}
        </button>
      </div>
    </div>
  );
}
