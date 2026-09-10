import { describe, expect, it } from "vitest";
import { describeDiff, diffTopics, isNoopDiff } from "../services/syllabus/diff";
import type { CanonicalTopic, SyllabusTopicRow } from "../src/shared/syllabus-types";

function topic(overrides: Partial<SyllabusTopicRow> & { code: string }): SyllabusTopicRow {
  return {
    id: 1,
    syllabus_id: 1,
    parent_id: null,
    title: overrides.code,
    section: null,
    order_index: 0,
    est_hours: null,
    status: "not_started",
    valence: null,
    archived_at: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

describe("diffTopics", () => {
  const existing = [
    topic({ id: 1, code: "1", title: "Atomic structure", section: "Physical", est_hours: 8 }),
    topic({ id: 2, code: "2", title: "Bonding", section: "Physical", est_hours: 10 }),
    topic({ id: 3, code: "9", title: "Old topic", section: "Inorganic" }),
  ];

  it("classifies added, changed, unchanged and removed", () => {
    const incoming: CanonicalTopic[] = [
      { code: "1", title: "Atomic structure", section: "Physical", estHours: 8 },
      { code: "2", title: "Chemical bonding", section: "Physical", estHours: 10 },
      { code: "3", title: "New topic", section: "Organic" },
    ];

    const diff = diffTopics(existing, incoming);

    expect(diff.added.map((entry) => entry.code)).toEqual(["3"]);
    expect(diff.changed.map((entry) => entry.code)).toEqual(["2"]);
    expect(diff.changed[0].fields).toEqual(["title"]);
    expect(diff.changed[0].previousTitle).toBe("Bonding");
    expect(diff.unchanged.map((entry) => entry.code)).toEqual(["1"]);
    expect(diff.removed.map((entry) => entry.code)).toEqual(["9"]);
    expect(diff.counts).toEqual({ added: 1, changed: 1, unchanged: 1, removed: 1 });
  });

  it("detects a changed section and time allocation", () => {
    const diff = diffTopics(
      [topic({ code: "1", title: "T", section: "A", est_hours: 8 })],
      [{ code: "1", title: "T", section: "B", estHours: 9 }],
    );
    expect(diff.changed[0].fields).toEqual(["section", "estHours"]);
  });

  it("treats a numeric round-trip as unchanged", () => {
    const diff = diffTopics(
      [topic({ code: "1", title: "T", est_hours: 8 })],
      [{ code: "1", title: "T", estHours: 8.0 }],
    );
    expect(diff.counts.unchanged).toBe(1);
  });

  it("ignores whitespace-only differences in optional fields", () => {
    const diff = diffTopics(
      [topic({ code: "1", title: "T", section: "Physical" })],
      [{ code: "1", title: "T", section: "  Physical  " }],
    );
    expect(diff.counts.changed).toBe(0);
  });

  it("ignores archived rows so they are not reported as removed", () => {
    const diff = diffTopics(
      [topic({ code: "1", title: "A" }), topic({ code: "2", title: "Gone", archived_at: "2026-01-02" })],
      [{ code: "1", title: "A" }],
    );
    expect(diff.removed).toEqual([]);
    expect(isNoopDiff(diff)).toBe(true);
  });

  it("reports a no-op for an identical re-import", () => {
    const diff = diffTopics(
      [topic({ code: "1", title: "A" })],
      [{ code: "1", title: "A" }],
    );
    expect(isNoopDiff(diff)).toBe(true);
    expect(describeDiff(diff)).toMatch(/no-op/i);
  });

  it("summarizes a real diff", () => {
    const diff = diffTopics(
      [topic({ code: "1", title: "A" }), topic({ code: "2", title: "B" })],
      [{ code: "1", title: "A" }, { code: "3", title: "C" }],
    );
    expect(describeDiff(diff)).toBe("1 added · 1 removed · 1 unchanged");
  });
});
