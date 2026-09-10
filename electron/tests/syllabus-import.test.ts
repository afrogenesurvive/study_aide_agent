import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../services/database/db";
import { applyImport, previewImport, rollbackImport } from "../services/syllabus/import";
import * as repo from "../services/syllabus/repo";
import type { CanonicalSyllabus } from "../src/shared/syllabus-types";
import { createTestDb } from "./helpers/test-db";

const first: CanonicalSyllabus = {
  subject: "chemistry",
  board: "cambridge",
  level: "a-level",
  title: "Chemistry 9701",
  topics: [
    { code: "1", title: "Atomic structure", section: "Physical", estHours: 8 },
    { code: "2", title: "Bonding", section: "Physical", estHours: 10 },
    { code: "9", title: "Retired topic", section: "Inorganic", estHours: 4 },
  ],
};

describe("syllabus import", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  const apply = (canonical: CanonicalSyllabus, format: "json" | "csv" = "json") =>
    applyImport(db, { canonical, format });

  it("creates a new syllabus and reports the diff without writing anything on preview", () => {
    const preview = previewImport(db, { canonical: first, format: "json" });
    expect(preview.isNewSyllabus).toBe(true);
    expect(preview.diff.counts.added).toBe(3);
    // A preview must not write.
    expect(repo.listSyllabi(db)).toHaveLength(0);
  });

  it("applies an import and records it", () => {
    const result = apply(first);
    expect(result.success).toBe(true);
    expect(result.diff?.counts.added).toBe(3);

    const topics = repo.getTopics(db, result.syllabusId!);
    expect(topics.map((topic) => topic.code)).toEqual(["1", "2", "9"]);
    expect(repo.listImports(db, result.syllabusId!)).toHaveLength(1);
  });

  it("preserves status and valence for matched codes on re-import", () => {
    const created = apply(first);
    const syllabusId = created.syllabusId!;

    const bond = repo.getTopicByCode(db, syllabusId, "2")!;
    repo.updateTopicProgress(db, bond.id, { status: "mastered", valence: "green" });
    const atomic = repo.getTopicByCode(db, syllabusId, "1")!;
    repo.updateTopicProgress(db, atomic.id, { status: "learning", valence: "red" });

    const revised: CanonicalSyllabus = {
      ...first,
      topics: [
        { code: "1", title: "Atomic structure (revised)", section: "Physical", estHours: 9 },
        { code: "2", title: "Chemical bonding", section: "Physical", estHours: 10 },
      ],
    };

    const second = apply(revised);
    expect(second.success).toBe(true);
    expect(second.diff?.counts.changed).toBe(2);
    expect(second.diff?.counts.removed).toBe(1);

    // Titles and hours update...
    expect(repo.getTopicByCode(db, syllabusId, "1")!.title).toBe("Atomic structure (revised)");
    expect(repo.getTopicByCode(db, syllabusId, "2")!.title).toBe("Chemical bonding");
    expect(repo.getTopicByCode(db, syllabusId, "1")!.est_hours).toBe(9);

    // ...but progress does not.
    const afterBond = repo.getTopicByCode(db, syllabusId, "2")!;
    expect(afterBond.status).toBe("mastered");
    expect(afterBond.valence).toBe("green");
    const afterAtomic = repo.getTopicByCode(db, syllabusId, "1")!;
    expect(afterAtomic.status).toBe("learning");
    expect(afterAtomic.valence).toBe("red");
  });

  it("archives removed topics instead of deleting them", () => {
    const created = apply(first);
    const syllabusId = created.syllabusId!;

    apply({ ...first, topics: first.topics.filter((topic) => topic.code !== "9") });

    const visible = repo.getTopics(db, syllabusId);
    expect(visible.map((topic) => topic.code)).toEqual(["1", "2"]);

    const all = repo.getTopics(db, syllabusId, { includeArchived: true });
    const archived = all.find((topic) => topic.code === "9");
    expect(archived?.archived_at).toBeTruthy();
  });

  it("un-archives a topic when its code comes back", () => {
    const created = apply(first);
    const syllabusId = created.syllabusId!;
    apply({ ...first, topics: first.topics.filter((topic) => topic.code !== "9") });
    apply(first);

    const restored = repo.getTopicByCode(db, syllabusId, "9");
    expect(restored?.archived_at).toBeNull();
    expect(repo.getTopics(db, syllabusId)).toHaveLength(3);
  });

  it("rolls an import back to the exact previous state", () => {
    const created = apply(first);
    const syllabusId = created.syllabusId!;

    const bond = repo.getTopicByCode(db, syllabusId, "2")!;
    repo.updateTopicProgress(db, bond.id, { status: "mastered", valence: "green" });

    // Snapshot *after* the progress change: that is the state the next import
    // must be able to restore, `updated_at` and all.
    const before = repo.getTopics(db, syllabusId).map((topic) => ({ ...topic }));

    const second = apply({
      ...first,
      topics: [
        { code: "1", title: "Atomic structure (revised)" },
        { code: "42", title: "Brand new" },
      ],
    });
    expect(second.success).toBe(true);

    const rolled = rollbackImport(db, second.importId!);
    expect(rolled.success).toBe(true);

    const after = repo.getTopics(db, syllabusId).map((topic) => ({ ...topic }));
    expect(after).toEqual(before);
    expect(after.find((topic) => topic.code === "2")!.status).toBe("mastered");
    expect(after.find((topic) => topic.code === "2")!.valence).toBe("green");
  });

  it("refuses to roll the same import back twice", () => {
    const created = apply(first);
    apply({ ...first, topics: [{ code: "1", title: "Atomic structure" }] });
    const latest = repo.listImports(db, created.syllabusId!)[0];

    expect(rollbackImport(db, latest.id).success).toBe(true);
    const again = rollbackImport(db, latest.id);
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/already been rolled back/i);
  });

  it("reports a missing import rather than throwing", () => {
    const result = rollbackImport(db, 999);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no longer exists/i);
  });

  it("rejects an empty topic list", () => {
    const result = apply({ ...first, topics: [] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no topics/i);
  });

  it("links parents by code in a second pass", () => {
    const created = apply({
      subject: "chemistry",
      board: "cambridge",
      level: "a-level",
      topics: [
        { code: "CHILD", title: "Child", parent: "PARENT" },
        { code: "PARENT", title: "Parent" },
      ],
    });

    const child = repo.getTopicByCode(db, created.syllabusId!, "CHILD")!;
    const parent = repo.getTopicByCode(db, created.syllabusId!, "PARENT")!;
    expect(child.parent_id).toBe(parent.id);
  });

  it("keeps two syllabi for the same subject apart", () => {
    apply(first);
    apply({ ...first, level: "as-level" });
    expect(repo.listSyllabi(db)).toHaveLength(2);
  });

  it("matches an existing syllabus by the import payload when no id is given", () => {
    const created = apply(first);
    const second = apply({ ...first, topics: [{ code: "1", title: "Atomic structure" }] });
    expect(second.syllabusId).toBe(created.syllabusId);
  });

  it("stores a rollback snapshot on every applied import", () => {
    const created = apply(first);
    const imports = repo.listImports(db, created.syllabusId!);
    const record = repo.getImportRecord(db, imports[0].id);
    expect(record?.prior_snapshot_json).toBe("[]");
    expect(record?.raw_payload).toContain("Atomic structure");
  });
});
