/**
 * Service-layer contracts.
 *
 * Services under `electron/services/` deliberately know nothing about Electron:
 * they take a plain database handle plus injected callbacks. That keeps them
 * importable from Vitest with no Electron stub, and keeps the main process as
 * the only place that touches `app`, windows and IPC.
 */

export type ServiceLogLevel = "debug" | "info" | "warn" | "error";

/** Injected logger. The main process passes a `logger.addLog` adapter. */
export type ServiceLogger = (level: ServiceLogLevel, message: string) => void;

/** Fire-and-forget usage recorder for LLM calls (see `shared/usage-tracker.mjs`). */
export interface LlmUsageRecord {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  statusCode: number;
  source: string;
  step: string | null;
  tool: string | null;
  cost: number | null;
  createdAt: number;
  instanceId: string;
}

export type LlmUsageSink = (record: LlmUsageRecord) => void;
