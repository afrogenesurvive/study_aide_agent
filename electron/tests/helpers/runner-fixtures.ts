import type { RunnerJobPayload } from "../../agent-runner/protocol";
import type { GenerationTopicInput } from "../../src/shared/generation-types";

/** Shared runner fixtures. */

export const RUN_TOPICS: GenerationTopicInput[] = [
  {
    topicId: 1,
    code: "1.1",
    title: "Atomic structure",
    subject: "chemistry",
    section: "Section 1",
    syllabusId: 1,
    themes: ["STRUCTURE AND BONDING"],
  },
];

/** A minimal, valid job payload. Override anything with `overrides`. */
export function buildRunnerPayload(overrides: Partial<RunnerJobPayload> = {}): RunnerJobPayload {
  return {
    jobId: 1,
    pipeline: "material-generation",
    systemPrompt: "Ground rules.",
    temperature: 0.4,
    maxRetries: 0,
    retryBaseDelayMs: 10,
    timeoutMs: 5_000,
    units: [
      {
        stepId: "step-2",
        toolName: "generate_flashcards",
        topicCode: "1.1",
        label: "Generate flashcards",
        systemMessage: "You are generating study material.",
        userContext: "Topic: 1.1 — Atomic structure (chemistry).",
      },
      {
        stepId: "step-3",
        toolName: "generate_quiz",
        topicCode: "1.1",
        label: "Generate quiz items",
        systemMessage: "You are writing a quiz.",
        userContext: "Topic: 1.1 — Atomic structure (chemistry).",
      },
    ],
    ...overrides,
  };
}

/** A model reply in the shape the prompts ask for. */
export function cardReply(questions = ["What is an orbital?"]): string {
  return JSON.stringify({ cards: questions.map((q) => ({ question: q, answer: "A region." })) });
}

export function quizReply(count = 3): string {
  return JSON.stringify({
    questions: Array.from({ length: count }, (_unused, index) => ({
      question: `Question ${index + 1}?`,
      choices: ["a", "b", "c", "d"],
      answerIndex: index % 4,
      explanation: "Because.",
    })),
  });
}
