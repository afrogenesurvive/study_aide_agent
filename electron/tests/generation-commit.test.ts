import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitGeneration, discardGeneration, rejectGeneration } from "../services/generation/run";
import * as repo from "../services/generation/repo";
import * as quizRepo from "../services/quiz/repo";
import type { Database } from "../services/database/db";
import type {
  GeneratedCard,
  GenerationJobInput,
  GenerationOutput,
} from "../src/shared/generation-types";
import { createTestDb } from "./helpers/test-db";
import { NOW, seedSyllabus } from "./helpers/review-fixtures";

const JOB_INPUT: GenerationJobInput = {
  request: { scope: "topic", syllabusIds: [1], codes: ["1.1", "1.2"] },
  topics: [
    {
      topicId: 1,
      code: "1.1",
      title: "Atomic structure",
      subject: "chemistry",
      section: "Section 1",
      syllabusId: 1,
      themes: [],
    },
  ],
  syllabusIds: [1],
  maxCardsPerTopic: 8,
};

function output(overrides: Partial<GenerationOutput> = {}): GenerationOutput {
  return {
    cards: [
      { question: "What is an orbital?", answer: "A region of probability.", topicCode: "1.1" },
      { question: "What is a mole?", answer: "6.02e23 particles.", topicCode: "1.2" },
    ],
    questions: [
      {
        question: "How many orbitals in a p subshell?",
        choices: ["1", "3", "5"],
        answerIndex: 1,
        explanation: "px, py, pz.",
        topicCode: "1.1",
      },
      {
        question: "What is Avogadro's number?",
        choices: ["6.0e23", "3.0e8"],
        answerIndex: 0,
        explanation: null,
        topicCode: "1.2",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe("commitGeneration", () => {
  let db: Database;
  let close: () => void;
  let jobId: number;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    const syllabusId = seedSyllabus(db, "chemistry", ["1.1", "1.2"]).syllabusId;
    jobId = repo.createJob(
      db,
      { pipeline: "material-generation", jobInput: { ...JOB_INPUT, syllabusIds: [syllabusId] } },
      NOW,
    );
    // The real flow: a job only ever reaches the gate from `running`.
    repo.markRunning(db, jobId, NOW);
  });

  afterEach(() => close());

  /** Park the job at the gate, which is the only state a commit is valid from. */
  const gate = (candidates = output()) => repo.markAwaitingReview(db, jobId, candidates, NOW);

  it("writes cards, a quiz per topic and their questions", () => {
    gate();
    const result = commitGeneration(db, jobId, output(), NOW);

    expect(result).toMatchObject({ success: true, cards: 2, quizzes: 2, questions: 2 });
    expect(result.warnings).toEqual([]);

    const cards = db
      .prepare("SELECT question, topic_id, source FROM flashcards ORDER BY id")
      .all() as Array<{ question: string; topic_id: number; source: string }>;
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.source === "generated")).toBe(true);
    expect(cards[0].topic_id).toBeGreaterThan(0);
  });

  it("stamps the job id on each quiz and numbers its questions from zero", () => {
    gate();
    commitGeneration(db, jobId, output(), NOW);

    const quizzes = quizRepo.listQuizzes(db);
    expect(quizzes).toHaveLength(2);
    expect(quizzes.every((quiz) => quiz.questionCount === 1)).toBe(true);

    for (const quiz of quizzes) {
      const detail = quizRepo.getQuizDetail(db, quiz.id);
      expect(detail?.quiz.job_id).toBe(jobId);
      expect(detail?.questions.map((question) => question.orderIndex)).toEqual([0]);
    }
  });

  it("records the edited output as what was actually saved", () => {
    gate();
    const edited = output({ cards: [output().cards[0]], questions: [] });
    commitGeneration(db, jobId, edited, NOW);

    const stored = repo.getJobOutput(db, jobId);
    expect(stored?.cards).toHaveLength(1);
    expect(stored?.questions).toHaveLength(0);
    expect(repo.getJob(db, jobId)?.gate_state).toBe("approved");
    expect(repo.getJob(db, jobId)?.committed_at).toBe(NOW.toISOString());
  });

  /**
   * The gate guard. A job can only be committed from `awaiting_review`, so a
   * second commit — a double click, a retried IPC call — must not duplicate
   * every card in the set.
   */
  it("refuses to commit a job that is not waiting for review", () => {
    gate();
    expect(commitGeneration(db, jobId, output(), NOW).success).toBe(true);

    const second = commitGeneration(db, jobId, output(), NOW);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/no longer waiting for review/i);

    const count = db.prepare("SELECT COUNT(*) AS count FROM flashcards").get() as { count: number };
    expect(count.count).toBe(2);
  });

  it("refuses to commit a job that is still running", () => {
    const result = commitGeneration(db, jobId, output(), NOW);
    expect(result.success).toBe(false);
    expect(result.cards).toBe(0);
    const count = db.prepare("SELECT COUNT(*) AS count FROM flashcards").get() as { count: number };
    expect(count.count).toBe(0);
  });

  /**
   * The rollback proof.
   *
   * `markCommitted` flips the status *before* any card is written, so a failure
   * partway through the loop has to undo that flip as well as the cards —
   * otherwise the run would be marked saved with nothing to show for it, and
   * un-retryable.
   */
  it("rolls the whole commit back when a write fails", () => {
    gate();
    const poison = {
      get question(): string {
        throw new Error("boom");
      },
      answer: "unreachable",
      topicCode: "1.1",
    } as unknown as GeneratedCard;

    const result = commitGeneration(
      db,
      jobId,
      { cards: [output().cards[0], poison], questions: [], warnings: [] },
      NOW,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("boom");

    const count = db.prepare("SELECT COUNT(*) AS count FROM flashcards").get() as { count: number };
    expect(count.count).toBe(0);
    expect(repo.getJob(db, jobId)?.status).toBe("awaiting_review");
    expect(repo.getJob(db, jobId)?.gate_state).toBe("pending");
  });

  it("skips questions with no topic, with a warning", () => {
    gate();
    const result = commitGeneration(
      db,
      jobId,
      {
        cards: [],
        questions: [
          { question: "Orphan?", choices: ["a", "b"], answerIndex: 0, explanation: null, topicCode: null },
        ],
        warnings: [],
      },
      NOW,
    );

    expect(result.success).toBe(true);
    expect(result.quizzes).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/no topic/i);
    expect(quizRepo.listQuizzes(db)).toHaveLength(0);
  });

  it("saves a card whose code is unknown, without a topic, and says so", () => {
    gate();
    const result = commitGeneration(
      db,
      jobId,
      {
        cards: [{ question: "Off-syllabus?", answer: "Yes.", topicCode: "999" }],
        questions: [],
        warnings: [],
      },
      NOW,
    );

    expect(result.cards).toBe(1);
    expect(result.warnings.join(" ")).toContain("999");
    const row = db.prepare("SELECT topic_id FROM flashcards").get() as { topic_id: number | null };
    expect(row.topic_id).toBeNull();
  });

  it("skips a quiz whose topic code no longer exists", () => {
    gate();
    const result = commitGeneration(
      db,
      jobId,
      {
        cards: [],
        questions: [
          { question: "Gone?", choices: ["a", "b"], answerIndex: 1, explanation: null, topicCode: "8.8" },
        ],
        warnings: [],
      },
      NOW,
    );

    expect(result.quizzes).toBe(0);
    expect(result.warnings.join(" ")).toContain("8.8");
  });

  it("does not resolve a code against a syllabus the run never covered", () => {
    // A second syllabus with the same code: the commit must stay inside the
    // job's own syllabi rather than matching whichever exists first.
    const other = seedSyllabus(db, "biology", ["1.1"]).syllabusId;
    gate();
    commitGeneration(db, jobId, output(), NOW);

    const cards = db
      .prepare(
        `SELECT t.syllabus_id AS syllabus_id
           FROM flashcards c JOIN syllabus_topics t ON t.id = c.topic_id`,
      )
      .all() as Array<{ syllabus_id: number }>;

    expect(cards.every((card) => card.syllabus_id !== other)).toBe(true);
  });
});

describe("answering the gate", () => {
  let db: Database;
  let close: () => void;
  let jobId: number;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    seedSyllabus(db, "chemistry", ["1.1"]);
    jobId = repo.createJob(db, { pipeline: "material-generation", jobInput: JOB_INPUT }, NOW);
    repo.markRunning(db, jobId, NOW);
    repo.markAwaitingReview(db, jobId, output(), NOW);
  });

  afterEach(() => close());

  it("rejects a run but keeps it in the history", () => {
    expect(rejectGeneration(db, jobId, NOW).success).toBe(true);
    expect(repo.getJob(db, jobId)?.status).toBe("rejected");
    expect(repo.getJob(db, jobId)?.gate_state).toBe("rejected");
    expect(repo.listJobs(db)).toHaveLength(1);
  });

  it("refuses to reject a run that already moved on", () => {
    rejectGeneration(db, jobId, NOW);
    const again = rejectGeneration(db, jobId, NOW);
    expect(again.success).toBe(false);
    expect(again.error).toBeTruthy();
  });

  it("discards a run entirely", () => {
    expect(discardGeneration(db, jobId).success).toBe(true);
    expect(repo.getJob(db, jobId)).toBeNull();
    expect(repo.listJobs(db)).toHaveLength(0);
  });

  it("cannot discard a committed run", () => {
    commitGeneration(db, jobId, output(), NOW);
    const result = discardGeneration(db, jobId);
    expect(result.success).toBe(false);
    expect(repo.getJob(db, jobId)).not.toBeNull();
  });
});
