import { useCallback, useEffect, useState } from "react";

import { Icon } from "../../icons";
import { CHOICE_LABELS } from "../../../shared/quiz-types";
import type { QuizAnswer, QuizDetail, QuizSummary } from "../../../shared/quiz-types";

/**
 * The quiz sub-tab of the Review panel.
 *
 * Where the Due tab drills recall by producing an answer from memory, a quiz
 * tests recognition with distractors — a different grip on the same topic, which
 * is why it lives beside the card loop rather than in Generate. Quizzes arrive
 * from a generation run; this view only reads them and records attempts.
 */
export function QuizRunner({ onSaved }: { onSaved: (message: string) => void }) {
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [quizId, setQuizId] = useState<number | null>(null);
  const [detail, setDetail] = useState<QuizDetail | null>(null);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [finished, setFinished] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    const list = (await window.electronAPI?.listQuizzes()) ?? [];
    setQuizzes(list);
    setQuizId((current) => current ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadList().finally(() => setLoading(false));
  }, [loadList]);

  useEffect(() => {
    if (quizId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const loaded = (await window.electronAPI?.getQuiz(quizId)) ?? null;
      if (cancelled) return;
      setDetail(loaded);
      setIndex(0);
      setPicked(null);
      setAnswers([]);
      setFinished(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [quizId]);

  if (loading) return <p className="muted">Loading your quizzes…</p>;

  if (quizzes.length === 0) {
    return (
      <div className="empty-state">
        <Icon name="generate" size={26} />
        <h3>No quizzes yet</h3>
        <p className="muted">
          Quizzes come from a generation run. Open the Generate section, pick a scope, and save the
          questions you want to keep.
        </p>
      </div>
    );
  }

  const questions = detail?.questions ?? [];
  const question = questions[index];
  const correctSoFar = answers.filter((answer) => answer.correct).length;
  const revealed = picked !== null;

  const answer = (choiceIndex: number) => {
    if (!question || revealed) return;
    setPicked(choiceIndex);
    setAnswers((current) => [
      ...current,
      {
        questionId: question.id,
        choiceIndex,
        correct: choiceIndex === question.answerIndex,
      },
    ]);
  };

  const next = async () => {
    if (!detail) return;
    const isLast = index + 1 >= questions.length;
    if (!isLast) {
      setIndex(index + 1);
      setPicked(null);
      return;
    }

    setBusy(true);
    try {
      const completed = answers;
      const result = await window.electronAPI?.recordQuizAttempt(detail.quiz.id, completed);
      if (result) {
        onSaved(`Quiz finished — ${result.correct} of ${result.total} correct.`);
      }
      setFinished(true);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setIndex(0);
    setPicked(null);
    setAnswers([]);
    setFinished(false);
  };

  return (
    <div className="quiz-runner">
      <div className="toolbar">
        <select
          className="input"
          value={quizId ?? ""}
          disabled={busy}
          onChange={(event) => setQuizId(Number(event.target.value))}
        >
          {quizzes.map((quiz) => (
            <option key={quiz.id} value={quiz.id}>
              {quiz.title} · {quiz.questionCount} question(s)
            </option>
          ))}
        </select>
        {questions.length && !finished ? (
          <span className="muted">
            Question {Math.min(index + 1, questions.length)} of {questions.length} · {correctSoFar}{" "}
            correct
          </span>
        ) : null}
      </div>

      {finished ? (
        <div className="review-card">
          <h3>
            {correctSoFar} / {questions.length} correct
          </h3>
          <p className="muted">
            {score(correctSoFar, questions.length)}
          </p>
          <div className="toolbar">
            <button type="button" className="btn btn--primary" onClick={restart}>
              <Icon name="refresh" size={14} />
              Try again
            </button>
          </div>
        </div>
      ) : question ? (
        <div className="review-card">
          <div className="review-card__meta">
            <span className="mono-note">
              {detail?.quiz.topic_id ? `topic #${detail.quiz.topic_id}` : detail?.quiz.title}
            </span>
            <div className="bar">
              <div
                className="bar__fill"
                style={{ width: `${questions.length ? (index / questions.length) * 100 : 0}%` }}
              />
            </div>
          </div>

          <p className="quiz-runner__question">{question.question}</p>

          <ol className="quiz-runner__choices">
            {question.choices.map((choice, choiceIndex) => {
              const isAnswer = choiceIndex === question.answerIndex;
              const isPicked = choiceIndex === picked;
              const className = !revealed
                ? "quiz-choice"
                : isAnswer
                  ? "quiz-choice quiz-choice--correct"
                  : isPicked
                    ? "quiz-choice quiz-choice--wrong"
                    : "quiz-choice";
              return (
                <li key={`${choice}-${choiceIndex}`}>
                  <button
                    type="button"
                    className={className}
                    disabled={revealed}
                    onClick={() => answer(choiceIndex)}
                  >
                    <span className="quiz-choice__label">{CHOICE_LABELS[choiceIndex] ?? "?"}</span>
                    {choice}
                  </button>
                </li>
              );
            })}
          </ol>

          {revealed ? (
            <>
              <p className={picked === question.answerIndex ? "notice notice--ok" : "notice notice--warn"}>
                {picked === question.answerIndex
                  ? "Correct."
                  : `Not quite — the answer is ${CHOICE_LABELS[question.answerIndex] ?? "?"}.`}
                {question.explanation ? ` ${question.explanation}` : ""}
              </p>
              <div className="toolbar">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => void next()}
                >
                  {index + 1 >= questions.length ? "Finish" : "Next question"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <p className="muted">This quiz has no questions. Generate it again, or pick another.</p>
      )}
    </div>
  );
}

function score(correct: number, total: number): string {
  if (total === 0) return "";
  const ratio = correct / total;
  if (ratio === 1) return "Every one right — that topic is ready for a longer interval.";
  if (ratio >= 0.7) return "Solid. The ones you missed are the ones worth another look.";
  return "Worth another pass before the next review session.";
}
