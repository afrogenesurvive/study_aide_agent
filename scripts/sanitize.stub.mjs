/**
 * Re-export shim.
 *
 * The scrubber moved to `shared/sanitize.mjs` in phase 3, because `shared/` is
 * shipped as a runtime resource (`extraResources`) while `scripts/` is not — the
 * agent-runner needs the scrubber at runtime. This path is kept so the MCP
 * servers added in phase 4 can import either location.
 */

export { sanitize, sanitizeObject, sanitizeWithAudit } from "../shared/sanitize.mjs";


export function hasPrivatePatterns() {
  return impl !== null;
}
