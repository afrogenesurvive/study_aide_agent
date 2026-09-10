import type {
  ImportFormat,
  ImportFormatHint,
  ParseResult,
  ParseWarning,
} from "../../../src/shared/syllabus-types";
import { normalizeCanonical, type CanonicalDefaults } from "../canonical";
import { extractSyllabusWithLlm, parseJsonLoose } from "../../llm/extract";
import { parseCsvTopics } from "./csv";
import { parseMarkdownOutline } from "./markdown";
import { extractDocxText, extractPdfText } from "./document";

/**
 * Format detection and the parse dispatcher.
 *
 * Deterministic parsers (JSON, CSV, Markdown) are always tried first and are
 * free. The LLM is only consulted when they cannot find structure — a PDF whose
 * text layer lost its headings, or a block of pasted prose.
 */

/** Below this, a deterministic parse is considered too thin and the LLM is asked. */
const MIN_DETERMINISTIC_TOPICS = 4;

const EXTENSION_FORMATS: Record<string, ImportFormat> = {
  json: "json",
  csv: "csv",
  tsv: "csv",
  md: "md",
  markdown: "md",
  txt: "text",
  pdf: "pdf",
  docx: "docx",
  doc: "docx",
};

export interface ParseInput {
  /** Text content, for text-like formats. */
  text?: string;
  /** Raw bytes, for PDF/DOCX. */
  bytes?: Uint8Array;
  fileName?: string;
  format?: ImportFormatHint;
}

export interface ParseOptions extends CanonicalDefaults {
  /** Set false to forbid an LLM call (used by tests and the offline path). */
  allowLlm?: boolean;
}

/** Best-effort format detection: explicit hint → file extension → content sniff. */
export function detectFormat(fileName: string | undefined, text: string | undefined): ImportFormat {
  if (fileName) {
    const extension = fileName.toLowerCase().split(".").pop() ?? "";
    const byExtension = EXTENSION_FORMATS[extension];
    if (byExtension) return byExtension;
  }

  const sample = String(text ?? "").trimStart().slice(0, 2000);
  if (!sample) return "text";
  if (sample.startsWith("{") || sample.startsWith("[")) return "json";
  if (/^#{1,6}\s/m.test(sample)) return "md";

  const firstLine = sample.split(/\r?\n/)[0] ?? "";
  const delimiters = [",", ";", "\t"].filter((delimiter) => firstLine.includes(delimiter));
  if (delimiters.length && /\b(code|title|name|topic|section)\b/i.test(firstLine)) return "csv";

  return "text";
}

function toLooseFromMarkdown(text: string): { document: unknown; warnings: ParseWarning[] } {
  const parsed = parseMarkdownOutline(text);
  const topics: Array<Record<string, unknown>> = [];

  for (const section of parsed.sections) {
    for (const topic of section.topics) {
      const { subTopics, ...rest } = topic;
      topics.push({ ...rest, section: section.title });
      for (const sub of subTopics ?? []) {
        topics.push({ ...sub, section: section.title, parent: sub.parent ?? topic.code });
      }
    }
  }
  for (const loose of parsed.looseTopics) topics.push({ ...loose });

  return { document: { title: parsed.title, topics }, warnings: parsed.warnings };
}

function result(
  format: ImportFormat,
  normalized: { canonical: ParseResult["canonical"]; warnings: ParseWarning[]; error?: string },
  usedLlm: boolean,
): ParseResult {
  return {
    ok: Boolean(normalized.canonical),
    canonical: normalized.canonical,
    format,
    warnings: normalized.warnings,
    ...(normalized.error ? { error: normalized.error } : {}),
    usedLlm,
  };
}

/**
 * Parse an import into the canonical shape.
 *
 * Never throws: every failure path returns `{ ok: false, error }` so the IPC
 * handler can surface it directly in the import dialog.
 */
export async function parseSyllabus(
  input: ParseInput,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const format = input.format && input.format !== "auto"
    ? input.format
    : detectFormat(input.fileName, input.text);

  const defaults: CanonicalDefaults = {
    subject: options.subject ?? null,
    board: options.board,
    level: options.level,
    examDate: options.examDate,
    title: options.title,
  };

  try {
    switch (format) {
      case "json": {
        const parsed = parseJsonLoose(input.text ?? "");
        if (!parsed) {
          return result(format, {
            canonical: null,
            warnings: [],
            error: "That file is not valid JSON.",
          }, false);
        }
        return result(format, normalizeCanonical(parsed, defaults), false);
      }

      case "csv": {
        const csv = parseCsvTopics(input.text ?? "");
        if (csv.error) {
          return result(format, { canonical: null, warnings: csv.warnings, error: csv.error }, false);
        }
        return result(format, normalizeCanonical({ topics: csv.rows }, defaults), false);
      }

      case "md": {
        const { document, warnings } = toLooseFromMarkdown(input.text ?? "");
        const normalized = normalizeCanonical(document, defaults);
        if (normalized.canonical && normalized.canonical.topics.length >= MIN_DETERMINISTIC_TOPICS) {
          return result(format, { ...normalized, warnings: [...warnings, ...normalized.warnings] }, false);
        }
        // Too thin to trust: fall through to the LLM when it is allowed.
        if (options.allowLlm === false) {
          return result(format, { ...normalized, warnings: [...warnings, ...normalized.warnings] }, false);
        }
        return llmFallback(input.text ?? "", format, defaults, warnings);
      }

      case "pdf": {
        if (!input.bytes) {
          return result(format, { canonical: null, warnings: [], error: "No PDF data received." }, false);
        }
        const extracted = await extractPdfText(input.bytes);
        if (extracted.error) {
          return result(format, { canonical: null, warnings: [], error: extracted.error }, false);
        }
        const { document, warnings } = toLooseFromMarkdown(extracted.text);
        const normalized = normalizeCanonical(document, defaults);
        if (
          normalized.canonical &&
          normalized.canonical.topics.length >= MIN_DETERMINISTIC_TOPICS &&
          options.allowLlm === false
        ) {
          return result(format, normalized, false);
        }
        if (normalized.canonical && normalized.canonical.topics.length >= MIN_DETERMINISTIC_TOPICS) {
          // A clean heading structure was recovered from the text layer.
          return result(format, { ...normalized, warnings: [...warnings, ...normalized.warnings] }, false);
        }
        return llmFallback(
          extracted.text,
          format,
          defaults,
          warnings,
          input.fileName ? `extracted from ${input.fileName}` : "extracted from PDF",
        );
      }

      case "docx": {
        if (!input.bytes) {
          return result(format, { canonical: null, warnings: [], error: "No DOCX data received." }, false);
        }
        const extracted = await extractDocxText(input.bytes);
        if (extracted.error) {
          return result(format, { canonical: null, warnings: [], error: extracted.error }, false);
        }
        return llmFallback(
          extracted.text,
          format,
          defaults,
          [],
          input.fileName ? `extracted from ${input.fileName}` : "extracted from DOCX",
        );
      }

      default: {
        // Pasted plain text.
        if (options.allowLlm === false) {
          const { document, warnings } = toLooseFromMarkdown(input.text ?? "");
          return result("text", { ...normalizeCanonical(document, defaults), warnings }, false);
        }
        return llmFallback(input.text ?? "", "text", defaults, [], "pasted text");
      }
    }
  } catch (err) {
    return result(format, {
      canonical: null,
      warnings: [],
      error: err instanceof Error ? err.message : String(err),
    }, false);
  }
}

async function llmFallback(
  text: string,
  format: ImportFormat,
  defaults: CanonicalDefaults,
  warnings: ParseWarning[],
  sourceLabel = "pasted text",
): Promise<ParseResult> {
  if (!text.trim()) {
    return result(format, { canonical: null, warnings, error: "There is no text to parse." }, false);
  }
  const extracted = await extractSyllabusWithLlm({ text, defaults, sourceLabel });
  return result(
    format,
    {
      canonical: extracted.canonical,
      warnings: [...warnings, ...extracted.warnings],
      ...(extracted.error ? { error: extracted.error } : {}),
    },
    extracted.usedLlm,
  );
}
