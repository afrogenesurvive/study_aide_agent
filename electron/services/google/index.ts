/**
 * Google service layer.
 *
 * `gateway` is the app's typed access to the twelve Google tools; `calendars`
 * owns the friendly-name index. Neither imports Electron — the MCP caller, the
 * calendar file path and the sanitizer all arrive as injected options.
 */

export {
  GoogleGateway,
  type GoogleCallResult,
  type GoogleGatewayOptions,
  type GoogleServiceProbe,
  type McpCaller,
  type PayloadSanitizer,
} from "./gateway";

export {
  buildCalendarIndex,
  coerceCalendarEntries,
  emptyCalendarIndex,
  knownCalendarNames,
  parseCalendarIndex,
  readCalendarIndex,
  resolveCalendarId,
  writeCalendarIndex,
  type CalendarEntry,
  type CalendarIndex,
} from "./calendars";
