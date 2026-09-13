/**
 * Keep stdout clean.
 *
 * Import this **first** in an MCP stdio server — before any other import.
 *
 * ESM evaluates every import before the importing module's body runs, so calling
 * a redirect function at the top of a server file does *not* actually precede the
 * imports above it. A side-effect module does: imports are evaluated in order, so
 * this one runs before whatever follows it.
 *
 * stdout carries one JSON-RPC message per line and nothing else. A single stray
 * `console.log` from a dependency corrupts the framing and the parent sees a
 * parse error rather than a tool result.
 */

const toStderr = (...args) => process.stderr.write(`${args.map(String).join(" ")}\n`);

console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

export { toStderr };
