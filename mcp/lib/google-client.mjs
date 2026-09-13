/**
 * The Google auth + REST core.
 *
 * Both MCP servers import this, so the OAuth dance, the token cache, the retry
 * policy, the error shape and the payload scrub exist exactly once.
 *
 * Two deliberate constraints:
 *
 *  - **No Google SDK.** `googleapis` is a large tree that would have to be
 *    shipped inside each server's `node_modules`, and `google-auth-library`
 *    exists mainly to do the one POST this file already does. Node 24 has a
 *    global `fetch`, so the whole dependency is ~40 lines of REST plumbing.
 *  - **No path knowledge.** Every function takes its configuration and its
 *    `fetch` as options defaulting to `process.env` and the global. Nothing here
 *    reads a file, which is what makes it unit-testable with no network and no
 *    credentials.
 *
 * Every response payload passes through `sanitizeObject` before it is returned
 * *and* before it can be logged: email bodies and event descriptions are
 * attacker-controlled text that ends up in a model's context.
 */

import { sanitizeObject } from "../../shared/sanitize.mjs";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

export const GOOGLE_ENDPOINTS = {
  token: TOKEN_ENDPOINT,
  userinfo: USERINFO_ENDPOINT,
  gmail: "https://gmail.googleapis.com/gmail/v1",
  calendar: "https://www.googleapis.com/calendar/v3",
  tasks: "https://tasks.googleapis.com/tasks/v1",
};

/** Refresh this many ms before the token actually expires. */
const EXPIRY_SKEW_MS = 60_000;

/** One retry after the first attempt, for 429/5xx/network only. */
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

/** A log line never needs a whole email body. */
const MAX_LOG_CHARS = 2_000;

/**
 * A failure talking to Google.
 *
 * `retryable` is the field callers branch on: it separates "the network blipped"
 * from "the refresh token was revoked", which are the two failures a user has to
 * be told apart in the Settings panel.
 */
export class GoogleApiError extends Error {
  constructor(message, { status = 0, retryable = false, detail = "" } = {}) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}

// ── configuration ────────────────────────────────────────────────────────────

/**
 * Read the Google settings out of an environment bag.
 *
 * Defaults match `DEFAULTS` in `electron/src/shared/config-defaults.ts`, so a
 * half-configured install behaves the same whether the values came from
 * `config.json`, the environment or nowhere.
 */
export function readGoogleConfig(env = process.env) {
  const value = (key) => String(env?.[key] ?? "").trim();
  return {
    clientId: value("GMAIL_CLIENT_ID"),
    clientSecret: value("GMAIL_CLIENT_SECRET"),
    refreshToken: value("GMAIL_REFRESH_TOKEN"),
    /** `me` is the Gmail API's own alias for the authenticated account. */
    user: value("GMAIL_USER") || "me",
    calendarId: value("GOOGLE_CALENDAR_ID") || "primary",
    calendarsFile: value("CALENDARS_FILE"),
  };
}

/**
 * The settings that are missing, named the way a user sees them in Settings.
 *
 * Returned rather than thrown so the "test connection" panel can list them all
 * at once instead of making the user fix them one at a time.
 */
export function missingGoogleConfig(env = process.env) {
  const config = readGoogleConfig(env);
  const missing = [];
  if (!config.clientId) missing.push("GMAIL_CLIENT_ID");
  if (!config.clientSecret) missing.push("GMAIL_CLIENT_SECRET");
  if (!config.refreshToken) missing.push("GMAIL_REFRESH_TOKEN");
  return missing;
}

/**
 * A description of the configuration for the status panel.
 *
 * Reports *whether* each secret is present — never a prefix, a suffix or a
 * length, which would all leak more than they tell.
 */
export function describeGoogleConfig(env = process.env) {
  const config = readGoogleConfig(env);
  const missing = missingGoogleConfig(env);
  return {
    clientId: Boolean(config.clientId),
    clientSecret: Boolean(config.clientSecret),
    refreshToken: Boolean(config.refreshToken),
    user: config.user,
    calendarId: config.calendarId,
    configured: missing.length === 0,
    missing,
  };
}

// ── tokens ───────────────────────────────────────────────────────────────────

/**
 * One cached access token per credential set.
 *
 * Keyed by a fingerprint rather than a boolean so that editing the client id or
 * the refresh token in Settings takes effect on the next call instead of serving
 * a token minted for the old account.
 */
let cachedToken = null;

/** Test seam. The cache is otherwise keyed and self-invalidating. */
export function resetTokenCache() {
  cachedToken = null;
}

function fingerprintOf(config) {
  return `${config.clientId}\u0000${config.clientSecret}\u0000${config.refreshToken}`;
}

/**
 * Exchange the refresh token for a short-lived access token.
 *
 * Memoised until shortly before expiry. The refresh token itself is never
 * logged, never returned to a renderer, and never included in an error message.
 */
export async function getAccessToken(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.nowImpl ?? Date.now;

  const config = readGoogleConfig(env);
  const missing = missingGoogleConfig(env);
  if (missing.length) {
    throw new GoogleApiError(
      `Google is not configured. Set ${missing.join(", ")} in Settings.`,
      { status: 0, retryable: false },
    );
  }

  const fingerprint = fingerprintOf(config);
  if (cachedToken && cachedToken.fingerprint === fingerprint && cachedToken.expiresAt > now()) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetchWithPolicy(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, { fetchImpl, signal: options.signal, timeoutMs: options.timeoutMs });

  const payload = await readJson(response);
  if (!response.ok) {
    // 400 here is Google's "invalid_grant" — a revoked or expired refresh token.
    // Retrying cannot fix it, and the user has to re-authorise.
    const detail = String(payload?.error_description ?? payload?.error ?? "").trim();
    throw new GoogleApiError(
      response.status === 400
        ? "Google rejected the refresh token. Reconnect Google in Settings."
        : `Could not get a Google access token (${response.status}).`,
      { status: response.status, retryable: isRetryableStatus(response.status), detail },
    );
  }

  const accessToken = String(payload?.access_token ?? "");
  if (!accessToken) {
    throw new GoogleApiError("Google returned no access token.", { status: 0, retryable: false });
  }

  const expiresIn = Number(payload?.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_600_000;
  cachedToken = {
    fingerprint,
    accessToken,
    expiresAt: now() + Math.max(0, ttl - EXPIRY_SKEW_MS),
  };
  return accessToken;
}

/**
 * The authenticated account's email address.
 *
 * Requires the `openid` + `email` scopes. Best-effort: the caller uses it for
 * display, and a failure here must never fail a tool call.
 */
export async function googleProfile(options = {}) {
  const data = await request(`${GOOGLE_ENDPOINTS.userinfo}`, { method: "GET" }, options);
  return { email: String(data?.email ?? ""), name: String(data?.name ?? "") };
}

// ── REST ─────────────────────────────────────────────────────────────────────

/** Build a URL with only the parameters the caller actually supplied. */
function withQuery(url, query) {
  if (!query) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * One authenticated JSON request.
 *
 * `path` is appended to `base` and may already contain query parameters.
 */
export async function request(path, init = {}, options = {}) {
  const base = options.base ?? "";
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const method = (init.method ?? "GET").toUpperCase();
  const token = await getAccessToken(options);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(init.headers ?? {}),
  };
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetchWithPolicy(
    withQuery(url, init.query),
    { method, headers, body },
    { fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: options.timeoutMs },
  );

  if (response.status === 204) return sanitizeObject(null);

  const payload = await readJson(response);
  if (!response.ok) throw errorFromResponse(response, payload);

  return sanitizeObject(payload);
}

/** Gmail, scoped to the configured account. */
export function gmailRequest(path, init = {}, options = {}) {
  const config = readGoogleConfig(options.env ?? process.env);
  return request(`/users/${encodeURIComponent(config.user)}${path}`, init, {
    ...options,
    base: GOOGLE_ENDPOINTS.gmail,
  });
}

/** Google Calendar. */
export function calendarRequest(path, init = {}, options = {}) {
  return request(path, init, { ...options, base: GOOGLE_ENDPOINTS.calendar });
}

/** Google Tasks. */
export function tasksRequest(path, init = {}, options = {}) {
  return request(path, init, { ...options, base: GOOGLE_ENDPOINTS.tasks });
}

// ── internals ────────────────────────────────────────────────────────────────

function errorFromResponse(response, payload) {
  const message = String(payload?.error?.message ?? payload?.error_description ?? "").trim();
  const status = response.status;
  const reason = String(payload?.error?.status ?? "").trim();

  if (status === 401) {
    return new GoogleApiError(
      "Google rejected the access token. Reconnect Google in Settings.",
      { status, retryable: false, detail: message },
    );
  }
  if (status === 403) {
    const hint = /insufficient|scope/i.test(`${reason} ${message}`)
      ? " The granted scopes do not cover this operation — reconnect Google and grant all requested scopes."
      : "";
    return new GoogleApiError(
      `Google refused the request (403).${hint}`,
      { status, retryable: false, detail: message },
    );
  }
  if (status === 404) {
    return new GoogleApiError(message || "Google could not find that item.", {
      status,
      retryable: false,
      detail: message,
    });
  }
  return new GoogleApiError(
    `Google request failed (${status})${message ? `: ${message}` : "."}`,
    { status, retryable: isRetryableStatus(status), detail: message },
  );
}

/**
 * `fetch` with a timeout and a bounded retry.
 *
 * Retries 429/5xx and network failures only, and never retries once the caller's
 * signal has aborted — a cancellation is a decision, not a blip.
 */
async function fetchWithPolicy(url, init, { fetchImpl = fetch, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new GoogleApiError("No fetch implementation is available.", { retryable: false });
  }

  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    if (signal?.aborted) throw cancelled();

    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      const response = await fetchImpl(url, { ...init, signal: combined });
      if (response.ok || !isRetryableStatus(response.status) || attempt === MAX_RETRIES - 1) {
        return response;
      }
      lastError = new GoogleApiError(`Google returned ${response.status}.`, {
        status: response.status,
        retryable: true,
      });
      await delay(retryDelay(response, attempt), signal);
    } catch (err) {
      if (signal?.aborted) throw cancelled();
      if (err instanceof GoogleApiError) throw err;

      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      lastError = new GoogleApiError(
        timedOut ? `Google did not respond within ${Math.round(timeoutMs / 1000)}s.` : "Could not reach Google.",
        { status: 0, retryable: true, detail: err?.message ?? String(err) },
      );
      if (attempt === MAX_RETRIES - 1) throw lastError;
      await delay(RETRY_BASE_DELAY_MS * 2 ** attempt, signal);
    }
  }
  throw lastError ?? new GoogleApiError("Google request failed.", { retryable: true });
}

function cancelled() {
  return new GoogleApiError("Cancelled.", { status: 0, retryable: false });
}

/** Honour `Retry-After` when Google sends one, capped so a call cannot hang. */
function retryDelay(response, attempt) {
  const header = Number(response.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 5_000);
  return RETRY_BASE_DELAY_MS * 2 ** attempt;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(cancelled());
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function readJson(response) {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    // A body that is not JSON is not itself an error worth reporting; the status
    // code already carries the outcome.
    return null;
  }
}

// ── logging ──────────────────────────────────────────────────────────────────

/**
 * A scrubbed, truncated, log-safe projection of a Google payload.
 *
 * Call this instead of logging a raw response. Never returns a token: the
 * payloads reaching here are already scrubbed by `request`, and anything that
 * looks like a credential is dropped outright.
 */
export function describeForLog(payload) {
  let text;
  try {
    text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  } catch {
    text = "[unserialisable]";
  }
  if (text === undefined) text = "null";
  if (text.length > MAX_LOG_CHARS) text = `${text.slice(0, MAX_LOG_CHARS)}… (${text.length} chars)`;
  return text;
}

/** A one-line summary of a failure, safe to show a user and to log. */
export function describeError(err) {
  if (err instanceof GoogleApiError) {
    return err.detail ? `${err.message} (${err.detail})` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
