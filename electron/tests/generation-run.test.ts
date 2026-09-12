import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as repo from "../services/generation/repo";
import { startGeneration } from "../services/generation/run";
import type { Database } from "../services/database/db";
import type { RunnerEvent, RunnerJobPayload } from "../agent-runner/protocol";
import type { RunnerOutcome, RunnerTransport } from "../services/generation/transport";
import type {
  GenerationOutput,
  GenerationProgress,
  GenerationRequest,
} from "../src/shared/generation-types";
import { createTestDb } from "./helpers/test-db";
import { NOW, seedSyllabus } from "./helpers/review-fixtures";
import { SYSTEM_PROMPT, TOPICS, materialPlan, testConfig } from "./helpers/generation-fixtures";

/**
 * The end-to-end proof that is available without a provider key.
 *
 * A fake transport drives `startGeneration` through the same path a real child
 * would: build the payload, emit events, park the job at the gate. Everything
 * except the model call is real — the real pipeline template, the real unit
 * builder, a real database.
 */

const OUTPUT: GenerationOutput = {
  cards: [{ question: "What is an orbital?", answer: "A region of probability.", topicCode: "1.1" }],
  questions: [
    {
      question: "How many orbitals in a p subshell?",
      choices: ["1", "3", "5"],
      answerIndex: 1,
      explanation: "px, py, pz.",
      topicCode: "1.1",
    },
  ],
  warnings: [],
};

function candidatesEvent(jobId: number, output = OUTPUT): RunnerEvent {
  return { type: "candidates", jobId, output };
}

/** Emits a scripted run and returns whatever outcome the test asked for. */
class FakeRunner implements RunnerTransport {
  payloads: RunnerJobPayload[] = [];
  cancelled = false;

  constructor(
    private readonly behavior: {
      events?: RunnerEvent[] | ((payload: RunnerJobPayload) => RunnerEvent[]);
      outcome?: RunnerOutcome;
      /** Runs after each event is emitted, for tests that act mid-run. */
      after?: (event: RunnerEvent) => void;
    } = {},
  ) {}

  async start(payload: RunnerJobPayload, onEvent: (event: RunnerEvent) => void): Promise<RunnerOutcome> {
    this.payloads.push(payload);
    const events =
      typeof this.behavior.events === "function"
        ? this.behavior.events(payload)
        : (this.behavior.events ?? []);
    for (const event of events) {
      onEvent(event);
      this.behavior.after?.(event);
    }
    return this.behavior.outcome ?? { ok: true };
  }

  cancel(): void {
    this.cancelled = true;
  }
}

/** A run that produced one card and one question for one topic. */
function happyPath(jobId = 1): RunnerEvent[] {
  return [
    { type: "ready", jobId, totalUnits: 2 },
    {
      type: "unit-start",
      jobId,
      index: 1,
      total: 2,
      stepId: "step-2",
      toolName: "generate_flashcards",
      label: "Generate flashcards",
      topicCode: "1.1",
    },
    {
      type: "unit-done",
      jobId,
      index: 1,
      total: 2,
      stepId: "step-2",
      toolName: "generate_flashcards",
      topicCode: "1.1",
      cards: 1,
      questions: 0,
      ms: 500,
      warnings: [],
    },
    {
      type: "unit-start",
      jobId,
      index: 2,
      total: 2,
      stepId: "step-3",
      toolName: "generate_quiz",
      label: "Generate quiz items",
      topicCode: "1.1",
    },
    {
      type: "unit-done",
      jobId,
      index: 2,
      total: 2,
      stepId: "step-3",
      toolName: "generate_quiz",
      topicCode: "1.1",
      cards: 0,
      questions: 1,
      ms: 400,
      warnings: [],
    },
    candidatesEvent(jobId),
    { type: "done", jobId, ok: true, cards: 1, questions: 1, warnings: [] },
  ];
}

describe("startGeneration", () => {
  let db: Database;
  let close: () => void;
  let syllabusId: number;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    syllabusId = seedSyllabus(db, "chemistry", ["1.1", "1.2"]).syllabusId;
  });

  afterEach(() => close());

  const request: GenerationRequest = {
    scope: "topic",
    syllabusIds: [1],
    codes: ["1.1"],
  };

  const run = async (
    runner: RunnerTransport,
    overrides: {
      config?: Record<string, string>;
      plan?: ReturnType<typeof materialPlan>;
      topics?: typeof TOPICS;
      hooks?: Parameters<typeof startGeneration>[3];
    } = {},
  ) =>
    startGeneration(
      db,
      runner,
      {
        request,
        config: testConfig(overrides.config),
        plan: overrides.plan ?? materialPlan(),
        topics: overrides.topics ?? TOPICS.map((topic) => ({ ...topic, syllabusId })),
        systemPrompt: SYSTEM_PROMPT,
      },
      overrides.hooks ?? {},
      NOW,
    );

  // ── pre-flight ──

  it("refuses to run when the agent runner is switched off, without creating a job", async () => {
    const runner = new FakeRunner();
    const result = await run(runner, { config: { AGENT_RUNNER_ENABLED: "false" } });

    expect(result.ok).toBe(false);
    expect(result.jobId).toBeNull();
    expect(result.errors.join(" ")).toMatch(/switched off/i);
    expect(runner.payloads).toHaveLength(0);
    expect(repo.listJobs(db)).toHaveLength(0);
  });

  it("refuses to run when no API key is configured, and names the setting", async () => {
    const result = await run(new FakeRunner(), { config: { DEEPSEEK_API_KEY: "" } });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("DEEPSEEK_API_KEY");
    expect(repo.listJobs(db)).toHaveLength(0);
  });

  it("refuses a pipeline with no generation steps", async () => {
    const plan = { ...materialPlan(), work: [] };
    const result = await run(new FakeRunner(), { plan });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/no generation steps/i);
  });

  it("refuses a pipeline with no save step", async () => {
    const plan = { ...materialPlan(), commit: null };
    const result = await run(new FakeRunner(), { plan });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/no save step/i);
  });

  it("refuses an empty scope", async () => {
    const result = await run(new FakeRunner(), { topics: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/nothing to generate/i);
  });

  // ── the happy path ──

  it("parks the run at the review gate with its candidates stored", async () => {
    const runner = new FakeRunner({ events: happyPath() });
    const result = await run(runner);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("awaiting_review");
    expect(result.cards).toBe(1);
    expect(result.questions).toBe(1);

    const job = repo.getJob(db, result.jobId as number);
    expect(job?.status).toBe("awaiting_review");
    expect(job?.gate_state).toBe("pending");
    expect(repo.getJobOutput(db, job?.id as number)?.cards).toHaveLength(1);
  });

  it("writes nothing to the flashcards table — the gate owns that", async () => {
    await run(new FakeRunner({ events: happyPath() }));
    const count = db.prepare("SELECT COUNT(*) AS count FROM flashcards").get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("sends one unit per generation step per topic", async () => {
    const runner = new FakeRunner({ events: happyPath() });
    await run(runner, {
      topics: [
        { ...TOPICS[0], syllabusId },
        { ...TOPICS[0], topicId: 2, code: "1.2", syllabusId },
      ],
    });

    const payload = runner.payloads[0];
    expect(payload.units).toHaveLength(4);
    expect(payload.units.map((unit) => unit.toolName)).toEqual([
      "generate_flashcards",
      "generate_flashcards",
      "generate_quiz",
      "generate_quiz",
    ]);
  });

  it("carries the resolved options into the payload", async () => {
    const runner = new FakeRunner({ events: happyPath() });
    await run(runner, {
      config: { GENERATION_TEMPERATURE: "0.7", LLM_TIMEOUT_MS: "30000", LLM_MAX_RETRIES: "1" },
    });

    expect(runner.payloads[0]).toMatchObject({
      temperature: 0.7,
      timeoutMs: 30_000,
      maxRetries: 1,
    });
  });

  it("stores the scope it was asked for, so the commit can resolve codes", async () => {
    const runner = new FakeRunner({ events: happyPath() });
    const result = await run(runner);
    const input = repo.getJobInput(db, result.jobId as number);

    expect(input?.syllabusIds).toEqual([syllabusId]);
    expect(input?.topics.map((topic) => topic.code)).toEqual(["1.1"]);
  });

  it("reports progress from starting through to the gate", async () => {
    const seen: GenerationProgress[] = [];
    await run(new FakeRunner({ events: happyPath() }), {
      hooks: { onProgress: (progress) => seen.push(progress) },
    });

    expect(seen[0].phase).toBe("starting");
    expect(seen.some((progress) => progress.phase === "running")).toBe(true);
    expect(seen[seen.length - 1]).toMatchObject({ phase: "review", done: true, fraction: 1 });
  });

  it("forwards usage records to the caller rather than writing them", async () => {
    const records: unknown[] = [];
    const events: RunnerEvent[] = [
      ...happyPath(),
      {
        type: "usage",
        jobId: 1,
        record: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cachedTokens: 0,
          reasoningTokens: 0,
          latencyMs: 120,
          statusCode: 200,
          source: "generate",
          step: "step-2",
          tool: "generate_flashcards",
          cost: null,
          createdAt: 1,
          instanceId: "test",
        },
      },
    ];

    await run(new FakeRunner({ events }), { hooks: { onUsage: (record) => records.push(record) } });

    expect(records).toHaveLength(1);
    const usage = db.prepare("SELECT COUNT(*) AS count FROM llm_usage").get() as { count: number };
    expect(usage.count).toBe(0);
  });

  it("attributes a unit's warnings to its topic, once", async () => {
    const events: RunnerEvent[] = [
      {
        type: "unit-done",
        jobId: 1,
        index: 1,
        total: 1,
        stepId: "step-2",
        toolName: "generate_flashcards",
        topicCode: "1.1",
        cards: 0,
        questions: 0,
        ms: 10,
        warnings: ["Card #1 was skipped."],
      },
      {
        type: "candidates",
        jobId: 1,
        output: { ...OUTPUT, warnings: ["Card #1 was skipped.", "Dropped a duplicate card."] },
      },
      { type: "done", jobId: 1, ok: true, cards: 1, questions: 1, warnings: [] },
    ];

    const result = await run(new FakeRunner({ events }));

    expect(result.warnings).toContain("1.1: Card #1 was skipped.");
    expect(result.warnings).toContain("Dropped a duplicate card.");
    expect(result.warnings.filter((warning) => warning.includes("skipped"))).toHaveLength(1);
  });

  // ── failure paths ──

  it("marks the job failed when the runner reports a failure", async () => {
    const runner = new FakeRunner({ outcome: { ok: false, error: "DeepSeek API key not set." } });
    const result = await run(runner);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(repo.getJob(db, result.jobId as number)?.error).toContain("API key not set");
  });

  it("marks the job failed when the run produced nothing usable", async () => {
    const events: RunnerEvent[] = [
      {
        type: "candidates",
        jobId: 1,
        output: { cards: [], questions: [], warnings: ["The model returned nothing."] },
      },
      { type: "done", jobId: 1, ok: true, cards: 0, questions: 0, warnings: [] },
    ];

    const result = await run(new FakeRunner({ events }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(repo.getJob(db, result.jobId as number)?.status).toBe("failed");
  });

  it("prefers the runner's own error message, and keeps the error event", async () => {
    const events: RunnerEvent[] = [{ type: "error", jobId: 1, message: "Rate limited." }];
    const result = await run(new FakeRunner({ events, outcome: { ok: false, error: "Exited 1." } }));

    expect(repo.getJob(db, result.jobId as number)?.error).toBe("Exited 1.");
    expect(result.errors.join(" ")).toBe("Exited 1.");
  });

  /**
   * The cancel race.
   *
   * A run can finish producing candidates moments after the user stops it. The
   * transition guard is what decides who wins, and it must be the user — an
   * event arriving late must not revive a stopped run or park it at a gate
   * nobody asked for.
   */
  it("does not revive a run the user stopped mid-flight", async () => {
    const jobId = 7;
    let stopped = false;
    const events: RunnerEvent[] = [
      {
        type: "unit-start",
        jobId,
        index: 1,
        total: 1,
        stepId: "step-2",
        toolName: "generate_flashcards",
        label: "Generate flashcards",
        topicCode: "1.1",
      },
      candidatesEvent(jobId),
      { type: "done", jobId, ok: true, cards: 1, questions: 1, warnings: [] },
    ];

    const runner = new FakeRunner({
      events,
      // Stop "the run" the moment work starts: the only job in play is the one
      // `startGeneration` has just created.
      after: (event) => {
        if (event.type !== "unit-start" || stopped) return;
        stopped = true;
        repo.markCancelled(db, repo.listJobs(db)[0].id, NOW);
      },
    });

    const result = await run(runner);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/stopped/i);
    expect(repo.getJob(db, repo.listJobs(db)[0].id)?.status).toBe("cancelled");
  });

  it("marks interrupted jobs failed at boot without touching the gate", async () => {
    const running = repo.createJob(
      db,
      { pipeline: "material-generation", jobInput: { request, topics: TOPICS, syllabusIds: [syllabusId], maxCardsPerTopic: 8 } },
      NOW,
    );
    repo.markRunning(db, running, NOW);

    const waiting = repo.createJob(
      db,
      { pipeline: "material-generation", jobInput: { request, topics: TOPICS, syllabusIds: [syllabusId], maxCardsPerTopic: 8 } },
      NOW,
    );
    repo.markAwaitingReview(db, waiting, OUTPUT, NOW);

    const changed = repo.markStaleFailed(db, NOW);

    expect(changed).toBe(1);
    expect(repo.getJob(db, running)?.status).toBe("failed");
    expect(repo.getJob(db, running)?.error).toMatch(/stopped before this run finished/i);
    expect(repo.getJob(db, waiting)?.status).toBe("awaiting_review");
  });
});
