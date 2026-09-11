import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A pausable countdown.
 *
 * The reference implementation only ever counted *up* (a recording clock), so
 * this is new. It works from a deadline rather than by decrementing a counter,
 * because a decrementing counter drifts: `setInterval` is not precise, and a
 * backgrounded window throttles timers hard. Deriving the remaining time from
 * `Date.now()` means the timer is still correct after the app has been idle.
 */

const TICK_MS = 250;

export interface Countdown {
  remainingMs: number;
  elapsedMs: number;
  /** 0 → 1 as the block runs down. */
  progress: number;
  paused: boolean;
  finished: boolean;
  togglePause: () => void;
  restart: (durationMs?: number) => void;
  /** Add or remove time, e.g. "I need five more minutes". */
  adjust: (deltaMs: number) => void;
}

export function useCountdown(
  durationMs: number,
  options: { autoStart?: boolean; onFinish?: () => void } = {},
): Countdown {
  const { autoStart = true, onFinish } = options;

  const [remainingMs, setRemainingMs] = useState(durationMs);
  const [paused, setPaused] = useState(!autoStart);
  const deadlineRef = useRef<number>(Date.now() + durationMs);
  const totalRef = useRef<number>(durationMs);
  const finishedRef = useRef(false);
  const onFinishRef = useRef(onFinish);

  onFinishRef.current = onFinish;
  totalRef.current = durationMs;

  const restart = useCallback((next?: number) => {
    const total = next ?? durationMs;
    totalRef.current = total;
    deadlineRef.current = Date.now() + total;
    finishedRef.current = false;
    setRemainingMs(total);
    setPaused(false);
  }, [durationMs]);

  const togglePause = useCallback(() => {
    setPaused((wasPaused) => {
      if (wasPaused) {
        deadlineRef.current = Date.now() + remainingMs;
        return false;
      }
      return true;
    });
  }, [remainingMs]);

  const adjust = useCallback((deltaMs: number) => {
    deadlineRef.current += deltaMs;
    finishedRef.current = false;
    setRemainingMs((current) => Math.max(0, current + deltaMs));
  }, []);

  // Restart whenever the block length changes (e.g. the user moves to the next
  // block, which may be a break rather than a subject block).
  useEffect(() => {
    restart(durationMs);
  }, [durationMs, restart]);

  useEffect(() => {
    const tick = () => {
      if (paused) return;
      const next = Math.max(0, deadlineRef.current - Date.now());
      setRemainingMs(next);
      if (next === 0 && !finishedRef.current) {
        finishedRef.current = true;
        onFinishRef.current?.();
      }
    };

    const handle = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(handle);
  }, [paused]);

  const elapsedMs = Math.max(0, totalRef.current - remainingMs);

  return {
    remainingMs,
    elapsedMs,
    progress: totalRef.current ? Math.min(1, elapsedMs / totalRef.current) : 0,
    paused,
    finished: remainingMs === 0,
    togglePause,
    restart,
    adjust,
  };
}

/** `mm:ss`, or `h:mm:ss` past an hour. Used for both clocks and durations. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
