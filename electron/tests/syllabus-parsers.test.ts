import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectFormat, parseSyllabus } from "../services/syllabus/parsers";
import { parseCsvTopics } from "../services/syllabus/parsers/csv";
import { parseMarkdownOutline } from "../services/syllabus/parsers/markdown";

/** Fixtures live at the repo root; vitest runs with cwd = electron/. */
const fixture = (name: string) => path.resolve(process.cwd(), "..", "data", "fixtures", name);

const options = {
  subject: "chemistry" as const,
  board: "cambridge",
  level: "a-level",
  allowLlm: false,
};

describe("detectFormat", () => {
  it("prefers the file extension", () => {
    expect(detectFormat("outline.csv", "")).toBe("csv");
    expect(detectFormat("spec.PDF", "")).toBe("pdf");
    expect(detectFormat("notes.md", "")).toBe("md");
  });

  it("sniffs content when the extension is unknown", () => {
    expect(detectFormat(undefined, '{"subject":"chemistry"}')).toBe("json");
    expect(detectFormat(undefined, "# Title\n## Section")).toBe("md");
    expect(detectFormat(undefined, "code,title,section\n1,Atomic structure,Physical")).toBe("csv");
    expect(detectFormat(undefined, "just some prose about chemistry")).toBe("text");
  });
});

describe("parseMarkdownOutline", () => {
  it("treats ## as a section and ### as a topic, stripping the reference into a code", () => {
    const parsed = parseMarkdownOutline(
      ["# Chemistry", "## Physical chemistry", "### 1.1 Atomic structure", "### 1.2 Bonding"].join("\n"),
    );

    expect(parsed.title).toBe("Chemistry");
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].title).toBe("Physical chemistry");
    expect(parsed.sections[0].topics[0]).toMatchObject({
      code: "1.1",
      title: "Atomic structure",
    });
  });

  it("nests #### beneath the preceding topic", () => {
    const parsed = parseMarkdownOutline(
      ["## Section", "### 1 Topic", "#### 1a Sub-topic"].join("\n"),
    );
    const topic = parsed.sections[0].topics[0];
    expect(topic.subTopics?.[0].title).toBe("Sub-topic");
    expect(topic.subTopics?.[0].parent).toBe("1");
  });

  it("falls back to bullets when there are no headings", () => {
    const parsed = parseMarkdownOutline("- Atomic structure\n- Bonding\n- Kinetics");
    expect(parsed.looseTopics).toHaveLength(3);
  });
});

describe("parseCsvTopics", () => {
  it("normalizes header aliases", () => {
    const result = parseCsvTopics("Ref,Name,Unit,Estimated Hours\n1.1,Atomic structure,Physical,8");
    expect(result.error).toBeUndefined();
    expect(result.rows[0]).toMatchObject({
      code: "1.1",
      title: "Atomic structure",
      section: "Physical",
      est_hours: "8",
    });
  });

  it("errors when there is no title column", () => {
    const result = parseCsvTopics("a,b\n1,2");
    expect(result.error).toMatch(/title/i);
  });

  it("handles quoted values containing commas", () => {
    const result = parseCsvTopics('code,title,section\n2,"Atoms, molecules and stoichiometry",Physical');
    expect(result.rows[0].title).toBe("Atoms, molecules and stoichiometry");
  });
});

describe("parseSyllabus", () => {
  it("parses the JSON seed", async () => {
    const text = fs.readFileSync(
      path.resolve(process.cwd(), "..", "data", "syllabi", "cambridge-alevel-9701-chemistry.json"),
      "utf8",
    );
    const result = await parseSyllabus({ text, fileName: "9701.json" }, options);
    expect(result.ok).toBe(true);
    expect(result.format).toBe("json");
    expect(result.canonical?.subject).toBe("chemistry");
    expect(result.canonical?.topics.length).toBeGreaterThan(20);
    // Section metadata must survive.
    expect(result.canonical?.topics.some((topic) => topic.section === "Organic chemistry")).toBe(true);
  });

  it("parses the CSV fixture", async () => {
    const text = fs.readFileSync(fixture("9701-chemistry-min.csv"), "utf8");
    const result = await parseSyllabus({ text, fileName: "9701-chemistry-min.csv" }, options);
    expect(result.ok).toBe(true);
    expect(result.format).toBe("csv");
    expect(result.canonical?.topics).toHaveLength(12);
    expect(result.canonical?.topics[1].title).toBe("Atoms, molecules and stoichiometry");
  });

  it("parses the Markdown fixture", async () => {
    const text = fs.readFileSync(fixture("9701-chemistry-min.md"), "utf8");
    const result = await parseSyllabus({ text, fileName: "9701-chemistry-min.md" }, options);
    expect(result.ok).toBe(true);
    expect(result.format).toBe("md");
    // 3 + 4 + 4 topics across the fixture's three sections.
    expect(result.canonical?.topics).toHaveLength(11);
    expect(result.usedLlm).toBe(false);
  });

  it("yields unique codes and a section for every topic, in every deterministic format", async () => {
    for (const name of ["9701-chemistry-min.csv", "9701-chemistry-min.md"]) {
      const result = await parseSyllabus(
        { text: fs.readFileSync(fixture(name), "utf8"), fileName: name },
        options,
      );
      const topics = result.canonical?.topics ?? [];
      expect(topics.length).toBeGreaterThan(8);
      expect(new Set(topics.map((topic) => topic.code)).size).toBe(topics.length);
      expect(topics.every((topic) => Boolean(topic.section))).toBe(true);
    }
  });

  it("does not call the LLM when allowLlm is false", async () => {
    const result = await parseSyllabus({ text: "some unstructured prose", fileName: "x.txt" }, options);
    expect(result.usedLlm).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no text to parse|no topics/i);
  });

  it("reports invalid JSON without throwing", async () => {
    const result = await parseSyllabus({ text: "{not json", fileName: "x.json" }, options);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSON/i);
  });

  it("reports a missing PDF payload without throwing", async () => {
    const result = await parseSyllabus({ fileName: "x.pdf" }, options);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No PDF data/i);
  });

  it("never throws, even on nonsense input", async () => {
    const result = await parseSyllabus({ text: "\u0000\u0001", fileName: "broken.json" }, options);
    expect(result.ok).toBe(false);
  });
});
