import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "../../icons";
import { useUiStateValue } from "../../hooks/useUiState";
import { formatDuration, useCountdown } from "../../hooks/useCountdown";
import type { PlanSnapshot } from "../../../shared/scheduler-types";
import { SUBJECT_LABELS } from "../../../shared/syllabus-types";
import { stateFor, stagesFromPlan, useMaxReachedStage } from "./sessionStages";

/**
 * The timed interleaved session.
 *
 * Blocks come from the day's plan (intention → subject, break, subject … →
 * synthesis). The panel owns three pieces of state that must survive a restart —
 * the session id, when it started, and the notes — so an interrupted session can
 * be picked up rather than orphaned, which is why they live in `ui-state.json`
 * rather than in React state.
 */
export function SessionPanel({ onSaved }: { onSaved: (message: string) => void }) {
  const [snapshot, setSnapshot] = useState<PlanSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeIndex, setActiveIndex] = useUiStateValue<number>("session.activeIndex", 0);
  const [notes, setNotes] = useUiStateValue<string>("session.notes", "");
  const [sessionId, setSessionId] = useUiStateValue<number | null>("session.sessionId", null);
  const [startedAt, setStartedAt] = useUiStateValue<number | null>("session.startedAt", null);

  const refresh = useCallback(async () => {
    const next = await window.electronAPI?.getPlan();
    setSnapshot(next ?? null);
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const stages = useMemo(() => stagesFromPlan(snapshot?.plan ?? null), [snapshot]);
  const blocks = snapshot?.plan.blocks ?? [];

  // A stale index (a shorter plan was rebuilt) must not blank the panel.
  const safeIndex = blocks.length ? Math.min(activeIndex, blocks.length - 1) : 0;
  const activeBlock = blocks[safeIndex];
  const maxReached = useMaxReachedStage(safeIndex, snapshot?.plan.date ?? null);

  const advance = useCallback(
    (delta: number) => {
      const next = Math.min(Math.max(0, safeIndex + delta), Math.max(0, blocks.length - 1));
      setActiveIndex(next);
    },
    [blocks.length, safeIndex, setActiveIndex],
  );

  const onFinish = useCallback(() => {
    // Deliberately silent: the toast would fire while the user is reading the
    // block. The block simply shows as complete.
  }, []);

  const countdown = useCountdown(Math.max(1, (activeBlock?.minutes ?? 20) * 60_000), {
    autoStart: sessionId !== null,
    onFinish,
  });

  const start = async () => {
    const result = await window.electronAPI?.startSession(snapshot?.plan.theme ?? null);
    if (!result?.success || !result.sessionId) {
      onSaved(result?.error ?? "Could not start the session.");
      return;
    }
    setSessionId(result.sessionId);
    setStartedAt(Date.now());
    onSaved("Session started.");
  };

  const finish = async () => {
    if (!sessionId || !snapshot) return;

    // Report real elapsed time when the user pressed start; otherwise fall back to
    // the planned minutes of the blocks they worked through.
    const planned = blocks
      .slice(0, safeIndex + 1)
      .reduce((total, block) => total + block.minutes, 0);
    const elapsedMinutes = startedAt
      ? Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
      : planned;

    const covered = blocks.slice(0, safeIndex + 1);
    const summary = await window.electronAPI?.completeSession({
      sessionId,
      durationMinutes: elapsedMinutes,
      topicCodes: covered.flatMap((block) => block.topicCodes),
      themes: snapshot.plan.theme ? [snapshot.plan.theme] : [],
      notes,
    });

    setSessionId(null);
    setStartedAt(null);
    setActiveIndex(0);
    await refresh();

    if (!summary) {
      onSaved("Could not complete the session.");
      return;
    }
    onSaved(
      `Session logged: ${summary.durationMinutes} min · ${summary.cardsReviewed} card(s) · ` +
        `${summary.topicsAdvanced} topic(s) advanced · ${summary.streak}-day streak.`,
    );
  };

  const rebuild = async () => {
    const next = await window.electronAPI?.regeneratePlan();
    setSnapshot(next ?? null);
    setActiveIndex(0);
    onSaved("Rebuilt today's plan.");
  };

  if (loading) return <p className="muted">Loading your plan…</p>;

  if (!snapshot) {
    return (
      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">
            <Icon name="session" />
            Session
          </h2>
        </header>
        <div className="panel__body">
          <p className="muted">No plan could be loaded. Import a syllabus first.</p>
        </div>
      </section>
    );
  }

  const running = sessionId !== null;

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name="session" />
          Session
        </h2>
        <div className="panel__actions">
          <span className="muted">
            {snapshot.plan.date} · {snapshot.plan.minutes} min
          </span>
          <button type="button" className="btn btn--small" onClick={() => void rebuild()}>
            <Icon name="refresh" size={14} />
            Rebuild
          </button>
        </div>
      </header>

      <div className="panel__body">
        {snapshot.plan.theme ? (
          <div className="notice">
            <strong>{snapshot.plan.theme}</strong>
            <p className="muted">{snapshot.plan.rationale}</p>
          </div>
        ) : (
          <p className="muted">{snapshot.plan.rationale}</p>
        )}

        <ol className="session-stepper" aria-label="Session blocks">
          {stages.map((stage) => {
            const state = stateFor(stage.index, safeIndex, maxReached);
            return (
              <li key={stage.key} className={`session-step session-step--${state}`}>
                <button
                  type="button"
                  className={`session-step__button session-step__button--${state}`}
                  onClick={() => setActiveIndex(stage.index)}
                  aria-current={state === "active" ? "step" : undefined}
                >
                  <span className="session-step__time">{stage.startsAt}</span>
                  <Icon name={stage.icon} size={14} />
                  <span className="session-step__label truncate">{stage.label}</span>
                  <span className="session-step__minutes">{stage.minutes}m</span>
                </button>
              </li>
            );
          })}
        </ol>

        {activeBlock ? (
          <div className="session-block">
            <div className="session-block__head">
              <div>
                <h3 className="session-block__title">{activeBlock.label}</h3>
                <p className="muted">
                  {activeBlock.startsAt} · {activeBlock.minutes} minutes
                  {activeBlock.subject ? ` · ${SUBJECT_LABELS[activeBlock.subject]}` : ""}
                </p>
              </div>
              <div className="session-clock">
                <span className={`session-clock__value${countdown.finished ? " session-clock__value--done" : ""}`}>
                  {formatDuration(countdown.remainingMs)}
                </span>
                <div className="bar">
                  <div className="bar__fill" style={{ width: `${countdown.progress * 100}%` }} />
                </div>
              </div>
            </div>

            {activeBlock.topicCodes.length ? (
              <div className="chip-row">
                {activeBlock.topicCodes.map((code) => (
                  <span key={code} className="chip">
                    {code}
                  </span>
                ))}
              </div>
            ) : null}

            {activeBlock.overlays.length ? (
              <div className="fieldset session-overlays">
                <legend>Overlay connections</legend>
                {activeBlock.overlays.map((overlay) => (
                  <div key={overlay.subject} className="session-overlay">
                    <span className="badge">{SUBJECT_LABELS[overlay.subject]}</span>
                    <span>{overlay.concept}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {activeBlock.dueCounts.total ? (
              <p className="muted">
                {activeBlock.dueCounts.total} card(s) due for this subject ·{" "}
                {activeBlock.dueCounts.new} new
              </p>
            ) : null}

            <div className="toolbar">
              {running ? (
                <>
                  <button type="button" className="btn btn--small" onClick={countdown.togglePause}>
                    <Icon name={countdown.paused ? "play" : "session"} size={14} />
                    {countdown.paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => countdown.adjust(5 * 60_000)}
                  >
                    <Icon name="plus" size={14} />
                    5 min
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn--primary btn--small" onClick={() => void start()}>
                  <Icon name="play" size={14} />
                  Start session
                </button>
              )}

              <button
                type="button"
                className="btn btn--small"
                onClick={() => advance(-1)}
                disabled={safeIndex === 0}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => advance(1)}
                disabled={safeIndex >= blocks.length - 1}
              >
                {activeBlock.kind === "break" ? "Skip break" : "Next block"}
              </button>
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={() => void finish()}
                disabled={!running}
              >
                <Icon name="check" size={14} />
                Finish session
              </button>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="session-notes">
                Notes
              </label>
              <textarea
                id="session-notes"
                className="input session-notes"
                rows={3}
                value={notes}
                placeholder="What clicked? What still feels shaky?"
                onChange={(event) => setNotes(event.target.value)}
              />
              <p className="field__hint">Kept as you type, and saved with the session when you finish.</p>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <h3>Nothing planned</h3>
            <p>Import a syllabus in the Syllabus section, then rebuild the plan.</p>
          </div>
        )}
      </div>
    </section>
  );
}
