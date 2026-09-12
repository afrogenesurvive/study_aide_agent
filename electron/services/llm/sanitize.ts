/**
 * Text hardening for anything that reaches the model.
 *
 * Two layers, applied in order:
 *
 *  1. `baseline()` — a deterministic regex scrub that always runs. It is
 *     deliberately crude but cannot be disabled by configuration, so a build
 *     with no private pattern set still strips the obvious attacks.
 *  2. The private pattern set (`shared/sanitize.mjs` → gitignored
 *     `sanitize.private.mjs`) when one is installed, registered by the main
 *     process through `setSanitizerLoader`.
 *
 * The provider is reached through a loader rather than an import for the same
 * reason as `provider.ts`: `shared/*.mjs` is ESM living outside the `electron/`
 * package, and services stay free of Electron and filesystem knowledge.
 */

/** Roughly 60k characters — comfortably inside a 32k-token context window. */
export const MAX_INPUT_CHARS = 60_000;

export interface SanitizerModule {
  /** Scrub one string. Returning a falsy value falls back to the input. */
  sanitize?: (value: string) => string;
}

let loader: (() => Promise<SanitizerModule>) | null = null;
let cached: SanitizerModule | null = null;

/** Register how to load the private pattern set. Pass `null` to reset. */
export function setSanitizerLoader(fn: (() => Promise<SanitizerModule>) | null): void {
  loader = fn;
  cached = null;
}

/**
 * The always-on scrub.
 *
 * Removes NUL bytes, fenced code markers and the handful of instruction-override
 * phrasings that show up in pasted prose, then truncates. The truncation is part
 * of the defence, not just a token limit: it bounds how much text an attacker
 * can use to bury an instruction.
 */
export function neutralize(text: string): string {
  return baseline(String(text ?? "")).slice(0, MAX_INPUT_CHARS);
}

/**
 * Scrub text destined for the model.
 *
 * Never throws: if the private pattern set is missing, broken or throws, the
 * baseline scrub is still applied and the call proceeds.
 */
export async function sanitizeText(text: string): Promise<string> {
  const scrubbed = baseline(String(text ?? ""));
  const mod = await loadSanitizerSafe();
  const viaPrivate = mod?.sanitize ? attempt(() => mod.sanitize?.(scrubbed)) : null;
  return (viaPrivate || scrubbed).slice(0, MAX_INPUT_CHARS);
}

// ── internals ────────────────────────────────────────────────────────────────

function baseline(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/^```.*$/gm, "")
    .replace(
      /^[^\n]{0,40}\b(ignore (all )?(previous|prior|above) instructions|disregard .{0,20}instructions|you are now|new instructions?:)\b[^\n]*$/gim,
      "[removed]",
    );
}

async function loadSanitizerSafe(): Promise<SanitizerModule | null> {
  if (cached) return cached;
  if (!loader) return null;
  cached = await attemptAsync(loader);
  return cached;
}

function attempt(fn: () => string | undefined): string | null {
  try {
    const value = fn();
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

async function attemptAsync(fn: () => Promise<SanitizerModule>): Promise<SanitizerModule | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
