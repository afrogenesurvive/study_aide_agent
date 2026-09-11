/**
 * Scheduler subsystem barrel.
 *
 * `overlay` owns the cross-subject themes, `plan` builds the day's interleaved
 * blocks, and `session` records what actually happened. All three are pure or
 * SQL-only, which is what lets the whole scheduler be tested without Electron.
 */

export * from "./overlay";
export * from "./plan";
export * from "./session";
