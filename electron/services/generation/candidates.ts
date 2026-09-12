import {
  EMPTY_GENERATION_OUTPUT,
  type GeneratedCard,
  type GeneratedQuestion,
  type GenerationOutput,
} from "../../src/shared/generation-types";

/**
 * Turning whatever the model said into candidates.
 *
 * Modelled on `syllabus/canonical.ts`: coerce and collect warnings rather than
 * throw. A model that returns four good cards and one malformed one should yield
 * four cards and a warning, not a failed run — the user still sees the four at
 * the gate and can judge them.
 *
 * Nothing here is trusted. The output is JSON that a language model produced from
 * a prompt, so every field is checked and every rejection is explained.
 */

/** A question needs at least this many choices to be answerable at all. */
const MIN_CHOICES = 2;
/** Above this, the item is unusable as a single question. */
const MAX_CHOICES = 8;
const MAX_QUESTION_CHARS = 2_000;
const MAX_ANSWER_CHARS = 4_000;

export interface CoerceResult {
  cards: GeneratedCard[];
  questions: GeneratedQuestion[];
  warnings: string[];
}

/**
 * Accept either `{cards: […]}`, `{questions: […]}` or a bare array.
 *
 * The prompts ask for a specific key, but models also return a top-level array
 * or nest the payload under an obvious alternative name, and there is no upside
 * in rejecting those.
 */
function pickArray(raw: unknown, key: "cards" | "questions"): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const source = raw as Record<string, unknown>;
  const direct = source[key];
  if (Array.isArray(direct)) return direct;
  // Single-item convenience: { card: {...} } / { question: {...} }
  const singular = key === "cards" ? source.card : source.question;
  if (singular && typeof singular === "object") return [singular];
  return [];
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function optionalText(value: unknown, max: number): string | null {
  return text(value, max);
}

/**
 * Coerce one topic's worth of model output.
 *
 * `topicCode` is stamped on rather than read from the response: the child knows
 * which unit produced this text, so asking the model to echo the code back would
 * only add a way for it to be wrong.
 */
export function coerceCandidates(raw: unknown, topicCode: string | null): CoerceResult {
  const warnings: string[] = [];

  const cards: GeneratedCard[] = [];
  for (const [index, entry] of pickArray(raw, "cards").entries()) {
    if (!entry || typeof entry !== "object") {
      warnings.push(`Card #${index + 1} was not an object and was skipped.`);
      continue;
    }
    const source = entry as Record<string, unknown>;
    const question = text(source.question ?? source.front ?? source.prompt, MAX_QUESTION_CHARS);
    const answer = text(source.answer ?? source.back ?? source.response, MAX_ANSWER_CHARS);
    if (!question || !answer) {
      warnings.push(`Card #${index + 1} was missing a usable question or answer and was skipped.`);
      continue;
    }
    cards.push({ question, answer, topicCode });
  }

  const questions: GeneratedQuestion[] = [];
  for (const [index, entry] of pickArray(raw, "questions").entries()) {
    if (!entry || typeof entry !== "object") {
      warnings.push(`Question #${index + 1} was not an object and was skipped.`);
      continue;
    }
    const source = entry as Record<string, unknown>;
    const stem = text(source.question ?? source.stem ?? source.prompt, MAX_QUESTION_CHARS);
    if (!stem) {
      warnings.push(`Question #${index + 1} had no question text and was skipped.`);
      continue;
    }

    const rawChoices = Array.isArray(source.choices) ? source.choices : [];
    const choices = rawChoices
      .map((choice) => text(choice, MAX_ANSWER_CHARS))
      .filter((choice): choice is string => choice !== null);

    if (choices.length < MIN_CHOICES) {
      warnings.push(
        `Question #${index + 1} had fewer than ${MIN_CHOICES} usable choices and was skipped.`,
      );
      continue;
    }
    if (choices.length > MAX_CHOICES) {
      warnings.push(`Question #${index + 1} had more than ${MAX_CHOICES} choices and was skipped.`);
      continue;
    }

    const answerIndex = Number(source.answerIndex ?? source.answer_index ?? source.correctIndex);
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= choices.length) {
      warnings.push(
        `Question #${index + 1} named an answer that is not one of its choices and was skipped.`,
      );
      continue;
    }

    questions.push({
      question: stem,
      choices,
      answerIndex,
      explanation: optionalText(source.explanation ?? source.rationale, MAX_ANSWER_CHARS),
      topicCode,
    });
  }

  return { cards, questions, warnings };
}

/** Merge a run's per-unit results into the single payload stored on the job. */
export function mergeOutputs(outputs: Array<CoerceResult | GenerationOutput>): GenerationOutput {
  const cards: GeneratedCard[] = [];
  const questions: GeneratedQuestion[] = [];
  const warnings: string[] = [];
  const seenCards = new Set<string>();
  const seenQuestions = new Set<string>();

  for (const output of outputs) {
    warnings.push(...output.warnings);

    for (const card of output.cards) {
      // Two topics can legitimately produce the same wording; the duplicate is
      // still noise at the gate, so keep the first and say so.
      const key = duplicateKey(card.question);
      if (seenCards.has(key)) {
        warnings.push(`Dropped a duplicate card: “${card.question.slice(0, 60)}”.`);
        continue;
      }
      seenCards.add(key);
      cards.push(card);
    }

    for (const question of output.questions) {
      const key = duplicateKey(question.question);
      if (seenQuestions.has(key)) {
        warnings.push(`Dropped a duplicate question: “${question.question.slice(0, 60)}”.`);
        continue;
      }
      seenQuestions.add(key);
      questions.push(question);
    }
  }

  return { cards, questions, warnings };
}

/**
 * Key for duplicate detection.
 *
 * Case and whitespace are ignored — models vary both between calls, and
 * "Same?" and "  same?  " are the same question to a reader.
 */
function duplicateKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Group questions by the topic they came from, for one quiz per topic. */
export function groupQuestionsByTopic(
  questions: GeneratedQuestion[],
): Map<string | null, GeneratedQuestion[]> {
  const groups = new Map<string | null, GeneratedQuestion[]>();
  for (const question of questions) {
    const key = question.topicCode ?? null;
    const bucket = groups.get(key);
    if (bucket) bucket.push(question);
    else groups.set(key, [question]);
  }
  return groups;
}

export function emptyOutput(): GenerationOutput {
  return { ...EMPTY_GENERATION_OUTPUT };
}
