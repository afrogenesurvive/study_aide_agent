import { useEffect, useState } from "react";

import { Icon } from "../../icons";
import type { GenerationOutput } from "../../../shared/generation-types";

/**
 * Step 3: the review gate.
 *
 * This is the only place generated material can be edited before it reaches the
 * database, so it follows the syllabus importer's preview: what was produced,
 * grouped, with the ability to fix or drop an individual item. Nothing here is
 * saved until the user says so — a rejected run leaves the cards in the job row
 * as a record and writes nothing to `flashcards`.
 */

const PREVIEW_LIMIT = 200;

interface Draft {
  cards: GenerationOutput["cards"];
  questions: GenerationOutput["questions"];
}

export function CandidatePreview({
  output,
  committed,
  busy,
  onCommit,
  onDiscard,
  onReject,
}: {
  output: GenerationOutput;
  /** True once the run has been saved; the gate is closed. */
  committed: boolean;
  busy: boolean;
  onCommit: (edited: GenerationOutput) => void;
  onDiscard: () => void;
  onReject: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({ cards: output.cards, questions: output.questions });

  // Re-seed when a different job is opened: the parent keys this component by job
  // id, but a re-run of the same id (after an edit) must not resurrect old edits.
  useEffect(() => {
    setDraft({ cards: output.cards, questions: output.questions });
  }, [output]);

  const cards = draft.cards.slice(0, PREVIEW_LIMIT);
  const questions = draft.questions.slice(0, PREVIEW_LIMIT);
  const edited =
    draft.cards.length !== output.cards.length || draft.questions.length !== output.questions.length;

  const removeCard = (index: number) =>
    setDraft((current) => ({ ...current, cards: current.cards.filter((_, i) => i !== index) }));

  const removeQuestion = (index: number) =>
    setDraft((current) => ({
      ...current,
      questions: current.questions.filter((_, i) => i !== index),
    }));

  const editCard = (index: number, patch: Partial<GenerationOutput["cards"][number]>) =>
    setDraft((current) => ({
      ...current,
      cards: current.cards.map((card, i) => (i === index ? { ...card, ...patch } : card)),
    }));

  const editQuestion = (
    index: number,
    patch: Partial<GenerationOutput["questions"][number]>,
  ) =>
    setDraft((current) => ({
      ...current,
      questions: current.questions.map((question, i) =>
        i === index ? { ...question, ...patch } : question,
      ),
    }));

  const editChoice = (index: number, choiceIndex: number, value: string) => {
    const question = draft.questions[index];
    if (!question) return;
    const choices = question.choices.map((choice, i) => (i === choiceIndex ? value : choice));
    editQuestion(index, { choices });
  };

  return (
    <div className="diff-preview">
      <div className="diff-summary">
        <span className="badge badge--ok">{draft.cards.length} cards</span>
        <span className="badge badge--warn">{draft.questions.length} questions</span>
        <span className="badge badge--muted">{output.warnings.length} warnings</span>
        {edited ? <span className="badge badge--muted">edited</span> : null}
      </div>

      {output.warnings.length ? (
        <details className="notice notice--warn">
          <summary>{output.warnings.length} warning(s) from the run</summary>
          <ul className="error-list">
            {output.warnings.slice(0, 50).map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <details className="diff-group diff-group--added" open={draft.cards.length > 0}>
        <summary>
          Flashcards <span className="muted">({draft.cards.length})</span>
        </summary>
        <ul className="generate-list">
          {cards.map((card, index) => (
            <li key={`card-${index}`}>
              <div className="generate-item">
                <span className="mono-note">{card.topicCode ?? "no topic"}</span>
                <textarea
                  className="input input--code"
                  rows={2}
                  value={card.question}
                  disabled={busy || committed}
                  onChange={(event) => editCard(index, { question: event.target.value })}
                />
                <textarea
                  className="input input--code"
                  rows={2}
                  value={card.answer}
                  disabled={busy || committed}
                  onChange={(event) => editCard(index, { answer: event.target.value })}
                />
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busy || committed}
                  onClick={() => removeCard(index)}
                >
                  <Icon name="trash" size={13} />
                  Drop
                </button>
              </div>
            </li>
          ))}
          {draft.cards.length > PREVIEW_LIMIT ? (
            <li className="muted">…and {draft.cards.length - PREVIEW_LIMIT} more cards will also be saved.</li>
          ) : null}
          {draft.cards.length === 0 ? <li className="muted">No cards to save.</li> : null}
        </ul>
      </details>

      <details className="diff-group diff-group--changed" open={draft.questions.length > 0}>
        <summary>
          Quiz questions <span className="muted">({draft.questions.length})</span>
        </summary>
        <ul className="generate-list">
          {questions.map((question, index) => (
            <li key={`question-${index}`}>
              <div className="generate-item">
                <span className="mono-note">{question.topicCode ?? "no topic"}</span>
                <textarea
                  className="input input--code"
                  rows={2}
                  value={question.question}
                  disabled={busy || committed}
                  onChange={(event) => editQuestion(index, { question: event.target.value })}
                />
                <ol className="generate-choices">
                  {question.choices.map((choice, choiceIndex) => (
                    <li
                      key={`choice-${choiceIndex}`}
                      className={choiceIndex === question.answerIndex ? "generate-choice--correct" : undefined}
                    >
                      <input
                        type="radio"
                        name={`answer-${index}`}
                        checked={choiceIndex === question.answerIndex}
                        disabled={busy || committed}
                        onChange={() => editQuestion(index, { answerIndex: choiceIndex })}
                      />
                      <input
                        className="input input--cell"
                        value={choice}
                        disabled={busy || committed}
                        onChange={(event) => editChoice(index, choiceIndex, event.target.value)}
                      />
                    </li>
                  ))}
                </ol>
                {question.explanation ? (
                  <p className="muted">Why: {question.explanation}</p>
                ) : null}
                <div className="toolbar">
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy || committed}
                    onClick={() => {
                      const choices = [...question.choices, ""];
                      editQuestion(index, { choices, answerIndex: question.answerIndex });
                    }}
                  >
                    <Icon name="plus" size={13} />
                    Choice
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy || committed}
                    onClick={() => removeQuestion(index)}
                  >
                    <Icon name="trash" size={13} />
                    Drop
                  </button>
                </div>
              </div>
            </li>
          ))}
          {draft.questions.length > PREVIEW_LIMIT ? (
            <li className="muted">
              …and {draft.questions.length - PREVIEW_LIMIT} more questions will also be saved.
            </li>
          ) : null}
          {draft.questions.length === 0 ? <li className="muted">No questions to save.</li> : null}
        </ul>
      </details>

      {draft.cards.length === 0 && draft.questions.length === 0 ? (
        <div className="notice notice--warn">
          Everything was dropped — there is nothing left to save. Discard the run instead.
        </div>
      ) : null}

      <div className="toolbar">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || committed || (draft.cards.length === 0 && draft.questions.length === 0)}
          onClick={() => onCommit({ ...output, cards: draft.cards, questions: draft.questions })}
        >
          <Icon name="check" size={14} />
          {committed ? "Saved" : busy ? "Saving…" : "Save to database"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onReject}>
          <Icon name="close" size={14} />
          Reject
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onDiscard}>
          <Icon name="trash" size={14} />
          Discard run
        </button>
        <span className="muted">
          Reject keeps the run in History; discard removes it. Neither writes anything.
        </span>
      </div>
    </div>
  );
}
