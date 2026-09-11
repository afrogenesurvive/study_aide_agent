import { openDatabase, type Database } from "../../services/database/db";
import { resetSavepointCounter } from "../../services/database/migrations";

/**
 * Fresh in-memory database with the full schema applied.
 *
 * `:memory:` keeps the suite fast and guarantees no test can see another's rows.
 * The savepoint counter is reset too, so a failing `ROLLBACK TO sp_N` names the
 * same savepoint on every run.
 */
export function createTestDb(): { db: Database; close: () => void } {
  resetSavepointCounter();
  const opened = openDatabase(":memory:");
  return { db: opened.db, close: () => opened.db.close() };
}
