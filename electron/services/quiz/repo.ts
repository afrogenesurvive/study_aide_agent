import type { Database } from "../database/db";
import { isoOf } from "../time";
import {
  toQuestionView,
  type QuizAnswer,
  type QuizAttemptResult,
  type QuizDetail,
  type QuizQuestionRow,
  type QuizResultRow,
  type QuizRow,
  type QuizSummary,
} from "../../src/shared/quiz-types";

/**
 * Quiz persistence.
 *
 * Quizzes hold generated multiple-choice items, which is a different shape from
 * a flashcard: distractors have nowhere to live in `flashcards.question/answer`.
 * `quiz_results` records each answer and can point at either kind of item.
 *
 * Same conventions as the other repositories: `db` first, an explicit `now`, and
 * ISO-8601 UTC timestamps written from JavaScript rather than `datetime('now')`.
 */

const QUIZ_SELECT = `
  SELECT q.id, q.job_id, q.topic_id, q.title, q.source, q.archived_at, q.created_at, q.updated_at
    FROM quizzes q
`;

// ── writes ───────────────────────────────────────────────────────────────────

export interface QuizInput {
  title: string;
  topicId?: number | null;
  jobId?: number | null;
  source?: string;
}

export function createQuiz(db: Database, input: QuizInput, now: Date = new Date()): number {
  const stamp = isoOf(now);
  const result = db
    .prepare(
      `INSERT INTO quizzes (job_id, topic_id, title, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.jobId ?? null,
      input.topicId ?? null,
      input.title,
      input.source ?? "generated",
      stamp,
      stamp,
    );
  return Number(result.lastInsertRowid);
}

export interface QuizQuestionInput {
  quizId: number;
  question: string;
  choices: string[];
  answerIndex: number;
  explanation?: string | null;
  topicId?: number | null;
  orderIndex?: number;
}

export function insertQuestion(
  db: Database,
  input: QuizQuestionInput,
  now: Date = new Date(),
): number {
  const result = db
    .prepare(
      `INSERT INTO quiz_questions
         (quiz_id, topic_id, order_index, question, choices_json, answer_index, explanation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.quizId,
      input.topicId ?? null,
      input.orderIndex ?? 0,
      input.question,
      JSON.stringify(input.choices),
      input.answerIndex,
      input.explanation ?? null,
      isoOf(now),
    );
  return Number(result.lastInsertRowid);
}

export interface QuizResultInput {
  /** Exactly one of these is set. */
  quizQuestionId?: number | null;
  flashcardId?: number | null;
  sessionId?: number | null;
  correct: boolean;
  confidence?: number | null;
  responseTimeMs?: number | null;
}

export function recordQuizResult(
  db: Database,
  input: QuizResultInput,
  now: Date = new Date(),
): number {
  const result = db
    .prepare(
      `INSERT INTO quiz_results
         (flashcard_id, quiz_question_id, session_id, correct, confidence, response_time_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.flashcardId ?? null,
      input.quizQuestionId ?? null,
      input.sessionId ?? null,
      input.correct ? 1 : 0,
      input.confidence ?? null,
      input.responseTimeMs ?? null,
      isoOf(now),
    );
  return Number(result.lastInsertRowid);
}

/** Record a whole attempt, so a finished quiz is one transaction's worth of rows. */
export function recordAttempt(
  db: Database,
  quizId: number,
  answers: QuizAnswer[],
  now: Date = new Date(),
): QuizAttemptResult {
  for (const answer of answers) {
    recordQuizResult(
      db,
      {
        quizQuestionId: answer.questionId,
        correct: answer.correct,
        confidence: answer.confidence ?? null,
        responseTimeMs: answer.responseTimeMs ?? null,
      },
      now,
    );
  }
  return {
    quizId,
    total: answers.length,
    correct: answers.filter((answer) => answer.correct).length,
    answers,
  };
}

export function archiveQuiz(db: Database, id: number, now: Date = new Date()): boolean {
  const result = db
    .prepare("UPDATE quizzes SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(isoOf(now), isoOf(now), id);
  return Number(result.changes) > 0;
}

export function deleteQuiz(db: Database, id: number): boolean {
  const result = db.prepare("DELETE FROM quizzes WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

// ── reads ────────────────────────────────────────────────────────────────────

export function getQuiz(db: Database, id: number): QuizRow | null {
  const row = db.prepare(`${QUIZ_SELECT} WHERE q.id = ?`).get(id);
  return (row as unknown as QuizRow) ?? null;
}

export function getQuestions(db: Database, quizId: number): QuizQuestionRow[] {
  return db
    .prepare("SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY order_index, id")
    .all(quizId) as unknown as QuizQuestionRow[];
}

export function getQuizDetail(db: Database, id: number): QuizDetail | null {
  const quiz = getQuiz(db, id);
  if (!quiz) return null;
  return { quiz, questions: getQuestions(db, id).map(toQuestionView) };
}

export function listQuizzes(
  db: Database,
  options: { includeArchived?: boolean; topicId?: number; limit?: number } = {},
): QuizSummary[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (!options.includeArchived) where.push("q.archived_at IS NULL");
  if (options.topicId) {
    where.push("q.topic_id = ?");
    params.push(options.topicId);
  }

  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  params.push(Math.max(1, Math.floor(options.limit ?? 100)));

  const rows = db
    .prepare(
      `SELECT q.id, q.title, q.topic_id, q.archived_at, q.created_at,
              t.code  AS topic_code,
              t.title AS topic_title,
              (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count
         FROM quizzes q
         LEFT JOIN syllabus_topics t ON t.id = q.topic_id
        ${clause}
        ORDER BY q.created_at DESC, q.id DESC
        LIMIT ?`,
    )
    .all(...params) as unknown as Array<{
    id: number;
    title: string;
    topic_id: number | null;
    archived_at: string | null;
    created_at: string;
    topic_code: string | null;
    topic_title: string | null;
    question_count: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    topicId: row.topic_id,
    topicCode: row.topic_code,
    topicTitle: row.topic_title,
    questionCount: Number(row.question_count ?? 0),
    archived: row.archived_at !== null,
    createdAt: row.created_at,
  }));
}

/** Answers recorded against a quiz's questions, newest first. */
export function listResults(db: Database, quizId: number, limit = 200): QuizResultRow[] {
  return db
    .prepare(
      `SELECT r.*
         FROM quiz_results r
         JOIN quiz_questions q ON q.id = r.quiz_question_id
        WHERE q.quiz_id = ?
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ?`,
    )
    .all(quizId, Math.max(1, Math.floor(limit))) as unknown as QuizResultRow[];
}

export function countQuizzes(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM quizzes").get() as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}
