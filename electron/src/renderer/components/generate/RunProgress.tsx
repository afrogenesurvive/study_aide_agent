import { useEffect, useState } from "react";

import { Icon } from "../../icons";
import { formatDuration } from "../../hooks/useCountdown";
import type { GenerationProgress } from "../../../shared/generation-types";

/**
 * Step 2's live view.
 *
 * A run can take minutes and makes one model call per topic, so the honest thing
 * to show is which call is in flight and how many are left — a bar alone would
 * sit still for a long time and look broken. Elapsed time is counted here rather
 * than taken from the events, because the interesting number is "how long have I
 * been waiting", which includes the gaps between events.
 */
export function RunProgress({
  progress,
  running,
  startedAt,
  onCancel,
  busy,
}: {
  progress: GenerationProgress | null;
  running: boolean;
  /** When the current run began, or null when nothing is in flight. */
  startedAt: number | null;
  onCancel: () => void;
  busy: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!progress && !running) return null;

  const fraction = Math.min(1, Math.max(0, progress?.fraction ?? 0));
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;

  return (
    <div className="generate-progress">
      <div className="generate-progress__head">
        <span className="generate-progress__label">
          {progress?.label ?? "Starting…"}
        </span>
        <span className="muted">
          {progress && progress.totalSteps > 0
            ? `${Math.min(progress.step, progress.totalSteps)} / ${progress.totalSteps} · `
            : ""}
          {formatDuration(elapsed)}
        </span>
      </div>

      <div className="bar">
        <div className="bar__fill" style={{ width: `${fraction * 100}%` }} />
      </div>

      {running ? (
        <div className="toolbar">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            <Icon name="stop" size={14} />
            {busy ? "Stopping…" : "Stop"}
          </button>
          <span className="muted">
            Stopping keeps everything already generated; nothing is saved until you approve it.
          </span>
        </div>
      ) : null}
    </div>
  );
}
