/**
 * Syllabus domain types — shared by `services/syllabus`, the main process and
 * the renderer. The canonical import shape and the persisted row shapes are
 * deliberately distinct: imports are validated/loose, rows are strict.
 */

export type Subject = "math" | "chemistry" | "biology";

export const SUBJECTS: Subject[] = ["math", "chemistry", "biology"];

export const SUBJECT_LABELS: Record<Subject, string> = {
  math: "Mathematics",
  chemistry: "Chemistry",
  biology: "Biology",
};

/** Progress ladder for a topic. Drives coverage analytics. */
export type TopicStatus = "not_started" | "introduced" | "learning" | "mastered";

export const TOPIC_STATUSES: TopicStatus[] = [
  "not_started",
  "introduced",
  "learning",
  "mastered",
];

export const TOPIC_STATUS_LABELS: Record<TopicStatus, string> = {
  not_started: "Not started",
  introduced: "Introduced",
  learning: "Learning",
  mastered: "Mastered",
};

/** Red = fear/stuck, yellow = curiosity, green = mastered. */
export type Valence = "red" | "yellow" | "green";

export const VALENCES: Valence[] = ["red", "yellow", "green"];

export const VALENCE_LABELS: Record<Valence, string> = {
  red: "Struggling",
  yellow: "Curious",
  green: "Mastered",
};

export type ImportFormat = "json" | "csv" | "md" | "pdf" | "docx" | "text";
export type ImportFormatHint = "auto" | ImportFormat;

/** One topic as it appears in an import file. Everything except code/title is optional. */
export interface CanonicalTopic {
  code: string;
  title: string;
  section?: string;
  /** Code of the parent topic, when the outline is hierarchical. */
  parent?: string;
  estHours?: number;
}

/** The single shape every parser must produce. */
export interface CanonicalSyllabus {
  subject: Subject;
  board: string;
  level: string;
  title?: string;
  examDate?: string;
  topics: CanonicalTopic[];
}

export interface ParseWarning {
  line?: number;
  code?: string;
  message: string;
}

export interface ParseResult {
  ok: boolean;
  canonical: CanonicalSyllabus | null;
  format: ImportFormat;
  warnings: ParseWarning[];
  error?: string;
  /** True when the LLM was consulted, so the UI can warn about cost/latency. */
  usedLlm: boolean;
}

/** A persisted `syllabus` row. */
export interface SyllabusRow {
  id: number;
  subject: Subject;
  board: string;
  level: string;
  title: string;
  exam_date: string | null;
  source_file: string | null;
  is_active: number;
  imported_at: string;
}

/** A persisted `syllabus_topics` row. */
export interface SyllabusTopicRow {
  id: number;
  syllabus_id: number;
  parent_id: number | null;
  code: string;
  title: string;
  section: string | null;
  order_index: number;
  est_hours: number | null;
  status: TopicStatus;
  valence: Valence | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyllabusSummary extends SyllabusRow {
  topic_count: number;
  archived_count: number;
  active_or_learning: number;
}

export type DiffKind = "added" | "changed" | "unchanged" | "removed";

export interface TopicDiffEntry {
  code: string;
  title: string;
  kind: DiffKind;
  /** Field names that differ, for `changed` entries. */
  fields: string[];
  previousTitle?: string;
}

export interface SyllabusDiff {
  added: TopicDiffEntry[];
  changed: TopicDiffEntry[];
  unchanged: TopicDiffEntry[];
  removed: TopicDiffEntry[];
  counts: { added: number; changed: number; unchanged: number; removed: number };
}

export interface ImportPreview {
  /** Null when the import would create a brand-new syllabus. */
  syllabusId: number | null;
  isNewSyllabus: boolean;
  subject: Subject;
  board: string;
  level: string;
  topicCount: number;
  diff: SyllabusDiff;
}

export interface ImportCommitResult {
  success: boolean;
  syllabusId?: number;
  importId?: number;
  diff?: SyllabusDiff;
  error?: string;
}

export interface SyllabusImportRow {
  id: number;
  syllabus_id: number;
  format: ImportFormat;
  source_file: string | null;
  topic_count: number;
  status: "applied" | "rolled_back";
  created_at: string;
  rolled_back_at: string | null;
  subject: Subject;
  board: string;
  level: string;
}

export interface CoverageBucket {
  key: string;
  total: number;
  not_started: number;
  introduced: number;
  learning: number;
  mastered: number;
  estHours: number;
  coveredPct: number;
}

export interface CoverageReport {
  syllabusId: number;
  subject: Subject;
  board: string;
  level: string;
  examDate: string | null;
  total: number;
  archived: number;
  byStatus: Record<TopicStatus, number>;
  byValence: Record<Valence, number> & { untagged: number };
  bySection: CoverageBucket[];
  introducedPct: number;
  masteredPct: number;
  remainingEstHours: number;
  daysToExam: number | null;
  weeksToExam: number | null;
  hoursPerWeekNeeded: number | null;
}

export interface SyllabusDetail {
  syllabus: SyllabusRow;
  topics: SyllabusTopicRow[];
}
