import { describe, expect, it } from "vitest";
import {
  coerceCandidates,
  groupQuestionsByTopic,
  mergeOutputs,
} from "../services/generation/candidates";

describe("coerceCandidates — cards", () => {
  it("accepts the documented shape and stamps the topic code", () => {
    const result = coerceCandidates(
      { cards: [{ question: "What is an orbital?", answer: "A region of high probability." }] },
      "1.1",
    );
    expect(result.warnings).toEqual([]);
    expect(result.cards).toEqual([
      { question: "What is an orbital?", answer: "A region of high probability.", topicCode: "1.1" },
    ]);
  });

  it("accepts a bare array", () => {
    const result = coerceCandidates([{ question: "Q", answer: "A" }], "1.1");
    expect(result.cards).toHaveLength(1);
  });

  it("accepts a single card object under a singular key", () => {
    const result = coerceCandidates({ card: { question: "Q", answer: "A" } }, "1.1");
    expect(result.cards).toHaveLength(1);
  });

  it("accepts the front/back synonyms", () => {
    const result = coerceCandidates({ cards: [{ front: "Q", back: "A" }] }, null);
    expect(result.cards[0]).toMatchObject({ question: "Q", answer: "A", topicCode: null });
  });

  it("trims whitespace", () => {
    const result = coerceCandidates({ cards: [{ question: "  Q  ", answer: "  A  " }] }, "1.1");
    expect(result.cards[0].question).toBe("Q");
    expect(result.cards[0].answer).toBe("A");
  });

  it("drops a card with no answer and says why", () => {
    const result = coerceCandidates({ cards: [{ question: "Q" }] }, "1.1");
    expect(result.cards).toEqual([]);
    expect(result.warnings[0]).toMatch(/Card #1 was missing/);
  });

  it("drops a card that is only whitespace", () => {
    const result = coerceCandidates({ cards: [{ question: "   ", answer: "A" }] }, "1.1");
    expect(result.cards).toEqual([]);
  });

  it("drops a non-object entry", () => {
    const result = coerceCandidates({ cards: ["nope"] }, "1.1");
    expect(result.cards).toEqual([]);
    expect(result.warnings[0]).toMatch(/not an object/);
  });

  it("keeps the good cards alongside a bad one", () => {
    const result = coerceCandidates(
      { cards: [{ question: "Q1", answer: "A1" }, { question: "Q2" }, { question: "Q3", answer: "A3" }] },
      "1.1",
    );
    expect(result.cards.map((card) => card.question)).toEqual(["Q1", "Q3"]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("coerceCandidates — questions", () => {
  const good = {
    question: "How many orbitals in a p subshell?",
    choices: ["1", "3", "5"],
    answerIndex: 1,
    explanation: "px, py and pz.",
  };

  it("accepts a well-formed question", () => {
    const result = coerceCandidates({ questions: [good] }, "1.1");
    expect(result.warnings).toEqual([]);
    expect(result.questions[0]).toEqual({
      question: good.question,
      choices: ["1", "3", "5"],
      answerIndex: 1,
      explanation: "px, py and pz.",
      topicCode: "1.1",
    });
  });

  it("accepts answer_index as well as answerIndex", () => {
    const { answerIndex, ...rest } = good;
    const result = coerceCandidates({ questions: [{ ...rest, answer_index: 2 }] }, "1.1");
    expect(result.questions[0].answerIndex).toBe(2);
  });

  it("drops an answer that is not one of the choices", () => {
    const result = coerceCandidates({ questions: [{ ...good, answerIndex: 9 }] }, "1.1");
    expect(result.questions).toEqual([]);
    expect(result.warnings[0]).toMatch(/not one of its choices/);
  });

  it("drops a negative answer index", () => {
    const result = coerceCandidates({ questions: [{ ...good, answerIndex: -1 }] }, "1.1");
    expect(result.questions).toEqual([]);
  });

  it("drops a question with too few choices", () => {
    const result = coerceCandidates({ questions: [{ ...good, choices: ["only"] }] }, "1.1");
    expect(result.questions).toEqual([]);
    expect(result.warnings[0]).toMatch(/fewer than 2/);
  });

  it("discards blank choices rather than failing the question", () => {
    const result = coerceCandidates(
      { questions: [{ ...good, choices: ["1", "  ", "3", "5"], answerIndex: 3 }] },
      "1.1",
    );
    // "5" is now at index 2 after the blank is dropped, so index 3 is out of range.
    expect(result.questions).toEqual([]);
    expect(result.warnings[0]).toMatch(/not one of its choices/);
  });

  it("keeps choices intact when nothing is blank", () => {
    const result = coerceCandidates({ questions: [good] }, "1.1");
    expect(result.questions[0].choices).toEqual(["1", "3", "5"]);
  });

  it("treats a missing explanation as null", () => {
    const { explanation, ...rest } = good;
    const result = coerceCandidates({ questions: [rest] }, "1.1");
    expect(result.questions[0].explanation).toBeNull();
  });

  it("drops a question with no stem", () => {
    const { question, ...rest } = good;
    const result = coerceCandidates({ questions: [rest] }, "1.1");
    expect(result.questions).toEqual([]);
    expect(result.warnings[0]).toMatch(/no question text/);
  });
});

describe("coerceCandidates — degenerate input", () => {
  it("returns empty for null", () => {
    expect(coerceCandidates(null, "1.1")).toEqual({ cards: [], questions: [], warnings: [] });
  });

  it("returns empty for a bare string", () => {
    expect(coerceCandidates("I could not do that.", "1.1").cards).toEqual([]);
  });

  it("returns empty for an object with neither key", () => {
    expect(coerceCandidates({ reply: "hi" }, "1.1").questions).toEqual([]);
  });

  it("handles both keys in one payload", () => {
    const result = coerceCandidates(
      {
        cards: [{ question: "Q", answer: "A" }],
        questions: [{ question: "Q2", choices: ["a", "b"], answerIndex: 0 }],
      },
      "1.1",
    );
    expect(result.cards).toHaveLength(1);
    expect(result.questions).toHaveLength(1);
  });
});

describe("mergeOutputs", () => {
  it("concatenates units and keeps every warning", () => {
    const merged = mergeOutputs([
      { cards: [{ question: "Q1", answer: "A1", topicCode: "1.1" }], questions: [], warnings: ["w1"] },
      { cards: [{ question: "Q2", answer: "A2", topicCode: "1.2" }], questions: [], warnings: ["w2"] },
    ]);
    expect(merged.cards).toHaveLength(2);
    expect(merged.warnings).toEqual(["w1", "w2"]);
  });

  it("drops a duplicate card and reports it", () => {
    const merged = mergeOutputs([
      { cards: [{ question: "Same?", answer: "A", topicCode: "1.1" }], questions: [], warnings: [] },
      { cards: [{ question: "  same?  ", answer: "A", topicCode: "1.2" }], questions: [], warnings: [] },
    ]);
    expect(merged.cards).toHaveLength(1);
    expect(merged.warnings[0]).toMatch(/duplicate card/);
  });

  it("drops a duplicate question", () => {
    const question = { question: "Same?", choices: ["a", "b"], answerIndex: 0, explanation: null, topicCode: "1.1" };
    const merged = mergeOutputs([
      { cards: [], questions: [question], warnings: [] },
      { cards: [], questions: [{ ...question, topicCode: "1.2" }], warnings: [] },
    ]);
    expect(merged.questions).toHaveLength(1);
    expect(merged.warnings[0]).toMatch(/duplicate question/);
  });

  it("returns an empty payload for no inputs", () => {
    expect(mergeOutputs([])).toEqual({ cards: [], questions: [], warnings: [] });
  });
});

describe("groupQuestionsByTopic", () => {
  it("groups by topic code and keeps an unattributed bucket", () => {
    const groups = groupQuestionsByTopic([
      { question: "Q1", choices: ["a", "b"], answerIndex: 0, explanation: null, topicCode: "1.1" },
      { question: "Q2", choices: ["a", "b"], answerIndex: 0, explanation: null, topicCode: "1.1" },
      { question: "Q3", choices: ["a", "b"], answerIndex: 0, explanation: null, topicCode: null },
    ]);
    expect(groups.get("1.1")).toHaveLength(2);
    expect(groups.get(null)).toHaveLength(1);
  });
});
