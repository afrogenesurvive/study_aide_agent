import { Icon } from "../icons";

export interface StatusBarProps {
  version: string;
  dbLabel: string;
  dbOk: boolean;
  configOk: boolean;
  usageLabel?: string;
  onOpenPanel: (panel: "settings" | "dev" | "storage") => void;
}

/**
 * Persistent bottom bar.
 *
 * Shows the two things that actually block work — whether the database opened
 * and whether the LLM is configured — plus a click-through to the relevant panel.
 */
export function StatusBar({
  version,
  dbLabel,
  dbOk,
  configOk,
  usageLabel,
  onOpenPanel,
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <div className="status-bar__group">
        <button
          type="button"
          className={`status-pill${dbOk ? " status-pill--ok" : " status-pill--bad"}`}
          onClick={() => onOpenPanel("storage")}
          title="Database status"
        >
          <span className="status-dot" />
          {dbLabel}
        </button>

        <button
          type="button"
          className={`status-pill${configOk ? " status-pill--ok" : " status-pill--warn"}`}
          onClick={() => onOpenPanel("settings")}
          title="Configuration status"
        >
          <Icon name={configOk ? "check" : "warning"} size={13} />
          {configOk ? "LLM ready" : "LLM not configured"}
        </button>
      </div>

      <div className="status-bar__group status-bar__group--right">
        {usageLabel ? (
          <button type="button" className="status-pill" onClick={() => onOpenPanel("dev")} title="Token usage">
            {usageLabel}
          </button>
        ) : null}
        <button type="button" className="status-pill" onClick={() => onOpenPanel("dev")} title="Open logs">
          v{version}
        </button>
      </div>
    </footer>
  );
}
