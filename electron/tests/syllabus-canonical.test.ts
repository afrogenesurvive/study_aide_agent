import { describe, expect, it } from "vitest";
import {
  deriveCode,
  normalizeBoard,
  normalizeCanonical,
  normalizeLevel,
  normalizeSubject,
} from "../services/syllabus/canonical";
import type { ParseWarning } from "../src/shared/syllabus-types";

/** Warnings are structured; join their messages for readable assertions. */
const messages = (warnings: ParseWarning[]) => warnings.map((warning) => warning.message).join(" ");

describe("normalizers", () => {
  it("maps subject aliases and paper codes", () => {
    expect(normalizeSubject("Chemistry")).toBe("chemistry");
    expect(normalizeSubject("9701")).toBe("chemistry");
    expect(normalizeSubject("maths")).toBe("math");
    expect(normalizeSubject("BIO")).toBe("biology");
    expect(normalizeSubject("physics")).toBeNull();
  });

  it("maps board aliases", () => {
    expect(normalizeBoard("CAIE")).toBe("cambridge");
    expect(normalizeBoard("cambridge international")).toBe("cambridge");
    expect(normalizeBoard("Pearson")).toBe("edexcel");
    expect(normalizeBoard(undefined)).toBe("cambridge");
  });

  it("maps level aliases", () => {
    expect(normalizeLevel("A Level")).toBe("a-level");
    expect(normalizeLevel("AS")).toBe("as-level");
    expect(normalizeLevel("")).toBe("a-level");
  });
});

describe("deriveCode", () => {
  it("slugifies a title when there is no section", () => {
    expect(deriveCode("Atomic structure")).toBe("atomic-structure");
  });

  it("prefixes with the section so identical titles do not collide", () => {
    expect(deriveCode("Kinetics", "Physical chemistry")).toBe("physical-chemistry.kinetics");
  });

  it("falls back to a positional code for untitleable input", () => {
    expect(deriveCode("!!!", undefined, 4)).toBe("topic-5");
  });
});

describe("normalizeCanonical", () => {
  const base = { board: "cambridge", level: "a-level" } as const;

  it("accepts a flat topic list", () => {
    const result = normalizeCanonical(
      {
        subject: "chemistry",
        topics: [
          { code: "1.1", title: "Atomic structure", estHours: 8 },
          { code: "1.2", title: "Bonding" },
        ],
      },
      base,
    );

    expect(result.canonical?.subject).toBe("chemistry");
    expect(result.canonical?.board).toBe("cambridge");
    expect(result.canonical?.topics).toEqual([
      { code: "1.1", title: "Atomic structure", estHours: 8 },
      { code: "1.2", title: "Bonding" },
    ]);
  });

  it("flattens a nested section structure and carries the section down", () => {
    const result = normalizeCanonical(
      {
        subject: "chemistry",
        sections: [
          {
            code: "PHYS",
            title: "Physical chemistry",
            topics: [{ code: "1", title: "Atomic structure" }],
          },
          { title: "Organic chemistry", topics: [{ title: "Hydrocarbons" }] },
        ],
      },
      base,
    );

    const topics = result.canonical?.topics ?? [];
    expect(topics).toHaveLength(2);
    expect(topics[0]).toMatchObject({ code: "1", section: "Physical chemistry", parent: "PHYS" });
    expect(topics[1].section).toBe("Organic chemistry");
  });

  it("uses camelCase aliases from loose JSON", () => {
    const result = normalizeCanonical(
      {
        subject: "math",
        topics: [{ id: "1.4", name: "Circular measure", unit: "Pure Mathematics 1", est_hours: "6" }],
      },
      base,
    );
    expect(result.canonical?.topics[0]).toMatchObject({
      code: "1.4",
      title: "Circular measure",
      section: "Pure Mathematics 1",
      estHours: 6,
    });
  });

  it("rejects an unresolvable subject with an actionable message", () => {
    const result = normalizeCanonical({ topics: [{ title: "Something" }] });
    expect(result.canonical).toBeNull();
    expect(result.error).toMatch(/subject/i);
  });

  it("falls back to the supplied defaults when the document omits metadata", () => {
    const result = normalizeCanonical({ topics: [{ title: "Cell structure" }] }, {
      subject: "biology",
      board: "aqa",
      level: "as-level",
    });
    expect(result.canonical).toMatchObject({ subject: "biology", board: "aqa", level: "as-level" });
  });

  it("renames duplicate codes rather than silently dropping a topic", () => {
    const result = normalizeCanonical(
      {
        subject: "chemistry",
        topics: [
          { code: "1", title: "First" },
          { code: "1", title: "Second" },
        ],
      },
      base,
    );
    expect(result.canonical?.topics.map((topic) => topic.code)).toEqual(["1", "1-2"]);
    expect(messages(result.warnings)).toMatch(/Duplicate topic code/);
  });

  it("warns and skips topics with no title", () => {
    const result = normalizeCanonical(
      { subject: "chemistry", topics: [{ code: "1" }, { code: "2", title: "Kept" }] },
      base,
    );
    expect(result.canonical?.topics).toHaveLength(1);
    expect(messages(result.warnings)).toMatch(/missing a title/);
  });

  it("errors when there are no usable topics", () => {
    const result = normalizeCanonical({ subject: "chemistry", topics: [] }, base);
    expect(result.canonical).toBeNull();
    expect(result.error).toMatch(/No topics/);
  });

  it("ignores an out-of-range estimated hours value", () => {
    const result = normalizeCanonical(
      { subject: "chemistry", topics: [{ title: "Weird", estHours: 99999 }] },
      base,
    );
    expect(result.canonical?.topics[0].estHours).toBeUndefined();
  });
});
