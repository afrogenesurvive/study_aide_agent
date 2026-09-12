import { useState } from "react";

import { Icon } from "../../icons";
import { CandidatePreview } from "./CandidatePreview";
import { RunProgress } from "./RunProgress";
import { ScopePicker } from "./ScopePicker";
import { useGeneration } from "../../hooks/useGeneration";
import type { GenerationJobSummary, GenerationStatus } from "../../../shared/generation-types";

/**
 * The Generate section.
 *
 * Four numbered steps mirroring the syllabus importer, because generating
 * material is the same shape of task: choose an input, run something expensive,
 * look at what came back, then decide. The gate is deliberately not a modal —
 * the app has no modal primitive, and a step the user can scroll back out of is
 * easier to trust than one that traps them.
 */

const STATUS_LABELS: Record<GenerationStatus, string> = {
  pending: "Queued",
  running: "Running",
  awaiting_review: "Awaiting review",
  committed: "Saved",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Stopped",
};

const STATUS_BADGES: Record<GenerationStatus, string> = {
  pending: "badge--muted",
  running: "badge--warn",
  awaiting_review: "badge--warn",
  committed: "badge--ok",
  rejected: "badge--muted",
  failed: "badge--bad",
  cancelled: "badge--muted",
};

export function GeneratePanel({ onSaved }: { onSaved: (message: string) => void }) {
  const api = useGeneration();
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const status = api.status;
  const running = api.busy === "start" || (api.progress !== null && !api.progress.done);
  const committed = api.job?.summary.status === "committed";

  // Collected rather than short-circuited so the user sees everything that is
  // wrong at once instead of fixing one thing to discover the next.
  const blockers: string[] = [];
  if (status && !status.enabled) {
    blockers.push("Generation is switched off. Turn on “Agent runner” in Settings.");
  }
  if (status && !status.ready) {
    blockers.push(
      `The language model is not configured (${status.provider}). Set ${status.missing.join(", ")} in Settings.`,
    );
  }
  if (status && !status.configOk) {
    blockers.push(
      status.configErrors[0] ??
        "The agent pipeline config has no runnable material-generation pipeline.",
    );
  }
  if (api.draft.syllabusIds.length === 0) {
    blockers.push("Choose at least one syllabus.");
  }

  const start = async () => {
    setStartedAt(Date.now());
    api.dismissMessages();
    await api.start();
    setStartedAt(null);
  };

  const commit = async (output: Parameters<typeof api.commit>[0]) => {
    const saved = await api.commit(output);
    if (saved) {
      onSaved(
        `Saved ${output.cards.length} card(s) and ${output.questions.length} quiz question(s).`,
      );
    }
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name="generate" />
          Generate
        </h2>
        <div className="panel__actions">
          {status ? (
            <span className="muted">
              {status.provider}
              {status.model ? ` · ${status.model}` : ""}
              {status.awaitingReview > 0 ? ` · ${status.awaitingReview} awaiting review` : ""}
            </span>
          ) : null}
          <button type="button" className="btn btn--small" onClick={() => void api.refresh()}>
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        </div>
      </header>

      <div className="panel__body">
        <div className="generate-panel">
          {api.errors.length ? (
            <div className="notice notice--error">
              <strong>
                {api.errors.length === 1 ? "This run could not start" : "These problems blocked the run"}
              </strong>
              <ul className="error-list">
                {api.errors.map((error, index) => (
                  <li key={`${error}-${index}`}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {api.warnings.length ? (
            <details className="notice notice--warn">
              <summary>{api.warnings.length} warning(s)</summary>
              <ul className="error-list">
                {api.warnings.slice(0, 50).map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </details>
          ) : null}

          <section className="import-step">
            <h3 className="step-title">
              <span className="step-number">1</span> Scope
            </h3>
            <ScopePicker api={api} disabled={running} />
          </section>

          <section className="import-step">
            <h3 className="step-title">
              <span className="step-number">2</span> Run
            </h3>

            {blockers.length ? (
              <div className="notice notice--warn">
                <ul className="error-list">
                  {blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="toolbar">
              <button
                type="button"
                className="btn btn--primary"
                disabled={running || blockers.length > 0}
                onClick={() => void start()}
              >
                <Icon name="play" size={14} />
                {running ? "Generating…" : "Generate"}
              </button>
              <span className="muted">
                One model call per topic. Nothing is written to your flashcards until you approve it
                in step 3.
              </span>
            </div>

            <RunProgress
              progress={api.progress}
              running={running}
              startedAt={startedAt}
              busy={api.busy === "cancel"}
              onCancel={() => void api.cancel()}
            />
          </section>

          <section className="import-step">
            <h3 className="step-title">
              <span className="step-number">3</span> Review
            </h3>

            {api.job ? (
              <>
                <p className="muted">
                  Run #{api.job.summary.id} · {STATUS_LABELS[api.job.summary.status]}
                  {api.job.summary.topicCount
                    ? ` · ${api.job.summary.topicCount} topic(s)`
                    : ""}
                </p>
                {api.job.summary.error ? (
                  <div className="notice notice--error">{api.job.summary.error}</div>
                ) : null}
                <CandidatePreview
                  key={api.job.summary.id}
                  output={api.job.output}
                  committed={committed}
                  busy={api.busy !== null}
                  onCommit={(edited) => void commit(edited)}
                  onReject={() => void api.reject()}
                  onDiscard={() => void api.discard()}
                />
              </>
            ) : (
              <p className="muted">
                A finished run appears here for review. Nothing has been generated yet.
              </p>
            )}
          </section>

          <section className="import-step">
            <h3 className="step-title">
              <span className="step-number">4</span> History
            </h3>

            {api.history.length === 0 ? (
              <p className="muted">No runs yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>When</th>
                    <th>Status</th>
                    <th className="table__number">Cards</th>
                    <th className="table__number">Questions</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {api.history.map((job) => (
                    <tr
                      key={job.id}
                      className={api.job?.summary.id === job.id ? "row--busy" : undefined}
                    >
                      <td className="mono-note">#{job.id}</td>
                      <td className="muted">{when(job)}</td>
                      <td>
                        <span className={`badge ${STATUS_BADGES[job.status]}`}>
                          {STATUS_LABELS[job.status]}
                        </span>
                      </td>
                      <td className="table__number">{job.cardCount}</td>
                      <td className="table__number">{job.questionCount}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--small"
                          disabled={api.busy !== null}
                          onClick={() => void api.openJob(job.id)}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

function when(job: GenerationJobSummary): string {
  const parsed = Date.parse(job.createdAt);
  if (!Number.isFinite(parsed)) return job.createdAt;
  return new Date(parsed).toLocaleString();
}
