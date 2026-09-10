/**
 * Syllabus subsystem.
 *
 * Pipeline:  parse (JSON/CSV/Markdown/PDF/paste, LLM-assisted when needed)
 *         → normalize to the canonical shape
 *         → diff against the stored topics on (syllabus_id, code)
 *         → apply in one transaction (archive removed, never delete)
 *         → optionally roll back via the stored pre-import snapshot.
 */

export * from "./canonical";
export * from "./diff";
export * from "./coverage";
export * from "./import";
export * from "./repo";
export { parseSyllabus, detectFormat } from "./parsers";
export type { ParseInput, ParseOptions } from "./parsers";
