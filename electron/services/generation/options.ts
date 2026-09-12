import type { GenerationRequest } from "../../src/shared/generation-types";

/**
 * Tunables for one generation run.
 *
 * Resolved from the flat string config rather than from `AppConfig`, following
 * `services/fsrs/service.ts`: the loose parameter type is what keeps this module
 * free of any main-process import, and the config is a flat string map anyway.
 *
 * Note what is *not* here: `AGENT_RUNNER_TIMEOUT_MS` is owned by
 * `src/main/runner.ts`, which re-reads it before every run. Carrying a second
 * whole-run ceiling here would give two timers racing to stop the same child.
 * `timeoutMs` below is the per-*attempt* ceiling passed down to the provider.
 */

export interface GenerationOptions {
  /** Cards requested per topic; `buildUnits` interpolates it into the prompt. */
  maxCardsPerTopic: number;
  temperature: number;
  /** Per-attempt ceiling for one model call. */
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

export const GENERATION_DEFAULTS = {
  maxCardsPerTopic: 8,
  temperature: 0.4,
  timeoutMs: 120_000,
  maxRetries: 3,
  retryBaseDelayMs: 4_000,
} as const;

/**
 * Accepted ranges, mirroring the warnings `checkConfigValues` raises.
 *
 * A value outside its range is clamped rather than rejected: the app already
 * told the user their number was unusual, and refusing to generate at all would
 * be a worse answer than using the nearest workable one.
 */
const LIMITS = {
  maxCardsPerTopic: { min: 1, max: 50 },
  temperature: { min: 0, max: 2 },
  timeoutMs: { min: 1_000, max: 600_000 },
  maxRetries: { min: 0, max: 10 },
  retryBaseDelayMs: { min: 250, max: 60_000 },
} as const;

/** Read one numeric setting, tolerating anything the config file might hold. */
function readNumber(
  value: unknown,
  limits: { min: number; max: number },
  fallback: number,
  round = false,
): number {
  // An empty or whitespace-only value means "unset", not zero — `Number("")` is
  // 0, which would silently clamp every such field to its minimum.
  if (value === undefined || value === null || String(value).trim() === "") return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  const scaled = round ? Math.round(parsed) : parsed;
  return Math.min(limits.max, Math.max(limits.min, scaled));
}

/**
 * Effective generation options.
 *
 * `maxCardsPerTopic` is the one field a run may override, because the Generate
 * panel lets the user ask for a different number for one run without editing
 * Settings. Everything else comes from the config.
 */
export function resolveGenerationOptions(
  config: Record<string, string | undefined | null>,
  request?: Pick<GenerationRequest, "maxCardsPerTopic">,
): GenerationOptions {
  const requested = request?.maxCardsPerTopic;

  return {
    maxCardsPerTopic: readNumber(
      requested ?? config.GENERATION_MAX_CARDS_PER_TOPIC,
      LIMITS.maxCardsPerTopic,
      GENERATION_DEFAULTS.maxCardsPerTopic,
      true,
    ),
    temperature: readNumber(
      config.GENERATION_TEMPERATURE,
      LIMITS.temperature,
      GENERATION_DEFAULTS.temperature,
    ),
    timeoutMs: readNumber(config.LLM_TIMEOUT_MS, LIMITS.timeoutMs, GENERATION_DEFAULTS.timeoutMs),
    maxRetries: readNumber(config.LLM_MAX_RETRIES, LIMITS.maxRetries, GENERATION_DEFAULTS.maxRetries, true),
    retryBaseDelayMs: readNumber(
      config.LLM_RETRY_BASE_DELAY_MS,
      LIMITS.retryBaseDelayMs,
      GENERATION_DEFAULTS.retryBaseDelayMs,
      true,
    ),
  };
}
