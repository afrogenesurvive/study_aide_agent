/**
 * LLM provider layer (ESM). Fetch-based, no SDKs, Node 18+.
 *
 * Provider and model are resolved from `process.env` **on every call**, so
 * settings changes apply without a restart. The Electron main process pushes
 * its effective config into `process.env` via `syncConfigToEnv()` before calling.
 *
 * Normalized return shape:
 *   { toolCall: {name, arguments} | null, reply: string | null, usage: object | null, reasoningContent: string | null }
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
 * @param {{systemMessage?:string, userContext?:string, tools?:object[], temperature?:number, meta?:object}} opts
 */
export async function callChat({ systemMessage, userContext, tools = [], temperature, meta } = {}) {
  const messages = [];
  if (systemMessage) messages.push({ role: "system", content: systemMessage });
  messages.push({ role: "user", content: userContext ?? "" });
  return dispatch({ messages, tools, temperature, meta });
}

/**
 * Multi-turn call.
 * @param {{systemMessage?:string, messages?:object[], tools?:object[], temperature?:number, meta?:object}} opts
 */
export async function callChatHistory({
  systemMessage,
  messages = [],
  tools = [],
  temperature,
  meta,
} = {}) {
  const assembled = systemMessage
    ? [{ role: "system", content: systemMessage }, ...messages]
    : [...messages];
  return dispatch({ messages: assembled, tools, temperature, meta });
}

/** Providers whose prompt evaluation is expensive enough to be worth caching. */
export function isLocalProvider(provider = getProvider()) {
  return provider === "ollama";
}

// ── internals ────────────────────────────────────────────────────────────────

async function dispatch({ messages, tools, temperature, meta }) {
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

  const startedAt = Date.now();
  const result =
    provider === "anthropic"
      ? await callAnthropic({ apiKey, model, messages, tools, temperature: resolvedTemperature })
      : await callOpenAiCompatible({
          provider,
          apiKey,
          model,
          messages,
          tools,
          temperature: resolvedTemperature,
        });

  recordCall(result.usage, {
    providerId: provider,
    model,
    latencyMs: Date.now() - startedAt,
    statusCode: 200,
    ...(meta || {}),
  });

  return result;
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

async function callOpenAiCompatible({ provider, apiKey, model, messages, tools, temperature }) {
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

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${LABELS[provider]} API ${res.status}: ${text.slice(0, 500)}`);
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

async function callAnthropic({ apiKey, model, messages, tools, temperature }) {
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
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
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
