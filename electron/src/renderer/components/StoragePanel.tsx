import { useEffect, useState } from "react";
import { Icon } from "../icons";
import type { DbStatus, StorageUsage } from "../../shared/ipc-types";

/** Storage: where things live, how big they are, and how to back them up. */

export function StoragePanel({ onSaved }: { onSaved: (message: string) => void }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [status, setStatus] = useState<DbStatus | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const [nextUsage, nextStatus, nextTables, info] = await Promise.all([
      window.electronAPI?.getStorageUsage(),
      window.electronAPI?.getDbStatus(),
      window.electronAPI?.getDbTables(),
      window.electronAPI?.getInfo(),
    ]);
    setUsage(nextUsage ?? null);
    setStatus(nextStatus ?? null);
    setTables(nextTables ?? []);
    setCounts(info?.recordCounts ?? {});
  };

  useEffect(() => {
    void reload();
  }, []);

  const backup = async () => {
    setBusy(true);
    try {
      const result = await window.electronAPI?.backupDb();
      onSaved(
        result?.success
          ? `Backup written (${formatBytes(result.bytes ?? 0)}).`
          : result?.error ?? "Backup failed.",
      );
      if (result?.success && result.filePath) {
        await window.electronAPI?.showItemInFolder(result.filePath);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name="storage" />
          Storage
        </h2>
        <div className="panel__actions">
          <button type="button" className="btn" onClick={() => void reload()}>
            <Icon name="refresh" size={14} />
            Refresh
          </button>
          <button type="button" className="btn btn--primary" onClick={backup} disabled={busy}>
            {busy ? "Backing up…" : "Back up database"}
          </button>
        </div>
      </header>

      <div className="panel__body">
        <div className="stat-grid">
          <div className="stat">
            <span className="stat__value">{formatBytes(usage?.dbBytes ?? 0)}</span>
            <span className="stat__label">Database</span>
          </div>
          <div className="stat">
            <span className="stat__value">{formatBytes(usage?.logBytes ?? 0)}</span>
            <span className="stat__label">Log files</span>
          </div>
          <div className="stat">
            <span className="stat__value">v{status?.schemaVersion ?? "—"}</span>
            <span className="stat__label">Schema version</span>
          </div>
          <div className="stat">
            <span className="stat__value">{status?.tableCount ?? 0}</span>
            <span className="stat__label">Tables</span>
          </div>
        </div>

        {status && !status.ok ? (
          <div className="notice notice--error">
            <strong>Database unavailable</strong>
            <span>{status.error}</span>
          </div>
        ) : null}

        <fieldset className="fieldset">
          <legend>Locations</legend>
          <LocationRow label="User data" path={usage?.userData} />
          <LocationRow label="Database" path={usage?.dbPath} />
          <LocationRow label="Config" path={usage?.configPath} />
          <LocationRow label="Logs" path={usage?.logsDir} />
        </fieldset>

        <fieldset className="fieldset">
          <legend>Record counts</legend>
          <table className="table">
            <tbody>
              {Object.entries(counts).map(([table, count]) => (
                <tr key={table}>
                  <td className="mono-note">{table}</td>
                  <td className="table__number">{count.toLocaleString()}</td>
                </tr>
              ))}
              {!Object.keys(counts).length ? (
                <tr>
                  <td className="muted">No data yet.</td>
                  <td />
                </tr>
              ) : null}
            </tbody>
          </table>
        </fieldset>

        <fieldset className="fieldset">
          <legend>Tables ({tables.length})</legend>
          <div className="chip-row">
            {tables.map((table) => (
              <span key={table} className="chip mono-note">
                {table}
              </span>
            ))}
          </div>
        </fieldset>
      </div>
    </section>
  );
}

function LocationRow({ label, path }: { label: string; path?: string }) {
  return (
    <div className="location-row">
      <span className="location-row__label">{label}</span>
      <code className="location-row__path">{path ?? "—"}</code>
      <button
        type="button"
        className="btn btn--small"
        disabled={!path}
        onClick={() => path && void window.electronAPI?.openPath(path)}
      >
        <Icon name="external" size={13} />
        Open
      </button>
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}
