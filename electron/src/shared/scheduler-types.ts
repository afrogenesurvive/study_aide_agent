/**
 * Scheduling domain types — overlay themes, the day's plan, and study sessions.
 *
 * Shared by `services/scheduler`, the main process and the renderer, the same way
 * `syllabus-types.ts` and `review-types.ts` are.
 */

import type { DueCounts, DueSummary } from "./review-types";
import type { Subject, TopicStatus } from "./syllabus-types";

export type { Subject } from "./syllabus-types";

// ── overlay themes ───────────────────────────────────────────────────────────

/**
 * One subject's leg of a theme, e.g. Chemistry → "Le Chatelier's principle" →
 * topics `7`, `25`.
 *
 * `topicCodes` are syllabus codes, not ids: the same theme has to survive a
 * syllabus being re-imported or replaced, and codes are the only identifier that
 * is stable across that.
 */
export interface OverlayConnection {
  subject: Subject;
  concept: string;
  topicCodes: string[];
}

export interface OverlayTheme {
  theme: string;
  commonPrinciple: string;
  /** `"seeded"` for rows that came from `data/overlap-map.json`. */
  source: string;
  connections: OverlayConnection[];
}

export interface ResolvedThemeTopic {
  id: number;
  code: string;
  title: string;
  status: TopicStatus;
}

export interface ResolvedThemeConnection extends OverlayConnection {
  /** The codes above that actually exist in the syllabus being resolved against. */
  topics: ResolvedThemeTopic[];
}

export interface ResolvedTheme extends OverlayTheme {
  connections: ResolvedThemeConnection[];
  /** How many distinct subjects have at least one matching topic (0–3). */
  subjectCount: number;
  /** Every syllabus topic id this theme touches, deduplicated. */
  topicIds: number[];
}

export interface OverlaySeedResult {
  themes: number;
  connections: number;
  /** Rows dropped because they are no longer in the source file. */
  removed: number;
  warnings: string[];
}

// ── the day's plan ───────────────────────────────────────────────────────────

/**
 * `intention` and `synthesis` bookend the session; `break` separates the subject
 * blocks. The A → B → C ordering is the overlap-based interleaving the whole app
 * is built around.
 */
export type PlanBlockKind = "intention" | "subject" | "break" | "synthesis";

export interface PlanBlock {
  index: number;
  kind: PlanBlockKind;
  minutes: number;
  /** Local `HH:MM`. */
  startsAt: string;
  subject: Subject | null;
  /** Short human title, e.g. "Chemistry — Equilibrium". */
  label: string;
  topicIds: number[];
  topicCodes: string[];
  theme: string | null;
  /** The other subjects' legs of the theme, shown while working this block. */
  overlays: Array<{ subject: Subject; concept: string }>;
  /**
   * How many cards were due for this subject when the plan was built. A snapshot:
   * the live figure comes from the review queue, and the two are expected to
   * diverge as the day goes on.
   */
  dueCounts: DueCounts;
}

export interface StudyPlan {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  minutes: number;
  theme: string | null;
  commonPrinciple: string | null;
  /** Why this theme/ordering was chosen, so the plan is explicable in the UI. */
  rationale: string;
  blocks: PlanBlock[];
}

export interface PlanSnapshot {
  plan: StudyPlan;
  /** Live due figures for the day, recomputed on every read. */
  due: DueSummary;
  /** True when this call had to build the plan rather than load a saved one. */
  generated: boolean;
  completed: boolean;
  planId: number | null;
}

export interface PlanRequest {
  /** Local day to plan. Defaults to today. */
  date?: string | null;
  /** Overrides `DAILY_STUDY_TARGET` for one-off plans. */
  minutes?: number | null;
  /** Restrict to a single syllabus. */
  syllabusId?: number | null;
  /** Ignore any saved plan and rebuild from scratch. */
  force?: boolean;
}

// ── study sessions ───────────────────────────────────────────────────────────

export interface StudySessionRow {
  id: number;
  session_date: string;
  duration: number;
  session_type: string;
  themes: string;
  topic_codes: string;
  score: number | null;
  notes: string;
  created_at: string;
}

export interface SessionCompleteInput {
  sessionId: number;
  /** Actual elapsed minutes, which is rarely the planned figure. */
  durationMinutes: number;
  topicCodes?: string[];
  themes?: string[];
  notes?: string;
  score?: number | null;
}

export interface SessionSummary {
  sessionId: number;
  durationMinutes: number;
  cardsReviewed: number;
  /** Topics moved forward on the progress ladder by this session. */
  topicsAdvanced: number;
  /** The streak *after* this session. */
  streak: number;
}

export interface StreakInfo {
  /** Consecutive days ending today (or yesterday, if today is not done yet). */
  current: number;
  longest: number;
  lastSessionDate: string | null;
  /** Whether a session has already been recorded for today. */
  activeToday: boolean;
}

export interface TodaySummary {
  dateKey: string;
  due: DueSummary;
  streak: StreakInfo;
  cardsReviewedToday: number;
  minutesToday: number;
  /** Reviews recorded today, per subject. */
  bySubject: Array<{ subject: Subject; reviewed: number }>;
  /** Topics the user has flagged red, most recent first. */
  struggling: Array<{ topicId: number; code: string; title: string; subject: Subject | null }>;
}

export interface SessionStartResult {
  success: boolean;
  error?: string;
  sessionId?: number;
}
