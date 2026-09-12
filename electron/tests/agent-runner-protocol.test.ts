import { describe, expect, it } from "vitest";
import {
  encodeEvent,
  parseEventLine,
  RUNNER_EVENT_TYPES,
  type RunnerEvent,
  type RunnerJobPayload,
} from "../agent-runner/protocol";
import { buildRunnerPayload } from "./helpers/runner-fixtures";

describe("encodeEvent", () => {
  it("writes exactly one line", () => {
    const line = encodeEvent({ type: "ready", jobId: 7, totalUnits: 3 });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n")).toHaveLength(2);
  });

  it("round-trips through parseEventLine", () => {
    const event: RunnerEvent = { type: "ready", jobId: 7, totalUnits: 3 };
    expect(parseEventLine(encodeEvent(event))).toEqual(event);
  });

  it("round-trips a unit-start event", () => {
    const event: RunnerEvent = {
      type: "unit-start",
      jobId: 1,
      index: 1,
      total: 4,
      stepId: "step-2",
      toolName: "generate_flashcards",
      label: "Generate flashcards",
      topicCode: "1.1",
    };
    expect(parseEventLine(encodeEvent(event))).toEqual(event);
  });

  it("round-trips a candidates event with nested arrays", () => {
    const event: RunnerEvent = {
      type: "candidates",
      jobId: 1,
      output: {
        cards: [{ question: "Q", answer: "A", topicCode: "1.1" }],
        questions: [
          { question: "Q2", choices: ["a", "b"], answerIndex: 1, explanation: null, topicCode: "1.1" },
        ],
        warnings: ["w"],
      },
    };
    expect(parseEventLine(encodeEvent(event))).toEqual(event);
  });

  it("round-trips a usage event", () => {
    const event: RunnerEvent = {
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
    };
    expect(parseEventLine(encodeEvent(event))).toEqual(event);
  });

  it("never emits a newline inside the payload", () => {
    const event: RunnerEvent = {
      type: "error",
      jobId: 1,
      message: "line one\nline two",
    };
    expect(encodeEvent(event).split("\n")).toHaveLength(2);
    expect(parseEventLine(encodeEvent(event))).toMatchObject({ message: "line one\nline two" });
  });
});

describe("parseEventLine", () => {
  it("returns null for a blank line", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("   ")).toBeNull();
  });

  it("returns null for prose on stdout", () => {
    // A dependency logging to stdout must not fail the run.
    expect(parseEventLine("Listening on port 3000")).toBeNull();
  });

  it("returns null for truncated JSON", () => {
    expect(parseEventLine('{"type":"ready","jobId":1')).toBeNull();
  });

  it("returns null for an unknown event type", () => {
    expect(parseEventLine('{"type":"telemetry","jobId":1}')).toBeNull();
  });

  it("returns null when jobId is missing", () => {
    expect(parseEventLine('{"type":"ready"}')).toBeNull();
  });

  it("returns null when jobId is not a number", () => {
    expect(parseEventLine('{"type":"ready","jobId":"1"}')).toBeNull();
  });

  it("accepts a JSON array as a line, but not as an event", () => {
    expect(parseEventLine("[1,2,3]")).toBeNull();
  });

  it("accepts every event type in the union", () => {
    for (const type of RUNNER_EVENT_TYPES) {
      expect(parseEventLine(JSON.stringify({ type, jobId: 1 }))).toMatchObject({ type });
    }
  });

  it("tolerates trailing whitespace", () => {
    expect(parseEventLine('  {"type":"ready","jobId":1,"totalUnits":0}  ')).toMatchObject({
      type: "ready",
    });
  });
});

describe("RunnerJobPayload", () => {
  it("serialises and parses back", () => {
    const payload = buildRunnerPayload();
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});
