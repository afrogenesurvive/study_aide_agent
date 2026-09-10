import Papa from "papaparse";
import type { ParseWarning } from "../../../src/shared/syllabus-types";

/**
 * CSV parser.
 *
 * Expected columns (case- and separator-insensitive):
 *   code, title, section, parent, est_hours
 *
 * Only `title` is strictly required — anything else is derived downstream by
 * `canonical.ts`, so a two-column spreadsheet still imports cleanly.
 */

export interface CsvParseResult {
  rows: Array<Record<string, string>>;
  warnings: ParseWarning[];
  error?: string;
}

/** Normalize a header so `Est. Hours`, `est_hours` and `ESTHOURS` all collide. */
function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

const HEADER_ALIASES: Record<string, string> = {
  est_hours: "est_hours",
  esthours: "est_hours",
  estimated_hours: "est_hours",
  hours: "est_hours",
  ref: "code",
  reference: "code",
  id: "code",
  name: "title",
  topic: "title",
  unit: "section",
  module: "section",
  paper: "section",
  parent_code: "parent",
  parentcode: "parent",
};

export function parseCsvTopics(text: string): CsvParseResult {
  const warnings: ParseWarning[] = [];

  const result = Papa.parse<Record<string, string>>(String(text ?? ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => {
      const normalized = normalizeHeader(header);
      return HEADER_ALIASES[normalized] ?? normalized;
    },
  });

  for (const error of result.errors ?? []) {
    // Papa reports "TooFewFields" for trailing blank lines; not worth surfacing.
    if (error.code === "TooFewFields" || error.code === "TooManyFields") continue;
    warnings.push({
      line: typeof error.row === "number" ? error.row + 1 : undefined,
      message: error.message,
    });
  }

  const rows = (result.data ?? []).filter((row) => {
    if (!row || typeof row !== "object") return false;
    return Object.values(row).some((value) => String(value ?? "").trim() !== "");
  });

  if (!rows.length) {
    return { rows: [], warnings, error: "No data rows found in the CSV." };
  }

  const hasTitleColumn = rows.some((row) => String(row.title ?? "").trim() !== "");
  if (!hasTitleColumn) {
    return {
      rows: [],
      warnings,
      error: 'The CSV needs a "title" column (aliases: name, topic).',
    };
  }

  return { rows, warnings };
}
