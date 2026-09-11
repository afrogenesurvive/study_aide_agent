import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../services/database/db";
import {
  deleteTheme,
  getTheme,
  listThemes,
  loadOverlapMapFile,
  parseOverlapMap,
  resolveTheme,
  seedOverlayMapFile,
  seedOverlayThemes,
  themesForTopicCodes,
} from "../services/scheduler/overlay";
import type { OverlayTheme } from "../src/shared/scheduler-types";
import { createTestDb } from "./helpers/test-db";
import { seedSyllabus } from "./helpers/review-fixtures";

function theme(overrides: Partial<OverlayTheme> = {}): OverlayTheme {
  return {
    theme: "EQUILIBRIUM",
    commonPrinciple: "Systems under stress settle at a new steady state.",
    source: "seeded",
    connections: [
      { subject: "chemistry", concept: "Le Chatelier", topicCodes: ["7", "25"] },
      { subject: "math", concept: "Logarithms", topicCodes: ["2.2"] },
      { subject: "biology", concept: "Homeostasis", topicCodes: ["14"] },
    ],
    ...overrides,
  };
}

describe("parseOverlapMap", () => {
  it("reads a well-formed map", () => {
    const { themes, warnings } = parseOverlapMap({
      themes: [
        {
          theme: "ENERGY",
          source: "seeded",
          commonPrinciple: "Energy degrades.",
          connections: [{ subject: "chemistry", concept: "Enthalpy", topics: ["5"] }],
        },
      ],
    });
    expect(warnings).toEqual([]);
    expect(themes).toHaveLength(1);
    expect(themes[0].theme).toBe("ENERGY");
    expect(themes[0].connections[0].topicCodes).toEqual(["5"]);
  });

  it("defaults the optional fields", () => {
    const { themes } = parseOverlapMap({
      themes: [{ theme: "X", connections: [{ subject: "math", topics: ["1"] }] }],
    });
    expect(themes[0].commonPrinciple).toBe("");
    expect(themes[0].source).toBe("seeded");
    expect(themes[0].connections[0].concept).toBe("");
  });

  it("rejects input that is not a theme list", () => {
    expect(parseOverlapMap(null).themes).toEqual([]);
    expect(parseOverlapMap("nope").warnings[0]).toContain("not an object");
    expect(parseOverlapMap({}).warnings[0]).toContain("no `themes` array");
  });

  it("skips bad entries with a warning rather than failing the whole file", () => {
    const { themes, warnings } = parseOverlapMap({
      themes: [
        { connections: [] },
        { theme: "NO-CONNECTIONS" },
        { theme: "BAD-SUBJECT", connections: [{ subject: "history", topics: ["1"] }] },
        { theme: "NO-CODES", connections: [{ subject: "math", topics: [] }] },
        { theme: "GOOD", connections: [{ subject: "math", topics: ["1"] }] },
      ],
    });
    expect(themes.map((entry) => entry.theme)).toEqual(["GOOD"]);
    expect(warnings.some((w) => w.includes("has no name"))).toBe(true);
    expect(warnings.some((w) => w.includes("no connections array"))).toBe(true);
    expect(warnings.some((w) => w.includes("unknown subject"))).toBe(true);
    expect(warnings.some((w) => w.includes("no topic codes"))).toBe(true);
    expect(warnings.some((w) => w.includes("no usable connections"))).toBe(true);
  });

  it("coerces numeric topic codes to strings", () => {
    const { themes } = parseOverlapMap({
      themes: [{ theme: "X", connections: [{ subject: "math", topics: [1, "2.2"] }] }],
    });
    expect(themes[0].connections[0].topicCodes).toEqual(["1", "2.2"]);
  });
});

describe("the committed overlap map", () => {
  it("parses cleanly and still describes four themes", () => {
    // The file ships with the app, so a broken map is a real failure, not just a
    // fixture problem.
    const file = path.resolve(process.cwd(), "../data/overlap-map.json");
    const { themes, warnings } = loadOverlapMapFile(file);
    expect(warnings).toEqual([]);
    expect(themes.map((entry) => entry.theme)).toEqual([
      "EQUILIBRIUM",
      "EXPONENTIAL CHANGE",
      "ENERGY",
      "STRUCTURE AND BONDING",
    ]);
    // Three subjects per theme, thirteen topic links in total.
    expect(themes.every((entry) => entry.connections.length === 3)).toBe(true);
  });

  it("reports a missing file instead of throwing", () => {
    const { themes, warnings } = loadOverlapMapFile("/definitely/not/here.json");
    expect(themes).toEqual([]);
    expect(warnings[0]).toContain("Could not read");
  });
});

describe("seeding", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("writes themes and their topic links", () => {
    const result = seedOverlayThemes(db, [theme()]);
    expect(result.themes).toBe(1);
    expect(result.connections).toBe(4);
    expect(result.removed).toBe(0);

    const stored = listThemes(db);
    expect(stored).toHaveLength(1);
    expect(stored[0].theme).toBe("EQUILIBRIUM");
    expect(stored[0].connections.find((c) => c.subject === "chemistry")?.topicCodes).toEqual([
      "7",
      "25",
    ]);
  });

  it("is idempotent", () => {
    seedOverlayThemes(db, [theme()]);
    seedOverlayThemes(db, [theme()]);
    const stored = listThemes(db);
    expect(stored).toHaveLength(1);
    expect(stored[0].connections).toHaveLength(3);

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM overlay_theme_topics")
      .get() as { n: number };
    expect(Number(rows.n)).toBe(4);
  });

  it("updates the concept text of an existing link", () => {
    seedOverlayThemes(db, [theme()]);
    seedOverlayThemes(db, [
      theme({
        connections: [{ subject: "chemistry", concept: "Rewritten", topicCodes: ["7"] }],
      }),
    ]);
    const stored = getTheme(db, "EQUILIBRIUM");
    expect(stored?.connections).toHaveLength(1);
    expect(stored?.connections[0].concept).toBe("Rewritten");
  });

  it("drops seeded links the source no longer mentions", () => {
    seedOverlayThemes(db, [theme()]);
    const result = seedOverlayThemes(db, [
      theme({ connections: [{ subject: "chemistry", concept: "Le Chatelier", topicCodes: ["7"] }] }),
    ]);
    expect(result.removed).toBe(3);
    expect(getTheme(db, "EQUILIBRIUM")?.connections).toHaveLength(1);
  });

  it("removes a seeded theme that has disappeared from the source", () => {
    seedOverlayThemes(db, [theme(), theme({ theme: "ENERGY" })]);
    expect(listThemes(db)).toHaveLength(2);

    seedOverlayThemes(db, [theme()]);
    expect(listThemes(db).map((entry) => entry.theme)).toEqual(["EQUILIBRIUM"]);
  });

  it("leaves hand-edited, non-seeded themes alone", () => {
    seedOverlayThemes(db, [theme()]);
    db.prepare(
      `INSERT INTO overlay_themes (theme, common_principle, source) VALUES ('MINE', 'hand made', 'manual')`,
    ).run();
    db.prepare(
      `INSERT INTO overlay_theme_topics (theme, subject, concept, topic_code, source)
       VALUES ('MINE', 'biology', 'custom', '99', 'manual')`,
    ).run();

    seedOverlayThemes(db, []);
    const themes = listThemes(db);
    expect(themes.map((entry) => entry.theme)).toEqual(["MINE"]);
    expect(themes[0].source).toBe("manual");
  });

  it("seeds from a file and reports its warnings", () => {
    const file = path.resolve(process.cwd(), "../data/overlap-map.json");
    const result = seedOverlayMapFile(db, file);
    expect(result.warnings).toEqual([]);
    expect(result.themes).toBe(4);
    expect(listThemes(db)).toHaveLength(4);
  });

  it("deletes a theme and its links together", () => {
    seedOverlayThemes(db, [theme()]);
    expect(deleteTheme(db, "EQUILIBRIUM")).toBe(true);
    expect(listThemes(db)).toEqual([]);
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM overlay_theme_topics")
      .get() as { n: number };
    expect(Number(rows.n)).toBe(0);
  });
});

describe("resolveTheme", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    seedOverlayThemes(db, [theme()]);
  });

  afterEach(() => close());

  it("returns null for a theme that does not exist", () => {
    expect(resolveTheme(db, "NOPE")).toBeNull();
  });

  it("matches the theme's codes against the syllabus", () => {
    const { syllabusId, topicIds } = seedSyllabus(db, "chemistry", ["7", "25"]);
    const resolved = resolveTheme(db, "EQUILIBRIUM", [syllabusId]);
    const chemistry = resolved?.connections.find((c) => c.subject === "chemistry");

    // Codes keep the order the overlap map author wrote them in.
    expect(chemistry?.topics.map((topic) => topic.code)).toEqual(["7", "25"]);
    expect(chemistry?.topics.map((topic) => topic.id)).toEqual(topicIds);
    expect(resolved?.topicIds).toEqual(topicIds);
  });

  it("counts only the subjects with a matching topic", () => {
    const { syllabusId } = seedSyllabus(db, "chemistry", ["7"]);
    const resolved = resolveTheme(db, "EQUILIBRIUM", [syllabusId]);
    expect(resolved?.subjectCount).toBe(1);
  });

  it("spans all three subjects when each has its own active syllabus", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7", "25"]);
    const math = seedSyllabus(db, "math", ["2.2"]);
    const biology = seedSyllabus(db, "biology", ["14"]);

    const resolved = resolveTheme(db, "EQUILIBRIUM", [
      chemistry.syllabusId,
      math.syllabusId,
      biology.syllabusId,
    ]);
    expect(resolved?.subjectCount).toBe(3);
    expect(resolved?.topicIds).toHaveLength(4);
  });

  it("does not count a code that belongs to a different syllabus", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    const biology = seedSyllabus(db, "biology", ["14"]);

    // Scoped to biology only, the chemistry leg has no chemistry syllabus to match.
    const scoped = resolveTheme(db, "EQUILIBRIUM", [biology.syllabusId]);
    expect(scoped?.connections.find((c) => c.subject === "chemistry")?.topics).toEqual([]);
    expect(scoped?.topicIds).toEqual(biology.topicIds);
    expect(scoped?.subjectCount).toBe(1);

    // Both in scope: each leg matches inside its own subject.
    const both = resolveTheme(db, "EQUILIBRIUM", [chemistry.syllabusId, biology.syllabusId]);
    expect(both?.connections.find((c) => c.subject === "chemistry")?.topics[0].id).toBe(
      chemistry.topicIds[0],
    );
    expect(both?.connections.find((c) => c.subject === "biology")?.topics[0].id).toBe(
      biology.topicIds[0],
    );
    expect(both?.subjectCount).toBe(2);
  });

  it("will not match a chemistry code that only exists in the biology syllabus", () => {
    // Code 7 is the chemistry leg of EQUILIBRIUM. A biology syllabus that happens
    // to use the same code must not be mistaken for the chemistry link.
    const biology = seedSyllabus(db, "biology", ["7", "14"]);
    const resolved = resolveTheme(db, "EQUILIBRIUM", [biology.syllabusId]);
    expect(resolved?.connections.find((c) => c.subject === "chemistry")?.topics).toEqual([]);
    expect(resolved?.connections.find((c) => c.subject === "biology")?.topics[0].code).toBe("14");
  });

  it("searches every syllabus when no scope is given", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    const resolved = resolveTheme(db, "EQUILIBRIUM");
    expect(resolved?.connections.find((c) => c.subject === "chemistry")?.topics[0].id).toBe(
      chemistry.topicIds[0],
    );
  });

  it("ignores archived topics", () => {
    const { syllabusId, topicIds } = seedSyllabus(db, "chemistry", ["7"]);
    db.prepare("UPDATE syllabus_topics SET archived_at = '2026-09-10' WHERE id = ?").run(topicIds[0]);
    const resolved = resolveTheme(db, "EQUILIBRIUM", [syllabusId]);
    expect(resolved?.connections.find((c) => c.subject === "chemistry")?.topics).toEqual([]);
    expect(resolved?.subjectCount).toBe(0);
  });
});

describe("themesForTopicCodes", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    seedOverlayThemes(db, [
      theme(),
      theme({
        theme: "ENERGY",
        connections: [{ subject: "chemistry", concept: "Enthalpy", topicCodes: ["7", "5"] }],
      }),
    ]);
  });

  afterEach(() => close());

  it("lists every theme a code belongs to", () => {
    expect(themesForTopicCodes(db, ["7"])).toEqual(["ENERGY", "EQUILIBRIUM"]);
    expect(themesForTopicCodes(db, ["14"])).toEqual(["EQUILIBRIUM"]);
  });

  it("returns nothing for unknown codes or an empty list", () => {
    expect(themesForTopicCodes(db, ["nope"])).toEqual([]);
    expect(themesForTopicCodes(db, [])).toEqual([]);
  });
});
