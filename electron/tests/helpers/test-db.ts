import { openDatabase, type Database } from "../../services/database/db";

/**
 * Fresh in-memory database with the full schema applied.
 *
 * `:memory:` keeps the suite fast and guarantees no test can see another's rows.
 */
export function createTestDb(): { db: Database; close: () => void } {
  const opened = openDatabase(":memory:");
  return { db: opened.db, close: () => opened.db.close() };
}
