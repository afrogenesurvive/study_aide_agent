import type { Database } from "../database/db";
import { themesForTopicCodes } from "../scheduler/overlay";
import { getSyllabus, getTopics } from "../syllabus/repo";
import type {
  GenerationRequest,
  GenerationTopicInput,
} from "../../src/shared/generation-types";

/**
 * Turning a scope request into the topics a run will cover.
 *
 * The Generate panel asks in one of three ways — a list of topic codes, a section
 * name, or "the whole syllabus" — and this is the only place that difference is
 * understood. Everything downstream works with the same flat topic list.
 *
 * `errors` mean there is nothing to generate from; `warnings` mean the run can
 * proceed but the user asked for something that partly does not exist.
 */

export interface ScopeResolution {
  topics: GenerationTopicInput[];
  warnings: string[];
  errors: string[];
}

/** Trim, drop blanks, de-duplicate — the shape config and IPC both deliver. */
function uniqueStrings(values: Array<string | null | undefined> | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function uniqueIds(values: Array<number | string | null | undefined> | undefined): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of values ?? []) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Resolve the requested scope against the database.
 *
 * `GenerationTopicInput.syllabusId` is carried per topic rather than per run
 * because one run can span subjects: each subject is its own `syllabus` row, so
 * "chemistry and biology" is two ids, and `getTopicByCode` has to be told which
 * one a code belongs to.
 */
export function resolveScope(db: Database, request: GenerationRequest): ScopeResolution {
  const warnings: string[] = [];
  const errors: string[] = [];

  const syllabusIds = uniqueIds(request.syllabusIds);
  if (syllabusIds.length === 0) {
    errors.push("Choose at least one syllabus to generate from.");
    return { topics: [], warnings, errors };
  }

  const codes = uniqueStrings(request.codes);
  const section = String(request.section ?? "").trim();

  if (request.scope === "topic" && codes.length === 0) {
    errors.push("Select at least one topic to generate from.");
  }
  if (request.scope === "section" && !section) {
    errors.push("Choose a section to generate from.");
  }

  const wantedCodes = new Set(codes.map((code) => code.toLowerCase()));
  const matchedCodes = new Set<string>();

  const topics: GenerationTopicInput[] = [];
  const seenTopicIds = new Set<number>();

  for (const syllabusId of syllabusIds) {
    const syllabus = getSyllabus(db, syllabusId);
    if (!syllabus) {
      warnings.push(`Syllabus #${syllabusId} no longer exists and was skipped.`);
      continue;
    }

    let rows = getTopics(db, syllabusId);

    if (request.scope === "topic") {
      rows = rows.filter((row) => {
        if (!wantedCodes.has(row.code.trim().toLowerCase())) return false;
        matchedCodes.add(row.code.trim().toLowerCase());
        return true;
      });
    } else if (request.scope === "section") {
      rows = rows.filter(
        (row) => (row.section ?? "").trim().toLowerCase() === section.toLowerCase(),
      );
    }

    for (const row of rows) {
      if (seenTopicIds.has(row.id)) continue;
      seenTopicIds.add(row.id);
      topics.push({
        topicId: row.id,
        code: row.code,
        title: row.title,
        subject: syllabus.subject,
        section: row.section,
        syllabusId,
        themes: themesForTopicCodes(db, [row.code]),
      });
    }
  }

  if (request.scope === "topic") {
    const missing = codes.filter((code) => !matchedCodes.has(code.toLowerCase()));
    if (missing.length > 0) {
      warnings.push(
        `No topic matched ${missing.length === 1 ? "the code" : "these codes"}: ${missing.join(", ")}.`,
      );
    }
  }

  if (topics.length === 0 && errors.length === 0) {
    errors.push(
      request.scope === "section"
        ? `No topics found in section “${section}”.`
        : request.scope === "topic"
          ? "None of the selected topics are in the chosen syllabus."
          : "The chosen syllabus has no topics yet — import one first.",
    );
  }

  return { topics, warnings, errors };
}
