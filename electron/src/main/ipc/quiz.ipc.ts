import { ipcMain } from "electron";

import { getDb } from "../../../services/database";
import { getQuizDetail, listQuizzes, recordAttempt } from "../../../services/quiz/repo";
import { addLog } from "../logger";
import type {
  QuizAnswer,
  QuizAttemptResult,
  QuizDetail,
  QuizSummary,
} from "../../shared/quiz-types";

/**
 * Quiz channels: reading a generated quiz and recording an attempt.
 *
 * Three handlers, because a quiz only has three things you can do to it in phase
 * 3 — list the ones a run produced, open one, and answer it. Authoring and
 * editing quizzes by hand is not a phase 3 feature; the generator owns them.
 */

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerQuizIpc(): void {
  ipcMain.handle(
    "quiz:list",
    (
      _event,
      options?: { includeArchived?: boolean; topicId?: number; limit?: number },
    ): QuizSummary[] => {
      try {
        return listQuizzes(getDb(), options ?? {});
      } catch (err) {
        addLog("review", "warn", `Could not list quizzes: ${describe(err)}`);
        return [];
      }
    },
  );

  ipcMain.handle("quiz:get", (_event, quizId: number): QuizDetail | null => {
    try {
      return getQuizDetail(getDb(), Number(quizId));
    } catch (err) {
      addLog("review", "warn", `Could not load quiz ${quizId}: ${describe(err)}`);
      return null;
    }
  });

  ipcMain.handle(
    "quiz:record",
    (_event, quizId: number, answers: QuizAnswer[]): QuizAttemptResult => {
      const empty: QuizAttemptResult = { quizId: Number(quizId), total: 0, correct: 0, answers: [] };
      try {
        return recordAttempt(getDb(), Number(quizId), Array.isArray(answers) ? answers : []);
      } catch (err) {
        // A failed write must not lose the score the user just earned, so the
        // attempt is reported back and merely not persisted.
        addLog("review", "warn", `Could not record a quiz attempt: ${describe(err)}`);
        return {
          ...empty,
          answers: Array.isArray(answers) ? answers : [],
          total: Array.isArray(answers) ? answers.length : 0,
          correct: Array.isArray(answers) ? answers.filter((answer) => answer.correct).length : 0,
        };
      }
    },
  );
}
