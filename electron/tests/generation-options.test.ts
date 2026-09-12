import { describe, expect, it } from "vitest";

import { GENERATION_DEFAULTS, resolveGenerationOptions } from "../services/generation/options";

/**
 * Option resolution.
 *
 * These exist because the config is a flat string map that a user can hand-edit,
 * so every value has to survive being missing, empty, non-numeric or absurd —
 * and the answer must always be something the provider will accept.
 */

describe("resolveGenerationOptions", () => {
  it("falls back to the shipped defaults when the config is empty", () => {
    expect(resolveGenerationOptions({})).toEqual(GENERATION_DEFAULTS);
  });

  it("reads the generation settings", () => {
    const options = resolveGenerationOptions({
      GENERATION_MAX_CARDS_PER_TOPIC: "12",
      GENERATION_TEMPERATURE: "0.9",
      LLM_TIMEOUT_MS: "45000",
      LLM_MAX_RETRIES: "5",
      LLM_RETRY_BASE_DELAY_MS: "8000",
    });

    expect(options).toEqual({
      maxCardsPerTopic: 12,
      temperature: 0.9,
      timeoutMs: 45_000,
      maxRetries: 5,
      retryBaseDelayMs: 8_000,
    });
  });

  it("treats a blank value as unset rather than as zero", () => {
    // `Number("")` is 0, which would clamp every blank field to its minimum —
    // a silent 1 card per topic instead of the documented 8.
    const options = resolveGenerationOptions({
      GENERATION_MAX_CARDS_PER_TOPIC: "   ",
      LLM_MAX_RETRIES: "",
    });

    expect(options.maxCardsPerTopic).toBe(GENERATION_DEFAULTS.maxCardsPerTopic);
    expect(options.maxRetries).toBe(GENERATION_DEFAULTS.maxRetries);
  });

  it("falls back when a value is not a number", () => {
    const options = resolveGenerationOptions({
      GENERATION_MAX_CARDS_PER_TOPIC: "lots",
      GENERATION_TEMPERATURE: "warm",
      LLM_TIMEOUT_MS: null,
    });

    expect(options.maxCardsPerTopic).toBe(GENERATION_DEFAULTS.maxCardsPerTopic);
    expect(options.temperature).toBe(GENERATION_DEFAULTS.temperature);
    expect(options.timeoutMs).toBe(GENERATION_DEFAULTS.timeoutMs);
  });

  it("clamps out-of-range values instead of refusing to run", () => {
    const options = resolveGenerationOptions({
      GENERATION_MAX_CARDS_PER_TOPIC: "5000",
      GENERATION_TEMPERATURE: "9",
      LLM_TIMEOUT_MS: "10",
      LLM_MAX_RETRIES: "-4",
      LLM_RETRY_BASE_DELAY_MS: "1",
    });

    expect(options.maxCardsPerTopic).toBe(50);
    expect(options.temperature).toBe(2);
    expect(options.timeoutMs).toBe(1_000);
    expect(options.maxRetries).toBe(0);
    expect(options.retryBaseDelayMs).toBe(250);
  });

  it("rounds a fractional card count", () => {
    expect(resolveGenerationOptions({ GENERATION_MAX_CARDS_PER_TOPIC: "6.6" }).maxCardsPerTopic).toBe(7);
  });

  it("lets one run override the card count without touching the setting", () => {
    const config = { GENERATION_MAX_CARDS_PER_TOPIC: "8" };
    expect(resolveGenerationOptions(config, { maxCardsPerTopic: 3 }).maxCardsPerTopic).toBe(3);
    expect(resolveGenerationOptions(config, {}).maxCardsPerTopic).toBe(8);
  });

  it("ignores a nonsense per-run override", () => {
    const config = { GENERATION_MAX_CARDS_PER_TOPIC: "8" };
    expect(resolveGenerationOptions(config, { maxCardsPerTopic: Number.NaN }).maxCardsPerTopic).toBe(8);
  });
});
