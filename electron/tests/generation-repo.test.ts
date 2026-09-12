import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as repo from "../services/generation/repo";
import * as quizRepo from "../services/quiz/repo";
import type { Database } from "../services/database/db";
import type { GenerationJobInput, GenerationOutput } from "../src/shared/generation-types";
import { createTestDb } from "./helpers/test-db";
import { NOW, seedSyllabus } from "./helpers/review-fixtures";

const JOB_INPUT: GenerationJobInput = {
  request: { scope: "topic", syllabusIds: [1], codes: ["1.1"] },
  topics: [
    {
      topicId: 1,
      code: "1.1",
      title: "Atomic structure",
      subject: "chemistry",
      section: "Section 1",
      syllabusId: 1,
      themes: ["STRUCTURE AND BONDING"],
    },
  ],
  syllabusIds: [1],
  maxCardsPerTopic: 8,
};

const OUTPUT: GenerationOutput = {
  cards: [{ question: "What is an orbital?", answer: "A region of high probability.", topicCode: "1.1" }],
  questions: [
    {
      question: "How many orbitals in a p subshell?",
      choices: ["1", "3", "5"],
      answerIndex: 1,
      explanation: "px, py and pz.",
      topicCode: "1.1",
    },
  ],
  warnings: ["Topic 1.2 produced nothing."],
};

describe("generation repo", () => {
  let db: Database;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    seedSyllabus(db, "chemistry", ["1.1", "1.2"]);
  });

  afterEach(() => close());

  const create = () => repo.createJob(db, { pipeline: "material-generation", jobInput: JOB_INPUT }, NOW);

  it("creates a job in the pending state with its input stored", () => {
    const id = create();
    const job = repo.getJob(db, id);
    expect(job?.status).toBe("pending");
    expect(job?.gate_state).toBe("pending");
    expect(job?.output_json).toBeNull();
    expect(job?.committed_at).toBeNull();
    expect(job?.created_at).toBe(NOW.toISOString());
    expect(repo.getJobInput(db, id)?.topics[0].code).toBe("1.1");
  });

  it("moves pending → running once, and not twice", () => {
    const id = create();
    expect(repo.markRunning(db, id, NOW)).toBe(true);
    expect(repo.getJob(db, id)?.status).toBe("running");
    expect(repo.markRunning(db, id, NOW)).toBe(false);
  });

  it("moves running → awaiting_review and stores the candidates", () => {
    const id = create();
    repo.markRunning(db, id, NOW);
    expect(repo.markAwaitingReview(db, id, OUTPUT, NOW)).toBe(true);
    const job = repo.getJob(db, id);
    expect(job?.status).toBe("awaiting_review");
    expect(job?.gate_state).toBe("pending");
    expect(repo.getJobOutput(db, id)?.cards).toHaveLength(1);
  });

  it("commits only from awaiting_review, and only once", () => {
    const id = create();
    repo.markRunning(db, id, NOW);
    repo.markAwaitingReview(db, id, OUTPUT, NOW);

    expect(repo.markCommitted(db, id, OUTPUT, NOW)).toBe(true);
    const job = repo.getJob(db, id);
    expect(job?.status).toBe("committed");
    expect(job?.gate_state).toBe("approved");
    expect(job?.committed_at).toBe(NOW.toISOString());

    // A second commit attempt must not double-write.
    expect(repo.markCommitted(db, id, OUTPUT, NOW)).toBe(false);
  });

  it("refuses to commit a job that never reached the gate", () => {
    const id = create();
    repo.markRunning(db, id, NOW);
    expect(repo.markCommitted(db, id, OUTPUT, NOW)).toBe(false);
    expect(repo.getJob(db, id)?.status).toBe("running");
  });

  it("rejects a job at the gate", () => {
    const id = create();
    repo.markRunning(db, id, NOW);
    repo.markAwaitingReview(db, id, OUTPUT, NOW);
    expect(repo.markRejected(db, id, NOW)).toBe(true);
    const job = repo.getJob(db, id);
    expect(job?.status).toBe("rejected");
    expect(job?.gate_state).toBe("rejected");
  });

  it("records a failure with its message", () => {
    const id = create();
    repo.markRunning(db, id, NOW);
    expect(repo.markFailed(db, id, "provider exploded", NOW)).toBe(true);
    expect(repo.getJob(db, id)?.error).toBe("provider exploded");
  });

  it("does not let a late failure overwrite a cancelled job", () => {
    const id = create();
    repo.markRunning(db, id, NOW);
    expect(repo.markCancelled(db, id, NOW)).toBe(true);
    expect(repo.markFailed(db, id, "too late", NOW)).toBe(false);
    expect(repo.getJob(db, id)?.status).toBe("cancelled");
  });

  it("does not let a late cancellation overwrite a committed job", () => {
    const id = create();
    repo.markRunning(db, id, NOW);
    repo.markAwaitingReview(db, id, OUTPUT, NOW);
    repo.markCommitted(db, id, OUTPUT, NOW);
    expect(repo.markCancelled(db, id, NOW)).toBe(false);
    expect(repo.getJob(db, id)?.status).toBe("committed");
  });

  it("deletes an uncommitted job but never a committed one", () => {
    const draft = create();
    expect(repo.deleteJob(db, draft)).toBe(true);
    expect(repo.getJob(db, draft)).toBeNull();

    const kept = create();
    repo.markRunning(db, kept, NOW);
    repo.markAwaitingReview(db, kept, OUTPUT, NOW);
    repo.markCommitted(db, kept, OUTPUT, NOW);
    expect(repo.deleteJob(db, kept)).toBe(false);
    expect(repo.getJob(db, kept)).not.toBeNull();
  });

  it("lists jobs newest first and counts them", () => {
    const first = repo.createJob(db, { pipeline: "p", jobInput: JOB_INPUT }, new Date("2026-09-01T00:00:00Z"));
    const second = repo.createJob(db, { pipeline: "p", jobInput: JOB_INPUT }, new Date("2026-09-02T00:00:00Z"));
    expect(repo.listJobs(db).map((job) => job.id)).toEqual([second, first]);
    expect(repo.countJobs(db)).toBe(2);
  });

  it("lists only the jobs still waiting at the gate", () => {
    const waiting = create();
    repo.markRunning(db, waiting, NOW);
    repo.markAwaitingReview(db, waiting, OUTPUT, NOW);
    create();

    expect(repo.listPendingReview(db).map((job) => job.id)).toEqual([waiting]);
  });

  it("summarises a job with parsed counts", () => {
    const id = create();
    repo.markRunning(db, id, NOW);
    repo.markAwaitingReview(db, id, OUTPUT, NOW);

    const summary = repo.toSummary(repo.getJob(db, id)!);
    expect(summary).toMatchObject({
      id,
      status: "awaiting_review",
      gateState: "pending",
      topicCount: 1,
      cardCount: 1,
      questionCount: 1,
      warningCount: 1,
    });
  });

  it("degrades gracefully when stored candidates are not valid JSON", () => {
    const output = repo.parseGenerationOutput("{ not json");
    expect(output.cards).toEqual([]);
    expect(output.warnings).toHaveLength(1);
  });

  it("treats a missing output as empty rather than an error", () => {
    expect(repo.parseGenerationOutput(null).warnings).toEqual([]);
    expect(repo.parseGenerationInput(null)).toBeNull();
  });

  it("rejects stored input that has no topics array", () => {
    expect(repo.parseGenerationInput('{"request":{}}')).toBeNull();
  });

  it("narrows unknown status and gate text", () => {
    expect(repo.normalizeStatus("running")).toBe("running");
    expect(repo.normalizeStatus("who knows")).toBe("failed");
    expect(repo.normalizeGateState("approved")).toBe("approved");
    expect(repo.normalizeGateState("who knows")).toBe("pending");
  });
});

describe("quiz repo", () => {
  let db: Database;
  let close: () => void;
  let topicIds: number[];

  beforeEach(() => {
    ({ db, close } = createTestDb());
    topicIds = seedSyllabus(db, "chemistry", ["1.1", "1.2"]).topicIds;
  });

  afterEach(() => close());

  /** Quizzes are always generated by a run, so seed the run too. */
  function seedQuiz(): number {
    const jobId = repo.createJob(db, { pipeline: "material-generation", jobInput: JOB_INPUT }, NOW);
    const quizId = quizRepo.createQuiz(
      db,
      { title: "Atomic structure quiz", topicId: topicIds[0], jobId },
      NOW,
    );
    quizRepo.insertQuestion(
      db,
      {
        quizId,
        topicId: topicIds[0],
        orderIndex: 0,
        question: "How many orbitals in a p subshell?",
        choices: ["1", "3", "5"],
        answerIndex: 1,
        explanation: "px, py and pz.",
      },
      NOW,
    );
    quizRepo.insertQuestion(
      db,
      {
        quizId,
        orderIndex: 1,
        question: "Which quantum number sets orientation?",
        choices: ["n", "l", "ml"],
        answerIndex: 2,
      },
      NOW,
    );
    return quizId;
  }

  it("stores a quiz and decodes its questions", () => {
    const quizId = seedQuiz();
    const detail = quizRepo.getQuizDetail(db, quizId);
    expect(detail?.quiz.title).toBe("Atomic structure quiz");
    expect(detail?.quiz.created_at).toBe(NOW.toISOString());
    expect(detail?.questions).toHaveLength(2);
    expect(detail?.questions[0].choices).toEqual(["1", "3", "5"]);
    expect(detail?.questions[0].answerIndex).toBe(1);
    expect(detail?.questions[1].explanation).toBeNull();
  });

  it("orders questions by order_index", () => {
    const quizId = seedQuiz();
    expect(quizRepo.getQuestions(db, quizId).map((q) => q.order_index)).toEqual([0, 1]);
  });

  it("returns null for a quiz that does not exist", () => {
    expect(quizRepo.getQuizDetail(db, 999)).toBeNull();
  });

  it("lists quizzes with their topic code and question count", () => {
    seedQuiz();
    const [summary] = quizRepo.listQuizzes(db);
    expect(summary).toMatchObject({
      title: "Atomic structure quiz",
      topicCode: "1.1",
      topicTitle: "Topic 1.1",
      questionCount: 2,
      archived: false,
    });
    expect(quizRepo.countQuizzes(db)).toBe(1);
  });

  it("hides archived quizzes unless asked for them", () => {
    const quizId = seedQuiz();
    expect(quizRepo.archiveQuiz(db, quizId, NOW)).toBe(true);
    expect(quizRepo.listQuizzes(db)).toHaveLength(0);
    expect(quizRepo.listQuizzes(db, { includeArchived: true })).toHaveLength(1);
  });

  it("does not archive a quiz twice", () => {
    const quizId = seedQuiz();
    quizRepo.archiveQuiz(db, quizId, NOW);
    expect(quizRepo.archiveQuiz(db, quizId, NOW)).toBe(false);
  });

  it("filters by topic", () => {
    seedQuiz();
    expect(quizRepo.listQuizzes(db, { topicId: topicIds[0] })).toHaveLength(1);
    expect(quizRepo.listQuizzes(db, { topicId: topicIds[1] })).toHaveLength(0);
  });

  it("cascades questions when a quiz is deleted", () => {
    const quizId = seedQuiz();
    expect(quizRepo.deleteQuiz(db, quizId)).toBe(true);
    expect(quizRepo.getQuestions(db, quizId)).toHaveLength(0);
  });

  it("records a whole attempt and scores it", () => {
    const quizId = seedQuiz();
    const questions = quizRepo.getQuestions(db, quizId);
    const attempt = quizRepo.recordAttempt(
      db,
      quizId,
      [
        { questionId: questions[0].id, choiceIndex: 1, correct: true, responseTimeMs: 1200 },
        { questionId: questions[1].id, choiceIndex: 0, correct: false },
      ],
      NOW,
    );

    expect(attempt).toMatchObject({ quizId, total: 2, correct: 1 });
    const results = quizRepo.listResults(db, quizId);
    expect(results).toHaveLength(2);
    expect(results[0].created_at).toBe(NOW.toISOString());
    expect(Number(results.find((r) => r.correct === 1)?.response_time_ms)).toBe(1200);
  });

  it("cascades recorded answers when a quiz is deleted", () => {
    const quizId = seedQuiz();
    const questions = quizRepo.getQuestions(db, quizId);
    quizRepo.recordAttempt(db, quizId, [{ questionId: questions[0].id, choiceIndex: 1, correct: true }], NOW);
    quizRepo.deleteQuiz(db, quizId);

    const count = db.prepare("SELECT COUNT(*) AS count FROM quiz_results").get() as { count: number };
    expect(Number(count.count)).toBe(0);
  });

  it("scopes results to their own quiz", () => {
    const quizId = seedQuiz();
    const questions = quizRepo.getQuestions(db, quizId);
    quizRepo.recordAttempt(db, quizId, [{ questionId: questions[0].id, choiceIndex: 1, correct: true }], NOW);

    const other = quizRepo.createQuiz(db, { title: "Other" }, NOW);
    expect(quizRepo.listResults(db, other)).toHaveLength(0);
    expect(quizRepo.listResults(db, quizId)).toHaveLength(1);
  });

  it("links a quiz back to the run that produced it", () => {
    const quizId = seedQuiz();
    const jobId = quizRepo.getQuiz(db, quizId)?.job_id;
    expect(jobId).not.toBeNull();
    expect(repo.getJob(db, jobId!)).not.toBeNull();
  });

  it("refuses a quiz that points at a run which does not exist", () => {
    expect(() => quizRepo.createQuiz(db, { title: "Orphan", jobId: 999 }, NOW)).toThrow(
      /FOREIGN KEY/,
    );
  });
});
