import { interpolate, type RunPlan, type ResolvedStep } from "./pipeline";
import type { GenerationTopicInput } from "../../src/shared/generation-types";

/**
 * Building the work list.
 *
 * One unit per (work step × topic): the pipeline says *which* model calls to make
 * and in what order, the scope says *what* to make them about, and this module
 * turns the pair into fully rendered prompts.
 *
 * Rendering here rather than in the child is deliberate. Interpolation needs the
 * topic, the overlay themes and the limits, all of which the main process already
 * has; doing it here means the child receives finished strings and reads no
 * config at all.
 */

/** A single model call, ready to send. */
export interface GenerationUnit {
  stepId: string;
  /** Which registry tool this unit implements, e.g. `generate_flashcards`. */
  toolName: string;
  topicCode: string;
  /** Human label for the progress list, e.g. "Generate flashcards". */
  label: string;
  systemMessage: string;
  userContext: string;
}

export const CARD_TOOL = "generate_flashcards";
export const QUIZ_TOOL = "generate_quiz";

/**
 * How many quiz items one topic gets.
 *
 * A constant rather than a config key for now: it is a prompt instruction, not a
 * budget the user needs to tune, and four options is enough for a usable item
 * without inviting the model to pad.
 */
export const QUESTIONS_PER_TOPIC = 4;

/**
 * The output contract appended to each step's prompt.
 *
 * Models drift toward prose without an explicit shape, and a wrong shape costs a
 * whole unit's output. The keys here are the ones `candidates.ts` accepts first.
 */
const OUTPUT_CONTRACT: Record<string, string> = {
  [CARD_TOOL]: [
    "Return JSON only, in exactly this shape:",
    '{"cards":[{"question":"…","answer":"…"}]}',
    "Give at most {{maxCards}} cards, each testing one idea.",
  ].join("\n"),
  [QUIZ_TOOL]: [
    "Return JSON only, in exactly this shape:",
    '{"questions":[{"question":"…","choices":["…","…","…","…"],"answerIndex":0,"explanation":"…"}]}',
    "Give exactly {{questionCount}} questions with four choices each.",
    "answerIndex is the 0-based position of the correct choice.",
    "Every incorrect choice must be plausible to someone who has not mastered the topic — never filler or obviously wrong.",
  ].join("\n"),
};

/** Used when a step's own `hintTemplate` is empty, which is the shipped default. */
const DEFAULT_HINT = [
  "Topic: {{topicCode}} — {{topicTitle}} ({{subject}}).",
  "Section: {{section}}.",
  "Cross-subject themes: {{overlayThemes}}.",
].join(" ");

export interface BuildUnitsOptions {
  maxCardsPerTopic: number;
  /** Global grounding prompt from `agent-config/system-prompt.md`. */
  systemPrompt: string;
}

export interface BuildUnitsResult {
  units: GenerationUnit[];
  warnings: string[];
}

/**
 * Expand a plan and a scope into the ordered work list.
 *
 * Step-major: every topic's cards are generated before any topic's quiz. That
 * keeps the progress list legible ("Generate flashcards" is one block, not five
 * interleaved ones) and leaves the door open to deriving quizzes from cards later.
 */
export function buildUnits(
  plan: RunPlan,
  topics: GenerationTopicInput[],
  options: BuildUnitsOptions,
): BuildUnitsResult {
  const warnings: string[] = [];
  const units: GenerationUnit[] = [];

  for (const step of plan.work) {
    if (!OUTPUT_CONTRACT[step.toolName]) {
      warnings.push(
        `Step "${step.id}" uses the work tool "${step.toolName}", which has no prompt contract — it was skipped.`,
      );
      continue;
    }
    for (const topic of topics) {
      units.push(buildUnit(step, topic, topics, options));
    }
  }

  if (units.length === 0) {
    warnings.push("No work units: the pipeline has no usable generation step for this scope.");
  }

  return { units, warnings };
}

function buildUnit(
  step: ResolvedStep,
  topic: GenerationTopicInput,
  topics: GenerationTopicInput[],
  options: BuildUnitsOptions,
): GenerationUnit {
  const vars = templateVars(topic, topics, options);

  const systemParts = [
    options.systemPrompt.trim(),
    interpolate(step.systemPromptTemplate, vars).trim(),
    interpolate(OUTPUT_CONTRACT[step.toolName], vars).trim(),
  ].filter(Boolean);

  return {
    stepId: step.id,
    toolName: step.toolName,
    topicCode: topic.code,
    label: step.label,
    systemMessage: systemParts.join("\n\n"),
    userContext: interpolate(step.hintTemplate || DEFAULT_HINT, vars).trim(),
  };
}

function templateVars(
  topic: GenerationTopicInput,
  topics: GenerationTopicInput[],
  options: BuildUnitsOptions,
): Record<string, string | number> {
  const syllabusIds = [...new Set(topics.map((entry) => entry.syllabusId))];

  return {
    topicCode: topic.code,
    topicTitle: topic.title,
    subject: topic.subject,
    section: topic.section ?? "—",
    overlayThemes: topic.themes.length ? topic.themes.join(", ") : "none",
    maxCards: options.maxCardsPerTopic,
    questionCount: QUESTIONS_PER_TOPIC,
    topicList: topics.map((entry) => `${entry.code} ${entry.title}`).join("; "),
    topicCount: topics.length,
    syllabusIds: syllabusIds.join(", "),
  };
}
