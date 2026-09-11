import type { DatabaseSync } from "node:sqlite";

/**
 * Migration definitions.
 *
 * Migrations are TypeScript modules exporting SQL strings rather than `.sql`
 * files on purpose: the main process is compiled with `tsc` into `dist/`, and
 * `tsc` does not copy non-TypeScript assets, so `.sql` files would go missing in
 * packaged builds. Keeping them in TS also means the test suite can exercise
 * them directly with no build step.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

import { migration001Initial } from "./001_initial";
import { migration002FsrsAndScheduling } from "./002_fsrs_and_scheduling";

export const MIGRATIONS: Migration[] = [
  migration001Initial,
  migration002FsrsAndScheduling,
].sort((a, b) => a.version - b.version);

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export interface MigrationResult {
  from: number;
  to: number;
  applied: Migration[];
}

type Db = DatabaseSync;

/**
 * Bring the database up to `LATEST_VERSION`.
 *
 * Idempotent: already-applied migrations are skipped, and each migration runs
 * inside its own transaction so a failure leaves the schema at the previous
 * version rather than half-applied.
 */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const appliedRows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number | bigint;
  }>;
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  const from = applied.size ? Math.max(...applied) : 0;

  const record = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  const done: Migration[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    withTransaction(db, () => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name);
    });
    done.push(migration);
  }

  const to = done.length ? done[done.length - 1].version : from;
  return { from, to, applied: done };
}

/**
 * Run `fn` inside a savepoint.
 *
 * `node:sqlite` has no `db.transaction()` helper (unlike better-sqlite3), and
 * savepoints nest correctly, so this is the primitive everything else builds on.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  const name = `sp_${(savepointCounter += 1)}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      // Rolling back a savepoint can fail if the statement already aborted the
      // transaction; the original error is the one worth surfacing.
    }
    throw err;
  }
}

let savepointCounter = 0;

/**
 * Reset the savepoint counter.
 *
 * Called by the test helper before each case so savepoint names are identical
 * from run to run, which makes a failing `ROLLBACK TO` reproducible.
 */
export function resetSavepointCounter(): void {
  savepointCounter = 0;
}

export { migration001Initial, migration002FsrsAndScheduling };
