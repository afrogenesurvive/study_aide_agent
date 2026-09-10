import type { Database } from "../database/db";
import type { LlmUsageRecord } from "../types";
import type { LlmUsageSummary } from "../../src/shared/ipc-types";

/**
 * Local LLM usage log.
 *
 * Replaces the reference implementation's HTTP push to an external telemetry
 * service: Study Aide is local-first, so every recorded call lands in the local
 * `llm_usage` table and is surfaced in the Dev panel instead.
 */

const INSERT = `
  INSERT INTO llm_usage (
    provider, model, prompt_tokens, completion_tokens, total_tokens,
    cached_tokens, reasoning_tokens, latency_ms, status_code, cost,
    source, step, tool, instance_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function recordUsage(db: Database, record: LlmUsageRecord): void {
  db.prepare(INSERT).run(
    record.provider,
    record.model,
    record.promptTokens,
    record.completionTokens,
    record.totalTokens,
    record.cachedTokens,
    record.reasoningTokens,
    record.latencyMs,
    record.statusCode,
    record.cost,
    record.source,
    record.step,
    record.tool,
    record.instanceId,
    record.createdAt,
  );
}

export function summarizeUsage(db: Database, limitDays = 30): LlmUsageSummary {
  const since = Math.floor(Date.now() / 1000) - limitDays * 86_400;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(total_tokens), 0)      AS totalTokens,
              COALESCE(SUM(cached_tokens), 0)     AS cachedTokens,
              MAX(created_at)                     AS lastCallAt
         FROM llm_usage
        WHERE created_at >= ?`,
    )
    .get(since) as Record<string, number | null> | undefined;

  const byModel = db
    .prepare(
      `SELECT model, provider, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS totalTokens
         FROM llm_usage
        WHERE created_at >= ?
        GROUP BY model, provider
        ORDER BY totalTokens DESC
        LIMIT 20`,
    )
    .all(since) as Array<{ model: string; provider: string; calls: number; totalTokens: number }>;

  return {
    calls: Number(totals?.calls ?? 0),
    promptTokens: Number(totals?.promptTokens ?? 0),
    completionTokens: Number(totals?.completionTokens ?? 0),
    totalTokens: Number(totals?.totalTokens ?? 0),
    cachedTokens: Number(totals?.cachedTokens ?? 0),
    lastCallAt: totals?.lastCallAt ? Number(totals.lastCallAt) : null,
    byModel: byModel.map((row) => ({
      model: row.model,
      provider: row.provider,
      calls: Number(row.calls),
      totalTokens: Number(row.totalTokens),
    })),
  };
}

export function clearUsage(db: Database): number {
  const result = db.prepare("DELETE FROM llm_usage").run();
  return Number(result.changes ?? 0);
}
