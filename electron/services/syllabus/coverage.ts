import type {
  CoverageBucket,
  CoverageReport,
  Subject,
  SyllabusRow,
  SyllabusTopicRow,
  TopicStatus,
  Valence,
} from "../../src/shared/syllabus-types";

/**
 * Coverage analytics.
 *
 * Computed entirely from `syllabus_topics.status` and `valence`, so it works
 * from the moment a syllabus is imported — long before FSRS review history
 * exists. Retention curves and exam-readiness projections (which need review
 * data) layer on top of this in later phases.
 */

const COVERED: TopicStatus[] = ["introduced", "learning", "mastered"];

function emptyCounts(): Record<TopicStatus, number> {
  return { not_started: 0, introduced: 0, learning: 0, mastered: 0 };
}

function pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.ceil(ms / 86_400_000);
}

/** Parse a `YYYY-MM-DD` (or ISO) exam date. Returns null when absent/invalid. */
export function parseExamDate(raw: string | null | undefined): Date | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildCoverage(
  syllabus: SyllabusRow,
  topics: SyllabusTopicRow[],
  now: Date = new Date(),
): CoverageReport {
  const archived = topics.filter((topic) => topic.archived_at).length;
  const active = topics.filter((topic) => !topic.archived_at);

  const byStatus = emptyCounts();
  const byValence: CoverageReport["byValence"] = {
    red: 0,
    yellow: 0,
    green: 0,
    untagged: 0,
  };
  const sectionMap = new Map<string, CoverageBucket>();

  let coveredCount = 0;
  let remainingEstHours = 0;

  for (const topic of active) {
    byStatus[topic.status] = (byStatus[topic.status] ?? 0) + 1;
    if (COVERED.includes(topic.status)) coveredCount += 1;

    if (topic.valence && topic.valence in byValence) {
      byValence[topic.valence as Valence] += 1;
    } else {
      byValence.untagged += 1;
    }

    const hours = topic.est_hours ?? 0;
    if (topic.status !== "mastered") remainingEstHours += hours;

    const sectionKey = (topic.section ?? "Unsorted").trim() || "Unsorted";
    const bucket = sectionMap.get(sectionKey) ?? {
      key: sectionKey,
      total: 0,
      not_started: 0,
      introduced: 0,
      learning: 0,
      mastered: 0,
      estHours: 0,
      coveredPct: 0,
    };
    bucket.total += 1;
    bucket[topic.status] += 1;
    bucket.estHours = Math.round((bucket.estHours + hours) * 100) / 100;
    sectionMap.set(sectionKey, bucket);
  }

  const bySection = [...sectionMap.values()]
    .map((bucket) => ({
      ...bucket,
      coveredPct: pct(bucket.introduced + bucket.learning + bucket.mastered, bucket.total),
    }))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));

  const examDate = parseExamDate(syllabus.exam_date);
  const daysToExam = examDate ? daysBetween(now, examDate) : null;
  const weeksToExam = daysToExam !== null && daysToExam > 0 ? daysToExam / 7 : null;
  const hoursPerWeekNeeded =
    weeksToExam && weeksToExam > 0
      ? Math.round((remainingEstHours / weeksToExam) * 10) / 10
      : null;

  return {
    syllabusId: syllabus.id,
    subject: syllabus.subject as Subject,
    board: syllabus.board,
    level: syllabus.level,
    examDate: syllabus.exam_date,
    total: active.length,
    archived,
    byStatus,
    byValence,
    bySection,
    introducedPct: pct(coveredCount, active.length),
    masteredPct: pct(byStatus.mastered, active.length),
    remainingEstHours: Math.round(remainingEstHours * 100) / 100,
    daysToExam,
    weeksToExam: weeksToExam === null ? null : Math.round(weeksToExam * 10) / 10,
    hoursPerWeekNeeded,
  };
}
