#!/usr/bin/env node
/**
 * Obtain the Google refresh token, from a terminal.
 *
 *   node scripts/gmail-auth.mjs
 *
 * This is the developer path. The app also has a "Connect Google" button that
 * runs exactly the same consent flow in-process; this script exists for a fresh
 * checkout where you would rather not launch the app, and for recovering when
 * the in-app flow cannot open a browser.
 *
 * `scripts/` is deliberately not shipped in `extraResources`, so this stays a
 * developer operation and never becomes something a packaged install depends on.
 *
 * Where the OAuth client comes from, in order:
 *   1. `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` in the environment
 *   2. the repository's `config.json` or `.env`
 *   3. `safe/gmail-oauth2.json` — the OAuth client JSON downloaded from Google
 *
 * The refresh token is written to `tokens/gmail-token.json` (gitignored) and
 * printed for you to paste into Settings. The client secret is never printed.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describeScopes, runLoopbackConsent, STUDY_AIDE_SCOPES } from "../mcp/lib/google-oauth.mjs";
import { describeError } from "../mcp/lib/google-client.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CREDENTIALS_PATH = path.join(ROOT, "safe", "gmail-oauth2.json");
const TOKEN_PATH = path.join(ROOT, "tokens", "gmail-token.json");
const CONFIG_PATH = path.join(ROOT, "config.json");
const ENV_PATH = path.join(ROOT, ".env");

const SCOPE_HINT =
  "Google Cloud Console → APIs & Services → Credentials → Create credentials → " +
  "OAuth client ID → Desktop app, then download the JSON.";

function readCredentials() {
  // 1 + 2: an explicit env var wins; then the repo's own config layers.
  try {
    require(path.join(ROOT, "shared", "config-loader.cjs")).loadEnvInto(process.env);
  } catch {
    // No config-loader or no .env — the keyfile fallback below still works.
  }
  const fromEnv = {
    clientId: String(process.env.GMAIL_CLIENT_ID ?? "").trim(),
    clientSecret: String(process.env.GMAIL_CLIENT_SECRET ?? "").trim(),
  };
  if (fromEnv.clientId && fromEnv.clientSecret) {
    return { ...fromEnv, source: "environment (or config.json / .env)" };
  }

  // 3: the downloaded OAuth client JSON.
  try {
    const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    const block = raw.installed ?? raw.web ?? raw;
    const clientId = String(block?.client_id ?? "").trim();
    const clientSecret = String(block?.client_secret ?? "").trim();
    if (clientId && clientSecret) {
      return { clientId, clientSecret, source: path.relative(ROOT, CREDENTIALS_PATH) };
    }
  } catch {
    // Missing or malformed; reported below.
  }

  return { clientId: "", clientSecret: "", source: "" };
}

/** Open the system browser, without holding the process open. */
function openUrl(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  try {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // `openUrl` is best-effort: the URL is printed either way.
  }
}

function writeToken(refreshToken, email) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  // Deliberately narrower than the usual token file: no client secret and no
  // access token, because neither is needed again and both would be extra
  // credentials at rest.
  const payload = {
    type: "authorized_user",
    email: email || null,
    refresh_token: refreshToken,
    obtained_at: new Date().toISOString(),
  };
  fs.writeFileSync(TOKEN_PATH, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function rule() {
  console.log("──────────────────────────────────────────────────────────────");
}

async function main() {
  const credentials = readCredentials();

  rule();
  console.log("Study Aide — connect Google (Gmail + Calendar + Tasks)");
  rule();
  console.log(`Repository:  ${ROOT}`);
  console.log(`Scopes:      ${describeScopes(STUDY_AIDE_SCOPES).join(", ")}`);

  if (!credentials.clientId || !credentials.clientSecret) {
    console.error("");
    console.error("✗ No OAuth client found.");
    console.error("");
    console.error(`  Looked in: ${path.relative(ROOT, ENV_PATH)}, ${path.relative(ROOT, CONFIG_PATH)},`);
    console.error(`             ${path.relative(ROOT, CREDENTIALS_PATH)}`);
    console.error("");
    console.error("  To fix: create a Desktop app OAuth client and save the JSON as");
    console.error(`          ${CREDENTIALS_PATH}`);
    console.error("");
    console.error(`  ${SCOPE_HINT}`);
    console.error("");
    console.error("  Or set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in the environment.");
    process.exitCode = 1;
    return;
  }

  console.log(`Client:      ${credentials.source}`);
  console.log("");
  console.log("Opening your browser. If nothing happens, paste the URL below.");
  console.log("");

  const result = await runLoopbackConsent({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    scopes: STUDY_AIDE_SCOPES,
    openUrl: (url) => {
      console.log(url);
      console.log("");
      openUrl(url);
    },
  });

  if (!result.ok) {
    console.error("");
    console.error(`✗ ${result.error}`);
    process.exitCode = 1;
    return;
  }

  writeToken(result.refreshToken, result.email);

  console.log("");
  rule();
  console.log("✓ Authorized");
  rule();
  console.log(`Account:  ${result.email || "(address unavailable)"}`);
  console.log(`Token:    ${path.relative(ROOT, TOKEN_PATH)}`);
  console.log("");
  console.log("Add these to your .env, or paste them into Settings → Google:");
  console.log("");
  console.log(`GMAIL_REFRESH_TOKEN=${result.refreshToken}`);
  console.log(`GMAIL_USER=${result.email || "me"}`);
  console.log("");
  console.log("The refresh token is a secret. Don't commit it, paste it into a chat,");
  console.log("or send it anywhere. The client secret is never printed.");
  console.log("");
}

main().catch((err) => {
  console.error(`✗ Authorization failed: ${describeError(err)}`);
  process.exitCode = 1;
});
