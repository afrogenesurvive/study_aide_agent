import { describe, expect, it } from "vitest";
import { buildCoverage, parseExamDate } from "../services/syllabus/coverage";
import type { SyllabusRow, SyllabusTopicRow } from "../src/shared/syllabus-types";

function syllabus(overrides: Partial<SyllabusRow> = {}): SyllabusRow {
  return {
    id: 1,
    subject: "chemistry",
    board: "cambridge",
    level: "a-level",
    title: "Chemistry 9701",
    exam_date: null,
    source_file: null,
    is_active: 1,
    imported_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

function topic(overrides: Partial<SyllabusTopicRow> = {}): SyllabusTopicRow {
  return {
    id: 1,
    syllabus_id: 1,
    parent_id: null,
    code: "1",
    title: "Topic",
    section: "Physical",
    order_index: 0,
    est_hours: 10,
    status: "not_started",
    valence: null,
    archived_at: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

const NOW = new Date("2026-09-10T00:00:00Z");

describe("parseExamDate", () => {
  it("parses a plain date", () => {
    expect(parseExamDate("2027-06-01")?.toISOString()).toBe("2027-06-01T00:00:00.000Z");
  });

  it("returns null for missing or invalid values", () => {
    expect(parseExamDate(null)).toBeNull();
    expect(parseExamDate("")).toBeNull();
    expect(parseExamDate("not a date")).toBeNull();
  });
});

describe("buildCoverage", () => {
  it("counts topics by status and computes percentages", () => {
    const report = buildCoverage(
      syllabus(),
      [
        topic({ id: 1, status: "mastered" }),
        topic({ id: 2, status: "learning" }),
        topic({ id: 3, status: "introduced" }),
        topic({ id: 4, status: "not_started" }),
      ],
      NOW,
    );

    expect(report.total).toBe(4);
    expect(report.byStatus).toEqual({ not_started: 1, introduced: 1, learning: 1, mastered: 1 });
    expect(report.introducedPct).toBe(75);
    expect(report.masteredPct).toBe(25);
  });

  it("excludes archived topics from the totals but reports their count", () => {
    const report = buildCoverage(
      syllabus(),
      [topic({ id: 1 }), topic({ id: 2, archived_at: "2026-02-01 00:00:00" })],
      NOW,
    );
    expect(report.total).toBe(1);
    expect(report.archived).toBe(1);
  });

  it("sums remaining estimated hours, skipping mastered topics", () => {
    const report = buildCoverage(
      syllabus(),
      [
        topic({ id: 1, status: "mastered", est_hours: 10 }),
        topic({ id: 2, status: "learning", est_hours: 6 }),
        topic({ id: 3, status: "not_started", est_hours: 4 }),
      ],
      NOW,
    );
    expect(report.remainingEstHours).toBe(10);
  });

  it("counts valence, with everything else untagged", () => {
    const report = buildCoverage(
      syllabus(),
      [
        topic({ id: 1, valence: "red" }),
        topic({ id: 2, valence: "green" }),
        topic({ id: 3, valence: "green" }),
        topic({ id: 4, valence: null }),
      ],
      NOW,
    );
    expect(report.byValence).toEqual({ red: 1, yellow: 0, green: 2, untagged: 1 });
  });

  it("buckets by section and computes per-section coverage", () => {
    const report = buildCoverage(
      syllabus(),
      [
        topic({ id: 1, section: "Physical", status: "mastered", est_hours: 8 }),
        topic({ id: 2, section: "Physical", status: "not_started", est_hours: 4 }),
        topic({ id: 3, section: "Organic", status: "not_started", est_hours: 5 }),
      ],
      NOW,
    );

    const physical = report.bySection.find((section) => section.key === "Physical");
    expect(physical).toMatchObject({ total: 2, mastered: 1, estHours: 12, coveredPct: 50 });

    const organic = report.bySection.find((section) => section.key === "Organic");
    expect(organic?.coveredPct).toBe(0);
  });

  it("groups topics with no section under Unsorted", () => {
    const report = buildCoverage(syllabus(), [topic({ section: null })], NOW);
    expect(report.bySection[0].key).toBe("Unsorted");
  });

  it("projects a required pace from the exam date", () => {
    const report = buildCoverage(
      syllabus({ exam_date: "2026-10-08" }), // 28 days after NOW
      [topic({ id: 1, est_hours: 20, status: "not_started" })],
      NOW,
    );

    expect(report.daysToExam).toBe(28);
    expect(report.weeksToExam).toBe(4);
    expect(report.hoursPerWeekNeeded).toBe(5);
  });

  it("leaves the projection empty without an exam date", () => {
    const report = buildCoverage(syllabus(), [topic()], NOW);
    expect(report.daysToExam).toBeNull();
    expect(report.weeksToExam).toBeNull();
    expect(report.hoursPerWeekNeeded).toBeNull();
  });

  it("does not divide by zero for a past exam date", () => {
    const report = buildCoverage(syllabus({ exam_date: "2026-01-01" }), [topic()], NOW);
    expect(report.daysToExam).toBeLessThan(0);
    expect(report.hoursPerWeekNeeded).toBeNull();
  });

  it("handles an empty syllabus without dividing by zero", () => {
    const report = buildCoverage(syllabus(), [], NOW);
    expect(report.total).toBe(0);
    expect(report.introducedPct).toBe(0);
    expect(report.masteredPct).toBe(0);
    expect(report.bySection).toEqual([]);
  });
});
