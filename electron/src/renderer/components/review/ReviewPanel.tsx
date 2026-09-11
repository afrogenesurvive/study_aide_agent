import { useCallback, useEffect, useState } from "react";

import { Icon } from "../../icons";
import { useUiStateValue } from "../../hooks/useUiState";
import type { DueCard, DueSummary, ReviewStats } from "../../../shared/review-types";
import { AddCardForm } from "./AddCardForm";
import { CardBrowser } from "./CardBrowser";
import { ReviewSession } from "./ReviewSession";

type SubTab = "due" | "cards" | "add";

const SUB_TABS: Array<{ id: SubTab; label: string }> = [
  { id: "due", label: "Due" },
  { id: "cards", label: "Cards" },
  { id: "add", label: "Add" },
];

/**
 * The Review section: the spaced-repetition loop.
 *
 * The queue is owned here rather than inside the session view so that grading a
 * card, archiving one from the library, or adding a new one all refresh the same
 * source of truth — which matters because the daily new-card cap means adding a
 * card can change what is due.
 */
export function ReviewPanel({ onSaved }: { onSaved: (message: string) => void }) {
  const [subTab, setSubTab] = useUiStateValue<SubTab>("review.subTab", "due");
  const [summary, setSummary] = useState<DueSummary | null>(null);
  const [queue, setQueue] = useState<DueCard[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [nextSummary, nextQueue, nextStats] = await Promise.all([
      window.electronAPI?.getReviewSummary(),
      window.electronAPI?.getReviewQueue(),
      window.electronAPI?.getReviewStats(),
    ]);
    setSummary(nextSummary ?? null);
    setQueue(nextQueue ?? []);
    setStats(nextStats ?? null);
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const dueToday = (summary?.counts.due ?? 0) + (summary?.counts.learning ?? 0);

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name="review" />
          Review
        </h2>
        <div className="panel__actions">
          <span className="muted">
            {dueToday} due · {summary?.newRemaining ?? 0} new left today
            {stats ? ` · ${stats.reviewedToday} reviewed` : ""}
          </span>
          <button type="button" className="btn btn--small" onClick={() => void refresh()}>
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        </div>
      </header>

      <div className="tab-row tab-row--panel" role="tablist">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={subTab === tab.id}
            className={`tab${subTab === tab.id ? " tab--active" : ""}`}
            onClick={() => setSubTab(tab.id)}
          >
            {tab.label}
            {tab.id === "due" && queue.length ? (
              <span className="tab__count">{queue.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="muted">Loading your cards…</p>
      ) : (
        <div className="panel__body">
          {subTab === "due" ? (
            <ReviewSession queue={queue} onChanged={refresh} onSaved={onSaved} />
          ) : null}
          {subTab === "cards" ? (
            <CardBrowser onChanged={refresh} onSaved={onSaved} />
          ) : null}
          {subTab === "add" ? <AddCardForm onChanged={refresh} onSaved={onSaved} /> : null}
        </div>
      )}
    </section>
  );
}
