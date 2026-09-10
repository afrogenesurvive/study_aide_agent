import { closeDatabase, databaseStatus, openDatabase, type Database } from "./db";
import type { DbStatus } from "../../src/shared/ipc-types";
import type { ServiceLogger } from "../types";

/**
 * Process-wide database handle.
 *
 * The database is owned by the Electron main process (`node:sqlite` is
 * synchronous, so there is no benefit to a separate thread), and the renderer
 * reaches it only through IPC handlers.
 */

let db: Database | null = null;
let dbFile = "";
let dbStatus: DbStatus | null = null;

export function initDatabase(file: string, log?: ServiceLogger): DbStatus {
  if (db) return databaseStatus(db, dbFile);

  const opened = openDatabase(file);
  db = opened.db;
  dbFile = opened.file;
  dbStatus = databaseStatus(db, dbFile);

  const applied = opened.migration.applied.map((m) => `v${m.version}`).join(", ");
  log?.(
    "info",
    `Database ready at ${dbFile} (schema v${dbStatus.schemaVersion}, ${dbStatus.tableCount} tables, journal=${opened.journalMode})${applied ? ` — applied ${applied}` : ""}`,
  );
  return dbStatus;
}

/** Throws when the database has not been initialised. Prefer `tryGetDb()`. */
export function getDb(): Database {
  if (!db) throw new Error("Database is not initialised yet.");
  return db;
}

export function tryGetDb(): Database | null {
  return db;
}

export function getDbFile(): string {
  return dbFile;
}

export function getDbStatus(): DbStatus | null {
  if (!db) return null;
  dbStatus = databaseStatus(db, dbFile);
  return dbStatus;
}

export function closeDb(log?: ServiceLogger): void {
  if (!db) return;
  closeDatabase(db);
  db = null;
  dbStatus = null;
  log?.("info", "Database closed.");
}
