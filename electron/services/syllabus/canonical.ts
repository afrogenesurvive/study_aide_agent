import type {
  CanonicalSyllabus,
  CanonicalTopic,
  ParseWarning,
  Subject,
} from "../../src/shared/syllabus-types";

/**
 * Canonical syllabus shape and the normalization every parser funnels through.
 *
 * Import formats differ wildly (a JSON dump, a CSV, a Markdown outline, a page of
 * pasted text), but everything downstream — diffing, coverage, scheduling,
 * notifications — only ever sees a `CanonicalSyllabus`. Normalizing in one place
 * keeps those consumers simple and the parsers dumb.
 */

const SUBJECT_ALIASES: Record<string, Subject> = {
  math: "math",
  maths: "math",
  mathematics: "math",
  "9709": "math",
  chem: "chemistry",
  chemistry: "chemistry",
  "9701": "chemistry",
  bio: "biology",
  biology: "biology",
  "9700": "biology",
};

const BOARD_ALIASES: Record<string, string> = {
  cambridge: "cambridge",
  caie: "cambridge",
  cie: "cambridge",
  "cambridge international": "cambridge",
  ocr: "ocr",
  aqa: "aqa",
  edexcel: "edexcel",
  pearson: "edexcel",
  cxc: "cxc",
  cape: "cxc",
};

export function normalizeSubject(raw: unknown): Subject | null {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).toLowerCase().trim();
  return SUBJECT_ALIASES[key] ?? null;
}

export function normalizeBoard(raw: unknown): string {
  if (raw === null || raw === undefined) return "cambridge";
  const key = String(raw).toLowerCase().trim();
  if (!key) return "cambridge";
  return BOARD_ALIASES[key] ?? key;
}

export function normalizeLevel(raw: unknown): string {
  if (raw === null || raw === undefined) return "a-level";
  const key = String(raw).toLowerCase().trim().replace(/[\s_]+/g, "-");
  if (!key) return "a-level";
  if (key === "as" || key === "a2" || key === "as-level") return "as-level";
  if (key === "alevel") return "a-level";
  return key;
}

/**
 * Derive a stable topic code from a title when the source provides none.
 * Section-aware so `1.2` under section 1 does not collide with `2.2`.
 */
export function deriveCode(title: string, section?: string, index = 0): string {
  const sectionPrefix = section ? sectionSlug(section) : "";
  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = titleSlug || `topic-${index + 1}`;
  return sectionPrefix ? `${sectionPrefix}.${base}` : base;
}

function sectionSlug(section: string): string {
  return section
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function coerceEstHours(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(value) || value < 0 || value > 1000) return undefined;
  return Math.round(value * 100) / 100;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}

export interface TopicDefaults {
  section?: string;
  parent?: string;
}

/** Normalize one loose topic record. Returns null when it is unusable. */
export function coerceTopic(
  raw: unknown,
  index: number,
  warnings: ParseWarning[],
  defaults: TopicDefaults = {},
): CanonicalTopic | null {
  if (typeof raw === "string") {
    const title = raw.trim();
    if (!title) return null;
    return {
      code: deriveCode(title, defaults.section, index),
      title,
      ...(defaults.section ? { section: defaults.section } : {}),
      ...(defaults.parent ? { parent: defaults.parent } : {}),
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push({ message: `Topic ${index + 1}: expected an object or a string; skipped.` });
    return null;
  }

  const record = raw as Record<string, unknown>;
  const title = pickString(record, ["title", "name", "topic", "label", "description"]);
  if (!title) {
    warnings.push({ message: `Topic ${index + 1}: missing a title; skipped.` });
    return null;
  }

  const section = pickString(record, ["section", "unit", "module", "paper"]) ?? defaults.section;
  const code = pickString(record, ["code", "id", "ref", "number"]) ?? deriveCode(title, section, index);
  const parent = pickString(record, ["parent", "parentCode", "parent_code"]) ?? defaults.parent;
  const estHours = coerceEstHours(
    record.estHours ?? record.est_hours ?? record.hours ?? record.estimated_hours,
  );

  return {
    code,
    title,
    ...(section ? { section } : {}),
    ...(parent ? { parent } : {}),
    ...(estHours !== undefined ? { estHours } : {}),
  };
}

/**
 * Pull a loose array of topics out of whatever the source produced.
 *
 * Understands three shapes:
 *   - `{ topics: [...] }`
 *   - `{ sections: [{ title, topics: [...] }] }`  (section title becomes the topic's section)
 *   - a bare array of topics
 */
function extractTopics(input: unknown, warnings: ParseWarning[]): Array<{
  raw: unknown;
  defaults: TopicDefaults;
}> {
  const collected: Array<{ raw: unknown; defaults: TopicDefaults }> = [];

  if (Array.isArray(input)) {
    for (const entry of input) collected.push({ raw: entry, defaults: {} });
    return collected;
  }
  if (!input || typeof input !== "object") return collected;

  const record = input as Record<string, unknown>;

  const sections = record.sections ?? record.units ?? record.modules;
  if (Array.isArray(sections)) {
    for (const section of sections) {
      if (!section || typeof section !== "object") continue;
      const sectionRecord = section as Record<string, unknown>;
      const sectionTitle =
        pickString(sectionRecord, ["title", "name", "section", "unit", "module"]) ?? undefined;
      const sectionCode = pickString(sectionRecord, ["code", "id", "ref", "number"]);
      const sectionTopics = sectionRecord.topics ?? sectionRecord.items ?? sectionRecord.subtopics;
      if (Array.isArray(sectionTopics)) {
        for (const topic of sectionTopics) {
          collected.push({
            raw: topic,
            defaults: {
              ...(sectionTitle ? { section: sectionTitle } : {}),
              ...(sectionCode ? { parent: sectionCode } : {}),
            },
          });
        }
      }
    }
  }

  const topics = record.topics ?? record.items ?? record.outline;
  if (Array.isArray(topics)) {
    for (const topic of topics) collected.push({ raw: topic, defaults: {} });
  }

  return collected;
}

export interface CanonicalDefaults {
  subject?: Subject | null;
  board?: string;
  level?: string;
  examDate?: string;
  title?: string;
}

export interface NormalizeResult {
  canonical: CanonicalSyllabus | null;
  warnings: ParseWarning[];
  error?: string;
}

/**
 * Turn a loose parsed document into a `CanonicalSyllabus`.
 *
 * Missing subject/board/level fall back to `defaults` (supplied by the import
 * dialog); if the subject still cannot be resolved the import is rejected,
 * because every downstream feature needs it.
 */
export function normalizeCanonical(input: unknown, defaults: CanonicalDefaults = {}): NormalizeResult {
  const warnings: ParseWarning[] = [];

  if (input === null || input === undefined) {
    return { canonical: null, warnings, error: "Nothing to import." };
  }

  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const subject =
    normalizeSubject(record.subject ?? record.discipline) ?? defaults.subject ?? null;
  if (!subject) {
    return {
      canonical: null,
      warnings,
      error: "Could not determine the subject — set it in the import dialog (math, chemistry or biology).",
    };
  }

  const board = normalizeBoard(record.board ?? record.awardingBody ?? defaults.board);
  const level = normalizeLevel(record.level ?? record.qualification ?? defaults.level);
  const examDate =
    pickString(record, ["examDate", "exam_date", "exam"]) ?? defaults.examDate ?? undefined;
  const title = pickString(record, ["title", "name", "syllabusTitle"]) ?? defaults.title;

  const candidates = extractTopics(input, warnings);
  const topics: CanonicalTopic[] = [];
  const seen = new Set<string>();

  candidates.forEach((candidate, index) => {
    const topic = coerceTopic(candidate.raw, index, warnings, candidate.defaults);
    if (!topic) return;

    let code = topic.code;
    if (seen.has(code)) {
      warnings.push({
        code,
        message: `Duplicate topic code "${code}" — the later entry was renamed to "${code}-2".`,
      });
      let suffix = 2;
      while (seen.has(`${code}-${suffix}`)) suffix += 1;
      code = `${code}-${suffix}`;
    }
    seen.add(code);
    topics.push({ ...topic, code });
  });

  if (!topics.length) {
    return {
      canonical: null,
      warnings,
      error: "No topics could be read from that input.",
    };
  }

  return {
    canonical: {
      subject,
      board,
      level,
      ...(title ? { title } : {}),
      ...(examDate ? { examDate } : {}),
      topics,
    },
    warnings,
  };
}

/**
 * Re-derive parent links from a `section` field when the source supplies codes
 * only for sections. Ordering is taken from array position when the rows are
 * written, so it is not stored on the canonical topic.
 */
export function assignParents(canonical: CanonicalSyllabus): CanonicalSyllabus {
  const codesByTitle = new Map<string, string>();
  for (const topic of canonical.topics) {
    const key = topic.title.toLowerCase();
    if (!codesByTitle.has(key)) codesByTitle.set(key, topic.code);
  }
  return {
    ...canonical,
    topics: canonical.topics.map((topic) => {
      if (topic.parent || !topic.section) return topic;
      const parent = codesByTitle.get(topic.section.toLowerCase());
      return parent ? { ...topic, parent } : topic;
    }),
  };
}

/** A compact fingerprint, used to skip a no-op re-import cheaply. */
export function canonicalFingerprint(canonical: CanonicalSyllabus): string {
  const parts = canonical.topics
    .map((topic) => `${topic.code}|${topic.title}|${topic.section ?? ""}|${topic.estHours ?? ""}`)
    .sort();
  return `${canonical.subject}/${canonical.board}/${canonical.level}#${parts.join(";")}`;
}
