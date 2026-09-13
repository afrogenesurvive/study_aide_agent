/**
 * The app's typed access to the Google tools.
 *
 * Everything above this — the pipeline dispatcher, the IPC layer, the Settings
 * panel — talks to Google through this, never through MCP directly. It owns three
 * things:
 *
 *  1. **Routing.** A tool name becomes a server name via an injected resolver, so
 *     this module holds no routing table of its own and cannot drift from the
 *     registry and the manifest.
 *  2. **Decoding.** Payloads arrive as `unknown` from a process boundary, so they
 *     are coerced here rather than at each call site.
 *  3. **Sanitising.** Every payload is scrubbed before it can reach a log line or
 *     a model prompt. The servers scrub too — email bodies are untrusted text and
 *     two boundaries are cheaper than one.
 *
 * Never throws: a missing server, a dead child and a tool that reported an error
 * all come back as `{ ok: false, error }`, because every caller has to show the
 * failure to a user rather than unwind.
 */

import type { McpToolResult } from "../mcp";
import type { ServiceLogger } from "../types";
import {
  buildCalendarIndex,
  coerceCalendarEntries,
  emptyCalendarIndex,
  readCalendarIndex,
  resolveCalendarId as resolveFromIndex,
  writeCalendarIndex,
  type CalendarEntry,
  type CalendarIndex,
} from "./calendars";

/** Runs one tool on one MCP server. */
export type McpCaller = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<McpToolResult>;

/** Scrubs an external payload. Required, so every construction site has to decide. */
export type PayloadSanitizer = (value: unknown) => unknown;

export interface GoogleCallResult {
  ok: boolean;
  data: unknown;
  error: string | null;
  retryable: boolean;
}

export interface GoogleServiceProbe {
  ok: boolean;
  /** One short line for the panel: what worked, or why it did not. */
  detail: string;
}

export interface GoogleGatewayOptions {
  call: McpCaller;
  /** Which MCP server owns a tool. Backed by `TOOL_EXECUTORS[...].mcpServer`. */
  resolveServer: (tool: string) => string | null;
  /** Absolute path to `<userData>/calendars.json`. */
  calendarFile: string;
  /** `GOOGLE_CALENDAR_ID`; `"primary"` unless the user changed it. */
  defaultCalendarId: string;
  sanitize: PayloadSanitizer;
  now?: () => Date;
  log?: ServiceLogger;
}

export class GoogleGateway {
  private readonly options: GoogleGatewayOptions;
  private readonly log: ServiceLogger;
  private index: CalendarIndex | null = null;
  private indexLoaded = false;

  constructor(options: GoogleGatewayOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
  }

  /**
   * Run one Google tool.
   *
   * Unknown tools and tools with no server are refused here rather than sent to
   * a child that would answer "unknown tool".
   */
  async callTool(tool: string, args: Record<string, unknown> = {}): Promise<GoogleCallResult> {
    const server = this.options.resolveServer(tool);
    if (!server) {
      return { ok: false, data: null, error: `"${tool}" is not a Google tool.`, retryable: false };
    }

    try {
      const result = await this.options.call(server, tool, args);
      if (!result.ok) {
        return { ok: false, data: null, error: result.error ?? `${tool} failed.`, retryable: result.retryable };
      }
      return { ok: true, data: this.options.sanitize(result.data), error: null, retryable: false };
    } catch (err) {
      // The caller is contractually non-throwing, but a bug in the manager should
      // still surface as a reported failure rather than a rejected promise.
      const message = err instanceof Error ? err.message : String(err);
      this.log("warn", `${tool} threw: ${message}`);
      return { ok: false, data: null, error: message, retryable: true };
    }
  }

  // ── calendars ──────────────────────────────────────────────────────────────

  /** The stored index, read once per process. `null` before the first refresh. */
  getIndex(): CalendarIndex | null {
    if (!this.indexLoaded) {
      this.index = readCalendarIndex(this.options.calendarFile);
      this.indexLoaded = true;
    }
    return this.index;
  }

  /** Forget the cached index, so the next read comes from disk. */
  invalidateIndex(): void {
    this.index = null;
    this.indexLoaded = false;
  }

  /**
   * Resolve a configured calendar name to an id.
   *
   * Falls back to the configured default, then `"primary"`, so an unconfigured
   * install still works.
   */
  resolveCalendarId(value?: string | null): string {
    const fallback = this.options.defaultCalendarId || "primary";
    return resolveFromIndex(this.getIndex(), value ?? fallback, fallback);
  }

  /** Ask Google for every calendar on the account. */
  async listCalendars(): Promise<{ ok: boolean; entries: CalendarEntry[]; error: string | null }> {
    const result = await this.callTool("calendar_list_calendars", {});
    if (!result.ok) return { ok: false, entries: [], error: result.error };

    const entries = coerceCalendarEntries(result.data);
    if (entries.length === 0) {
      return { ok: false, entries: [], error: "Google returned no calendars for this account." };
    }
    return { ok: true, entries, error: null };
  }

  /**
   * Refresh `<userData>/calendars.json` from the live calendar list.
   *
   * This is what makes a friendly name in Settings work, and it is the reason
   * the index is written by the app rather than shipped in the repository.
   */
  async refreshCalendarIndex(): Promise<{ ok: boolean; count: number; error: string | null }> {
    const listed = await this.listCalendars();
    if (!listed.ok) return { ok: false, count: 0, error: listed.error };

    const index = buildCalendarIndex(listed.entries, (this.options.now ?? (() => new Date()))());
    const written = writeCalendarIndex(this.options.calendarFile, index);
    if (!written.ok) {
      return { ok: false, count: 0, error: `Could not write the calendar index: ${written.error}` };
    }

    this.index = index;
    this.indexLoaded = true;
    this.log("info", `Calendar index refreshed: ${index.list.length} calendar(s).`);
    return { ok: true, count: index.list.length, error: null };
  }

  // ── diagnostics ────────────────────────────────────────────────────────────

  /**
   * One cheap real call per service.
   *
   * Deliberately shallow: the point is to prove the credentials work and the
   * child is alive, not to fetch anything. Runs both regardless of the first
   * outcome, so the panel can show two results from one click.
   */
  async probe(): Promise<{ gmail: GoogleServiceProbe; calendar: GoogleServiceProbe }> {
    const [gmail, calendar] = await Promise.all([
      this.callTool("gmail_list_messages", { maxResults: 1 }),
      this.callTool("calendar_list_calendars", {}),
    ]);

    return { gmail: describeProbe(gmail, countMessages), calendar: describeProbe(calendar, countCalendars) };
  }

  /** What the Settings panel shows without making a call. */
  describe(): { calendarFile: string; defaultCalendarId: string; indexedCalendars: number } {
    const index = this.getIndex() ?? emptyCalendarIndex();
    return {
      calendarFile: this.options.calendarFile,
      defaultCalendarId: this.options.defaultCalendarId || "primary",
      indexedCalendars: index.list.length,
    };
  }
}

/** Probe results describe themselves, but only if the call succeeded. */
function describeProbe(result: GoogleCallResult, describe: (data: unknown) => string): GoogleServiceProbe {
  if (!result.ok) return { ok: false, detail: result.error ?? "Failed." };
  try {
    return { ok: true, detail: describe(result.data) };
  } catch {
    return { ok: true, detail: "Connected." };
  }
}

function countMessages(data: unknown): string {
  const messages = (data as { messages?: unknown })?.messages;
  const count = Array.isArray(messages) ? messages.length : 0;
  return count === 0 ? "Connected. The mailbox is empty or nothing matched." : `Connected. ${count} recent message(s).`;
}

function countCalendars(data: unknown): string {
  const count = coerceCalendarEntries(data).length;
  return count === 0 ? "Connected, but the account has no calendars." : `Connected. ${count} calendar(s).`;
}
