import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "../../icons";
import type { CardState, DueCard } from "../../../shared/review-types";
import { CARD_STATE_LABELS } from "../../../shared/review-types";

/**
 * The card library.
 *
 * Read-mostly: filter, inspect, archive. Editing a card's text deliberately lives
 * in the syllabus Editor's orbit rather than here — a card that changes its
 * question after reviews have been logged makes that history meaningless.
 */

interface Props {
  onChanged: () => Promise<void>;
  onSaved: (message: string) => void;
}

function relativeDue(iso: string | null): string {
  if (!iso) return "—";
  const due = new Date(iso).getTime();
  const diffDays = Math.round((due - Date.now()) / 86_400_000);
  if (diffDays <= 0) return "due";
  if (diffDays === 1) return "tomorrow";
  if (diffDays < 31) return `in ${diffDays} d`;
  return `in ${Math.round(diffDays / 30)} mo`;
}

const STATE_BADGE: Record<CardState, string> = {
  new: "badge",
  learning: "badge badge--warn",
  relearning: "badge badge--warn",
  review: "badge badge--ok",
};

export function CardBrowser({ onChanged, onSaved }: Props) {
  const [cards, setCards] = useState<DueCard[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const next = await window.electronAPI?.listCards();
    setCards(next ?? []);
  }, []);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return cards;
    return cards.filter((card) =>
      [card.question, card.answer, card.topic_code ?? "", card.topic_title ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [cards, filter]);

  const archive = async (card: DueCard) => {
    const result = await window.electronAPI?.archiveCard(card.id, true);
    if (!result?.success) {
      onSaved("Could not archive that card.");
      return;
    }
    await Promise.all([load(), onChanged()]);
    onSaved("Card archived. Its review history is kept.");
  };

  if (loading) return <p className="muted">Loading cards…</p>;

  if (!cards.length) {
    return (
      <div className="empty-state">
        <h3>No cards yet</h3>
        <p>Add cards by hand from the Add tab. Generated material arrives in a later phase.</p>
      </div>
    );
  }

  return (
    <div className="card-browser">
      <div className="toolbar">
        <input
          className="input input--search"
          type="search"
          value={filter}
          placeholder="Filter by question, answer or topic…"
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Filter cards"
        />
        <span className="muted">
          {visible.length} of {cards.length}
        </span>
        <button type="button" className="btn btn--small" onClick={() => void load()}>
          <Icon name="refresh" size={14} />
          Refresh
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Question</th>
            <th>Topic</th>
            <th>State</th>
            <th className="table__number">Reps</th>
            <th>Next</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {visible.map((card) => (
            <tr key={card.id}>
              <td className="truncate card-browser__question" title={card.question}>
                {card.question}
              </td>
              <td>
                {card.topic_code ? (
                  <span className="badge" title={card.topic_title ?? undefined}>
                    {card.topic_code}
                  </span>
                ) : (
                  <span className="badge badge--muted">—</span>
                )}
              </td>
              <td>
                <span className={STATE_BADGE[card.state]}>{CARD_STATE_LABELS[card.state]}</span>
              </td>
              <td className="table__number">{card.reps}</td>
              <td className={card.overdue_days > 0 ? "card-browser__late" : undefined}>
                {relativeDue(card.next_review)}
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => void archive(card)}
                  title="Archive — keeps the review history"
                >
                  <Icon name="trash" size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
