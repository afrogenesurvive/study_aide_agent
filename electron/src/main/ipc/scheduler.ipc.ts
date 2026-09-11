import { ipcMain } from "electron";

import { getDb } from "../../../services/database";
import * as fsrs from "../../../services/fsrs";
import {
  planContextFromConfig,
  planSnapshot,
  resolveAllThemes,
  resolveTheme,
  sessionContextFromConfig,
  setPlanCompleted,
  getSession,
  listSessions,
  completeSession,
  startSession,
  themesForTopicCodes,
  todaySummary,
} from "../../../services/scheduler";
import { getConfig } from "../config";
import { addLog } from "../logger";
import type {
  PlanRequest,
  PlanSnapshot,
  ResolvedTheme,
  SessionCompleteInput,
  SessionStartResult,
  SessionSummary,
  StreakInfo,
  StudySessionRow,
  TodaySummary,
} from "../../shared/scheduler-types";
import type { CardReviewRow } from "../../shared/review-types";
import { computeStreak, countSessionReviews } from "../../../services/scheduler/session";
import { listSessionReviews } from "../../../services/fsrs/repo";

/**
 * Scheduler and session channels.
 *
 * The plan is built and cached per day; `scheduler:plan` reuses today's stored
 * plan unless the target length changed or the caller asks for a rebuild, so the
 * plan stays a commitment rather than being reshuffled on every render.
 */

function planContext() {
  return planContextFromConfig(getConfig());
}

function syllabusScope(syllabusId?: number | null): number[] | null {
  const configured = Number(getConfig().SYLLABUS_ACTIVE_ID || 0) || null;
  const target = syllabusId ?? configured;
  return target ? [target] : null;
}

function fail(error: string) {
  addLog("scheduler", "warn", error);
  return { success: false as const, error };
}

export function registerSchedulerIpc(): void {
  // ── themes ──
  ipcMain.handle(
    "scheduler:themes",
    (_event, syllabusId?: number | null): ResolvedTheme[] =>
      resolveAllThemes(getDb(), syllabusScope(syllabusId)),
  );

  ipcMain.handle(
    "scheduler:theme",
    (_event, theme: string, syllabusId?: number | null): ResolvedTheme | null =>
      resolveTheme(getDb(), String(theme), syllabusScope(syllabusId)),
  );

  /** Every theme that touches a given topic — used by the session overlay panel. */
  ipcMain.handle(
    "scheduler:themesForTopic",
    (_event, topicId: number, syllabusId?: number | null): ResolvedTheme[] => {
      const db = getDb();
      const topic = db
        .prepare("SELECT code FROM syllabus_topics WHERE id = ?")
        .get(Number(topicId)) as { code: string } | undefined;
      if (!topic) return [];
      return themesForTopicCodes(db, [topic.code])
        .map((theme) => resolveTheme(db, theme, syllabusScope(syllabusId)))
        .filter((entry): entry is ResolvedTheme => entry !== null);
    },
  );

  // ── the day's plan ──
  ipcMain.handle("scheduler:plan", (_event, request?: PlanRequest): PlanSnapshot =>
    planSnapshot(getDb(), planContext(), request ?? {}),
  );

  ipcMain.handle(
    "scheduler:regenerate",
    (_event, request?: PlanRequest): PlanSnapshot => {
      const snapshot = planSnapshot(getDb(), planContext(), { ...request, force: true });
      addLog("scheduler", "info", `Rebuilt the plan for ${snapshot.plan.date}.`);
      return snapshot;
    },
  );

  ipcMain.handle("scheduler:completePlan", (_event, planId: number, completed?: boolean) => {
    setPlanCompleted(getDb(), Number(planId), completed ?? true);
    return true;
  });

  // ── progress ──
  ipcMain.handle("scheduler:dueBySubject", () =>
    fsrs.dueSummary(getDb(), fsrs.resolveOptions(getConfig())).bySubject,
  );

  ipcMain.handle("scheduler:today", (): TodaySummary =>
    todaySummary(getDb(), fsrs.resolveOptions(getConfig())),
  );

  ipcMain.handle(
    "scheduler:streak",
    (): StreakInfo => computeStreak(getDb(), { today: sessionContextFromConfig(getConfig()).date }),
  );

  // ── sessions ──
  ipcMain.handle(
    "session:start",
    (_event, theme?: string | null): SessionStartResult => {
      const result = startSession(getDb(), sessionContextFromConfig(getConfig()), theme ?? null);
      addLog("scheduler", "info", `Session ${result.sessionId} started.`);
      return result;
    },
  );

  ipcMain.handle(
    "session:complete",
    (_event, input: SessionCompleteInput): SessionSummary | { success: false; error: string } => {
      if (!input?.sessionId) return fail("No session to complete.");
      const summary = completeSession(getDb(), input, sessionContextFromConfig(getConfig()));
      addLog(
        "scheduler",
        "info",
        `Session ${summary.sessionId} completed: ${summary.durationMinutes} min, ` +
          `${summary.cardsReviewed} card(s), ${summary.topicsAdvanced} topic(s) advanced.`,
      );
      return summary;
    },
  );

  ipcMain.handle("session:list", (_event, limit?: number): StudySessionRow[] =>
    listSessions(getDb(), Number(limit ?? 50)),
  );

  ipcMain.handle("session:get", (_event, sessionId: number): StudySessionRow | null =>
    getSession(getDb(), Number(sessionId)),
  );

  ipcMain.handle("session:reviews", (_event, sessionId: number): CardReviewRow[] =>
    listSessionReviews(getDb(), Number(sessionId)),
  );

  ipcMain.handle("session:reviewCount", (_event, sessionId: number): number =>
    countSessionReviews(getDb(), Number(sessionId)),
  );
}
