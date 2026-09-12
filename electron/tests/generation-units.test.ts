import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MATERIAL_GENERATION,
  parsePipelineFile,
  resolveRunPlan,
  selectPipeline,
  type ResolvedStep,
  type RunPlan,
} from "../services/generation/pipeline";
import { parseToolList, type ToolDef } from "../services/generation/tools";
import {
  buildUnits,
  CARD_TOOL,
  QUIZ_TOOL,
  QUESTIONS_PER_TOPIC,
} from "../services/generation/units";
import type { GenerationTopicInput } from "../src/shared/generation-types";

/**
 * `buildUnits` runs against the shipped pipeline, so a change to
 * `pipeline.template.json` that breaks prompt rendering fails here.
 */
function readTemplate(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "..", "agent-config", name), "utf8"));
}

const TOOLS: ToolDef[] = parseToolList(readTemplate("tools.template.json")).tools;
const PIPELINE = parsePipelineFile(readTemplate("pipeline.template.json")).file;

function realPlan(): RunPlan {
  const pipeline = selectPipeline(PIPELINE, MATERIAL_GENERATION);
  if (!pipeline) throw new Error("material-generation pipeline is missing from the template");
  return resolveRunPlan(pipeline, TOOLS, { maxSteps: PIPELINE.maxPipelineSteps });
}

/** A plan whose only work step uses a tool with no prompt contract. */
function bogusPlan(toolName: string): RunPlan {
  const step: ResolvedStep = {
    id: "step-0",
    toolName,
    label: "Bogus",
    description: "",
    systemPromptTemplate: "",
    hintTemplate: "",
    enabled: true,
    isTerminal: false,
    index: 1,
    executor: "child",
    stage: "work",
    available: false,
  };
  return {
    pipeline: "test",
    label: "test",
    steps: [step],
    pre: [],
    work: [step],
    gate: null,
    commit: null,
    errors: [],
    warnings: [],
    ok: true,
  };
}

const TOPICS: GenerationTopicInput[] = [
  {
    topicId: 1,
    code: "1.1",
    title: "Atomic structure",
    subject: "chemistry",
    section: "Section 1",
    syllabusId: 1,
    themes: ["STRUCTURE AND BONDING", "ENERGY"],
  },
  {
    topicId: 2,
    code: "1.2",
    title: "Amount of substance",
    subject: "chemistry",
    section: "Section 1",
    syllabusId: 1,
    themes: [],
  },
];

const OPTIONS = { maxCardsPerTopic: 8, systemPrompt: "Ground rules." };

describe("buildUnits", () => {
  it("produces one unit per topic per work step", () => {
    const { units } = buildUnits(realPlan(), TOPICS, OPTIONS);
    // Two work steps (flashcards, quiz) across two topics.
    expect(units).toHaveLength(4);
  });

  it("orders step-major, so a whole step finishes before the next begins", () => {
    const { units } = buildUnits(realPlan(), TOPICS, OPTIONS);
    expect(units.map((unit) => unit.toolName)).toEqual([
      CARD_TOOL,
      CARD_TOOL,
      QUIZ_TOOL,
      QUIZ_TOOL,
    ]);
    expect(units.map((unit) => unit.topicCode)).toEqual(["1.1", "1.2", "1.1", "1.2"]);
  });

  it("carries the step id and label through for the progress list", () => {
    const { units } = buildUnits(realPlan(), TOPICS, OPTIONS);
    expect(units[0]).toMatchObject({ stepId: "step-2", label: "Generate flashcards" });
    expect(units[2]).toMatchObject({ stepId: "step-3", label: "Generate quiz items" });
  });

  it("layers the global prompt, the step prompt and the output contract", () => {
    const { units } = buildUnits(realPlan(), TOPICS, OPTIONS);
    const system = units[0].systemMessage;
    expect(system).toContain("Ground rules.");
    expect(system).toContain("Prefer retrieval-practice questions");
    expect(system).toContain('"cards"');
  });

  it("interpolates the topic into the user prompt", () => {
    const { units } = buildUnits(realPlan(), TOPICS, OPTIONS);
    expect(units[0].userContext).toContain("1.1");
    expect(units[0].userContext).toContain("Atomic structure");
    expect(units[0].userContext).toContain("chemistry");
  });

  it("renders the overlay themes, or says there are none", () => {
    const { units } = buildUnits(realPlan(), TOPICS, OPTIONS);
    expect(units[0].userContext).toContain("STRUCTURE AND BONDING");
    expect(units[1].userContext).toContain("none");
  });

  it("puts the card limit in the flashcard contract", () => {
    const { units } = buildUnits(realPlan(), TOPICS, { ...OPTIONS, maxCardsPerTopic: 5 });
    expect(units[0].systemMessage).toContain("at most 5 cards");
  });

  it("puts the question count in the quiz contract", () => {
    const { units } = buildUnits(realPlan(), TOPICS, OPTIONS);
    expect(units[2].systemMessage).toContain(`exactly ${QUESTIONS_PER_TOPIC} questions`);
  });

  it("leaves no placeholder unfilled in either prompt", () => {
    const { units } = buildUnits(realPlan(), TOPICS, OPTIONS);
    for (const unit of units) {
      expect(unit.systemMessage).not.toMatch(/\{\{/);
      expect(unit.userContext).not.toMatch(/\{\{/);
    }
  });

  it("skips a work tool with no prompt contract and warns", () => {
    const { units, warnings } = buildUnits(bogusPlan("socratic_reply"), TOPICS, OPTIONS);
    expect(units).toEqual([]);
    expect(warnings.some((warning) => warning.includes("no prompt contract"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("No work units"))).toBe(true);
  });

  it("warns when there is nothing to do", () => {
    const { units, warnings } = buildUnits(realPlan(), [], OPTIONS);
    expect(units).toEqual([]);
    expect(warnings.some((warning) => warning.includes("No work units"))).toBe(true);
  });

  it("never leaves a prompt empty", () => {
    const { units } = buildUnits(realPlan(), TOPICS, { maxCardsPerTopic: 8, systemPrompt: "" });
    for (const unit of units) {
      expect(unit.systemMessage.trim()).not.toBe("");
      expect(unit.userContext.trim()).not.toBe("");
    }
  });
});
