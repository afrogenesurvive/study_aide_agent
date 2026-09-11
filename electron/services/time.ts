/**
 * Timezone-aware date helpers.
 *
 * The app stores every instant as ISO-8601 UTC, but "today", "yesterday" and
 * "the 08:00 digest" are all *local* concepts. `TIMEZONE` in the config is the
 * single source of truth for what local means; these helpers are the only place
 * that conversion happens.
 *
 * Deliberately dependency-free: `Intl.DateTimeFormat` already carries the full
 * IANA database, so there is no reason to ship a date library for this.
 */

const MS_PER_DAY = 86_400_000;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Fall back to the machine zone rather than throwing on a bad config value. */
export function safeTimeZone(timeZone?: string | null): string {
  if (timeZone && isValidTimeZone(timeZone)) return timeZone;
  return systemTimeZone();
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    // Some ICU builds render local midnight as hour 24.
    hour: pick("hour") % 24,
    minute: pick("minute"),
    second: pick("second"),
  };
}

/** Milliseconds by which `timeZone` is ahead of UTC at `date`. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - (date.getTime() - date.getMilliseconds());
}

/**
 * Turn a wall-clock reading in `timeZone` into the matching UTC instant.
 *
 * Two passes: the first guess can land on the wrong side of a DST transition,
 * and re-reading the offset at the guessed instant settles it.
 */
function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = guess - zoneOffsetMs(new Date(guess), timeZone);
  instant = guess - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** Local calendar day as `YYYY-MM-DD`. */
export function dayKey(date: Date, timeZone?: string | null): string {
  const zone = safeTimeZone(timeZone);
  const parts = zonedParts(date, zone);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

/** The UTC instant at which the local day containing `date` begins. */
export function dayStart(date: Date, timeZone?: string | null): Date {
  const zone = safeTimeZone(timeZone);
  const parts = zonedParts(date, zone);
  return wallClockToUtc(parts.year, parts.month, parts.day, 0, 0, zone);
}

/** The UTC instant at which the local day containing `date` ends (exclusive). */
export function dayEnd(date: Date, timeZone?: string | null): Date {
  return new Date(dayStart(date, timeZone).getTime() + MS_PER_DAY);
}

/** `hours`/`minutes` on the local day containing `date`, as a UTC instant. */
export function zonedTime(
  date: Date,
  clock: string,
  timeZone?: string | null,
): Date {
  const zone = safeTimeZone(timeZone);
  const parts = zonedParts(date, zone);
  const [hour, minute] = clock.split(":").map((n) => Number(n) || 0);
  return wallClockToUtc(parts.year, parts.month, parts.day, hour, minute, zone);
}

/** Add whole days to a `YYYY-MM-DD` key. */
export function addDays(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return [
    String(next.getUTCFullYear()).padStart(4, "0"),
    String(next.getUTCMonth() + 1).padStart(2, "0"),
    String(next.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Whole days from `fromKey` to `toKey` (negative when `toKey` is earlier). */
export function daysBetween(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((to - from) / MS_PER_DAY);
}

/** `"08:00"` → `480`. Returns null when the string is not a clock time. */
export function parseClock(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Local wall-clock time as `HH:MM`, for display. */
export function formatClock(date: Date, timeZone?: string | null): string {
  const parts = zonedParts(date, safeTimeZone(timeZone));
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/** `2026-09-10T02:30:00.000Z` — the only date format written to the DB. */
export function isoOf(date: Date): string {
  return date.toISOString();
}

/** Parse a stored ISO timestamp. Returns null for empty or unparseable input. */
export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
