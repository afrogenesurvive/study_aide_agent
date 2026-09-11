import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../services/database/db";
import { normalizeCanonical } from "../services/syllabus/canonical";
import * as repo from "../services/syllabus/repo";
import { createTestDb } from "./helpers/test-db";

/**
 * Section-derived hierarchy and manual parent edits.
 *
 * Most import sources describe structure with a section heading without ever
 * saying which topic that section *is*, so `normalizeCanonical` derives the link.
 * The editor then has to be able to override or remove it.
 */

/** A source where sections exist as topics but nothing links to them. */
function sectionOnlySource() {
  return {
    subject: "chemistry",
    board: "cambridge",
    level: "a-level",
    topics: [
      { code: "1", title: "Atomic structure" },
      { code: "1.1", title: "Sub-atomic particles", section: "Atomic structure" },
      { code: "1.2", title: "Mass spectrometry", section: "Atomic structure" },
      { code: "2", title: "Bonding" },
      { code: "2.1", title: "Ionic bonding", section: "Bonding" },
    ],
  };
}

describe("normalizeCanonical parent derivation", () => {
  it("links topics whose section names another topic", () => {
    const { canonical } = normalizeCanonical(sectionOnlySource());
    const byCode = new Map(canonical?.topics.map((topic) => [topic.code, topic]));
    expect(byCode.get("1.1")?.parent).toBe("1");
    expect(byCode.get("1.2")?.parent).toBe("1");
    expect(byCode.get("2.1")?.parent).toBe("2");
  });

  it("leaves the section topics themselves without a parent", () => {
    const { canonical } = normalizeCanonical(sectionOnlySource());
    const byCode = new Map(canonical?.topics.map((topic) => [topic.code, topic]));
    expect(byCode.get("1")?.parent).toBeUndefined();
    expect(byCode.get("2")?.parent).toBeUndefined();
  });

  it("does not invent a parent for a section with no matching topic", () => {
    const { canonical } = normalizeCanonical({
      subject: "math",
      board: "cambridge",
      level: "a-level",
      topics: [{ code: "1.1", title: "Quadratics", section: "Algebra" }],
    });
    expect(canonical?.topics[0].parent).toBeUndefined();
  });

  it("respects an explicit parent and leaves it alone", () => {
    const { canonical } = normalizeCanonical({
      subject: "math",
      board: "cambridge",
      level: "a-level",
      topics: [
        { code: "A", title: "Algebra" },
        { code: "B", title: "Algebra basics" },
        { code: "C", title: "Quadratics", section: "Algebra", parent: "B" },
      ],
    });
    expect(canonical?.topics.find((topic) => topic.code === "C")?.parent).toBe("B");
  });

  it("can be turned off", () => {
    const { canonical } = normalizeCanonical(sectionOnlySource(), { deriveParents: false });
    expect(canonical?.topics.every((topic) => topic.parent === undefined)).toBe(true);
  });
});

describe("editing a topic's parent", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  function seeded() {
    const syllabusId = repo.createSyllabus(db, {
      subject: "chemistry",
      board: "cambridge",
      level: "a-level",
    });
    const parent = repo.upsertTopic(db, syllabusId, {
      code: "1",
      title: "Atomic structure",
      orderIndex: 0,
    });
    const child = repo.upsertTopic(db, syllabusId, {
      code: "1.1",
      title: "Sub-atomic particles",
      parentId: parent,
      orderIndex: 1,
    });
    const other = repo.upsertTopic(db, syllabusId, {
      code: "2",
      title: "Bonding",
      orderIndex: 2,
    });
    return { syllabusId, parent, child, other };
  }

  it("attaches a topic to a parent", () => {
    const { child, other } = seeded();
    expect(repo.getTopic(db, other)?.parent_id).toBeNull();

    repo.updateTopicFields(db, other, { parentId: child });
    expect(repo.getTopic(db, other)?.parent_id).toBe(child);
  });

  it("detaches a topic", () => {
    const { parent, child } = seeded();
    expect(repo.getTopic(db, child)?.parent_id).toBe(parent);

    repo.updateTopicFields(db, child, { parentId: null });
    expect(repo.getTopic(db, child)?.parent_id).toBeNull();
  });

  it("leaves the parent alone when the patch does not mention it", () => {
    const { parent, child } = seeded();
    repo.updateTopicFields(db, child, { title: "Renamed" });
    expect(repo.getTopic(db, child)?.parent_id).toBe(parent);
    expect(repo.getTopic(db, child)?.title).toBe("Renamed");
  });
});
