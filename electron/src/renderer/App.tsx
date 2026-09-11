import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar, type PanelId } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { LoadingModal } from "./components/LoadingModal";
import { AppearancePanel } from "./components/AppearancePanel";
import { ConfigPanel } from "./components/ConfigPanel";
import { DashboardPanel } from "./components/DashboardPanel";
import { DevPanel } from "./components/DevPanel";
import { ReviewPanel } from "./components/review/ReviewPanel";
import { SessionPanel } from "./components/session/SessionPanel";
import { StoragePanel } from "./components/StoragePanel";
import { SyllabusPanel } from "./components/SyllabusPanel";
import { Icon, type IconName } from "./icons";
import { useUiState, useUiStateValue } from "./hooks/useUiState";
import {
  DEFAULT_APPEARANCE,
  applyAppearance,
  appearanceFromConfig,
  clampSidebarWidth,
  unwatchSystemTheme,
  watchSystemTheme,
  type AppearanceConfig,
} from "./appearance";
import type { ConfigCheckResult, DbStatus, LlmUsageSummary, LogEntry } from "../shared/ipc-types";

/**
 * Application shell.
 *
 * No router: panel selection is a `useState` value persisted through
 * `ui-state.json`, which keeps deep-linking out of the picture and makes the
 * "reopen where I left off" behaviour trivial.
 */

interface Toast {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
}

export default function App() {
  const { ready } = useUiState();
  const [panel, setPanel] = useUiStateValue<PanelId>("app.panel", "dashboard");

  const [appearance, setAppearance] = useState<AppearanceConfig>(DEFAULT_APPEARANCE);
  const [version, setVersion] = useState("0.0.0");
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);
  const [check, setCheck] = useState<ConfigCheckResult | null>(null);
  const [usage, setUsage] = useState<LlmUsageSummary | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_APPEARANCE.sidebarWidth);

  const sidebarRef = useRef<HTMLElement>(null);
  const resizing = useRef(false);

  // ── toasts ────────────────────────────────────────────────────────────────

  const notify = useCallback((message: string, level: Toast["level"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, level, message }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 6000);
  }, []);

  // ── initial load ──────────────────────────────────────────────────────────

  const refreshStatus = useCallback(async () => {
    const [status, nextCheck, summary] = await Promise.all([
      window.electronAPI?.getDbStatus(),
      window.electronAPI?.checkConfig(),
      window.electronAPI?.getUsageSummary(),
    ]);
    setDbStatus(status ?? null);
    setCheck(nextCheck ?? null);
    setUsage(summary ?? null);
  }, []);

  useEffect(() => {
    void (async () => {
      const [config, nextVersion] = await Promise.all([
        window.electronAPI?.getConfig(),
        window.electronAPI?.getVersion(),
      ]);
      if (nextVersion) setVersion(nextVersion);

      if (config) {
        const next = appearanceFromConfig(config);
        setAppearance(next);
        setSidebarWidth(next.sidebarWidth);
        applyAppearance(next);
      }
      await refreshStatus();
    })();

    return () => unwatchSystemTheme();
  }, [refreshStatus]);

  // Follow the OS theme while "system" is selected.
  useEffect(() => {
    if (appearance.theme !== "system") {
      unwatchSystemTheme();
      return;
    }
    watchSystemTheme(() => applyAppearance(appearance));
    applyAppearance(appearance);
  }, [appearance]);

  // Log lines at warn/error surface as toasts so failures are visible immediately.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onLog((entry: LogEntry) => {
      if (entry.level !== "error") return;
      notify(`${entry.source}: ${entry.message}`, "error");
    });
    return () => unsubscribe?.();
  }, [notify]);

  // ── sidebar resizing ──────────────────────────────────────────────────────

  const onResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    resizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!resizing.current) return;
      setSidebarWidth(clampSidebarWidth(event.clientX));
    };
    const onUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Live preview while dragging; persisted only from the Appearance panel.
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  const usageLabel = useMemo(() => {
    if (!usage?.calls) return undefined;
    return `${usage.calls} calls · ${usage.totalTokens.toLocaleString()} tok`;
  }, [usage]);

  if (!ready) return <LoadingModal message="Starting Study Aide…" />;

  return (
    <div className="app">
      <div className="app-body">
        <Sidebar
          active={panel}
          onSelect={setPanel}
          onResizeStart={onResizeStart}
          sidebarRef={sidebarRef}
        />

        <main className="app-main">
          {panel === "dashboard" ? (
            <DashboardPanel onOpenPanel={setPanel} onSaved={(message) => notify(message)} />
          ) : null}

          {panel === "syllabus" ? <SyllabusPanel onSaved={(message) => notify(message)} /> : null}

          {panel === "generate" ? (
            <Placeholder
              title="Generate"
              icon="generate"
              phase="Phase 3"
              description="Syllabus-grounded flashcard and quiz generation, with a review gate before anything is saved."
            />
          ) : null}

          {panel === "review" ? <ReviewPanel onSaved={(message) => notify(message)} /> : null}

          {panel === "session" ? <SessionPanel onSaved={(message) => notify(message)} /> : null}

          {panel === "socratic" ? (
            <Placeholder
              title="Socratic"
              icon="socratic"
              phase="Phase 6"
              description="Multi-turn dialogue grounded in the current topic code, plus the pre-written question trees."
            />
          ) : null}

          {panel === "analytics" ? (
            <Placeholder
              title="Analytics"
              icon="analytics"
              phase="Phase 6"
              description="Coverage over time, retention curves, valence trends and exam-readiness per subject. The Coverage tab in Syllabus is the phase 1 slice of this."
            />
          ) : null}

          {panel === "notifications" ? (
            <Placeholder
              title="Notifications"
              icon="notifications"
              phase="Phase 5"
              description="Reminder channels, offsets, digest time and test sends. Raises the review gate before any email or calendar event is created."
            />
          ) : null}

          {panel === "settings" ? <ConfigPanel onSaved={(message) => { notify(message); void refreshStatus(); }} /> : null}

          {panel === "appearance" ? (
            <AppearancePanel
              appearance={appearance}
              onChange={(next) => {
                setAppearance(next);
                setSidebarWidth(next.sidebarWidth);
              }}
              onSaved={(message) => {
                notify(message);
                void refreshStatus();
              }}
            />
          ) : null}

          {panel === "dev" ? <DevPanel onSaved={(message) => notify(message)} /> : null}

          {panel === "storage" ? <StoragePanel onSaved={(message) => notify(message)} /> : null}
        </main>
      </div>

      <StatusBar
        version={version}
        dbLabel={
          dbStatus?.ok
            ? `DB v${dbStatus.schemaVersion} · ${dbStatus.tableCount} tables`
            : "Database unavailable"
        }
        dbOk={Boolean(dbStatus?.ok)}
        configOk={Boolean(check?.ok)}
        usageLabel={usageLabel}
        onOpenPanel={setPanel}
      />

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.level}`}>
            <Icon name={toast.level === "error" ? "warning" : "check"} size={14} />
            <span>{toast.message}</span>
            <button
              type="button"
              className="toast__close"
              aria-label="Dismiss"
              onClick={() => setToasts((current) => current.filter((candidate) => candidate.id !== toast.id))}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Placeholder({
  title,
  icon,
  phase,
  description,
}: {
  title: string;
  icon: IconName;
  phase: string;
  description: string;
}) {
  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name={icon} />
          {title}
        </h2>
        <span className="badge badge--muted">{phase}</span>
      </header>
      <div className="panel__body">
        <p className="muted">{description}</p>
      </div>
    </section>
  );
}
