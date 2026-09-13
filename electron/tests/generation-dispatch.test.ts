import { describe, expect, it } from "vitest";

import type { GoogleCallResult } from "../services/google";
import {
  TOOL_CONTEXT_MAX_CHARS,
  googleSteps,
  interpolateArgs,
  runCommitTools,
  runPreTools,
  type GoogleToolRunner,
} from "../services/generation/dispatch";
import type { ResolvedStep, RunPlan, StepStage } from "../services/generation/pipeline";

/**
 * The dispatcher is driven by a fake runner, so no test here spawns a child or
 * reaches Google. What is being pinned is *which* steps run, in what order, with
 * what arguments, and what happens when one fails.
 */

interface StepOptions {
  id: string;
  toolName: string;
  stage?: StepStage;
  args?: Record<string, unknown>;
  enabled?: boolean;
  label?: string;
}

function step(options: StepOptions): ResolvedStep {
  return {
    id: options.id,
    toolName: options.toolName,
    label: options.label ?? options.toolName,
    description: "",
    systemPromptTemplate: "",
    hintTemplate: "",
    enabled: options.enabled !== false,
    isTerminal: false,
    args: options.args ?? {},
    index: 1,
    executor: "main",
    stage: options.stage ?? "pre",
    available: true,
  };
}

function plan(steps: ResolvedStep[]): RunPlan {
  return {
    pipeline: "test",
    label: "Test",
    steps,
    pre: steps.filter((entry) => entry.stage === "pre"),
    work: steps.filter((entry) => entry.stage === "work"),
    gate: null,
    commit: steps.find((entry) => entry.stage === "commit") ?? null,
    errors: [],
    warnings: [],
    ok: true,
  };
}

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

function runner(
  responses: Record<string, GoogleCallResult | (() => GoogleCallResult)> = {},
  calls: Call[] = [],
): GoogleToolRunner {
  return {
    async callTool(tool, args = {}) {
      calls.push({ tool, args });
      const entry = responses[tool];
      if (typeof entry === "function") return entry();
      return entry ?? { ok: true, data: { tool }, error: null, retryable: false };
    },
  };
}

describe("googleSteps", () => {
  it("selects only the Google steps for the stage asked for", () => {
    const subject = plan([
      step({ id: "s0", toolName: "syllabus_list_topics" }),
      step({ id: "s1", toolName: "calendar_list_events", stage: "pre" }),
      step({ id: "s2", toolName: "generate_flashcards", stage: "work" }),
      step({ id: "s3", toolName: "materials_save", stage: "commit" }),
      step({ id: "s4", toolName: "calendar_create_event", stage: "commit" }),
    ]);

    // `syllabus_list_topics` and `materials_save` are absent on purpose: scope.ts
    // already gathers the first, and the second is the database commit.
    expect(googleSteps(subject, "pre").map((entry) => entry.id)).toEqual(["s1"]);
    expect(googleSteps(subject, "commit").map((entry) => entry.id)).toEqual(["s4"]);
  });

  it("skips a disabled step", () => {
    const subject = plan([step({ id: "s1", toolName: "calendar_list_events", enabled: false })]);
    expect(googleSteps(subject, "pre")).toHaveLength(0);
  });
});

describe("interpolateArgs", () => {
  it("fills placeholders in strings", () => {
    expect(interpolateArgs({ summary: "Study {{topicCode}}", maxResults: 5 }, { topicCode: "1.1" })).toEqual({
      summary: "Study 1.1",
      maxResults: 5,
    });
  });

  it("recurses into arrays and nested objects", () => {
    // A recurrence rule is the real case: the placeholder is inside a list.
    const result = interpolateArgs(
      { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY={{studyDay}}"], nested: { to: "{{user}}" } },
      { studyDay: "MO", user: "me@study.test" },
    );
    expect(result).toEqual({
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      nested: { to: "me@study.test" },
    });
  });

  it("leaves an unknown placeholder visible rather than blanking it", () => {
    // Same rule as prompts: a typo should be obvious, not silent.
    expect(interpolateArgs({ summary: "{{topicTitel}}" }, {})).toEqual({ summary: "{{topicTitel}}" });
  });

  it("passes non-strings through untouched", () => {
    expect(interpolateArgs({ a: 1, b: true, c: null }, {})).toEqual({ a: 1, b: true, c: null });
  });
});

describe("runPreTools", () => {
  it("runs reads in declaration order and collects their payloads", async () => {
    const calls: Call[] = [];
    const google = runner(
      {
        calendar_list_events: { ok: true, data: { events: [{ id: "e1" }] }, error: null, retryable: false },
      },
      calls,
    );
    const subject = plan([
      step({ id: "s1", toolName: "calendar_list_events" }),
      step({ id: "s2", toolName: "calendar_list_calendars" }),
    ]);

    const result = await runPreTools(google, subject, {});

    expect(calls.map((call) => call.tool)).toEqual(["calendar_list_events", "calendar_list_calendars"]);
    expect(result.ok).toBe(true);
    expect(result.results.s1).toEqual({ events: [{ id: "e1" }] });
    expect(Object.keys(result.results)).toEqual(["s1", "s2"]);
  });

  it("renders a readable context block", async () => {
    const google = runner({ calendar_list_events: { ok: true, data: { events: [] }, error: null, retryable: false } });
    const subject = plan([step({ id: "s1", toolName: "calendar_list_events", label: "Look at the week" })]);

    const context = (await runPreTools(google, subject, {})).context;

    // The label and the tool name are both there, so a reader can tell which read
    // produced which block.
    expect(context).toContain("### Look at the week (calendar_list_events)");
    expect(context).toContain('"events": []');
  });

  it("reports a failed read without stopping the others", async () => {
    const google = runner({
      gmail_list_messages: { ok: false, data: null, error: "Gmail is not configured.", retryable: false },
    });
    const subject = plan([
      step({ id: "s1", toolName: "gmail_list_messages" }),
      step({ id: "s2", toolName: "calendar_list_events" }),
    ]);

    const result = await runPreTools(google, subject, {});

    expect(result.ok).toBe(false);
    expect(result.outcomes[0]).toMatchObject({ ok: false, error: "Gmail is not configured." });
    expect(result.outcomes[1].ok).toBe(true);
    // A failed read contributes no context, but does not erase the good one.
    expect(result.results).not.toHaveProperty("s1");
    expect(result.results).toHaveProperty("s2");
  });

  it("bounds the context it will inline into a prompt", async () => {
    const huge = { body: "x".repeat(TOOL_CONTEXT_MAX_CHARS * 2) };
    const google = runner({ gmail_get_message: { ok: true, data: huge, error: null, retryable: false } });
    const subject = plan([step({ id: "s1", toolName: "gmail_get_message" })]);

    const context = (await runPreTools(google, subject, {})).context;

    expect(context).toContain("truncated");
    expect(context.length).toBeLessThan(TOOL_CONTEXT_MAX_CHARS + 200);
  });
});

describe("runCommitTools", () => {
  it("runs writes in order", async () => {
    const calls: Call[] = [];
    const google = runner({}, calls);
    const subject = plan([
      step({ id: "c1", toolName: "calendar_create_event", stage: "commit" }),
      step({ id: "c2", toolName: "calendar_create_task", stage: "commit" }),
    ]);

    const result = await runCommitTools(google, subject, {});

    expect(calls.map((call) => call.tool)).toEqual(["calendar_create_event", "calendar_create_task"]);
    expect(result.ok).toBe(true);
  });

  it("describes what it did in a way a user can read", async () => {
    const google = runner({
      gmail_send_message: {
        ok: true,
        data: { id: "m1", threadId: "t1" },
        error: null,
        retryable: false,
      },
    });
    const subject = plan([
      step({
        id: "c1",
        toolName: "gmail_send_message",
        stage: "commit",
        args: { to: "me@study.test", subject: "Weekly digest", body: "..." },
      }),
    ]);

    const result = await runCommitTools(google, subject, {});

    expect(result.outcomes[0].summary).toBe('Emailed “Weekly digest” to me@study.test');
  });

  it("reports a failed write and keeps going", async () => {
    const google = runner({
      calendar_update_event: {
        ok: false,
        data: null,
        error: "Google refused the request (403).",
        retryable: false,
      },
    });
    const subject = plan([
      step({ id: "c1", toolName: "calendar_update_event", stage: "commit" }),
      step({ id: "c2", toolName: "calendar_create_task", stage: "commit" }),
    ]);

    const result = await runCommitTools(google, subject, {});

    expect(result.ok).toBe(false);
    expect(result.outcomes[0]).toMatchObject({ ok: false, error: "Google refused the request (403)." });
    expect(result.outcomes[1].ok).toBe(true);
  });

  it("interpolates arguments before calling", async () => {
    const calls: Call[] = [];
    const google = runner({}, calls);
    const subject = plan([
      step({
        id: "c1",
        toolName: "calendar_create_event",
        stage: "commit",
        args: { summary: "{{topicTitle}} revision", start: "2026-09-14T19:00:00Z", end: "2026-09-14T20:00:00Z" },
      }),
    ]);

    await runCommitTools(google, subject, { topicTitle: "Equilibrium" });

    expect(calls[0].args.summary).toBe("Equilibrium revision");
  });

  it("does nothing, successfully, when there are no commit steps", async () => {
    const result = await runCommitTools(runner(), plan([]), {});
    expect(result).toMatchObject({ ok: true, outcomes: [], context: "" });
  });
});
