/**
 * The Google consent flow, implemented once.
 *
 * Two callers depend on this:
 *
 *  - `scripts/gmail-auth.mjs`, run from a terminal by a developer.
 *  - `electron/src/main/google-auth.ts`, behind the Settings "Connect Google"
 *    button. It passes Electron's `shell.openExternal` as `openUrl`.
 *
 * Nothing here imports Electron or reads a file — the browser is opened through
 * the injected `openUrl`, so the same code runs in a bare Node process and inside
 * a packaged app.
 *
 * Departures from the implementation this was ported from, all deliberate:
 *
 *  - **PKCE (S256).** The loopback leg is the one place a code can be
 *    intercepted on a shared machine, and PKCE closes it for ~10 lines of
 *    `node:crypto`. The client secret is still sent, because the OAuth client is
 *    a "Desktop app" one.
 *  - **The callback page tells the truth.** The original unconditionally rendered
 *    "Authorization complete", so a user who clicked Deny saw a success page
 *    while the app silently failed.
 *  - **Cancellable.** The original had no cancel path at all: closing the browser
 *    left the IPC call pending and the port bound for ten minutes.
 *  - **A `server.on("error")` handler**, so a port that cannot be bound is
 *    reported instead of crashing the process.
 *  - **Three-minute timeout** rather than ten.
 */

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

/** Three minutes is long enough to consent, short enough to fail visibly. */
export const DEFAULT_CONSENT_TIMEOUT_MS = 180_000;

/**
 * The scopes this app asks for: the narrowest set that covers its features.
 *
 * `gmail.readonly` is a restricted scope. Test users on your own Google Cloud
 * project are fine; distribution would need Google's verification. Nothing
 * broader is requested, so the consent screen says what the app actually does.
 */
export const STUDY_AIDE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
  // Not used for data access — `email` is what makes the userinfo call return the
  // address we show in Settings, and `openid` is required alongside it.
  "openid",
  "email",
];

/** Human-readable scope list, for the Settings panel and the auth script. */
export function describeScopes(scopes = STUDY_AIDE_SCOPES) {
  const labels = {
    "https://www.googleapis.com/auth/gmail.send": "Send email as you",
    "https://www.googleapis.com/auth/gmail.readonly": "Read your email",
    "https://www.googleapis.com/auth/calendar.events": "Read and write your calendar events",
    "https://www.googleapis.com/auth/tasks": "Read and write your tasks",
    openid: "Confirm your identity",
    email: "See your email address",
  };
  return scopes.map((scope) => labels[scope] ?? scope);
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh verifier/challenge pair. Exported so it can be unit-tested. */
export function createPkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** The consent URL. Pure, so the parameters can be asserted without a browser. */
export function buildAuthUrl({ clientId, redirectUri, scopes = STUDY_AIDE_SCOPES, state, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    // `offline` + `consent` together are what guarantee a refresh token. Without
    // `prompt=consent` a re-authorisation returns no refresh token at all, and
    // the app silently keeps working until the old token is revoked.
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// ── callback pages ───────────────────────────────────────────────────────────

const PAGE_STYLE =
  "font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;" +
  "display:flex;align-items:center;justify-content:center;height:100vh;margin:0";

function page({ title, heading, colour, body }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="${PAGE_STYLE}">
<div style="max-width:32rem;text-align:center">
<h2 style="color:${colour};margin:0 0 .5rem">${heading}</h2>
<p style="margin:0;line-height:1.5">${body}</p>
</div></body></html>`;
}

/** The page shown when the token exchange succeeded. */
export function successPage(user) {
  return page({
    title: "Authorization complete",
    heading: "\u2713 Authorization complete",
    colour: "#3fb950",
    body: user
      ? `Connected as <strong>${escapeHtml(user)}</strong>. You can close this tab and return to Study Aide.`
      : "You can close this tab and return to Study Aide.",
  });
}

/** The page shown whenever consent did not complete. */
export function failurePage(reason) {
  return page({
    title: "Authorization failed",
    heading: "\u2717 Authorization failed",
    colour: "#f85149",
    body: `${escapeHtml(reason)} You can close this tab and try again from Settings.`,
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── the flow ─────────────────────────────────────────────────────────────────

/**
 * Run the consent flow and return a refresh token.
 *
 * Never throws and never rejects: every outcome is a discriminated result, so an
 * IPC handler can pass it straight to the renderer without a try/catch.
 *
 * @param {object} options
 * @param {string} options.clientId
 * @param {string} options.clientSecret
 * @param {(url: string) => unknown} options.openUrl  Opens the system browser.
 * @param {string[]} [options.scopes]
 * @param {number} [options.port]        Loopback port; 0 picks a free one.
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal] Cancels the flow and closes the server.
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function runLoopbackConsent(options = {}) {
  const {
    clientId,
    clientSecret,
    openUrl,
    scopes = STUDY_AIDE_SCOPES,
    port = 0,
    timeoutMs = DEFAULT_CONSENT_TIMEOUT_MS,
    signal,
    fetchImpl = fetch,
  } = options;

  if (!clientId || !clientSecret) {
    return { ok: false, error: "GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set before connecting." };
  }
  if (typeof openUrl !== "function") {
    return { ok: false, error: "No way to open a browser was provided." };
  }
  if (!fetchImpl) {
    return { ok: false, error: "No fetch implementation is available." };
  }

  const state = randomBytes(16).toString("hex");
  const { verifier, challenge } = createPkcePair();

  /** @type {http.Server | null} */
  let server = null;
  let settled = false;
  let timer = null;

  return new Promise((resolve) => {
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
      try {
        server?.close();
      } catch {
        // Already closed, or never listening — nothing to do.
      }
    };

    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    function onAbort() {
      settle({ ok: false, error: "Cancelled." });
    }

    /** Exchange the code, then fetch the account's address. */
    const finish = async (code, redirectUri) => {
      try {
        const response = await fetchImpl(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
            code_verifier: verifier,
          }).toString(),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.refresh_token) {
          // A successful exchange with no refresh token means Google treated this
          // as a repeat consent. Say so, because "it didn't work" is unactionable.
          const detail = String(payload?.error_description ?? payload?.error ?? "").trim();
          if (response.ok && !payload?.refresh_token) {
            settle({
              ok: false,
              error:
                "Google did not return a refresh token. Remove Study Aide from your Google account's third-party access, then connect again.",
            });
            return;
          }
          settle({
            ok: false,
            error: `Token exchange failed (${response.status})${detail ? `: ${detail}` : "."}`,
          });
          return;
        }

        settle({ ok: true, refreshToken: String(payload.refresh_token), email: await fetchEmail(payload.access_token, fetchImpl) });
      } catch (err) {
        settle({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };

    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      const denied = url.searchParams.get("error");
      if (denied) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(failurePage("Google reported that access was not granted."));
        settle({ ok: false, error: `Google authorization failed: ${denied}` });
        return;
      }

      if (url.searchParams.get("state") !== state) {
        // A mismatched or replayed callback is refused *and* shown as a failure,
        // rather than being answered with a success page.
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(failurePage("The authorization response did not match this request."));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(failurePage("Google returned no authorization code."));
        settle({ ok: false, error: "No authorization code returned." });
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(successPage(""));
      void finish(code, `http://127.0.0.1:${server.address().port}/`);
    });

    // Without this, a port that cannot be bound is an unhandled 'error' event.
    server.on("error", (err) => {
      settle({ ok: false, error: `Could not start the local callback server: ${err.message}` });
    });

    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    server.listen(port, "127.0.0.1", () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/`;
      timer = setTimeout(() => {
        settle({ ok: false, error: "Timed out waiting for Google. No authorization code was returned." });
      }, timeoutMs);
      // Unref'd so a forgotten consent flow can never hold the process open.
      timer.unref?.();

      try {
        void openUrl(buildAuthUrl({ clientId, redirectUri, scopes, state, challenge }));
      } catch (err) {
        settle({ ok: false, error: `Could not open a browser: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  });
}

/** Best-effort; the address is for display only. */
async function fetchEmail(accessToken, fetchImpl) {
  try {
    const response = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return "";
    const payload = await response.json();
    return String(payload?.email ?? "");
  } catch {
    return "";
  }
}
