import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "../../icons";
import { Tooltip } from "../Tooltip";
import type { DueCard, Rating, RatingPreview, Valence } from "../../../shared/review-types";
import { RATING_DESCRIPTIONS, RATING_KEYS, RATING_LABELS } from "../../../shared/review-types";
import { VALENCES, VALENCE_LABELS } from "../../../shared/syllabus-types";

/**
 * The card review loop.
 *
 * Two details do most of the work here:
 *
 *  - Every rating button shows the interval it would schedule *before* the user
 *    commits, fetched from the same FSRS code that will apply it. Seeing "Good →
 *    6d" next to "Easy → 21d" is what makes the four buttons a real decision
 *    rather than a guess.
 *  - Grading is undoable. `card_reviews` stores the exact ts-fsrs log, so undo
 *    restores the previous schedule rather than approximating it.
 */

const RATING_ORDER: Rating[] = ["again", "hard", "good", "easy"];

interface Props {
  queue: DueCard[];
  onChanged: () => Promise<void>;
  onSaved: (message: string) => void;
}

export function ReviewSession({ queue, onChanged, onSaved }: Props) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [previews, setPreviews] = useState<RatingPreview[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [shownAt, setShownAt] = useState(() => Date.now());

  const card = queue[index] ?? null;

  // A shorter queue after grading must not leave the index dangling.
  useEffect(() => {
    if (index > 0 && index >= queue.length) setIndex(Math.max(0, queue.length - 1));
  }, [index, queue.length]);

  useEffect(() => {
    setRevealed(false);
    setShownAt(Date.now());
    if (!card) {
      setPreviews(null);
      return;
    }
    let cancelled = false;
    void window.electronAPI?.previewCard(card.id).then((next) => {
      if (!cancelled) setPreviews(next ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [card?.id]);

  const previewFor = useMemo(
    () => (rating: Rating) => previews?.find((preview) => preview.rating === rating) ?? null,
    [previews],
  );

  const grade = useCallback(
    async (rating: Rating) => {
      if (!card || busy) return;
      setBusy(true);
      const result = await window.electronAPI?.rateCard({
        cardId: card.id,
        rating,
        durationMs: Date.now() - shownAt,
      });
      setBusy(false);

      if (!result?.success) {
        onSaved(result?.error ?? "Could not record that answer.");
        return;
      }
      setIndex((current) => Math.min(current, Math.max(0, queue.length - 2)));
      await onChanged();
    },
    [busy, card, onChanged, onSaved, queue.length, shownAt],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      if (event.code === "Space" || event.key === "Enter") {
        event.preventDefault();
        setRevealed(true);
        return;
      }
      if (event.key === "u" || event.key === "U") {
        event.preventDefault();
        void undo();
        return;
      }
      const slot = RATING_ORDER.findIndex((rating) => RATING_KEYS[rating] === event.key);
      if (slot >= 0 && revealed) {
        event.preventDefault();
        void grade(RATING_ORDER[slot]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grade, revealed, card?.id]);

  const undo = async () => {
    if (!card) return;
    const result = await window.electronAPI?.undoReview(card.id);
    if (!result?.success) {
      onSaved(result?.error ?? "Nothing to undo.");
      return;
    }
    setIndex((current) => Math.max(0, current - 1));
    await onChanged();
    onSaved("Undid the last answer.");
  };

  const setValence = async (valence: Valence) => {
    if (!card) return;
    const next = card.valence === valence ? null : valence;
    await window.electronAPI?.setCardValence(card.id, next);
    await onChanged();
  };

  if (!card) {
    return (
      <div className="empty-state">
        <h3>Nothing due</h3>
        <p>
          Every card is scheduled for later. New cards appear as the daily allowance refreshes, or add
          your own from the Cards tab.
        </p>
      </div>
    );
  }

  return (
    <div className="review-session">
      <div className="review-session__head">
        <span className="muted">
          Card {index + 1} of {queue.length}
        </span>
        <div className="bar review-session__progress">
          <div
            className="bar__fill"
            style={{ width: `${((index + (revealed ? 0.5 : 0)) / queue.length) * 100}%` }}
          />
        </div>
        <Tooltip label="Undo the last answer (U)">
          <button type="button" className="btn btn--small" onClick={() => void undo()}>
            <Icon name="refresh" size={14} />
            Undo
          </button>
        </Tooltip>
      </div>

      <div className="review-card">
        <div className="review-card__meta">
          {card.topic_code ? (
            <span className="badge">{card.topic_code}</span>
          ) : (
            <span className="badge badge--muted">No topic</span>
          )}
          <span className="badge badge--muted">{card.state}</span>
          {card.overdue_days > 0 ? (
            <span className="badge badge--warn">{card.overdue_days} d overdue</span>
          ) : null}
        </div>

        <p className="review-card__question">{card.question}</p>

        {revealed ? (
          <p className="review-card__answer">{card.answer}</p>
        ) : (
          <button type="button" className="btn btn--primary" onClick={() => setRevealed(true)}>
            Show answer
            <span className="muted"> (space)</span>
          </button>
        )}
      </div>

      <div className="valence-row review-card__valence">
        {VALENCES.map((valence) => (
          <button
            key={valence}
            type="button"
            className={`valence valence--${valence}${card.valence === valence ? " valence--active" : ""}`}
            onClick={() => void setValence(valence)}
            title={VALENCE_LABELS[valence]}
          >
            {VALENCE_LABELS[valence]}
          </button>
        ))}
      </div>

      <div className="review-ratings">
        {RATING_ORDER.map((rating) => {
          const preview = previewFor(rating);
          return (
            <button
              key={rating}
              type="button"
              className={`review-rating review-rating--${rating}`}
              disabled={!revealed || busy}
              onClick={() => void grade(rating)}
              title={RATING_DESCRIPTIONS[rating]}
            >
              <span className="review-rating__label">{RATING_LABELS[rating]}</span>
              <span className="review-rating__interval">{preview?.intervalLabel ?? "—"}</span>
              <span className="review-rating__key">{RATING_KEYS[rating]}</span>
            </button>
          );
        })}
      </div>

      {!revealed ? (
        <p className="muted review-session__hint">
          Answer out loud before revealing — the rating only means something if you tested yourself.
        </p>
      ) : null}
    </div>
  );
}
