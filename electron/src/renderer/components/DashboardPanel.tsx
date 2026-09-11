import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "../icons";
import type { PanelId } from "./Sidebar";
import type { CoverageReport, SyllabusSummary } from "../../shared/syllabus-types";
import type { PlanSnapshot, TodaySummary } from "../../shared/scheduler-types";

/**
 * The Dashboard: what to do today, and whether you are on track.
 *
 * Everything here is derived — the plan comes from the scheduler, the counts from
 * the review queue, and the coverage from the syllabus. The one rule the panel
 * enforces is that with no syllabus imported there is nothing to show, so it
 * sends the user to the Syllabus section instead of displaying empty statistics.
 */

interface Props {
  onOpenPanel: (panel: PanelId) => void;
  onSaved: (message: string) => void;
}

const BLOCK_ICONS = {
  intention: "check",
  subject: "review",
  break: "session",
  synthesis: "analytics",
} as const;

function percent(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value)}%`;
}

export function DashboardPanel({ onOpenPanel, onSaved }: Props) {
  const [plan, setPlan] = useState<PlanSnapshot | null>(null);
  const [today, setToday] = useState<TodaySummary | null>(null);
  const [syllabi, setSyllabi] = useState<SyllabusSummary[]>([]);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [nextPlan, nextToday, nextSyllabi] = await Promise.all([
      window.electronAPI?.getPlan(),
      window.electronAPI?.getToday(),
      window.electronAPI?.listSyllabi(),
    ]);
    setPlan(nextPlan ?? null);
    setToday(nextToday ?? null);
    setSyllabi(nextSyllabi ?? []);

    const active = nextSyllabi?.find((row) => row.is_active) ?? nextSyllabi?.[0];
    setCoverage(active ? ((await window.electronAPI?.getCoverage(active.id)) ?? null) : null);
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const regenerate = async () => {
    const next = await window.electronAPI?.regeneratePlan();
    setPlan(next ?? null);
    onSaved("Rebuilt today's plan.");
  };

  /** Soonest exam date across the imported syllabi. */
  const daysToExam = useMemo(() => {
    const dates = syllabi
      .map((row) => row.exam_date)
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value).getTime())
      .filter((value) => Number.isFinite(value));
    if (!dates.length) return null;
    return Math.max(0, Math.ceil((Math.min(...dates) - Date.now()) / 86_400_000));
  }, [syllabi]);

  /** Percentage of syllabus topics that have been introduced at least. */
  const coveragePct = useMemo(() => {
    if (!coverage) return undefined;
    return coverage.introducedPct;
  }, [coverage]);

  if (loading) return <p className="muted">Loading your day…</p>;

  if (!syllabi.length) {
    return (
      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">
            <Icon name="dashboard" />
            Dashboard
          </h2>
        </header>
        <div className="panel__body">
          <div className="empty-state">
            <h3>Start with a syllabus</h3>
            <p>
              Everything on this screen is derived from your syllabus: the day's plan, the review
              queue, coverage, and the exam countdown.
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => onOpenPanel("syllabus")}
            >
              <Icon name="syllabus" size={14} />
              Import a syllabus
            </button>
          </div>
        </div>
      </section>
    );
  }

  const blocks = plan?.plan.blocks ?? [];
  const subjectBlocks = blocks.filter((block) => block.kind === "subject");

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name="dashboard" />
          Dashboard
        </h2>
        <div className="panel__actions">
          <span className="muted">{today?.dateKey ?? plan?.plan.date}</span>
          <button type="button" className="btn btn--small" onClick={() => void regenerate()}>
            <Icon name="refresh" size={14} />
            Rebuild plan
          </button>
        </div>
      </header>

      <div className="panel__body">
        <div className="stat-grid">
          <div className="stat">
            <span className="stat__value">{today?.due.queueSize ?? 0}</span>
            <span className="stat__label">Cards to review</span>
          </div>
          <div className="stat">
            <span className="stat__value">{today?.due.newRemaining ?? 0}</span>
            <span className="stat__label">New left today</span>
          </div>
          <div className="stat">
            <span className="stat__value">{today?.streak.current ?? 0}</span>
            <span className="stat__label">
              Day streak{today?.streak.activeToday ? "" : " (today not logged)"}
            </span>
          </div>
          <div className="stat">
            <span className="stat__value">{percent(coveragePct)}</span>
            <span className="stat__label">Syllabus introduced</span>
          </div>
          {daysToExam !== null ? (
            <div className="stat">
              <span className="stat__value">{daysToExam}</span>
              <span className="stat__label">Days to exam</span>
            </div>
          ) : null}
        </div>

        <div className="toolbar dashboard__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onOpenPanel("session")}
          >
            <Icon name="play" size={14} />
            Start session
          </button>
          <button type="button" className="btn" onClick={() => onOpenPanel("review")}>
            <Icon name="review" size={14} />
            Review cards
          </button>
          <button type="button" className="btn" onClick={() => onOpenPanel("syllabus")}>
            <Icon name="syllabus" size={14} />
            Syllabus
          </button>
        </div>

        <div className="dashboard__columns">
          <div className="fieldset dashboard__plan">
            <legend>Today's plan</legend>

            {plan?.plan.theme ? (
              <p className="dashboard__theme">
                <span className="badge badge--ok">{plan.plan.theme}</span>
              </p>
            ) : null}
            <p className="muted">{plan?.plan.rationale}</p>

            {blocks.length ? (
              <ul className="dashboard__blocks">
                {blocks.map((block) => (
                  <li key={block.index} className={`dashboard__block dashboard__block--${block.kind}`}>
                    <span className="dashboard__block-time">{block.startsAt}</span>
                    <Icon name={BLOCK_ICONS[block.kind]} size={14} />
                    <span className="dashboard__block-label truncate">{block.label}</span>
                    <span className="muted">{block.minutes}m</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No blocks planned yet.</p>
            )}

            {subjectBlocks.length ? (
              <p className="field__hint">
                {subjectBlocks.length} study block(s) · {plan?.plan.minutes} minutes total
              </p>
            ) : null}
          </div>

          <div className="dashboard__side">
            <div className="fieldset">
              <legend>By subject</legend>
              {today?.due.bySubject.length ? (
                <ul className="dashboard__subjects">
                  {today.due.bySubject.map((entry) => (
                    <li key={entry.subject}>
                      <span>{entry.subject}</span>
                      <span className="muted">
                        {entry.total} due ({entry.new} new)
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Nothing due right now.</p>
              )}
            </div>

            <div className="fieldset">
              <legend>Needs attention</legend>
              {today?.struggling.length ? (
                <ul className="dashboard__attention">
                  {today.struggling.map((topic) => (
                    <li key={topic.topicId}>
                      <span className="valence valence--red" aria-hidden="true" />
                      <span className="truncate">{topic.title}</span>
                      <span className="badge badge--muted">{topic.code}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  No topics flagged as struggling. Use the red valence tag when something will not stick.
                </p>
              )}
            </div>

            <div className="fieldset">
              <legend>Today</legend>
              <p className="muted">
                {today?.cardsReviewedToday ?? 0} card(s) reviewed · {today?.minutesToday ?? 0} minute(s)
                studied
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
