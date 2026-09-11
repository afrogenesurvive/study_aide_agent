import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../services/database/db";
import type { DueCard } from "../src/shared/review-types";
import { DEFAULT_FSRS_SETTINGS } from "../services/fsrs/scheduler";
import { seedOverlayMapFile } from "../services/scheduler/overlay";
import {
  activeSyllabusIds,
  buildLayout,
  buildPlan,
  chooseTheme,
  collectSubjectWork,
  composePlan,
  getStoredPlan,
  planContextFromConfig,
  planSnapshot,
  savePlan,
  setPlanCompleted,
  type Layout,
  type PlanContext,
  type SubjectWork,
} from "../services/scheduler/plan";
import type { ResolvedTheme, StudyPlan } from "../src/shared/scheduler-types";
import type { Subject } from "../src/shared/syllabus-types";
import { createTestDb } from "./helpers/test-db";
import { insertCard, NOW, NOW_ISO, seedSyllabus } from "./helpers/review-fixtures";
import * as repo from "../services/fsrs/repo";

const OVERLAP_MAP = path.resolve(process.cwd(), "../data/overlap-map.json");

const CONTEXT: PlanContext = {
  now: NOW,
  timeZone: "UTC",
  minutes: 90,
  sessionLength: 20,
  breakLength: 5,
  startClock: "19:00",
  review: {
    now: NOW,
    timeZone: "UTC",
    settings: DEFAULT_FSRS_SETTINGS,
    newCardsPerDay: 20,
  },
};

function totalMinutes(layout: Layout): number {
  const blocks = layout.blockMinutes.reduce((sum, value) => sum + value, 0);
  const breaks = layout.breakMinutes * Math.max(0, layout.blockMinutes.length - 1);
  return layout.intentionMinutes + blocks + breaks + layout.synthesisMinutes;
}

function dueCard(overrides: Partial<DueCard> = {}): DueCard {
  return {
    id: 1,
    topic_id: 10,
    question: "Q",
    answer: "A",
    source: "manual",
    valence: null,
    difficulty: null,
    stability: null,
    last_review: null,
    next_review: NOW_ISO,
    review_count: 0,
    lapses: 0,
    state: "new",
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    last_rating: null,
    archived_at: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    topic_code: "7",
    topic_title: "Topic 7",
    syllabus_id: 1,
    subject: "chemistry",
    overdue_days: 0,
    retrievability: null,
    ...overrides,
  };
}

/** Build a resolved theme from `subject -> topic ids` pairs. */
function resolvedTheme(theme: string, legs: Partial<Record<Subject, number[]>>): ResolvedTheme {
  const connections = Object.entries(legs).map(([subject, ids]) => ({
    subject: subject as Subject,
    concept: `${subject} concept`,
    topicCodes: (ids ?? []).map(String),
    topics: (ids ?? []).map((id) => ({
      id,
      code: String(id),
      title: `Topic ${id}`,
      status: "not_started" as const,
    })),
  }));
  return {
    theme,
    commonPrinciple: `${theme} principle`,
    source: "seeded",
    connections,
    subjectCount: connections.length,
    topicIds: connections.flatMap((connection) => connection.topics.map((topic) => topic.id)),
  };
}

function workFor(subject: Subject, topicIds: number[], due = 1): SubjectWork {
  return {
    subject,
    cards: [],
    counts: { new: due, learning: 0, due: 0, total: due },
    topicIds,
    topicCodes: topicIds.map(String),
    leadTopicId: topicIds[0] ?? null,
    leadTopicCode: topicIds[0] !== undefined ? String(topicIds[0]) : null,
    leadTopicTitle: topicIds[0] !== undefined ? `Topic ${topicIds[0]}` : null,
  };
}

describe("planContextFromConfig", () => {
  it("reads the study keys", () => {
    const context = planContextFromConfig(
      {
        DAILY_STUDY_TARGET: "120",
        SESSION_LENGTH: "25",
        BREAK_LENGTH: "10",
        STUDY_START_TIME: "06:30",
        TIMEZONE: "America/Jamaica",
        NEW_CARDS_PER_DAY: "15",
      },
      NOW,
    );
    expect(context.minutes).toBe(120);
    expect(context.sessionLength).toBe(25);
    expect(context.breakLength).toBe(10);
    expect(context.startClock).toBe("06:30");
    expect(context.timeZone).toBe("America/Jamaica");
    expect(context.review.newCardsPerDay).toBe(15);
  });

  it("falls back to the shipped defaults", () => {
    const context = planContextFromConfig({}, NOW);
    expect(context.minutes).toBe(90);
    expect(context.sessionLength).toBe(20);
    expect(context.breakLength).toBe(5);
    expect(context.startClock).toBe("19:00");
    expect(context.timeZone).toBe("UTC");
  });

  it("rejects a start time that is not a 24-hour clock value", () => {
    expect(planContextFromConfig({ STUDY_START_TIME: "7pm" }, NOW).startClock).toBe("19:00");
    expect(planContextFromConfig({ STUDY_START_TIME: "24:00" }, NOW).startClock).toBe("19:00");
    expect(planContextFromConfig({ STUDY_START_TIME: "07:05" }, NOW).startClock).toBe("07:05");
  });
});

describe("buildLayout", () => {
  it("accounts for every minute of the target", () => {
    expect(totalMinutes(buildLayout(90, 20, 5, 3))).toBe(90);
    expect(totalMinutes(buildLayout(60, 20, 5, 2))).toBe(60);
    expect(totalMinutes(buildLayout(45, 15, 5, 1))).toBe(45);
  });

  it("produces one block per subject for a standard session", () => {
    expect(buildLayout(90, 20, 5, 3).blockMinutes).toHaveLength(3);
  });

  it("repeats blocks when the target is longer than the subject list", () => {
    expect(buildLayout(180, 20, 5, 3).blockMinutes.length).toBeGreaterThan(3);
  });

  it("still interleaves when only one subject has work", () => {
    const layout = buildLayout(90, 20, 5, 1);
    expect(layout.blockMinutes.length).toBeGreaterThan(1);
    expect(totalMinutes(layout)).toBe(90);
  });

  it("keeps a floor under the block length on a very short session", () => {
    const layout = buildLayout(20, 20, 5, 3);
    expect(layout.blockMinutes.every((minutes) => minutes >= 3)).toBe(true);
    expect(layout.blockMinutes.length).toBeGreaterThanOrEqual(1);
  });

  it("copes with no breaks", () => {
    const layout = buildLayout(60, 20, 0, 3);
    expect(layout.breakMinutes).toBe(0);
    expect(totalMinutes(layout)).toBe(60);
  });
});

describe("collectSubjectWork", () => {
  it("groups cards by subject", () => {
    const work = collectSubjectWork([
      dueCard({ id: 1, subject: "chemistry" }),
      dueCard({ id: 2, subject: "chemistry" }),
      dueCard({ id: 3, subject: "biology", topic_id: 20, topic_code: "14" }),
    ]);
    expect(work.map((entry) => entry.subject)).toEqual(["chemistry", "biology"]);
    expect(work[0].counts.total).toBe(2);
  });

  it("skips cards with no syllabus topic", () => {
    const work = collectSubjectWork([dueCard({ subject: null, topic_id: null })]);
    expect(work).toEqual([]);
  });

  it("orders subjects by how much work is due", () => {
    const work = collectSubjectWork([
      dueCard({ id: 1, subject: "math", topic_id: 1, topic_code: "1.1" }),
      dueCard({ id: 2, subject: "biology", topic_id: 2, topic_code: "14" }),
      dueCard({ id: 3, subject: "biology", topic_id: 2, topic_code: "14" }),
    ]);
    expect(work[0].subject).toBe("biology");
  });

  it("leads each subject with its most overdue topic", () => {
    const work = collectSubjectWork([
      dueCard({ id: 1, overdue_days: 1, topic_id: 11, topic_code: "8", topic_title: "Rates" }),
      dueCard({ id: 2, overdue_days: 9, topic_id: 12, topic_code: "5", topic_title: "Energy" }),
      dueCard({ id: 3, overdue_days: 4, topic_id: 13, topic_code: "3", topic_title: "Bonding" }),
    ]);
    expect(work[0].leadTopicCode).toBe("5");
    expect(work[0].leadTopicTitle).toBe("Energy");
    expect(work[0].topicCodes).toEqual(["5", "3", "8"]);
  });

  it("counts new, learning and review cards separately", () => {
    const work = collectSubjectWork([
      dueCard({ id: 1, state: "new" }),
      dueCard({ id: 2, state: "learning" }),
      dueCard({ id: 3, state: "review" }),
      dueCard({ id: 4, state: "relearning" }),
    ]);
    expect(work[0].counts).toEqual({ new: 1, learning: 2, due: 1, total: 4 });
  });
});

describe("chooseTheme", () => {
  it("prefers the theme covering more subjects with work", () => {
    const themes = [
      resolvedTheme("TWO", { chemistry: [1], math: [2] }),
      resolvedTheme("THREE", { chemistry: [1], math: [2], biology: [3] }),
    ];
    const choice = chooseTheme(themes, [
      workFor("chemistry", [1]),
      workFor("math", [2]),
      workFor("biology", [3]),
    ]);
    expect(choice.theme?.theme).toBe("THREE");
  });

  it("will not choose a theme that only touches one subject", () => {
    const choice = chooseTheme(
      [resolvedTheme("ALONE", { chemistry: [1] })],
      [workFor("chemistry", [1])],
    );
    expect(choice.theme).toBeNull();
    expect(choice.rationale).toContain("most overdue topic per subject");
  });

  it("requires the subject to have work due, not just a matching topic", () => {
    const themes = [resolvedTheme("TWO", { chemistry: [1], math: [2] })];
    const choice = chooseTheme(themes, [workFor("chemistry", [1])]);
    expect(choice.theme).toBeNull();
  });

  it("breaks ties deterministically by theme name", () => {
    const themes = [
      resolvedTheme("ZEBRA", { chemistry: [1], math: [2] }),
      resolvedTheme("ALPHA", { chemistry: [1], math: [2] }),
    ];
    const work = [workFor("chemistry", [1]), workFor("math", [2])];
    expect(chooseTheme(themes, work).theme?.theme).toBe("ALPHA");
    expect(chooseTheme([...themes].reverse(), work).theme?.theme).toBe("ALPHA");
  });

  it("explains itself when it has to fall back", () => {
    expect(chooseTheme([], [workFor("chemistry", [1])]).rationale).toContain("No overlay themes");
  });

  it("names the subjects a winning theme connects", () => {
    const choice = chooseTheme(
      [resolvedTheme("EQUILIBRIUM", { chemistry: [1], biology: [2] })],
      [workFor("chemistry", [1]), workFor("biology", [2])],
    );
    expect(choice.rationale).toContain("EQUILIBRIUM");
    expect(choice.rationale).toContain("Chemistry");
    expect(choice.rationale).toContain("Biology");
  });
});

describe("buildPlan", () => {
  const work = [workFor("chemistry", [7, 25]), workFor("math", [2])];

  it("bookends the session with intention and synthesis", () => {
    const plan = buildPlan({
      date: "2026-09-10",
      context: CONTEXT,
      work,
      theme: null,
      rationale: "no theme",
      createdAt: NOW,
    });
    expect(plan.blocks[0].kind).toBe("intention");
    expect(plan.blocks[plan.blocks.length - 1].kind).toBe("synthesis");
  });

  it("alternates subject blocks with breaks", () => {
    const plan = buildPlan({
      date: "2026-09-10",
      context: CONTEXT,
      work,
      theme: null,
      rationale: "no theme",
      createdAt: NOW,
    });
    const kinds = plan.blocks.map((block) => block.kind);
    expect(kinds.filter((kind) => kind === "subject").length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((kind) => kind === "break").length).toBe(
      kinds.filter((kind) => kind === "subject").length - 1,
    );
  });

  it("spends exactly the daily target", () => {
    const plan = buildPlan({
      date: "2026-09-10",
      context: CONTEXT,
      work,
      theme: null,
      rationale: "no theme",
      createdAt: NOW,
    });
    const total = plan.blocks.reduce((sum, block) => sum + block.minutes, 0);
    expect(total).toBe(CONTEXT.minutes);
  });

  it("lays the blocks out from the configured start time, back to back", () => {
    const plan = buildPlan({
      date: "2026-09-10",
      context: CONTEXT,
      work,
      theme: null,
      rationale: "no theme",
      createdAt: NOW,
    });
    expect(plan.blocks[0].startsAt).toBe("19:00");

    let expected = 19 * 60;
    for (const block of plan.blocks) {
      const [hour, minute] = block.startsAt.split(":").map(Number);
      expect(hour * 60 + minute).toBe(expected % (24 * 60));
      expected += block.minutes;
    }
  });

  it("leads each subject block with its most overdue topic when there is no theme", () => {
    const plan = buildPlan({
      date: "2026-09-10",
      context: CONTEXT,
      work,
      theme: null,
      rationale: "no theme",
      createdAt: NOW,
    });
    const subjects = plan.blocks.filter((block) => block.kind === "subject");
    expect(subjects[0].label).toBe("Chemistry — Topic 7");
    expect(subjects[0].topicIds).toEqual([7]);
    expect(subjects[0].theme).toBeNull();
  });

  it("names the theme on themed blocks and lists the other subjects' concepts", () => {
    const theme = resolvedTheme("EQUILIBRIUM", { chemistry: [7], math: [2] });
    const plan = buildPlan({
      date: "2026-09-10",
      context: CONTEXT,
      work,
      theme,
      rationale: "theme",
      createdAt: NOW,
    });
    const chemistry = plan.blocks.find((block) => block.subject === "chemistry");
    expect(chemistry?.label).toBe("Chemistry — EQUILIBRIUM");
    expect(chemistry?.theme).toBe("EQUILIBRIUM");
    expect(chemistry?.overlays.map((overlay) => overlay.subject)).toEqual(["math"]);
  });

  it("follows the theme's own subject order", () => {
    // The overlay map lists chemistry, then maths, then biology.
    const theme = resolvedTheme("T", { biology: [3], chemistry: [1], math: [2] });
    const plan = buildPlan({
      date: "2026-09-10",
      context: CONTEXT,
      work: [workFor("biology", [3]), workFor("chemistry", [1]), workFor("math", [2])],
      theme,
      rationale: "theme",
      createdAt: NOW,
    });
    const first = plan.blocks.find((block) => block.kind === "subject");
    expect(first?.subject).toBe("biology");
  });

  it("records the theme and its principle", () => {
    const plan = buildPlan({
      date: "2026-09-10",
      context: CONTEXT,
      work,
      theme: resolvedTheme("EQUILIBRIUM", { chemistry: [7], math: [2] }),
      rationale: "theme",
      createdAt: NOW,
    });
    expect(plan.theme).toBe("EQUILIBRIUM");
    expect(plan.commonPrinciple).toBe("EQUILIBRIUM principle");
    expect(plan.rationale).toBe("theme");
  });

  it("still produces a usable plan when nothing is due", () => {
    const plan = buildPlan({
      date: "2026-09-10",
      context: CONTEXT,
      work: [],
      theme: null,
      rationale: "nothing due",
      createdAt: NOW,
    });
    expect(plan.blocks.filter((block) => block.kind === "subject").length).toBeGreaterThan(0);
    expect(plan.blocks[0].label).toBe("Set intention");
  });
});

describe("plan persistence", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  function plan(date = "2026-09-10", minutes = 90): StudyPlan {
    return buildPlan({
      date,
      context: { ...CONTEXT, minutes },
      work: [workFor("chemistry", [7])],
      theme: null,
      rationale: "test",
      createdAt: NOW,
    });
  }

  it("round-trips a plan", () => {
    const id = savePlan(db, plan());
    const stored = getStoredPlan(db, "2026-09-10");
    expect(stored?.id).toBe(id);
    expect(stored?.plan.blocks.length).toBeGreaterThan(0);
    expect(stored?.completed).toBe(false);
  });

  it("returns null for a day with no plan", () => {
    expect(getStoredPlan(db, "2020-01-01")).toBeNull();
  });

  it("replaces the plan for a day rather than accumulating rows", () => {
    savePlan(db, plan());
    const second = savePlan(db, plan("2026-09-10", 45));
    expect(getStoredPlan(db, "2026-09-10")?.id).toBe(second);

    const rows = db.prepare("SELECT COUNT(*) AS n FROM study_plans WHERE date = ?").get("2026-09-10") as {
      n: number;
    };
    expect(Number(rows.n)).toBe(1);
  });

  it("marks a plan complete", () => {
    const id = savePlan(db, plan());
    setPlanCompleted(db, id, true);
    expect(getStoredPlan(db, "2026-09-10")?.completed).toBe(true);
    setPlanCompleted(db, id, false);
    expect(getStoredPlan(db, "2026-09-10")?.completed).toBe(false);
  });

  it("treats an unreadable plan as absent rather than throwing", () => {
    db.prepare("INSERT INTO study_plans (date, plan_json) VALUES ('2026-09-10', 'not json')").run();
    expect(getStoredPlan(db, "2026-09-10")).toBeNull();
  });
});

describe("planSnapshot", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    seedOverlayMapFile(db, OVERLAP_MAP);
  });

  afterEach(() => close());

  it("generates and stores a plan the first time", () => {
    const snapshot = planSnapshot(db, CONTEXT);
    expect(snapshot.generated).toBe(true);
    expect(snapshot.planId).toBeGreaterThan(0);
    expect(snapshot.plan.date).toBe("2026-09-10");
    expect(getStoredPlan(db, "2026-09-10")).not.toBeNull();
  });

  it("reuses the stored plan on the next read", () => {
    const first = planSnapshot(db, CONTEXT);
    const second = planSnapshot(db, CONTEXT);
    expect(second.generated).toBe(false);
    expect(second.planId).toBe(first.planId);
    expect(second.plan.createdAt).toBe(first.plan.createdAt);
  });

  it("rebuilds when the daily target changes", () => {
    planSnapshot(db, CONTEXT);
    const rebuilt = planSnapshot(db, CONTEXT, { minutes: 45 });
    expect(rebuilt.generated).toBe(true);
    expect(rebuilt.plan.minutes).toBe(45);
  });

  it("rebuilds on request", () => {
    planSnapshot(db, CONTEXT);
    expect(planSnapshot(db, CONTEXT, { force: true }).generated).toBe(true);
  });

  it("carries the live due summary alongside the plan", () => {
    const snapshot = planSnapshot(db, CONTEXT);
    expect(snapshot.due.dateKey).toBe("2026-09-10");
    expect(snapshot.due.counts.total).toBe(0);
  });

  it("plans a different day on request", () => {
    const snapshot = planSnapshot(db, CONTEXT, { date: "2026-09-11" });
    expect(snapshot.plan.date).toBe("2026-09-11");
    expect(getStoredPlan(db, "2026-09-11")).not.toBeNull();
  });
});

describe("composePlan", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    seedOverlayMapFile(db, OVERLAP_MAP);
  });

  afterEach(() => close());

  it("picks the overlay theme when two subjects have themed work due", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7", "25"]);
    const math = seedSyllabus(db, "math", ["2.2", "1.2"]);
    insertCard(db, {
      question: "chem",
      answer: "A",
      topicId: chemistry.topicIds[0],
      dueAt: "2026-09-05T12:00:00.000Z",
      state: "review",
      reps: 2,
    });
    insertCard(db, {
      question: "math",
      answer: "A",
      topicId: math.topicIds[0],
      dueAt: "2026-09-05T12:00:00.000Z",
      state: "review",
      reps: 2,
    });

    const { plan, work } = composePlan(db, CONTEXT, "2026-09-10");
    expect(work).toHaveLength(2);
    expect(plan.theme).toBe("EQUILIBRIUM");

    const chemistryBlock = plan.blocks.find((block) => block.subject === "chemistry");
    expect(chemistryBlock?.topicCodes).toEqual(["7"]);
    expect(chemistryBlock?.overlays.map((overlay) => overlay.subject)).toEqual(["math"]);
  });

  it("falls back to the most overdue topic when only one subject has work", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    insertCard(db, { question: "chem", answer: "A", topicId: chemistry.topicIds[0] });

    const { plan } = composePlan(db, CONTEXT, "2026-09-10");
    expect(plan.theme).toBeNull();
    expect(plan.rationale).toContain("most overdue topic per subject");
    const block = plan.blocks.find((item) => item.kind === "subject");
    expect(block?.topicCodes).toEqual(["7"]);
  });

  it("produces a plan with no work at all when nothing is imported", () => {
    const { plan, work } = composePlan(db, CONTEXT, "2026-09-10");
    expect(work).toEqual([]);
    expect(plan.blocks.length).toBeGreaterThan(0);
  });

  it("only considers the requested syllabus", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    seedSyllabus(db, "biology", ["14"]);
    insertCard(db, { question: "chem", answer: "A", topicId: chemistry.topicIds[0] });

    const { work } = composePlan(db, { ...CONTEXT, syllabusIds: [chemistry.syllabusId] }, "2026-09-10");
    expect(work.map((entry) => entry.subject)).toEqual(["chemistry"]);
  });
});

describe("activeSyllabusIds", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("returns the active syllabus per subject", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    const math = seedSyllabus(db, "math", ["2.2"]);
    expect(activeSyllabusIds(db).sort()).toEqual([chemistry.syllabusId, math.syllabusId].sort());
  });

  it("honours an explicit preference", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    seedSyllabus(db, "math", ["2.2"]);
    expect(activeSyllabusIds(db, chemistry.syllabusId)).toEqual([chemistry.syllabusId]);
  });

  it("falls back to every syllabus when none is marked active", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7"]);
    db.prepare("UPDATE syllabus SET is_active = 0").run();
    expect(activeSyllabusIds(db)).toEqual([chemistry.syllabusId]);
  });

  it("returns nothing when nothing is imported", () => {
    expect(activeSyllabusIds(db)).toEqual([]);
  });
});

describe("scheduler and the review queue agree", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
  });

  afterEach(() => close());

  it("plans blocks for exactly the cards the queue reports as due", () => {
    const chemistry = seedSyllabus(db, "chemistry", ["7", "8"]);
    insertCard(db, { question: "a", answer: "A", topicId: chemistry.topicIds[0] });
    insertCard(db, { question: "b", answer: "A", topicId: chemistry.topicIds[1] });

    const { work } = composePlan(db, CONTEXT, "2026-09-10");
    const queue = repo.listQueue(db, { now: NOW, newLimit: null });

    expect(queue).toHaveLength(2);
    expect(work[0].counts.total).toBe(queue.length);
  });
});
