import { describe, expect, it } from "vitest";
import {
  applyCost,
  estimateCost,
  isUnverifiedPrice,
  lookupPrice,
  parsePricingTable,
  pricingKey,
  type PricingTable,
} from "../services/llm/pricing";
import type { LlmUsageRecord } from "../services/types";

const TABLE: PricingTable = {
  version: 1,
  updated: "2026-09-11",
  models: {
    "openai/gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10, verified: true },
    "anthropic/claude-sonnet-4-5": { input: 3, output: 15 },
    "ollama/*": { input: 0, output: 0, verified: true },
  },
};

function record(overrides: Partial<LlmUsageRecord> = {}): LlmUsageRecord {
  return {
    provider: "openai",
    model: "gpt-4o",
    promptTokens: 1000,
    completionTokens: 0,
    totalTokens: 1000,
    cachedTokens: 0,
    reasoningTokens: 0,
    latencyMs: 10,
    statusCode: 200,
    source: "test",
    step: null,
    tool: null,
    cost: null,
    createdAt: 0,
    instanceId: "test",
    ...overrides,
  };
}

describe("pricingKey", () => {
  it("lower-cases and joins provider and model", () => {
    expect(pricingKey("OpenAI", "GPT-4o")).toBe("openai/gpt-4o");
  });
});

describe("lookupPrice", () => {
  it("prefers an exact provider/model entry", () => {
    expect(lookupPrice(TABLE, "openai", "gpt-4o")?.input).toBe(2.5);
  });

  it("falls back to a provider wildcard", () => {
    expect(lookupPrice(TABLE, "ollama", "any-local-model")?.output).toBe(0);
  });

  it("matches case-insensitively", () => {
    expect(lookupPrice(TABLE, "OpenAI", "GPT-4O")?.output).toBe(10);
  });

  it("returns null for an unknown model rather than zero", () => {
    expect(lookupPrice(TABLE, "deepseek", "deepseek-v4-flash")).toBeNull();
  });

  it("tolerates a null table", () => {
    expect(lookupPrice(null, "openai", "gpt-4o")).toBeNull();
  });
});

describe("estimateCost", () => {
  it("prices input and output at their own rates", () => {
    // 1000 in @ 2.50/1M + 2000 out @ 10/1M = 0.0025 + 0.02
    expect(
      estimateCost(TABLE, {
        provider: "openai",
        model: "gpt-4o",
        promptTokens: 1000,
        completionTokens: 2000,
      }),
    ).toBeCloseTo(0.0225, 6);
  });

  it("bills cached tokens at the discounted rate", () => {
    // 1000 prompt of which 800 cached: 200 @ 2.50 + 800 @ 1.25
    const cost = estimateCost(TABLE, {
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 1000,
      completionTokens: 0,
      cachedTokens: 800,
    });
    expect(cost).toBeCloseTo((200 * 2.5 + 800 * 1.25) / 1_000_000, 6);
  });

  it("falls back to the full input rate when cachedInput is absent", () => {
    const cost = estimateCost(TABLE, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      promptTokens: 1000,
      completionTokens: 0,
      cachedTokens: 1000,
    });
    expect(cost).toBeCloseTo(1000 * 3 / 1_000_000, 6);
  });

  it("rounds to six decimal places", () => {
    const cost = estimateCost(TABLE, {
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 3,
      completionTokens: 0,
    });
    expect(cost).toBe(0.000008);
  });

  it("returns null for an unknown model", () => {
    expect(
      estimateCost(TABLE, {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        promptTokens: 10,
        completionTokens: 10,
      }),
    ).toBeNull();
  });

  it("ignores a cached count larger than the prompt count", () => {
    const cost = estimateCost(TABLE, {
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 100,
      completionTokens: 0,
      cachedTokens: 500,
    });
    expect(cost).toBeCloseTo((500 * 1.25) / 1_000_000, 6);
  });
});

describe("applyCost", () => {
  it("fills in a missing cost", () => {
    expect(applyCost(record(), TABLE).cost).toBeCloseTo(0.0025, 6);
  });

  it("leaves an explicit cost alone", () => {
    expect(applyCost(record({ cost: 9.99 }), TABLE).cost).toBe(9.99);
  });

  it("leaves the cost null when the model has no rate", () => {
    const unpriced = record({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(applyCost(unpriced, TABLE).cost).toBeNull();
  });

  it("does not mutate the record it is given", () => {
    const original = record();
    applyCost(original, TABLE);
    expect(original.cost).toBeNull();
  });
});

describe("isUnverifiedPrice", () => {
  it("is false for a rate marked verified", () => {
    expect(isUnverifiedPrice(TABLE, "openai", "gpt-4o")).toBe(false);
  });

  it("is true for a seeded rate with no verified flag", () => {
    expect(isUnverifiedPrice(TABLE, "anthropic", "claude-sonnet-4-5")).toBe(true);
  });

  it("is false when there is no rate at all", () => {
    expect(isUnverifiedPrice(TABLE, "deepseek", "deepseek-v4-flash")).toBe(false);
  });
});

describe("parsePricingTable", () => {
  it("keeps valid entries and normalises their keys", () => {
    const { table, warnings } = parsePricingTable({
      version: 2,
      updated: "2026-01-01",
      models: { "OpenAI/GPT-4o": { input: 1, output: 2, cachedInput: 0.5, verified: true } },
    });
    expect(warnings).toEqual([]);
    expect(table.version).toBe(2);
    expect(table.models["openai/gpt-4o"]).toEqual({
      input: 1,
      output: 2,
      cachedInput: 0.5,
      verified: true,
    });
  });

  it("drops an entry missing numeric rates and warns", () => {
    const { table, warnings } = parsePricingTable({ models: { "a/b": { input: "free" } } });
    expect(table.models).toEqual({});
    expect(warnings[0]).toMatch(/"a\/b" needs non-negative/);
  });

  it("drops an entry with a negative rate", () => {
    const { table, warnings } = parsePricingTable({ models: { "a/b": { input: -1, output: 1 } } });
    expect(table.models).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  it("drops an invalid cachedInput rate", () => {
    const { table } = parsePricingTable({
      models: { "a/b": { input: 1, output: 1, cachedInput: "cheap" } },
    });
    expect(table.models).toEqual({});
  });

  it("warns instead of throwing on a non-object payload", () => {
    const { table, warnings } = parsePricingTable("nonsense");
    expect(table.models).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  it("warns when the models key is missing", () => {
    const { warnings } = parsePricingTable({ version: 1 });
    expect(warnings[0]).toMatch(/no `models` object/);
  });

  it("drops a non-object entry", () => {
    const { table, warnings } = parsePricingTable({ models: { "a/b": 42 } });
    expect(table.models).toEqual({});
    expect(warnings[0]).toMatch(/not an object/);
  });
});
