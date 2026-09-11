import { ipcMain } from "electron";

import { getDb } from "../../../services/database";
import * as fsrs from "../../../services/fsrs";
import { getConfig } from "../config";
import { addLog } from "../logger";
import type {
  CardInput,
  CardPatch,
  CardReviewRow,
  DueCard,
  DueSummary,
  GradeResult,
  Rating,
  RatingPreview,
  ReviewFilter,
  ReviewStats,
  TopicCardCount,
  UndoResult,
  Valence,
} from "../../shared/review-types";

/**
 * Review channels: the due queue, grading, undo, and card authoring.
 *
 * Phase 3 will add LLM-generated cards; the manual authoring channels here are
 * what makes the FSRS loop usable before then.
 */

function options() {
  return fsrs.resolveOptions(getConfig());
}

function fail(error: string) {
  addLog("review", "warn", error);
  return { success: false as const, error };
}

/** Absent `syllabusId` means "everything", not "the active syllabus". */
function filterOf(filter?: ReviewFilter | null): ReviewFilter | null {
  if (!filter) return null;
  return {
    syllabusId: filter.syllabusId ?? null,
    subject: filter.subject ?? null,
    topicId: filter.topicId ?? null,
    includeArchived: filter.includeArchived ?? false,
  };
}

export function registerReviewIpc(): void {
  ipcMain.handle("review:summary", (): DueSummary => fsrs.dueSummary(getDb(), options()));

  ipcMain.handle(
    "review:dueBySubject",
    (_event, filter?: ReviewFilter) =>
      fsrs.dueSummary(getDb(), options(), filterOf(filter)).bySubject,
  );

  ipcMain.handle("review:queue", (_event, filter?: ReviewFilter): DueCard[] =>
    fsrs.reviewQueue(getDb(), options(), filterOf(filter)),
  );

  ipcMain.handle("review:stats", (_event, filter?: ReviewFilter): ReviewStats =>
    fsrs.statsFor(getDb(), options(), filterOf(filter)),
  );

  ipcMain.handle("review:cards", (_event, filter?: ReviewFilter): DueCard[] =>
    fsrs.listCards(getDb(), filterOf(filter)),
  );

  ipcMain.handle("review:card", (_event, cardId: number): DueCard | null =>
    fsrs.getDueCard(getDb(), Number(cardId)),
  );

  ipcMain.handle(
    "review:preview",
    (_event, cardId: number): RatingPreview[] | null =>
      fsrs.previewForCard(getDb(), options(), Number(cardId)),
  );

  ipcMain.handle(
    "review:rate",
    (
      _event,
      request: { cardId: number; rating: Rating; sessionId?: number | null; durationMs?: number | null },
    ): GradeResult => {
      const db = getDb();
      const result = fsrs.gradeCard(db, options(), {
        cardId: Number(request.cardId),
        rating: request.rating,
        sessionId: request.sessionId ?? null,
        durationMs: request.durationMs ?? null,
      });
      if (!result.success) return fail(result.error ?? "Could not grade the card.");
      addLog("review", "debug", `Graded card ${request.cardId} as ${request.rating}.`);
      return result;
    },
  );

  ipcMain.handle("review:undo", (_event, cardId: number): UndoResult => {
    const result = fsrs.undoLastReview(getDb(), options(), Number(cardId));
    if (!result.success) return fail(result.error ?? "Could not undo the review.");
    return result;
  });

  ipcMain.handle("review:createCard", (_event, input: CardInput) => {
    const question = String(input?.question ?? "").trim();
    const answer = String(input?.answer ?? "").trim();
    if (!question || !answer) return fail("A card needs both a question and an answer.");
    try {
      const cardId = fsrs.createCard(getDb(), {
        question,
        answer,
        topicId: input.topicId ?? null,
        source: input.source ?? "manual",
        valence: input.valence ?? null,
      });
      addLog("review", "info", `Created card ${cardId}.`);
      return { success: true, cardId };
    } catch (error) {
      return fail(`Could not create the card: ${(error as Error).message}`);
    }
  });

  ipcMain.handle("review:updateCard", (_event, cardId: number, patch: CardPatch) => {
    const ok = fsrs.updateCard(getDb(), Number(cardId), patch ?? {});
    return ok ? { success: true } : fail("Nothing to update on that card.");
  });

  ipcMain.handle("review:archiveCard", (_event, cardId: number, archived?: boolean) => ({
    success: fsrs.archiveCard(getDb(), Number(cardId), archived ?? true),
  }));

  ipcMain.handle("review:setValence", (_event, cardId: number, valence: Valence | null) => ({
    success: fsrs.setCardValence(getDb(), Number(cardId), valence),
  }));

  ipcMain.handle("review:deleteCard", (_event, cardId: number) => ({
    success: fsrs.deleteCard(getDb(), Number(cardId)),
  }));

  ipcMain.handle(
    "review:history",
    (_event, cardId: number, limit?: number): CardReviewRow[] =>
      fsrs.listReviews(getDb(), Number(cardId), Number(limit ?? 50)),
  );

  ipcMain.handle(
    "review:topicCounts",
    (_event, syllabusId?: number | null): TopicCardCount[] => {
      const db = getDb();
      const configured = Number(getConfig().SYLLABUS_ACTIVE_ID || 0) || null;
      const target = syllabusId ?? configured;
      return fsrs.countCardsByTopic(db, target, new Date());
    },
  );
}
