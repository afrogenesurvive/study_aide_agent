/**
 * Google IPC payloads.
 *
 * Self-contained on purpose: the renderer tsconfig only includes
 * `src/renderer/**` and `src/shared/**`, so a type defined here must not reach
 * into `services/`. It travels the other way — the IPC layer adapts the service
 * layer's shapes into these.
 */

/** One MCP child, as the Settings panel shows it. */
export interface GoogleServerStatus {
  name: string;
  /** "idle" (never started), "ready", "connecting" or "closed". */
  state: string;
  /** Null until the server has hand-shaken. */
  toolCount: number | null;
  error: string | null;
}

export interface GoogleStatusPayload {
  /** True when all three credentials are present. */
  configured: boolean;
  /** The config keys still missing, named as Settings shows them. */
  missing: string[];
  /** The account Google will send as. */
  user: string;
  /** The configured calendar, before name resolution. */
  calendarId: string;
  /** Absolute path of the friendly-name index, for the Storage readout. */
  calendarFile: string;
  /** How many calendars the index knows; 0 before the first refresh. */
  indexedCalendars: number;
  /** True while an authorization flow is running. */
  connecting: boolean;
  /** The scopes the consent screen asks for, in plain language. */
  scopes: string[];
  servers: GoogleServerStatus[];
}

export interface GoogleTestResult {
  gmail: { ok: boolean; detail: string };
  calendar: { ok: boolean; detail: string };
}

export interface GoogleActionResult {
  ok: boolean;
  error?: string;
  /** Set by the calendar refresh: how many calendars were indexed. */
  count?: number;
}

export interface GoogleConnectResult {
  ok: boolean;
  /** The connected account, for display. Never a credential. */
  user?: string;
  error?: string;
}
