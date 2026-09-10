import type { CanonicalTopic, ParseWarning } from "../../../src/shared/syllabus-types";

/**
 * Markdown / plain-text outline parser.
 *
 * Convention:
 *   # Heading            → syllabus title (ignored if it looks like a subject)
 *   ## Heading           → section
 *   ### Heading          → topic
 *   #### Heading         → sub-topic (child of the preceding ### topic)
 *
 * A leading reference is stripped into the topic `code`, so both
 * `### 1.2 Equilibrium` and `### 1.2 — Equilibrium` yield code `1.2`.
 *
 * When a document has no `###` headings at all (common for pasted text), bullet
 * list items under a `##` heading are treated as topics instead.
 */

/**
 * Matches a leading reference such as `1`, `1.2`, `1a` or `9.1c` followed by the title.
 * The optional trailing letter matters: sub-topics are commonly labelled `1a`, not `1.1`.
 */
const REFERENCE = /^((?:\d+(?:\.\d+)*[a-z]?)|(?:[A-Z]{1,3}\d+(?:\.\d+)*[a-z]?))\s*[:.)\-–—]?\s+(.*)$/;

export interface MarkdownParseResult {
  title?: string;
  sections: Array<{ title: string; topics: Array<CanonicalTopic & { subTopics?: CanonicalTopic[] }> }>;
  warnings: ParseWarning[];
  /** Topics found with no enclosing section. */
  looseTopics: CanonicalTopic[];
}

function splitHeading(text: string): { code?: string; title: string } {
  const match = REFERENCE.exec(text.trim());
  if (!match) return { title: text.trim() };
  const title = match[2].trim();
  if (!title) return { title: text.trim() };
  return { code: match[1], title };
}

function headingLevel(line: string): number | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  return match ? match[1].length : null;
}

function bulletText(line: string): string | null {
  const match = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/.exec(line);
  return match ? match[1].trim() : null;
}

export function parseMarkdownOutline(text: string): MarkdownParseResult {
  const warnings: ParseWarning[] = [];
  const sections: MarkdownParseResult["sections"] = [];
  const looseTopics: CanonicalTopic[] = [];
  let title: string | undefined;

  let currentSection: { title: string; topics: MarkdownParseResult["sections"][number]["topics"] } | null =
    null;
  let currentTopic: (CanonicalTopic & { subTopics?: CanonicalTopic[] }) | null = null;

  const lines = String(text ?? "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const level = headingLevel(line);

    if (level !== null) {
      const raw = line.replace(/^#+\s*/, "").trim();
      if (!raw) continue;
      const { code, title: headingTitle } = splitHeading(raw);

      if (level === 1) {
        // A lone H1 is usually the document title rather than a topic.
        if (!title) title = headingTitle;
        continue;
      }
      if (level === 2) {
        currentSection = { title: raw, topics: [] };
        sections.push(currentSection);
        currentTopic = null;
        continue;
      }

      const topic: CanonicalTopic = {
        code: code ?? "",
        title: headingTitle,
        section: currentSection?.title,
      };

      if (level === 3) {
        currentTopic = topic;
        if (currentSection) currentSection.topics.push(currentTopic);
        else looseTopics.push(topic);
        continue;
      }

      // Level 4+ becomes a child of the preceding topic.
      if (currentTopic) {
        currentTopic.subTopics = currentTopic.subTopics ?? [];
        currentTopic.subTopics.push({
          ...topic,
          parent: currentTopic.code || currentTopic.title,
        });
      } else if (currentSection) {
        currentSection.topics.push(topic);
      } else {
        looseTopics.push(topic);
      }
      continue;
    }

    // No headings at all: fall back to bullets.
    const bullet = bulletText(line);
    if (bullet && (sections.length === 0 || sections.every((s) => s.topics.length === 0))) {
      const { code, title: bulletTitle } = splitHeading(bullet);
      if (bulletTitle.length > 2 && bulletTitle.length < 200) {
        const topic: CanonicalTopic = { code: code ?? "", title: bulletTitle };
        if (currentSection) currentSection.topics.push(topic);
        else looseTopics.push(topic);
      }
    }
  }

  // Drop empty sections so the caller can rely on `topics.length`.
  const populated = sections.filter((section) => section.topics.length > 0);
  if (sections.length && !populated.length) {
    warnings.push({
      message: "Found section headings but no topics beneath them — check the heading levels.",
    });
  }

  return { title, sections: populated, warnings, looseTopics };
}
