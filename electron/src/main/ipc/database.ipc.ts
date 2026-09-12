import fs from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { APP_VERSION, getConfig } from "../config";
import { addLog } from "../logger";
import { configPath, studyDbPath, userDataPath } from "../paths";
import { backupDatabase, databaseStatus, fileSize, listTables } from "../../../services/database/db";
import { getDb, tryGetDb } from "../../../services/database";
import { clearUsage, summarizeUsage } from "../../../services/llm/usage";
import type { BackupResult, DbStatus, StorageUsage } from "../../shared/ipc-types";

/** Database, storage and LLM-usage channels. */

function directorySize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += directorySize(full);
      else if (entry.isFile()) total += fileSize(full);
    }
  } catch {
    // Missing or unreadable directory counts as zero.
  }
  return total;
}

export function registerDatabaseIpc(): void {
  ipcMain.handle("storage:usage", (): StorageUsage => {
    const db = tryGetDb();
    const dbFile = studyDbPath();
    return {
      userData: userDataPath(),
      logsDir: userDataPath("logs"),
      dbPath: dbFile,
      dbBytes: db ? databaseStatus(db, dbFile).sizeBytes : fileSize(dbFile),
      logBytes: directorySize(userDataPath("logs")),
      configPath: configPath(),
    };
  });

  ipcMain.handle("db:status", (): DbStatus => {
    const db = tryGetDb();
    if (!db) {
      return {
        ok: false,
        path: studyDbPath(),
        sizeBytes: 0,
        schemaVersion: 0,
        tableCount: 0,
        journalMode: "unknown",
        error: "Database is not open.",
      };
    }
    return databaseStatus(db, studyDbPath());
  });

  ipcMain.handle("db:tables", () => {
    const db = tryGetDb();
    return db ? listTables(db) : [];
  });

  ipcMain.handle("db:backup", async (): Promise<BackupResult> => {
    const db = tryGetDb();
    if (!db) return { success: false, error: "Database is not open." };
    const result = await backupDatabase(db, userDataPath("backups"));
    addLog(
      "db",
      result.success ? "info" : "error",
      result.success ? `Backup written to ${result.filePath}` : `Backup failed: ${result.error}`,
    );
    return result;
  });

  ipcMain.handle("app:info", () => ({
    version: APP_VERSION,
    recordCounts: recordCounts(),
  }));

  ipcMain.handle("usage:summary", () => {
    const db = tryGetDb();
    if (!db) {
      return {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        lastCallAt: null,
        byModel: [],
      };
    }
    return summarizeUsage(db);
  });

  ipcMain.handle("usage:clear", () => {
    const db = tryGetDb();
    if (!db) return 0;
    const removed = clearUsage(db);
    addLog("db", "info", `Cleared ${removed} LLM usage records.`);
    return removed;
  });
}

function recordCounts(): Record<string, number> {
  const db = tryGetDb();
  if (!db) return {};
  const tables = [
    "syllabus",
    "syllabus_topics",
    "syllabus_imports",
    "flashcards",
    "quizzes",
    "quiz_questions",
    "llm_usage",
    "generation_jobs",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
        | { count: number }
        | undefined;
      counts[table] = Number(row?.count ?? 0);
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}
