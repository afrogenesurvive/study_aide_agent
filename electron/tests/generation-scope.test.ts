import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveScope } from "../services/generation/scope";
import * as syllabusRepo from "../services/syllabus/repo";
import type { Database } from "../services/database/db";
import type { GenerationRequest } from "../src/shared/generation-types";
import { createTestDb } from "./helpers/test-db";
import { seedSyllabus } from "./helpers/review-fixtures";

function seedTheme(db: Database, theme: string, code: string): void {
  db.prepare("INSERT INTO overlay_themes (theme, common_principle) VALUES (?, ?)").run(
    theme,
    "Shared idea.",
  );
  db.prepare(
    "INSERT INTO overlay_theme_topics (theme, subject, concept, topic_code) VALUES (?, ?, ?, ?)",
  ).run(theme, "chemistry", "Concept", code);
}

describe("resolveScope", () => {
  let db: Database;
  let close: () => void;
  let chemistry: number;
  let biology: number;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    chemistry = seedSyllabus(db, "chemistry", ["1.1", "1.2", "1.3"]).syllabusId;
    biology = seedSyllabus(db, "biology", ["1.1", "2.1"]).syllabusId;
    // `seedSyllabus` puts every topic in "Section 1"; give one a second section.
    syllabusRepo.upsertTopic(db, chemistry, {
      code: "9.9",
      title: "Topic 9.9",
      section: "Section 9",
      orderIndex: 9,
    });
  });

  afterEach(() => close());

  const request = (overrides: Partial<GenerationRequest>): GenerationRequest => ({
    scope: "syllabus",
    syllabusIds: [chemistry],
    ...overrides,
  });

  it("covers every topic for a whole-syllabus scope", () => {
    const result = resolveScope(db, request({}));
    expect(result.errors).toEqual([]);
    expect(result.topics.map((topic) => topic.code)).toEqual(["1.1", "1.2", "1.3", "9.9"]);
  });

  it("takes the subject from the parent syllabus row, not the topic", () => {
    const result = resolveScope(db, request({ syllabusIds: [chemistry, biology] }));
    const subjects = new Set(result.topics.map((topic) => topic.subject));
    expect(subjects).toEqual(new Set(["chemistry", "biology"]));
    expect(result.topics.find((topic) => topic.syllabusId === biology)?.subject).toBe("biology");
  });

  it("keeps topics from two syllabi that share a code", () => {
    const result = resolveScope(db, request({ syllabusIds: [chemistry, biology] }));
    const ones = result.topics.filter((topic) => topic.code === "1.1");
    expect(ones).toHaveLength(2);
    expect(ones.map((topic) => topic.subject).sort()).toEqual(["biology", "chemistry"]);
  });

  it("narrows to the chosen codes", () => {
    const result = resolveScope(db, request({ scope: "topic", codes: ["1.2"] }));
    expect(result.topics.map((topic) => topic.code)).toEqual(["1.2"]);
    expect(result.warnings).toEqual([]);
  });

  it("matches codes case-insensitively and ignores duplicates", () => {
    const result = resolveScope(db, request({ scope: "topic", codes: [" 1.2 ", "1.2"] }));
    expect(result.topics).toHaveLength(1);
  });

  it("warns about codes that matched nothing", () => {
    const result = resolveScope(db, request({ scope: "topic", codes: ["1.1", "7.7"] }));
    expect(result.topics.map((topic) => topic.code)).toEqual(["1.1"]);
    expect(result.warnings.join(" ")).toContain("7.7");
  });

  it("narrows to a section, ignoring case and padding", () => {
    const result = resolveScope(db, request({ scope: "section", section: "  section 9 " }));
    expect(result.topics.map((topic) => topic.code)).toEqual(["9.9"]);
  });

  it("explains an empty section rather than returning nothing quietly", () => {
    const result = resolveScope(db, request({ scope: "section", section: "Section 42" }));
    expect(result.topics).toEqual([]);
    expect(result.errors.join(" ")).toContain("Section 42");
  });

  it("requires at least one syllabus", () => {
    const result = resolveScope(db, request({ syllabusIds: [] }));
    expect(result.topics).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it("requires at least one code in topic scope", () => {
    const result = resolveScope(db, request({ scope: "topic", codes: [] }));
    expect(result.errors.join(" ")).toMatch(/at least one topic/i);
  });

  it("requires a section in section scope", () => {
    const result = resolveScope(db, request({ scope: "section", section: "   " }));
    expect(result.errors.join(" ")).toMatch(/section/i);
  });

  it("warns when a chosen syllabus no longer exists", () => {
    const result = resolveScope(db, request({ syllabusIds: [chemistry, 9999] }));
    expect(result.topics.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("9999");
  });

  it("reports an empty syllabus as an error", () => {
    const empty = syllabusRepo.createSyllabus(db, {
      // A subject this suite has not already seeded: `syllabus` is unique on
      // subject + board + level.
      subject: "math",
      board: "cambridge",
      level: "a-level",
    });
    const result = resolveScope(db, request({ syllabusIds: [empty] }));
    expect(result.errors.join(" ")).toMatch(/no topics/i);
  });

  it("attaches the overlay themes a topic participates in", () => {
    seedTheme(db, "STRUCTURE AND BONDING", "1.1");
    const result = resolveScope(db, request({ scope: "topic", codes: ["1.1", "1.2"] }));
    expect(result.topics.find((topic) => topic.code === "1.1")?.themes).toEqual([
      "STRUCTURE AND BONDING",
    ]);
    expect(result.topics.find((topic) => topic.code === "1.2")?.themes).toEqual([]);
  });

  it("skips archived topics", () => {
    const { topicIds } = seedSyllabus(db, "math", ["4.1"]);
    syllabusRepo.archiveTopic(db, topicIds[0]);
    const result = resolveScope(db, request({ syllabusIds: [chemistry] }));
    expect(result.topics.map((topic) => topic.code)).not.toContain("4.1");
  });
});
