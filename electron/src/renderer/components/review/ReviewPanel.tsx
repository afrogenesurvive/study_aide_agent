import { useCallback, useEffect, useState } from "react";

import { Icon } from "../../icons";
import { useUiStateValue } from "../../hooks/useUiState";
import type { DueCard, DueSummary, ReviewStats } from "../../../shared/review-types";
import { AddCardForm } from "./AddCardForm";
import { CardBrowser } from "./CardBrowser";
import { QuizRunner } from "./QuizRunner";
import { ReviewSession } from "./ReviewSession";

type SubTab = "due" | "cards" | "quiz" | "add";

const SUB_TABS: Array<{ id: SubTab; label: string }> = [
  { id: "due", label: "Due" },
  { id: "cards", label: "Cards" },
  { id: "quiz", label: "Quiz" },
  { id: "add", label: "Add" },
];

/**
 * The persisted sub-tab is whatever `ui-state.json` happens to hold, which may
 * predate this tab or have been edited by hand, and `useUiStateValue` casts
 * without checking. An unrecognised value leaves every branch false and renders
 * an empty panel, so it is narrowed here.
 */
function isSubTab(value: unknown): value is SubTab {
  return SUB_TABS.some((tab) => tab.id === value);
}

/**
 * The Review section: the spaced-repetition loop.
 *
 * The queue is owned here rather than inside the session view so that grading a
 * card, archiving one from the library, or adding a new one all refresh the same
 * source of truth — which matters because the daily new-card cap means adding a
 * card can change what is due.
 */
export function ReviewPanel({ onSaved }: { onSaved: (message: string) => void }) {
  const [storedSubTab, setSubTab] = useUiStateValue<SubTab>("review.subTab", "due");
  const subTab: SubTab = isSubTab(storedSubTab) ? storedSubTab : "due";
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

      {/*
        The quiz view is deliberately outside the `loading` gate: it loads its own
        quizzes and needs neither the due queue nor the card summary, so making it
        wait for a card fetch would be a lie about what it is waiting for.
      */}
      <div className="panel__body">
        {subTab === "quiz" ? (
          <QuizRunner onSaved={onSaved} />
        ) : loading ? (
          <p className="muted">Loading your cards…</p>
        ) : (
          <>
            {subTab === "due" ? (
              <ReviewSession queue={queue} onChanged={refresh} onSaved={onSaved} />
            ) : null}
            {subTab === "cards" ? (
              <CardBrowser onChanged={refresh} onSaved={onSaved} />
            ) : null}
            {subTab === "add" ? <AddCardForm onChanged={refresh} onSaved={onSaved} /> : null}
          </>
        )}
      </div>
    </section>
  );
}
