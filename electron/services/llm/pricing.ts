import type { LlmUsageRecord } from "../types";

/**
 * Model pricing.
 *
 * Pure lookup plus arithmetic: the table itself is loaded from disk by the main
 * process (`src/main/pricing.ts`) and handed in, so this module stays testable
 * with no Electron and no filesystem.
 *
 * Rates are USD per 1,000,000 tokens, which is how every provider publishes
 * them. `cachedInput` is the discounted rate for prompt tokens served from the
 * provider's cache; when a provider has no such discount, omit it and the full
 * input rate is used.
 */

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M cached input tokens. Falls back to `input` when absent. */
  cachedInput?: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
  /** False (or absent) when the figure is indicative and worth confirming. */
  verified?: boolean;
}

export interface PricingTable {
  version: number;
  updated: string;
  note?: string;
  /** Keyed `provider/model`, lower-cased. `provider/*` matches any model. */
  models: Record<string, ModelPrice>;
}

/** A table with no rates, so every cost stays unknown rather than zero. */
export const EMPTY_PRICING: PricingTable = { version: 1, updated: "", models: {} };

export interface PricedCall {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export function pricingKey(provider: string, model: string): string {
  return `${provider}/${model}`.trim().toLowerCase();
}

/**
 * Look up a rate, preferring an exact `provider/model` entry over the
 * provider-wide `provider/*` wildcard. Returns null when nothing matches, which
 * is what keeps an unknown model's cost NULL instead of a misleading 0.
 */
export function lookupPrice(
  table: PricingTable | null | undefined,
  provider: string,
  model: string,
): ModelPrice | null {
  if (!table?.models) return null;
  const exact = table.models[pricingKey(provider, model)];
  if (exact) return exact;
  const wildcard = table.models[`${String(provider).toLowerCase()}/*`];
  return wildcard ?? null;
}

/**
 * Cost of one call in USD, or null when the model has no known rate.
 *
 * Rounded to six decimal places: a single cheap call is a fraction of a cent,
 * and unrounded float noise would make the Dev panel's totals drift.
 */
export function estimateCost(
  table: PricingTable | null | undefined,
  call: PricedCall,
): number | null {
  const price = lookupPrice(table, call.provider, call.model);
  if (!price) return null;

  const cached = Math.max(0, call.cachedTokens ?? 0);
  const billableInput = Math.max(0, call.promptTokens - cached);
  const cachedRate = price.cachedInput ?? price.input;

  const cost =
    (billableInput * price.input + cached * cachedRate + call.completionTokens * price.output) /
    1_000_000;

  return Math.round(cost * 1e6) / 1e6;
}

/** True when the table carries a rate the user should double-check. */
export function isUnverifiedPrice(
  table: PricingTable | null | undefined,
  provider: string,
  model: string,
): boolean {
  const price = lookupPrice(table, provider, model);
  return Boolean(price) && price?.verified !== true;
}

/**
 * Fill in a missing cost on a usage record.
 *
 * The provider layer only sets `cost` when a caller passes one through `meta`,
 * so this is what makes the `llm_usage.cost` column meaningful. A record that
 * already has a cost, or whose model has no known rate, is returned untouched.
 */
export function applyCost(
  record: LlmUsageRecord,
  table: PricingTable | null | undefined,
): LlmUsageRecord {
  if (typeof record.cost === "number") return record;
  const cost = estimateCost(table, {
    provider: record.provider,
    model: record.model,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    cachedTokens: record.cachedTokens,
  });
  return cost === null ? record : { ...record, cost };
}

const NON_NEGATIVE = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Parse a pricing file.
 *
 * Deliberately forgiving and never throwing: pricing is an optional nicety, so a
 * malformed file should degrade to "no costs" with warnings rather than stop the
 * app from recording usage. Entries that fail validation are dropped
 * individually.
 */
export function parsePricingTable(
  raw: unknown,
): { table: PricingTable; warnings: string[] } {
  const warnings: string[] = [];
  const table: PricingTable = { version: 1, updated: "", models: {} };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { table, warnings: ["Pricing file is not a JSON object."] };
  }

  const source = raw as Record<string, unknown>;
  if (typeof source.version === "number") table.version = source.version;
  if (typeof source.updated === "string") table.updated = source.updated;
  if (typeof source.note === "string") table.note = source.note;

  const models = source.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    warnings.push("Pricing file has no `models` object.");
    return { table, warnings };
  }

  for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") {
      warnings.push(`Pricing entry "${key}" is not an object.`);
      continue;
    }
    if (!NON_NEGATIVE(entry.input) || !NON_NEGATIVE(entry.output)) {
      warnings.push(`Pricing entry "${key}" needs non-negative numeric input/output rates.`);
      continue;
    }
    if (entry.cachedInput !== undefined && !NON_NEGATIVE(entry.cachedInput)) {
      warnings.push(`Pricing entry "${key}" has an invalid cachedInput rate.`);
      continue;
    }

    table.models[key.trim().toLowerCase()] = {
      input: entry.input as number,
      output: entry.output as number,
      ...(entry.cachedInput !== undefined ? { cachedInput: entry.cachedInput as number } : {}),
      ...(entry.verified === true ? { verified: true } : {}),
    };
  }

  return { table, warnings };
}
