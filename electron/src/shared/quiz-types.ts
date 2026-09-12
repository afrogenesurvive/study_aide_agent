/**
 * Quizzes: data shapes for generated multiple-choice questions and the answers
 * recorded against them.
 *
 * Self-contained — the renderer type-checks `src/shared` without `services/`.
 *
 * A quiz is not a flashcard. `flashcards` stores one question and one answer;
 * a multiple-choice item also needs its distractors, which is why
 * `quizzes` + `quiz_questions` exist. `quiz_results` (created in 001, extended
 * by 003) records the answer and can point at either a flashcard or a quiz
 * question.
 */

export interface QuizRow {
  id: number;
  job_id: number | null;
  topic_id: number | null;
  title: string;
  source: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuizQuestionRow {
  id: number;
  quiz_id: number;
  topic_id: number | null;
  order_index: number;
  question: string;
  /** JSON-encoded `string[]`; always at least two entries when generated. */
  choices_json: string;
  answer_index: number;
  explanation: string | null;
  created_at: string;
}

/** A question with its choices decoded, for the runner UI. */
export interface QuizQuestionView {
  id: number;
  quizId: number;
  topicId: number | null;
  orderIndex: number;
  question: string;
  choices: string[];
  answerIndex: number;
  explanation: string | null;
}

export interface QuizDetail {
  quiz: QuizRow;
  questions: QuizQuestionView[];
}

export interface QuizSummary {
  id: number;
  title: string;
  topicId: number | null;
  topicCode: string | null;
  topicTitle: string | null;
  questionCount: number;
  archived: boolean;
  createdAt: string;
}

export interface QuizResultRow {
  id: number;
  flashcard_id: number | null;
  quiz_question_id: number | null;
  session_id: number | null;
  correct: number;
  confidence: number | null;
  response_time_ms: number | null;
  created_at: string;
}

/** One answer, as the UI reports it after the fact. */
export interface QuizAnswer {
  questionId: number;
  /** Index the user picked, or null when the question was skipped. */
  choiceIndex: number | null;
  correct: boolean;
  confidence?: number | null;
  responseTimeMs?: number | null;
}

/** Outcome of a finished quiz attempt. */
export interface QuizAttemptResult {
  quizId: number;
  total: number;
  correct: number;
  answers: QuizAnswer[];
}

/** A, B, C, … labels for the choice list. */
export const CHOICE_LABELS = ["A", "B", "C", "D", "E", "F"] as const;

/** Decode `choices_json`, tolerating anything malformed in the database. */
export function decodeChoices(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((choice): choice is string => typeof choice === "string");
  } catch {
    return [];
  }
}

export function toQuestionView(row: QuizQuestionRow): QuizQuestionView {
  return {
    id: row.id,
    quizId: row.quiz_id,
    topicId: row.topic_id,
    orderIndex: row.order_index,
    question: row.question,
    choices: decodeChoices(row.choices_json),
    answerIndex: row.answer_index,
    explanation: row.explanation,
  };
}
