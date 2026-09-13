/**
 * Fill missing Google settings from the repository's `.env`.
 *
 * Only needed when a server is launched **outside the app** — from VS Code via
 * `.vscode/mcp.json`, or by hand — because the app injects the credentials into
 * the child environment explicitly and they are always already present.
 *
 * Non-destructive by construction: `loadEnvInto` writes a key only when it is
 * absent, so a credential the parent injected can never be overwritten by a
 * stale line in a file.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * @returns {{source: string, loadedKeys: string[]}} What was filled in, for the
 *   caller to log to stderr. Never returns a value, only key names.
 */
export function bootstrapEnv(target = process.env) {
  try {
    const config = require("../../shared/config-loader.cjs");
    if (typeof config?.loadEnvInto !== "function") return { source: "none", loadedKeys: [] };
    return config.loadEnvInto(target);
  } catch {
    // A packaged install has no repository `.env`, and neither does a checkout
    // that has never run the auth script. Both are ordinary.
    return { source: "none", loadedKeys: [] };
  }
}
