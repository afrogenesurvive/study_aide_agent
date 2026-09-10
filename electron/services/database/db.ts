import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LATEST_VERSION, migrate, type MigrationResult } from "./migrations";
import type { BackupResult, DbStatus } from "../../src/shared/ipc-types";

/**
 * Thin facade over `node:sqlite`.
 *
 * Everything database-shaped goes through this module, so swapping the driver
 * (e.g. to `better-sqlite3`) is a one-file change. `node:sqlite` was chosen
 * because Electron 43+ bundles Node 24, which ships it in core — no native
 * module, no `@electron/rebuild`, and therefore no ABI/notarisation risk.
 */

export type Database = DatabaseSync;

export interface OpenResult {
  db: Database;
  file: string;
  migration: MigrationResult;
  journalMode: string;
}

export function isMemory(file: string): boolean {
  return file === ":memory:" || file.startsWith("file::memory:");
}

/**
 * Open (creating if needed) a SQLite database and bring the schema up to date.
 */
export function openDatabase(file: string, options: { migrate?: boolean } = {}): OpenResult {
  const inMemory = isMemory(file);
  if (!inMemory) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });

  // Write-ahead logging keeps reads from blocking the (single) writer; it is a
  // no-op for in-memory databases, which report "memory" instead.
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
  } catch {
    // Older SQLite builds may not accept every pragma; the defaults still work.
  }

  const migration: MigrationResult = options.migrate === false
    ? { from: 0, to: 0, applied: [] }
    : migrate(db);

  return { db, file, migration, journalMode: readJournalMode(db) };
}

export function closeDatabase(db: Database): void {
  try {
    db.close();
  } catch {
    // Already closed.
  }
}

function readJournalMode(db: Database): string {
  try {
    const row = db.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined;
    return row ? String(Object.values(row)[0]) : "unknown";
  } catch {
    return "unknown";
  }
}

export function databaseStatus(db: Database, file: string): DbStatus {
  try {
    const tableRow = db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { count?: number } | undefined;
    const versionRow = db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version?: number } | undefined;
    return {
      ok: true,
      path: file,
      sizeBytes: isMemory(file) ? 0 : fileSize(file),
      schemaVersion: Number(versionRow?.version ?? 0),
      tableCount: Number(tableRow?.count ?? 0),
      journalMode: readJournalMode(db),
    };
  } catch (err) {
    return {
      ok: false,
      path: file,
      sizeBytes: 0,
      schemaVersion: 0,
      tableCount: 0,
      journalMode: "unknown",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function listTables(db: Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function tableColumns(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

/**
 * Copy the database to `targetDir` using SQLite's online backup API, which is
 * safe while the app is running (unlike a file copy under WAL).
 */
export async function backupDatabase(db: Database, targetDir: string): Promise<BackupResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(targetDir, `study-backup-${stamp}.db`);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const mod = (await import("node:sqlite")) as unknown as {
      backup?: (source: Database, path: string) => Promise<number>;
    };
    if (typeof mod.backup !== "function") {
      return { success: false, error: "node:sqlite backup() is unavailable in this runtime." };
    }
    await mod.backup(db, target);
    return { success: true, filePath: target, bytes: fileSize(target) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export { LATEST_VERSION, migrate, withTransaction } from "./migrations";
export type { Migration, MigrationResult } from "./migrations";
