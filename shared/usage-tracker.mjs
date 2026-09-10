/**
 * Usage tracker (ESM).
 *
 * Study Aide is local-first, so this does **not** push anywhere by default. It
 * exposes a single sink hook that the Electron main process wires to the local
 * `llm_usage` SQLite table (surfaced in the Dev panel). With no sink installed
 * every call is a silent no-op, which is what standalone scripts want.
 */

const SINK_KEY = Symbol.for("study-aide.usage-sink");

let sink = null;
let dropped = 0;

/** Install (or clear, with `null`) the sink. Returns the previous sink. */
export function setUsageSink(fn) {
  const previous = sink;
  sink = typeof fn === "function" ? fn : null;
  return previous;
}

export function getUsageSink() {
  return sink;
}

export function getDroppedCount() {
  return dropped;
}

/**
 * Record one LLM call.
 *
 * @param {object|null} usage  Raw provider usage block (prompt_tokens / completion_tokens / …)
 * @param {object} info        { providerId, model, latencyMs, source, step, tool, statusCode, cost }
 * @returns {object|null}      The normalized record that was handed to the sink.
 */
export function recordCall(usage, info = {}) {
  const record = normalize(usage, info);
  if (!record) return null;
  if (!sink) return record;
  try {
    sink(record);
  } catch {
    dropped += 1;
  }
  return record;
}

/** Normalize a provider-agnostic usage record. Returns null when there is nothing to record. */
export function normalize(usage, info = {}) {
  const promptTokens = num(usage?.prompt_tokens ?? usage?.input_tokens);
  const completionTokens = num(usage?.completion_tokens ?? usage?.output_tokens);
  const totalTokens = num(usage?.total_tokens) || promptTokens + completionTokens;
  if (!promptTokens && !completionTokens && !totalTokens && !info.model) return null;

  const cachedTokens = num(
    usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens,
  );
  const reasoningTokens = num(
    usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens,
  );

  return {
    provider: String(info.providerId || "unknown"),
    model: String(info.model || ""),
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    reasoningTokens,
    latencyMs: num(info.latencyMs),
    statusCode: num(info.statusCode) || 200,
    source: String(info.source || "unknown"),
    step: info.step ?? null,
    tool: info.tool ?? null,
    cost: typeof info.cost === "number" ? info.cost : null,
    createdAt: Math.floor(Date.now() / 1000),
    // Reserved for a future multi-machine setup; unused locally.
    instanceId: instanceId(),
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

let cachedInstanceId = null;

function instanceId() {
  if (!cachedInstanceId) {
    cachedInstanceId =
      process.env.STUDY_INSTANCE_ID || `${process.platform}-${Date.now().toString(36)}`;
  }
  return cachedInstanceId;
}

export { SINK_KEY };
