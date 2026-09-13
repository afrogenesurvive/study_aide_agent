/**
 * Google IPC.
 *
 * The boundary rules from `generation.ipc.ts` apply here too: config is read
 * **at the edge** and passed down, every refusal comes back as data rather than a
 * throw, and a failure is logged with `addLog`.
 *
 * One rule is specific to this file: **no credential ever crosses to the
 * renderer**. The status payload reports whether each secret is present and never
 * a prefix, a suffix or a length; `google:connect` returns the account address and
 * nothing else, because the token goes straight into `config.json` in main.
 */

import { ipcMain } from "electron";

import { executorFor } from "../../../services/generation/tools";
import { GoogleGateway, type PayloadSanitizer } from "../../../services/google";
import { getConfig } from "../config";
import { loadSharedModule } from "../esm";
import {
  beginGoogleConnect,
  cancelGoogleConnect,
  googleConnectInProgress,
  googleScopeDescriptions,
} from "../google-auth";
import { addLog } from "../logger";
import { tryGetMcp } from "../mcp";
import { userDataPath } from "../paths";
import type {
  GoogleActionResult,
  GoogleConnectResult,
  GoogleStatusPayload,
  GoogleTestResult,
} from "../../shared/google-types";

const GOOGLE_SECRET_KEYS = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(error: string): GoogleActionResult {
  addLog("mcp", "warn", error);
  return { ok: false, error };
}

/** `<userData>/calendars.json` — beside `model-pricing.json`, not in the repo. */
function calendarFile(): string {
  return userDataPath("calendars.json");
}

/**
 * The object scrubber from `shared/sanitize.mjs`, loaded once.
 *
 * Falls back to a pass-through when the module cannot be loaded. That is a
 * deliberate degradation rather than a hard failure: the MCP servers already
 * scrub at their own boundary, so this layer is the second of two, and losing it
 * must not stop the app talking to Google.
 */
let sanitizer: PayloadSanitizer | null = null;

async function payloadSanitizer(): Promise<PayloadSanitizer> {
  if (sanitizer) return sanitizer;
  try {
    const mod = await loadSharedModule("sanitize.mjs");
    const fn = mod.sanitizeObject;
    if (typeof fn === "function") {
      const scrub = fn as (value: unknown) => unknown;
      sanitizer = (value: unknown) => scrub(value);
      return sanitizer;
    }
    addLog("mcp", "warn", "shared/sanitize.mjs did not export sanitizeObject(); payloads are not scrubbed.");
  } catch (err) {
    addLog("mcp", "warn", `Could not load the sanitizer: ${describe(err)}`);
  }
  sanitizer = (value: unknown) => value;
  return sanitizer;
}

/**
 * A gateway bound to the current config.
 *
 * Built per call rather than cached, so a calendar id edited in Settings takes
 * effect immediately. The only I/O is reading `calendars.json`, which is a few
 * hundred bytes on a user-initiated action.
 */
async function createGateway(): Promise<GoogleGateway> {
  const config = getConfig();
  return new GoogleGateway({
    // Routing comes from the registry, so this file owns no tool list.
    resolveServer: (tool) => executorFor(tool)?.mcpServer ?? null,
    call: async (server, tool, args) => {
      const mcp = tryGetMcp();
      if (!mcp) {
        return { ok: false, data: null, error: "The MCP servers are not initialised.", retryable: true };
      }
      return mcp.call(server, tool, args);
    },
    calendarFile: calendarFile(),
    defaultCalendarId: String(config.GOOGLE_CALENDAR_ID ?? "primary"),
    sanitize: await payloadSanitizer(),
    log: (level, message) => addLog("mcp", level, message),
  });
}

export function registerGoogleIpc(): void {
  ipcMain.handle("google:status", async (): Promise<GoogleStatusPayload> => {
    const config = getConfig();
    const missing = GOOGLE_SECRET_KEYS.filter((key) => !String(config[key] ?? "").trim());

    let indexedCalendars = 0;
    try {
      indexedCalendars = (await createGateway()).describe().indexedCalendars;
    } catch (err) {
      // A status readout must never fail; an unreadable index is simply zero.
      addLog("mcp", "debug", `Could not read the calendar index: ${describe(err)}`);
    }

    return {
      configured: missing.length === 0,
      missing: [...missing],
      user: String(config.GMAIL_USER ?? "me"),
      calendarId: String(config.GOOGLE_CALENDAR_ID ?? "primary"),
      calendarFile: calendarFile(),
      indexedCalendars,
      connecting: googleConnectInProgress(),
      scopes: await googleScopeDescriptions(),
      // `snapshot`, not `describe`: showing status must not spawn a child.
      servers: (tryGetMcp()?.snapshot() ?? []).map((server) => ({
        name: server.name,
        state: server.state,
        toolCount: server.toolCount,
        error: server.lastError,
      })),
    };
  });

  /**
   * One real, cheap call per service.
   *
   * Clicking this is what starts the MCP children, so it doubles as the check
   * that the servers can spawn at all — which is otherwise invisible until a
   * pipeline tries to send something.
   */
  ipcMain.handle("google:test", async (): Promise<GoogleTestResult | GoogleActionResult> => {
    try {
      const probes = await (await createGateway()).probe();
      addLog(
        "mcp",
        probes.gmail.ok && probes.calendar.ok ? "info" : "warn",
        `Google test — Gmail: ${probes.gmail.detail} Calendar: ${probes.calendar.detail}`,
      );
      return probes;
    } catch (err) {
      return fail(`Could not reach Google: ${describe(err)}`);
    }
  });

  ipcMain.handle("google:connect", async (): Promise<GoogleConnectResult> => {
    try {
      return await beginGoogleConnect();
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  });

  ipcMain.handle("google:cancel", (): GoogleActionResult => {
    const cancelled = cancelGoogleConnect();
    if (cancelled) addLog("mcp", "info", "Google authorization cancelled.");
    return { ok: cancelled, ...(cancelled ? {} : { error: "Nothing to cancel." }) };
  });

  /**
   * Refresh `<userData>/calendars.json` from the live calendar list.
   *
   * This is what turns a friendly name in Settings into an id the Calendar API
   * accepts. The ported implementation had the same map but no way to populate
   * it, so it only ever resolved `"primary"`.
   */
  ipcMain.handle("google:refreshCalendars", async (): Promise<GoogleActionResult> => {
    try {
      const result = await (await createGateway()).refreshCalendarIndex();
      if (!result.ok) return fail(result.error ?? "Could not refresh the calendar list.");
      addLog("mcp", "info", `Indexed ${result.count} calendar(s).`);
      return { ok: true, count: result.count };
    } catch (err) {
      return fail(`Could not refresh the calendar list: ${describe(err)}`);
    }
  });

  /** Drop the running children so the next call spawns them from fresh settings. */
  ipcMain.handle("google:restartServers", async (): Promise<GoogleActionResult> => {
    try {
      const mcp = tryGetMcp();
      if (!mcp) return fail("The MCP servers are not initialised.");
      await mcp.restart();
      addLog("mcp", "info", "MCP servers restarted; they will start again on the next call.");
      return { ok: true };
    } catch (err) {
      return fail(`Could not restart the MCP servers: ${describe(err)}`);
    }
  });
}
