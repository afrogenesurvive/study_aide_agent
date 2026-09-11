import type { Database } from "../database/db";
import type { DueCard, DueCounts, DueSummary, Subject } from "../../src/shared/review-types";
import type {
  PlanBlock,
  PlanRequest,
  PlanSnapshot,
  ResolvedTheme,
  StudyPlan,
} from "../../src/shared/scheduler-types";
import { SUBJECT_LABELS } from "../../src/shared/syllabus-types";
import { dueSummary, resolveOptions, reviewQueue, type ReviewOptions } from "../fsrs/service";
import { dayKey, formatClock, zonedTime } from "../time";
import { resolveAllThemes } from "./overlay";

/**
 * Builds the day's interleaved study plan.
 *
 * The scheduler is **hybrid**, because the two models in the original design doc
 * each fail on their own:
 *
 *   - Purely theme-driven (study "EQUILIBRIUM" across all three subjects) breaks
 *     down whenever a theme only has material for one subject, which is the normal
 *     case on any given day.
 *   - Purely overdue-driven (take the most overdue topic per subject) degrades into
 *     three unrelated blocks, which is exactly the "surface-level interleaving" the
 *     app exists to avoid.
 *
 * So: prefer a theme that spans at least two subjects which actually have cards
 * due. If no theme qualifies, fall back to the most overdue topic per subject. The
 * chosen rationale is stored on the plan so the UI can explain itself.
 */

/** Intention/synthesis overheads are proportional, with hard floors and ceilings. */
const INTENTION_RATIO = 0.06;
const INTENTION_RANGE = { min: 2, max: 10 };
const SYNTHESIS_RATIO = 0.12;
const SYNTHESIS_RANGE = { min: 5, max: 20 };
const MIN_BLOCK_MINUTES = 3;
const MAX_SUBJECT_BLOCKS = 3;
/** More than this many topics in one block is noise, not a study plan. */
const MAX_TOPICS_PER_BLOCK = 3;

export interface PlanContext {
  now: Date;
  timeZone: string;
  /** Total session length in minutes — `DAILY_STUDY_TARGET`. */
  minutes: number;
  /** Target length of one subject block — `SESSION_LENGTH`. */
  sessionLength: number;
  /** Break between blocks — `BREAK_LENGTH`. */
  breakLength: number;
  /** Local `HH:MM` the first block starts at — `STUDY_START_TIME`. */
  startClock: string;
  review: ReviewOptions;
}

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clockOr(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

export function planContextFromConfig(
  config: Record<string, string | undefined | null>,
  now: Date = new Date(),
): PlanContext {
  return {
    now,
    timeZone: config.TIMEZONE?.trim() || "UTC",
    minutes: Math.max(5, Math.round(positive(config.DAILY_STUDY_TARGET, 90))),
    sessionLength: Math.max(1, Math.round(positive(config.SESSION_LENGTH, 20))),
    breakLength: Math.max(0, Math.round(Number(config.BREAK_LENGTH ?? 5) || 0)),
    startClock: clockOr(config.STUDY_START_TIME, "19:00"),
    review: resolveOptions(config, now),
  };
}

// ── subject work ─────────────────────────────────────────────────────────────

export interface SubjectWork {
  subject: Subject;
  /** Due cards for this subject, most overdue first. */
  cards: DueCard[];
  counts: DueCounts;
  topicIds: number[];
  topicCodes: string[];
  leadTopicId: number | null;
  leadTopicCode: string | null;
  leadTopicTitle: string | null;
}

function emptyCounts(): DueCounts {
  return { new: 0, learning: 0, due: 0, total: 0 };
}

/**
 * Group due cards by subject, ranking each subject's topics by how overdue their
 * most overdue card is.
 *
 * Cards with no syllabus topic are skipped: a block is built around a subject and
 * a topic, and an untethered card cannot be placed. They still appear in the
 * review queue, they just do not shape the plan.
 */
export function collectSubjectWork(cards: DueCard[]): SubjectWork[] {
  const bySubject = new Map<Subject, SubjectWork>();

  const ranked = [...cards].sort((a, b) => {
    if (b.overdue_days !== a.overdue_days) return b.overdue_days - a.overdue_days;
    return (a.next_review ?? "").localeCompare(b.next_review ?? "");
  });

  for (const card of ranked) {
    if (!card.subject) continue;
    const work =
      bySubject.get(card.subject) ??
      ({
        subject: card.subject,
        cards: [],
        counts: emptyCounts(),
        topicIds: [],
        topicCodes: [],
        leadTopicId: null,
        leadTopicCode: null,
        leadTopicTitle: null,
      } satisfies SubjectWork);

    work.cards.push(card);
    work.counts.total += 1;
    if (card.state === "new") work.counts.new += 1;
    else if (card.state === "learning" || card.state === "relearning") work.counts.learning += 1;
    else work.counts.due += 1;

    if (card.topic_id != null && !work.topicIds.includes(card.topic_id)) {
      work.topicIds.push(card.topic_id);
      work.topicCodes.push(card.topic_code ?? String(card.topic_id));
      if (work.leadTopicId === null) {
        work.leadTopicId = card.topic_id;
        work.leadTopicCode = card.topic_code ?? null;
        work.leadTopicTitle = card.topic_title ?? null;
      }
    }

    bySubject.set(card.subject, work);
  }

  // Most due work first, so a reduced session still covers the busiest subject.
  return [...bySubject.values()].sort((a, b) => b.counts.total - a.counts.total);
}

// ── theme choice ─────────────────────────────────────────────────────────────

export interface ThemeChoice {
  theme: ResolvedTheme | null;
  rationale: string;
}

/** How many of a theme's subjects actually have cards due today. */
function subjectsWithWork(theme: ResolvedTheme, work: SubjectWork[]): Subject[] {
  return theme.connections
    .filter((connection) => connection.topics.length > 0)
    .map((connection) => connection.subject)
    .filter((subject) => work.some((entry) => entry.subject === subject));
}

/**
 * Pick the day's theme: the one covering the most subjects that have work due.
 *
 * Ties break on total due cards, then on theme name, so the same day always
 * produces the same plan.
 */
export function chooseTheme(themes: ResolvedTheme[], work: SubjectWork[]): ThemeChoice {
  if (!themes.length) {
    return {
      theme: null,
      rationale: "No overlay themes are loaded; ordering each subject by its most overdue topic.",
    };
  }

  let best: { theme: ResolvedTheme; subjects: Subject[]; due: number } | null = null;

  for (const theme of themes) {
    const subjects = subjectsWithWork(theme, work);
    // A single-subject "theme" is just a topic with extra steps.
    if (subjects.length < 2) continue;
    const due = work
      .filter((entry) => subjects.includes(entry.subject))
      .reduce((total, entry) => total + entry.counts.total, 0);

    const better =
      !best ||
      subjects.length > best.subjects.length ||
      (subjects.length === best.subjects.length && due > best.due) ||
      (subjects.length === best.subjects.length &&
        due === best.due &&
        theme.theme.localeCompare(best.theme.theme) < 0);

    if (better) best = { theme, subjects, due };
  }

  if (!best) {
    return {
      theme: null,
      rationale:
        "No overlay theme spans two subjects with work due, so the plan falls back to the most overdue topic per subject.",
    };
  }

  const names = best.subjects.map((subject) => SUBJECT_LABELS[subject]).join(", ");
  return {
    theme: best.theme,
    rationale: `${best.theme.theme} chosen: it links ${names}, all of which have cards due. ${best.theme.commonPrinciple}`,
  };
}

// ── layout ───────────────────────────────────────────────────────────────────

export interface Layout {
  intentionMinutes: number;
  blockMinutes: number[];
  breakMinutes: number;
  synthesisMinutes: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Divide the session into intention → blocks with breaks → synthesis.
 *
 * Blocks target `SESSION_LENGTH`, but the leftover time is spread across them
 * rather than being dropped, so a 90-minute target with 20-minute blocks and
 * 5-minute breaks yields three ~22-minute blocks instead of 70 used minutes and
 * 5 wasted ones.
 */
export function buildLayout(
  minutes: number,
  sessionLength: number,
  breakLength: number,
  subjectCount: number,
): Layout {
  const intentionMinutes = clamp(Math.round(minutes * INTENTION_RATIO), INTENTION_RANGE.min, INTENTION_RANGE.max);
  const synthesisMinutes = clamp(Math.round(minutes * SYNTHESIS_RATIO), SYNTHESIS_RANGE.min, SYNTHESIS_RANGE.max);
  const body = Math.max(1, minutes - intentionMinutes - synthesisMinutes);

  const target = Math.max(1, Math.round(sessionLength));
  const brk = Math.max(0, Math.round(breakLength));
  const wanted = clamp(subjectCount || 1, 1, MAX_SUBJECT_BLOCKS);

  // As many target-length blocks as fit, but never fewer than one per subject
  // with work, and never so many that a block becomes uselessly short.
  const upper = Math.max(1, Math.floor((body + brk) / (target + brk)));
  const lower = Math.max(1, Math.floor((body + brk) / (MIN_BLOCK_MINUTES + brk)));
  const count = clamp(Math.max(Math.min(upper, lower), wanted), 1, Math.max(1, lower));

  const usable = Math.max(count, body - (count - 1) * brk);
  const base = Math.floor(usable / count);
  let remainder = usable - base * count;

  const blockMinutes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    blockMinutes.push(base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder -= 1;
  }

  return { intentionMinutes, blockMinutes, breakMinutes: brk, synthesisMinutes };
}

// ── blocks ───────────────────────────────────────────────────────────────────

/**
 * Topics to lead a subject's block with.
 *
 * When the day has a theme, the block leads with the theme's topics *for that
 * subject* that are also due — that is the overlap the app is built on. Otherwise
 * it leads with the most overdue topic.
 */
function topicsForBlock(
  work: SubjectWork,
  theme: ResolvedTheme | null,
): { topicIds: number[]; topicCodes: string[]; label: string; theme: string | null } {
  const label = SUBJECT_LABELS[work.subject];

  if (theme) {
    const connection = theme.connections.find((entry) => entry.subject === work.subject);
    const overlapping = (connection?.topics ?? []).filter((topic) =>
      work.topicIds.includes(topic.id),
    );
    if (overlapping.length) {
      return {
        topicIds: overlapping.slice(0, MAX_TOPICS_PER_BLOCK).map((topic) => topic.id),
        topicCodes: overlapping.slice(0, MAX_TOPICS_PER_BLOCK).map((topic) => topic.code),
        label: `${label} — ${theme.theme}`,
        theme: theme.theme,
      };
    }
  }

  if (work.leadTopicId !== null) {
    return {
      topicIds: [work.leadTopicId],
      topicCodes: work.leadTopicCode ? [work.leadTopicCode] : [],
      label: work.leadTopicTitle ? `${label} — ${work.leadTopicTitle}` : label,
      theme: null,
    };
  }

  return { topicIds: [], topicCodes: [], label, theme: null };
}

/** The other subjects' legs of the theme, shown while working one subject. */
function overlaysFor(
  work: SubjectWork,
  theme: ResolvedTheme | null,
): Array<{ subject: Subject; concept: string }> {
  if (!theme) return [];
  return theme.connections
    .filter((connection) => connection.subject !== work.subject && connection.topics.length > 0)
    .map((connection) => ({ subject: connection.subject, concept: connection.concept }));
}

export interface BuildPlanInput {
  date: string;
  context: PlanContext;
  work: SubjectWork[];
  theme: ResolvedTheme | null;
  rationale: string;
  createdAt: Date;
}

/** Assemble the plan's block list. Pure: no database, no clock of its own. */
export function buildPlan(input: BuildPlanInput): StudyPlan {
  const { date, context, work, theme, rationale, createdAt } = input;
  const layout = buildLayout(context.minutes, context.sessionLength, context.breakLength, work.length);

  // With a theme, follow the theme's own subject order so the session reads
  // Chemistry → Maths → Biology the way the overlay map is written.
  const ordered = theme
    ? [...work].sort((a, b) => {
        const order = (subject: Subject) =>
          theme.connections.findIndex((connection) => connection.subject === subject);
        return order(a.subject) - order(b.subject);
      })
    : work;

  const cycles = ordered.length ? ordered : [];
  const blocks: PlanBlock[] = [];
  let cursor = zonedTime(createdAt, context.startClock, context.timeZone);
  let index = 0;

  blocks.push({
    index: index++,
    kind: "intention",
    minutes: layout.intentionMinutes,
    startsAt: formatClock(cursor, context.timeZone),
    subject: null,
    label: theme ? `Set intention — today's theme is ${theme.theme}` : "Set intention",
    topicIds: [],
    topicCodes: [],
    theme: theme?.theme ?? null,
    overlays: [],
    dueCounts: emptyCounts(),
  });
  cursor = new Date(cursor.getTime() + layout.intentionMinutes * 60_000);

  layout.blockMinutes.forEach((minutes, position) => {
    const work0 = cycles.length ? cycles[position % cycles.length] : null;
    const topics = work0
      ? topicsForBlock(work0, theme)
      : { topicIds: [], topicCodes: [], label: "Study", theme: null };

    blocks.push({
      index: index++,
      kind: "subject",
      minutes,
      startsAt: formatClock(cursor, context.timeZone),
      subject: work0?.subject ?? null,
      label: topics.label,
      topicIds: topics.topicIds,
      topicCodes: topics.topicCodes,
      theme: topics.theme,
      overlays: work0 ? overlaysFor(work0, theme) : [],
      dueCounts: work0?.counts ?? emptyCounts(),
    });
    cursor = new Date(cursor.getTime() + minutes * 60_000);

    const isLast = position === layout.blockMinutes.length - 1;
    if (!isLast && layout.breakMinutes > 0) {
      blocks.push({
        index: index++,
        kind: "break",
        minutes: layout.breakMinutes,
        startsAt: formatClock(cursor, context.timeZone),
        subject: null,
        label: "Break — walk, hydrate, review your valence tags",
        topicIds: [],
        topicCodes: [],
        theme: null,
        overlays: [],
        dueCounts: emptyCounts(),
      });
      cursor = new Date(cursor.getTime() + layout.breakMinutes * 60_000);
    }
  });

  blocks.push({
    index: index++,
    kind: "synthesis",
    minutes: layout.synthesisMinutes,
    startsAt: formatClock(cursor, context.timeZone),
    subject: null,
    label: theme ? `Synthesis — ${theme.commonPrinciple}` : "Synthesis and reflection",
    topicIds: [],
    topicCodes: [],
    theme: theme?.theme ?? null,
    overlays: [],
    dueCounts: emptyCounts(),
  });

  return {
    date,
    createdAt: createdAt.toISOString(),
    minutes: context.minutes,
    theme: theme?.theme ?? null,
    commonPrinciple: theme?.commonPrinciple ?? null,
    rationale,
    blocks,
  };
}

// ── persistence ──────────────────────────────────────────────────────────────

export interface StoredPlan {
  id: number;
  plan: StudyPlan;
  completed: boolean;
}

export function savePlan(db: Database, plan: StudyPlan): number {
  const json = JSON.stringify(plan);
  const existing = db.prepare("SELECT id FROM study_plans WHERE date = ?").get(plan.date) as
    | { id: number | bigint }
    | undefined;

  if (existing) {
    const id = Number(existing.id);
    db.prepare("UPDATE study_plans SET plan_json = ? WHERE id = ?").run(json, id);
    return id;
  }

  const result = db
    .prepare("INSERT INTO study_plans (date, plan_json) VALUES (?, ?)")
    .run(plan.date, json);
  return Number(result.lastInsertRowid);
}

export function getStoredPlan(db: Database, date: string): StoredPlan | null {
  const row = db
    .prepare("SELECT id, plan_json, completed FROM study_plans WHERE date = ? ORDER BY id DESC LIMIT 1")
    .get(date) as { id: number | bigint; plan_json: string; completed: number } | undefined;
  if (!row) return null;

  try {
    return {
      id: Number(row.id),
      plan: JSON.parse(row.plan_json) as StudyPlan,
      completed: Number(row.completed) === 1,
    };
  } catch {
    // A corrupt plan is not worth failing the dashboard over; treat it as absent
    // and let the next request rebuild it.
    return null;
  }
}

export function setPlanCompleted(db: Database, planId: number, completed: boolean): void {
  db.prepare("UPDATE study_plans SET completed = ? WHERE id = ?").run(completed ? 1 : 0, planId);
}

// ── orchestration ────────────────────────────────────────────────────────────

/** The syllabi to plan against: the active one per subject, or the given set. */
export function activeSyllabusIds(db: Database, preferredId?: number | null): number[] {
  if (preferredId) return [preferredId];
  const rows = db
    .prepare("SELECT id FROM syllabus WHERE is_active = 1 ORDER BY subject")
    .all() as unknown as Array<{ id: number | bigint }>;
  if (rows.length) return rows.map((row) => Number(row.id));
  // Nothing marked active: fall back to every syllabus so the plan still works on
  // a fresh install where the user has not touched the Active tab yet.
  const all = db.prepare("SELECT id FROM syllabus ORDER BY subject").all() as unknown as Array<{
    id: number | bigint;
  }>;
  return all.map((row) => Number(row.id));
}

export interface PlanOptions extends PlanContext {
  syllabusIds?: number[] | null;
}

/**
 * Build a plan from scratch for `date`.
 *
 * Everything which depends on the clock or the database is passed in, so the whole
 * decision — which theme, which topics, how long each block — is reproducible.
 */
export function composePlan(
  db: Database,
  options: PlanOptions,
  date: string,
): { plan: StudyPlan; due: DueSummary; work: SubjectWork[] } {
  const syllabusIds = options.syllabusIds ?? activeSyllabusIds(db);

  // Due cards for every syllabus in scope. Cards with no topic are still returned
  // by the queue; `collectSubjectWork` is what drops them from the plan.
  const cards = syllabusIds.length
    ? syllabusIds.flatMap((syllabusId) => reviewQueue(db, options.review, { syllabusId }))
    : reviewQueue(db, options.review);

  const work = collectSubjectWork(cards);
  const due = dueSummary(db, options.review);
  const choice = chooseTheme(resolveAllThemes(db, syllabusIds), work);

  const plan = buildPlan({
    date,
    context: options,
    work,
    theme: choice.theme,
    rationale: choice.rationale,
    createdAt: options.now,
  });

  return { plan, due, work };
}

/**
 * The snapshot the Dashboard renders: today's plan, rebuilt if it is missing,
 * stale, or explicitly refreshed.
 */
export function planSnapshot(
  db: Database,
  options: PlanOptions,
  request: PlanRequest = {},
): PlanSnapshot {
  const date = request.date ?? dayKey(options.now, options.timeZone);
  const minutes = Math.max(5, Math.round(request.minutes ?? options.minutes));

  const stored = request.force ? null : getStoredPlan(db, date);
  const savedPlan = stored?.plan;
  const reusable =
    savedPlan && savedPlan.minutes === minutes && Array.isArray(savedPlan.blocks) && savedPlan.blocks.length > 0;

  if (reusable && stored) {
    return {
      plan: savedPlan,
      due: dueSummary(db, options.review),
      generated: false,
      completed: stored.completed,
      planId: stored.id,
    };
  }

  const { plan, due } = composePlan(
    db,
    { ...options, minutes, syllabusIds: request.syllabusId ? [request.syllabusId] : options.syllabusIds },
    date,
  );
  const planId = savePlan(db, plan);

  return { plan, due, generated: true, completed: false, planId };
}
