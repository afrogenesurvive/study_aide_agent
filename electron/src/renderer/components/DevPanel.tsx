import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import type { AgentConfigPayload, LlmUsageSummary, LogEntry, LogLevel } from "../../shared/ipc-types";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
type DevTab = "logs" | "usage" | "agent";

/**
 * Developer panel: live logs, token usage and the agent-config files.
 *
 * Log entries arrive over the `log` push channel and are kept in a bounded local
 * buffer so a chatty session cannot grow the renderer's memory without limit.
 */
export function DevPanel({ onSaved }: { onSaved: (message: string) => void }) {
  const [tab, setTab] = useState<DevTab>("logs");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LogLevel>("info");
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [usage, setUsage] = useState<LlmUsageSummary | null>(null);
  const [agentConfig, setAgentConfig] = useState<AgentConfigPayload | null>(null);
  const [logInfo, setLogInfo] = useState<{ dir: string; file: string | null } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);

  pausedRef.current = paused;

  useEffect(() => {
    void (async () => {
      const [initial, info] = await Promise.all([
        window.electronAPI?.getLogs(500),
        window.electronAPI?.getLogInfo(),
      ]);
      setEntries(initial ?? []);
      setLogInfo(info ?? null);
      if (info?.level) setLevel(info.level);
    })();

    const unsubscribe = window.electronAPI?.onLog((entry) => {
      if (pausedRef.current) return;
      setEntries((current) => {
        const next = [...current, entry];
        return next.length > 2000 ? next.slice(next.length - 2000) : next;
      });
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (tab !== "usage") return;
    void window.electronAPI?.getUsageSummary().then((summary) => setUsage(summary ?? null));
  }, [tab, entries.length]);

  useEffect(() => {
    if (tab !== "agent") return;
    void window.electronAPI?.getAgentConfig().then((payload) => setAgentConfig(payload ?? null));
  }, [tab]);

  useEffect(() => {
    if (paused || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, paused]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const weight: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
    return entries.filter((entry) => {
      if (weight[entry.level] < weight[level]) return false;
      if (!needle) return true;
      return (
        entry.message.toLowerCase().includes(needle) ||
        entry.source.toLowerCase().includes(needle) ||
        (entry.subSource ?? "").toLowerCase().includes(needle)
      );
    });
  }, [entries, filter, level]);

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name="dev" />
          Developer
        </h2>
        <div className="panel__actions">
          <div className="tab-row" role="tablist">
            {(["logs", "usage", "agent"] as DevTab[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={tab === candidate}
                className={`tab${tab === candidate ? " tab--active" : ""}`}
                onClick={() => setTab(candidate)}
              >
                {candidate === "logs" ? "Logs" : candidate === "usage" ? "Token usage" : "Agent config"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="panel__body panel__body--flush">
        {tab === "logs" ? (
          <>
            <div className="toolbar">
              <select
                className="input input--compact"
                value={level}
                onChange={(event) => {
                  const next = event.target.value as LogLevel;
                  setLevel(next);
                  void window.electronAPI?.setLogLevel(next);
                }}
                aria-label="Minimum log level"
              >
                {LEVELS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
              <input
                className="input input--compact"
                placeholder="Filter…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <button type="button" className="btn btn--small" onClick={() => setPaused((value) => !value)}>
                {paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={async () => {
                  await window.electronAPI?.clearLogs();
                  setEntries([]);
                }}
              >
                Clear
              </button>
              {logInfo?.dir ? (
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => void window.electronAPI?.openPath(logInfo.dir)}
                >
                  Open log folder
                </button>
              ) : null}
              <span className="muted">{visible.length} entries</span>
            </div>

            <div className="log-view" ref={scrollRef}>
              {visible.map((entry, index) => (
                <div key={`${entry.timestamp}-${index}`} className={`log-line log-line--${entry.level}`}>
                  <span className="log-line__time">
                    {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false })}
                  </span>
                  <span className="log-line__source">
                    {entry.source}
                    {entry.subSource ? `:${entry.subSource}` : ""}
                  </span>
                  <span className="log-line__message">{entry.message}</span>
                </div>
              ))}
              {!visible.length ? <p className="muted">Nothing logged yet.</p> : null}
            </div>
          </>
        ) : null}

        {tab === "usage" ? (
          <div className="panel__body">
            {usage ? (
              <>
                <div className="stat-grid">
                  <Stat label="Calls (30d)" value={usage.calls.toLocaleString()} />
                  <Stat label="Prompt tokens" value={usage.promptTokens.toLocaleString()} />
                  <Stat label="Completion tokens" value={usage.completionTokens.toLocaleString()} />
                  <Stat label="Cached tokens" value={usage.cachedTokens.toLocaleString()} />
                </div>
                {usage.byModel.length ? (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Provider</th>
                        <th>Calls</th>
                        <th>Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.byModel.map((row) => (
                        <tr key={`${row.provider}-${row.model}`}>
                          <td>{row.model || "—"}</td>
                          <td>{row.provider}</td>
                          <td>{row.calls.toLocaleString()}</td>
                          <td>{row.totalTokens.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted">No LLM calls recorded yet. Usage appears here as soon as the model is used.</p>
                )}
                <div className="toolbar">
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={async () => {
                      const removed = await window.electronAPI?.clearUsage();
                      onSaved(`Cleared ${removed ?? 0} usage records.`);
                      setUsage(await window.electronAPI?.getUsageSummary() ?? null);
                    }}
                  >
                    Clear usage history
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">Loading usage…</p>
            )}
          </div>
        ) : null}

        {tab === "agent" ? (
          <div className="panel__body">
            <p className="muted mono-note">{agentConfig?.dir ?? "Loading…"}</p>
            {agentConfig?.files.map((file) => (
              <AgentConfigFile
                key={file.name}
                file={file}
                onSaved={async (message) => {
                  onSaved(message);
                  setAgentConfig((await window.electronAPI?.getAgentConfig()) ?? null);
                }}
              />
            ))}
            <div className="toolbar">
              <button
                type="button"
                className="btn btn--small"
                onClick={async () => {
                  const result = await window.electronAPI?.restoreAgentConfigDefaults();
                  onSaved(
                    result?.success
                      ? `Restored: ${result.written.join(", ") || "nothing to do"}`
                      : result?.error ?? "Restore failed.",
                  );
                  setAgentConfig((await window.electronAPI?.getAgentConfig()) ?? null);
                }}
              >
                Restore shipped defaults
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

function AgentConfigFile({
  file,
  onSaved,
}: {
  file: { name: string; content: string; exists: boolean; valid: boolean; errors: string[] };
  onSaved: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(file.content);

  useEffect(() => setDraft(file.content), [file.content]);

  return (
    <div className="agent-file">
      <button type="button" className="agent-file__header" onClick={() => setOpen((value) => !value)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
        <span className="mono-note">{file.name}</span>
        <span className={`badge ${file.valid ? "badge--ok" : "badge--bad"}`}>
          {file.exists ? (file.valid ? "valid" : "invalid") : "missing"}
        </span>
      </button>
      {open ? (
        <div className="agent-file__body">
          {file.errors.length ? (
            <ul className="error-list">
              {file.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          <textarea
            className="input input--code"
            rows={14}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="toolbar">
            <button
              type="button"
              className="btn btn--small btn--primary"
              disabled={draft === file.content}
              onClick={async () => {
                const result = await window.electronAPI?.saveAgentConfig(
                  file.name as "pipeline" | "tools" | "system-prompt",
                  draft,
                );
                onSaved(
                  result?.success
                    ? `${file.name} saved.`
                    : result?.errors?.length
                      ? `${file.name} is invalid: ${result.errors[0]}`
                      : result?.error ?? "Save failed.",
                );
              }}
            >
              Save
            </button>
            <button type="button" className="btn btn--small" onClick={() => setDraft(file.content)}>
              Revert
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
