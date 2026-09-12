/**
 * LLM provider layer (ESM). Fetch-based, no SDKs, Node 18+.
 *
 * Provider and model are resolved from `process.env` **on every call**, so
 * settings changes apply without a restart. The Electron main process pushes
 * its effective config into `process.env` via `syncConfigToEnv()` before calling.
 *
 * Normalized return shape:
 *   { toolCall: {name, arguments} | null, reply: string | null, usage: object | null, reasoningContent: string | null }
 *
 * Calls are retried with exponential backoff on transient failures (429, 5xx,
 * network and timeout errors) and are individually cancellable: pass a `signal`
 * to abort, and `timeoutMs` to bound a single attempt. A cancellation is never
 * retried. Failures throw an `LlmCallError` carrying `status` and `retryable`,
 * so callers can tell bad input apart from a flaky network.
 */

import { recordCall } from "./usage-tracker.mjs";

const PROVIDERS = ["deepseek", "openai", "anthropic", "ollama"];

const DEFAULT_MODELS = {
  deepseek: "deepseek-v4-flash",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
  ollama: null,
};

const LABELS = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
};

const OLLAMA_CTX_OPTIONS = [32768, 65536, 131072];

/** A single attempt is bounded. Long generations need a generous ceiling. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Retries *after* the first attempt, matching `pipeline.json`'s `max_retries`. */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 4000;

/** Statuses worth trying again; other 4xx codes are the caller's fault. */
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);

/**
 * A failed provider call.
 *
 * `retryable` is what the backoff loop keys on. `status` is 0 for network and
 * timeout failures, which never produced an HTTP response.
 */
export class LlmCallError extends Error {
  constructor(message, { status = 0, retryable = false, providerId = "unknown" } = {}) {
    super(message);
    this.name = "LlmCallError";
    this.status = status;
    this.retryable = retryable;
    this.providerId = providerId;
  }
}

let lastProviderId = null;
let lastModel = null;

export function getProvider() {
  const raw = String(process.env.LLM_PROVIDER || "deepseek").toLowerCase().trim();
  return PROVIDERS.includes(raw) ? raw : "deepseek";
}

export function getModelName(provider = getProvider()) {
  switch (provider) {
    case "ollama":
      return process.env.OLLAMA_MODEL || DEFAULT_MODELS.ollama;
    case "openai":
      return process.env.OPENAI_MODEL || DEFAULT_MODELS.openai;
    case "anthropic":
      return process.env.ANTHROPIC_MODEL || DEFAULT_MODELS.anthropic;
    default:
      return process.env.DEEPSEEK_MODEL || DEFAULT_MODELS.deepseek;
  }
}

const KEY_VARS = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/** Fail fast with an actionable message. Returns the API key (empty for ollama). */
export function keyGuard(provider = getProvider()) {
  if (provider === "ollama") return "";
  const key = process.env[KEY_VARS[provider]];
  if (!key) {
    throw new Error(
      `${LABELS[provider]} API key not set — add ${KEY_VARS[provider]} in Settings → Configuration (LLM_PROVIDER=${provider}).`,
    );
  }
  return key;
}

/** Convert MCP-style tool definitions into OpenAI function-calling definitions. */
export function mapTools(toolDefs = []) {
  return toolDefs.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  }));
}

/** Probe a local Ollama server. Always true for non-Ollama providers. */
export async function checkOllamaHealth(baseUrl = ollamaBaseUrl()) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single-shot call.
 *
 * @param {{systemMessage?:string, userContext?:string, tools?:object[], temperature?:number, meta?:object,
 *          signal?:AbortSignal, timeoutMs?:number, maxRetries?:number, retryBaseDelayMs?:number}} opts
 */
export async function callChat({
  systemMessage,
  userContext,
  tools = [],
  temperature,
  meta,
  signal,
  timeoutMs,
  maxRetries,
  retryBaseDelayMs,
} = {}) {
  const messages = [];
  if (systemMessage) messages.push({ role: "system", content: systemMessage });
  messages.push({ role: "user", content: userContext ?? "" });
  return dispatch({
    messages,
    tools,
    temperature,
    meta,
    signal,
    timeoutMs,
    maxRetries,
    retryBaseDelayMs,
  });
}

/**
 * Multi-turn call.
 *
 * @param {{systemMessage?:string, messages?:object[], tools?:object[], temperature?:number, meta?:object,
 *          signal?:AbortSignal, timeoutMs?:number, maxRetries?:number, retryBaseDelayMs?:number}} opts
 */
export async function callChatHistory({
  systemMessage,
  messages = [],
  tools = [],
  temperature,
  meta,
  signal,
  timeoutMs,
  maxRetries,
  retryBaseDelayMs,
} = {}) {
  const assembled = systemMessage
    ? [{ role: "system", content: systemMessage }, ...messages]
    : [...messages];
  return dispatch({
    messages: assembled,
    tools,
    temperature,
    meta,
    signal,
    timeoutMs,
    maxRetries,
    retryBaseDelayMs,
  });
}

/** Providers whose prompt evaluation is expensive enough to be worth caching. */
export function isLocalProvider(provider = getProvider()) {
  return provider === "ollama";
}

// ── internals ────────────────────────────────────────────────────────────────

async function dispatch({
  messages,
  tools,
  temperature,
  meta,
  signal,
  timeoutMs,
  maxRetries,
  retryBaseDelayMs,
}) {
  const provider = getProvider();
  const model = getModelName(provider);
  lastProviderId = provider;
  lastModel = model;

  const apiKey = keyGuard(provider);
  if (provider === "ollama" && !(await checkOllamaHealth())) {
    throw new Error(
      `Ollama is not reachable at ${ollamaBaseUrl()} — start it with \`ollama serve\` or switch LLM_PROVIDER.`,
    );
  }

  const resolvedTemperature =
    typeof temperature === "number"
      ? temperature
      : Number.parseFloat(process.env.LLM_TEMPERATURE || "0.1");

  const retries = resolveInt(maxRetries, "LLM_MAX_RETRIES", DEFAULT_MAX_RETRIES);
  const baseDelay = resolveInt(
    retryBaseDelayMs,
    "LLM_RETRY_BASE_DELAY_MS",
    DEFAULT_RETRY_BASE_DELAY_MS,
  );
  const attempts = retries + 1;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const call = {
        apiKey,
        model,
        messages,
        tools,
        temperature: resolvedTemperature,
        signal,
        timeoutMs,
      };
      const result =
        provider === "anthropic"
          ? await callAnthropic(call)
          : await callOpenAiCompatible({ provider, ...call });

      recordCall(result.usage, {
        providerId: provider,
        model,
        latencyMs: Date.now() - startedAt,
        statusCode: 200,
        attempts: attempt,
        ...(meta || {}),
      });

      return result;
    } catch (err) {
      lastError = err;
      // Only transient provider/network faults are worth another attempt, and a
      // user cancellation must always win over the retry policy.
      if (!(err instanceof LlmCallError) || !err.retryable) throw err;
      if (attempt === attempts || signal?.aborted) throw err;
      await sleep(baseDelay * 2 ** (attempt - 1), signal);
    }
  }

  throw lastError ?? new Error("Provider call failed.");
}

/**
 * One bounded HTTP attempt.
 *
 * Caller cancellation and our own timeout both abort the fetch, but they mean
 * different things: a cancellation must never be retried, a timeout should be.
 */
async function request(url, init, { signal, timeoutMs, providerId }) {
  const controller = new AbortController();
  const limit = resolveInt(timeoutMs, "LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  let timedOut = false;

  const timer =
    limit > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, limit)
      : null;
  const forwardAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (signal?.aborted) throw new LlmCallError("Call cancelled.", { providerId });
    if (timedOut) {
      throw new LlmCallError(`${labelFor(providerId)} timed out after ${limit} ms.`, {
        retryable: true,
        providerId,
      });
    }
    throw new LlmCallError(`${labelFor(providerId)} request failed: ${describeError(err)}`, {
      retryable: true,
      providerId,
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

function labelFor(providerId) {
  return LABELS[providerId] || providerId;
}

function httpError(providerId, status, text) {
  return new LlmCallError(
    `${labelFor(providerId)} API ${status}: ${String(text || "").slice(0, 500)}`,
    { status, retryable: RETRYABLE_STATUSES.has(status) || status >= 500, providerId },
  );
}

function resolveInt(value, envKey, fallback) {
  const parsed = Number.parseInt(value ?? process.env[envKey], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err);
}

/** Abortable backoff. Resolving early on abort is safe: the loop re-checks. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}

function ollamaBaseUrl() {
  return String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function openAiBaseUrl() {
  return {
    openai: String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    deepseek: "https://api.deepseek.com",
    ollama: `${ollamaBaseUrl()}/v1`,
  };
}

function ollamaNumCtx() {
  const value = Number.parseInt(process.env.OLLAMA_NUM_CTX || "32768", 10);
  return OLLAMA_CTX_OPTIONS.includes(value) ? value : 32768;
}

async function callOpenAiCompatible({
  provider,
  apiKey,
  model,
  messages,
  tools,
  temperature,
  signal,
  timeoutMs,
}) {
  const base = openAiBaseUrl()[provider];
  const body = { model, messages, temperature, stream: false };

  if (tools.length) {
    body.tools = mapTools(tools);
    body.tool_choice = "auto";
  }
  // DeepSeek-only thinking knobs; other OpenAI-compatible providers reject them.
  if (provider === "deepseek") {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = "high";
  }
  // Local context window must be explicitly requested.
  if (provider === "ollama") {
    body.num_ctx = ollamaNumCtx();
  }

  const res = await request(
    `${base}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    { signal, timeoutMs, providerId: provider },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw httpError(provider, res.status, text);
  }

  const json = await res.json();
  const message = json?.choices?.[0]?.message ?? {};
  const toolCall = parseToolCall(message.tool_calls?.[0]);

  return {
    toolCall,
    reply: toolCall ? (message.content ?? null) : (message.content ?? null),
    usage: json?.usage ?? null,
    reasoningContent: message.reasoning_content ?? null,
  };
}

async function callAnthropic({ apiKey, model, messages, tools, temperature, signal, timeoutMs }) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");

  const body = {
    model,
    max_tokens: Number.parseInt(process.env.ANTHROPIC_MAX_TOKENS || "4096", 10),
    temperature,
    messages: rest.map(toAnthropicMessage),
  };
  if (system) body.system = system;
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      input_schema: tool.inputSchema || { type: "object", properties: {} },
    }));
    body.tool_choice = { type: "auto" };
  }

  const base = String(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const res = await request(
    `${base}/v1/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    },
    { signal, timeoutMs, providerId: "anthropic" },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw httpError("anthropic", res.status, text);
  }

  const json = await res.json();
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const textBlocks = blocks.filter((b) => b.type === "text");
  const toolBlock = blocks.find((b) => b.type === "tool_use");

  const toolCall =
    json?.stop_reason === "tool_use" && toolBlock
      ? { name: toolBlock.name, arguments: toolBlock.input ?? {} }
      : null;

  return {
    toolCall,
    reply: textBlocks.map((b) => b.text).join("\n").trim() || null,
    usage: json?.usage
      ? {
          prompt_tokens: json.usage.input_tokens,
          completion_tokens: json.usage.output_tokens,
          total_tokens: (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0),
          prompt_tokens_details: { cached_tokens: json.usage.cache_read_input_tokens ?? 0 },
        }
      : null,
    reasoningContent: null,
  };
}

function toAnthropicMessage(message) {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content ?? "" },
      ],
    };
  }
  return { role: message.role === "assistant" ? "assistant" : "user", content: message.content ?? "" };
}

/**
 * Tool arguments arrive as a JSON string. A malformed payload degrades to "no
 * tool call" rather than throwing, so the caller still gets usable prose.
 */
function parseToolCall(raw) {
  if (!raw?.function) return null;
  let args = {};
  const rawArgs = raw.function.arguments;
  if (typeof rawArgs === "string" && rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return null;
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    args = rawArgs;
  }
  return { name: raw.function.name, arguments: args };
}

/** For the Dev panel status line. */
export function getLastCallInfo() {
  return { providerId: lastProviderId, model: lastModel };
}
