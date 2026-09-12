/**
 * Prompt-injection scrubbing facade (ESM).
 *
 * The committed version is a no-op so the repository stays fully public. If you
 * maintain a private pattern set, add `sanitize.private.mjs` next to this file
 * (gitignored) exporting `sanitize`, `sanitizeObject` and `sanitizeWithAudit`;
 * this facade picks it up automatically and nothing else has to change.
 *
 * Every external payload (email bodies, event descriptions, imported syllabus
 * text) should pass through here before it reaches the LLM or the log files.
 *
 * Lives in `shared/` rather than `scripts/` because it is shipped as a runtime
 * resource — `extraResources` copies `shared/`, but not `scripts/`.
 */

const EMPTY_AUDIT = {
  sanitized: "",
  originalHash: "",
  injected: false,
  patterns: [],
  hadHidden: false,
};

function noopSanitize(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

function noopSanitizeObject(value) {
  return value;
}

function noopSanitizeWithAudit(value) {
  return { ...EMPTY_AUDIT, sanitized: noopSanitize(value) };
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

export function sanitize(value) {
  return impl ? impl.sanitize(value) : noopSanitize(value);
}

export function sanitizeObject(value) {
  return impl ? impl.sanitizeObject(value) : noopSanitizeObject(value);
}

export function sanitizeWithAudit(value) {
  return impl ? impl.sanitizeWithAudit(value) : noopSanitizeWithAudit(value);
}
