/**
 * The in-app "Connect Google" flow.
 *
 * Runs the same consent flow as `scripts/gmail-auth.mjs` — both call
 * `mcp/lib/google-oauth.mjs`, so there is one implementation of the OAuth dance
 * rather than the two divergent ones the reference repo ended up with.
 *
 * Three rules this file exists to enforce:
 *
 *  1. **The refresh token never reaches the renderer.** It is written straight
 *     into `config.json` through `saveConfig`, which also refreshes
 *     `process.env`. The IPC result carries the account address and nothing else.
 *  2. **A flow can be cancelled.** The ported implementation had no cancel path,
 *     so closing the browser left the IPC call pending and a port bound for ten
 *     minutes.
 *  3. **One flow at a time.** Two concurrent loopback listeners would race to
 *     write the same config key.
 *
 * `scripts/` is not shipped in `extraResources`, which is exactly why this path
 * has to exist: a packaged install has no other way to obtain a token.
 */

import { shell } from "electron";

import { getConfig, saveConfig } from "./config";
import { loadMcpLib } from "./esm";
import { addLog } from "./logger";

/** The shape `mcp/lib/google-oauth.mjs` resolves with. */
interface ConsentResult {
  ok: boolean;
  refreshToken?: string;
  email?: string;
  error?: string;
}

interface OAuthModule {
  runLoopbackConsent: (options: {
    clientId: string;
    clientSecret: string;
    scopes?: string[];
    openUrl: (url: string) => unknown;
    signal?: AbortSignal;
  }) => Promise<ConsentResult>;
  STUDY_AIDE_SCOPES: string[];
  describeScopes: (scopes?: string[]) => string[];
}

export interface GoogleConnectResult {
  ok: boolean;
  /** The connected account, for display. Never a credential. */
  user?: string;
  error?: string;
}

/** The one flow that may be in progress. */
let active: AbortController | null = null;

export function googleConnectInProgress(): boolean {
  return active !== null;
}

/** The scopes the app asks for, as human-readable lines, for the Settings panel. */
export async function googleScopeDescriptions(): Promise<string[]> {
  try {
    const oauth = (await loadMcpLib("google-oauth.mjs")) as unknown as OAuthModule;
    return oauth.describeScopes(oauth.STUDY_AIDE_SCOPES);
  } catch {
    return [];
  }
}

/**
 * Run the consent flow and store the result.
 *
 * Never throws: every outcome is a result object, so the IPC handler can pass it
 * straight back to the renderer.
 */
export async function beginGoogleConnect(): Promise<GoogleConnectResult> {
  if (active) {
    return { ok: false, error: "A Google connection is already in progress." };
  }

  const config = getConfig();
  const clientId = String(config.GMAIL_CLIENT_ID ?? "").trim();
  const clientSecret = String(config.GMAIL_CLIENT_SECRET ?? "").trim();

  if (!clientId || !clientSecret) {
    const missing = [!clientId && "OAuth client id", !clientSecret && "OAuth client secret"]
      .filter(Boolean)
      .join(" and ");
    return {
      ok: false,
      error: `Set the ${missing} in Settings first, then connect.`,
    };
  }

  let oauth: OAuthModule;
  try {
    oauth = (await loadMcpLib("google-oauth.mjs")) as unknown as OAuthModule;
    if (typeof oauth.runLoopbackConsent !== "function") {
      throw new Error("google-oauth.mjs did not export runLoopbackConsent().");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog("mcp", "error", `Could not load the Google consent flow: ${message}`);
    return { ok: false, error: `The Google consent flow is unavailable: ${message}` };
  }

  const controller = new AbortController();
  active = controller;
  addLog("mcp", "info", "Opening the browser for a Google authorization.");

  try {
    const result = await oauth.runLoopbackConsent({
      clientId,
      clientSecret,
      scopes: oauth.STUDY_AIDE_SCOPES,
      openUrl: (url) => shell.openExternal(url),
      signal: controller.signal,
    });

    if (!result.ok || !result.refreshToken) {
      const error = result.error ?? "Google did not return a refresh token.";
      addLog("mcp", "warn", `Google authorization did not complete: ${error}`);
      return { ok: false, error };
    }

    // Straight to disk, then into `process.env`. The token is deliberately absent
    // from every log line and from the returned object.
    const saved = saveConfig({
      GMAIL_REFRESH_TOKEN: result.refreshToken,
      ...(result.email ? { GMAIL_USER: result.email } : {}),
    });
    if (!saved.success) {
      return { ok: false, error: `Authorized, but the token could not be saved: ${saved.error}` };
    }

    addLog("mcp", "info", `Google connected${result.email ? ` as ${result.email}` : ""}.`);
    // Nothing has to be restarted: the MCP manager compares a credential
    // fingerprint before every call and replaces the child when it changes.
    return { ok: true, user: result.email || undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog("mcp", "error", `Google authorization failed: ${message}`);
    return { ok: false, error: message };
  } finally {
    active = null;
  }
}

/** Cancel the flow in progress. Returns false when there was nothing to cancel. */
export function cancelGoogleConnect(): boolean {
  if (!active) return false;
  active.abort();
  return true;
}

/** Set when the app is quitting, so a half-finished flow does not block exit. */
export function abortGoogleConnectOnQuit(): void {
  active?.abort();
  active = null;
}
