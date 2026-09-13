/**
 * Prompt-injection scrubbing facade (ESM).
 *
 * Two layers, matching `electron/services/llm/sanitize.ts`:
 *
 *  1. The always-on baseline from `sanitize-core.mjs`. It cannot be disabled —
 *     `sanitizeObject` runs it even when no private pattern set is installed, so
 *     a public checkout still scrubs untrusted email and event payloads.
 *  2. The private pattern set, when one is installed, layered on top of the
 *     baseline result rather than replacing it. Add `sanitize.private.mjs` next
 *     to this file (gitignored) exporting `sanitize`, `sanitizeObject` and
 *     `sanitizeWithAudit`.
 *
 * Every external payload (email bodies, event descriptions, imported syllabus
 * text) should pass through here before it reaches the LLM or the log files.
 *
 * Lives in `shared/` rather than `scripts/` because it is shipped as a runtime
 * resource — `extraResources` copies `shared/`, but not `scripts/`.
 */

import { scrubObject, scrubObjectWithAudit } from "./sanitize-core.mjs";

const EMPTY_AUDIT = {
  sanitized: "",
  originalHash: "",
  injected: false,
  patterns: [],
  hadHidden: false,
};

function baselineSanitizeObject(value) {
  return scrubObject(value);
}

function baselineSanitizeWithAudit(value) {
  const audit = scrubObjectWithAudit(value);
  return {
    ...EMPTY_AUDIT,
    sanitized: audit.sanitized,
    originalHash: audit.originalHash,
    injected: audit.injected,
    patterns: audit.patterns,
    hadHidden: audit.hadHidden,
  };
}

let impl = null;
let loaded = false;

async function loadImpl() {
  if (loaded) return impl;
  loaded = true;
  try {
    impl = await import("./sanitize.private.mjs");
  } catch (err) {
    if (err && err.code !== "ERR_MODULE_NOT_FOUND") throw err;
    impl = null;
  }
  return impl;
}

// Load eagerly but never throw: a missing private module is the normal case.
await loadImpl();

/**
 * Scrub one string.
 *
 * The fallback is deliberately an identity pass-through, and is *not* the same
 * shape as the object path below. For text there is already an always-on
 * baseline — `baseline()` in `services/llm/sanitize.ts` — which runs before this
 * module is ever consulted, so repeating it here would apply it twice and would
 * change the phase-3 text path. Use `scrubText` from `sanitize-core.mjs` when you
 * need standalone text scrubbing with no layer above you.
 */
export function sanitize(value) {
  if (impl?.sanitize) return impl.sanitize(value);
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * Scrub an external object payload (a decoded Gmail body, a calendar event).
 *
 * The baseline always runs; a private pattern set is layered on top of its
 * result rather than replacing it, so installing a shallow or broken private
 * implementation cannot *weaken* the scrub.
 */
export function sanitizeObject(value) {
  const base = baselineSanitizeObject(value);
  if (!impl?.sanitizeObject) return base;
  const refined = impl.sanitizeObject(base);
  return refined === undefined || refined === null ? base : refined;
}

export function sanitizeWithAudit(value) {
  const base = baselineSanitizeWithAudit(value);
  if (!impl?.sanitizeWithAudit) return base;
  const refined = impl.sanitizeWithAudit(value);
  return refined && typeof refined === "object" ? { ...base, ...refined } : base;
}
