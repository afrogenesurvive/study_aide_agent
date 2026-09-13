import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import type { GoogleActionResult, GoogleStatusPayload, GoogleTestResult } from "../../shared/google-types";

/**
 * The Google group's controls.
 *
 * `ConfigPanel` renders a list of fields and nothing else, so this is mounted
 * next to the Google fields rather than modelled as one — a group of labelled
 * text inputs has no natural place for a button that performs an action.
 *
 * Nothing here ever displays a credential. The status payload reports only
 * *whether* each secret is set, and the test result is a sentence per service.
 */
export function GoogleActions({ onSaved }: { onSaved: (message: string) => void }) {
  const [status, setStatus] = useState<GoogleStatusPayload | null>(null);
  const [probe, setProbe] = useState<GoogleTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus((await window.electronAPI?.getGoogleStatus()) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  /** Every action reports its own outcome, so no failure escapes as a rejection. */
  const run = async (label: string, action: () => Promise<GoogleActionResult | undefined>) => {
    setBusy(label);
    setError(null);
    try {
      const result = await action();
      if (result && !result.ok) setError(result.error ?? "That did not work.");
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(null);
      await refreshStatus();
    }
  };

  const onTest = () =>
    run("test", async () => {
      const result = await window.electronAPI?.testGoogle();
      if (!result) return undefined;
      // The probe result and an action result are distinguishable: only the
      // probe has a `gmail` key.
      if ("gmail" in result) {
        setProbe(result);
        onSaved(
          result.gmail.ok && result.calendar.ok
            ? "Google is reachable."
            : "Google answered, but something is not right — see the result below.",
        );
        return { ok: result.gmail.ok && result.calendar.ok };
      }
      return result;
    });

  const onConnect = () =>
    run("connect", async () => {
      onSaved("Opening your browser to authorize Google…");
      const result = await window.electronAPI?.connectGoogle();
      if (!result) return undefined;
      if (result.ok) {
        setProbe(null);
        onSaved(result.user ? `Connected as ${result.user}.` : "Google connected.");
      }
      return { ok: result.ok, error: result.error };
    });

  const onRefreshCalendars = () =>
    run("calendars", async () => {
      const result = await window.electronAPI?.refreshGoogleCalendars();
      if (result?.ok) onSaved(`Indexed ${result.count ?? 0} calendar(s).`);
      return result;
    });

  const connected = status?.configured ?? false;
  const spinner = busy ? ` (${busy}…)` : "";

  return (
    <div className="google-actions">
      <div className="google-actions__buttons">
        <button type="button" className="btn" onClick={onConnect} disabled={Boolean(busy) || status?.connecting}>
          <Icon name="refresh" size={14} />
          {status?.connecting ? "Waiting for Google…" : "Connect Google"}
        </button>
        {status?.connecting ? (
          <button
            type="button"
            className="btn"
            onClick={() => void run("cancel", async () => window.electronAPI?.cancelGoogleConnect())}
            disabled={Boolean(busy)}
          >
            <Icon name="close" size={14} />
            Cancel
          </button>
        ) : null}
        <button type="button" className="btn" onClick={onTest} disabled={Boolean(busy) || !connected}>
          <Icon name="check" size={14} />
          Test connection
        </button>
        <button type="button" className="btn" onClick={onRefreshCalendars} disabled={Boolean(busy) || !connected}>
          <Icon name="refresh" size={14} />
          Refresh calendars
        </button>
      </div>

      {status ? (
        <p className="field__hint">
          {status.configured ? (
            <>
              Connected as <span className="mono-note">{status.user}</span>. Calendar{" "}
              <span className="mono-note">{status.calendarId}</span>; {status.indexedCalendars} indexed.
              {status.servers.length
                ? ` MCP servers: ${status.servers
                    .map((server) => `${server.name} ${server.state}${server.toolCount ? ` (${server.toolCount})` : ""}`)
                    .join(", ")}.`
                : ""}
            </>
          ) : (
            <>Not connected — missing {status.missing.join(", ")}.</>
          )}
          {busy ? spinner : ""}
        </p>
      ) : null}

      {status?.scopes.length ? (
        <p className="field__hint">
          Asks for: {status.scopes.join(" · ")}. The refresh token is stored in config.json and never shown again.
        </p>
      ) : null}

      {probe ? (
        <div className={`notice${probe.gmail.ok && probe.calendar.ok ? " notice--ok" : " notice--warn"}`}>
          <span>
            Gmail: <strong>{probe.gmail.ok ? "ok" : "failed"}</strong> — {probe.gmail.detail}
          </span>
          <span>
            Calendar: <strong>{probe.calendar.ok ? "ok" : "failed"}</strong> — {probe.calendar.detail}
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="notice notice--error">
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
