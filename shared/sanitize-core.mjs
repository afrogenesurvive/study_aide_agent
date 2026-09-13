/**
 * The scrub primitives, shared by everything that touches untrusted text.
 *
 * Dependency-free and free of top-level `await` on purpose: the MCP servers
 * (`mcp/**`, plain ESM run by Node) and the Electron main process both load this
 * module, and main loads ESM through an `import()` shim because `tsc` downlevels
 * a dynamic `import()` in CommonJS output. Anything with top-level `await` could
 * only be reached asynchronously, which would make the boundary scrub optional —
 * exactly the wrong property for a defence that must always run.
 *
 * Four exports, deliberately distinct:
 *
 *  - `scrubText` is the **baseline**: it must behave identically to
 *    `baseline()` in `electron/services/llm/sanitize.ts`. A parity test feeds
 *    both the same corpus and asserts the output matches, so drift fails the
 *    suite instead of silently weakening one of the two paths.
 *  - `scrubExternalText` adds the hardening only the object path needs —
 *    invisible and bidirectional control characters, which can hide an
 *    instruction from a human reading a log while leaving it intact for a model.
 *  - `scrubObject` walks a decoded JSON payload and applies the above to every
 *    string it contains.
 *  - `scrubObjectWithAudit` does the same and reports what fired, so a caller can
 *    log *that* a payload was scrubbed without logging the payload.
 */

/** Roughly 60k characters — comfortably inside a 32k-token context window. */
export const MAX_TEXT_CHARS = 60_000;

/**
 * How deep `scrubObject` will walk before it stops descending.
 *
 * Google's payloads are shallow (headers, parts, events), so this is a guard
 * against a pathological or hostile response rather than a real limit.
 */
export const MAX_OBJECT_DEPTH = 32;

/** How much total text one object may contribute before it is truncated. */
export const MAX_OBJECT_CHARS = 200_000;

/**
 * Zero-width, joining and bidirectional-control characters.
 *
 * Every one of these is invisible in a terminal or a log viewer but survives
 * into a model's context, which makes them the cheapest way to smuggle an
 * instruction past a human reviewer.
 */
const INVISIBLE_RE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** Fenced code markers, stripped whole-line. */
const CODE_FENCE_RE = /^```.*$/gm;

/**
 * The instruction-override phrasings worth removing from pasted prose.
 *
 * Kept byte-identical to the baseline in `services/llm/sanitize.ts`; the parity
 * test enforces it.
 */
const OVERRIDE_RE =
  /^[^\n]{0,40}\b(ignore (all )?(previous|prior|above) instructions|disregard .{0,20}instructions|you are now|new instructions?:)\b[^\n]*$/gim;

/** Labelled so an audit record can say *what* fired without quoting the text. */
export const BASELINE_PATTERN_NAMES = ["code-fence", "instruction-override"];

/** The exact source `services/llm/sanitize.ts` compiles. Compared by the parity test. */
export const OVERRIDE_SOURCE = OVERRIDE_RE.source;

/** Descriptive text for a caller that wants to explain the scrub to a user. */
export const BASELINE_DESCRIPTION =
  "NUL bytes, fenced code markers and instruction-override phrasings are removed, " +
  `and text is truncated to ${MAX_TEXT_CHARS} characters.`;

function asText(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/**
 * The always-on text scrub. Behaviourally identical to the TypeScript baseline.
 *
 * The truncation is part of the defence, not just a token limit: it bounds how
 * much text an attacker can use to bury an instruction.
 */
export function scrubText(value) {
  return asText(value)
    .replace(/\u0000/g, "")
    .replace(CODE_FENCE_RE, "")
    .replace(OVERRIDE_RE, "[removed]")
    .slice(0, MAX_TEXT_CHARS);
}

/** `scrubText` plus the invisible characters, for text arriving from outside. */
export function scrubExternalText(value) {
  const text = asText(value);
  const hadHidden = INVISIBLE_RE.test(text);
  INVISIBLE_RE.lastIndex = 0;
  const visible = hadHidden ? text.replace(INVISIBLE_RE, "") : text;
  return { value: scrubText(visible), hadHidden };
}

/**
 * True for a value `scrubObject` should keep walking into.
 *
 * Only plain objects and arrays qualify. A `Date`, a `Map` or a class instance is
 * passed through untouched rather than being flattened into `{}`, which would
 * quietly destroy a caller's data.
 */
function isWalkable(value) {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-scrub a decoded JSON payload.
 *
 * Returns a **new** value; the input is never mutated. Keys are scrubbed as well
 * as values, because a Google payload can carry caller-supplied field names.
 *
 * Non-walkable leaves (numbers, booleans, `null`, and any foreign object) are
 * returned as-is, so a payload cannot be corrupted by passing it through here.
 */
export function scrubObject(value) {
  return scrubObjectWithAudit(value).sanitized;
}

/**
 * As `scrubObject`, but also reports what was found.
 *
 * The audit deliberately carries counts and a content hash rather than the text,
 * so it is safe to write to a log file.
 */
export function scrubObjectWithAudit(value) {
  const stats = { strings: 0, hidden: 0, injected: 0, truncated: false };
  const patterns = new Set();
  let budget = MAX_OBJECT_CHARS;

  const walk = (node, depth) => {
    if (typeof node === "string") {
      stats.strings += 1;
      const { value: cleaned, hadHidden } = scrubExternalText(node);
      if (hadHidden) {
        stats.hidden += 1;
        patterns.add("invisible-characters");
      }
      if (cleaned !== node) {
        if (OVERRIDE_RE.test(cleaned)) patterns.add("instruction-override");
        OVERRIDE_RE.lastIndex = 0;
        if (/^```/m.test(cleaned)) patterns.add("code-fence");
        stats.injected += 1;
      }
      if (cleaned.length > budget) {
        stats.truncated = true;
        const clipped = cleaned.slice(0, Math.max(0, budget));
        budget = 0;
        return clipped;
      }
      budget -= cleaned.length;
      return cleaned;
    }

    if (typeof node !== "object" || node === null) return node;
    if (depth >= MAX_OBJECT_DEPTH || !isWalkable(node)) return node;

    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));

    const out = {};
    for (const [key, item] of Object.entries(node)) {
      out[scrubExternalText(key).value] = walk(item, depth + 1);
    }
    return out;
  };

  const sanitized = walk(value, 0);
  return {
    sanitized,
    originalHash: hash(JSON.stringify(value) ?? ""),
    injected: stats.injected > 0,
    patterns: [...patterns],
    hadHidden: stats.hidden > 0,
    strings: stats.strings,
    truncated: stats.truncated,
  };
}

/**
 * FNV-1a, 32-bit, hex.
 *
 * A hash rather than a cryptographic digest because this only has to let a log
 * line say "the same payload as last time" — and because `node:crypto` would be
 * one more thing the MCP servers depend on.
 */
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
