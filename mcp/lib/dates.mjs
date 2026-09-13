/**
 * Event and task time handling.
 *
 * Google Calendar takes `{dateTime}` for a timed event and `{date}` for an
 * all-day one. The implementation this was ported from sent `{dateTime}` for
 * both, so its own schema advertised all-day support that the API then rejected
 * with a 400.
 */

/** `YYYY-MM-DD` with no time part. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a bare calendar date, which means an all-day event. */
export function isAllDay(value) {
  return DATE_ONLY_RE.test(String(value ?? "").trim());
}

/**
 * An event time in the shape the API expects, or `undefined` for empty input.
 *
 * Anything with a time part — an offset, a `Z`, or a time without one — is passed
 * through as `dateTime` and interpreted by the calendar's own time zone.
 */
export function parseDateTime(value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return DATE_ONLY_RE.test(text) ? { date: text } : { dateTime: text };
}

/**
 * Salesforce-style event times describe a date or a date-time, so the same shape
 * is used for both when building a request body.
 */
export function isDateShape(value) {
  return Boolean(value) && typeof value === "object" && ("date" in value || "dateTime" in value);
}

/**
 * A task's `due`, which the Tasks API requires to be an RFC 3339 timestamp.
 *
 * A bare date is widened to the start of that day in UTC, because sending it
 * unchanged is rejected.
 */
export function normalizeTaskDue(value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (DATE_ONLY_RE.test(text)) return `${text}T00:00:00.000Z`;
  return text;
}
