/**
 * Injection point for the shared LLM provider.
 *
 * `shared/model-provider.mjs` is ESM and lives outside the `electron/` package,
 * so the main process resolves its real path at runtime and registers it here.
 * Services stay free of Electron and of any hard filesystem knowledge, and tests
 * can register a fake implementation instead.
 */

export interface ChatCallOptions {
  systemMessage?: string;
  userContext?: string;
  tools?: unknown[];
  temperature?: number;
  meta?: Record<string, unknown>;
}

export interface ChatCallResult {
  toolCall: { name: string; arguments: Record<string, unknown> } | null;
  reply: string | null;
  usage: Record<string, unknown> | null;
  reasoningContent?: string | null;
}

export interface ChatModule {
  callChat: (options: ChatCallOptions) => Promise<ChatCallResult>;
  getProvider?: () => string;
  getModelName?: () => string | null;
  keyGuard?: () => string;
  checkOllamaHealth?: () => Promise<boolean>;
}

let loader: (() => Promise<ChatModule>) | null = null;
let cached: ChatModule | null = null;

/** Register how to load the provider. Pass `null` to reset. */
export function setChatModuleLoader(fn: (() => Promise<ChatModule>) | null): void {
  loader = fn;
  cached = null;
}

export function hasChatModule(): boolean {
  return loader !== null;
}

/** Load (and memoise) the provider. Throws a user-facing error when unset. */
export async function loadChatModule(): Promise<ChatModule> {
  if (cached) return cached;
  if (!loader) {
    throw new Error(
      "LLM provider is not available in this context. Start the app (or configure a provider) and try again.",
    );
  }
  cached = await loader();
  return cached;
}

/** Current provider/model, for the Dev panel. Best-effort. */
export async function describeProvider(): Promise<{ provider: string; model: string | null }> {
  try {
    const mod = await loadChatModule();
    return {
      provider: mod.getProvider?.() ?? "unknown",
      model: mod.getModelName?.() ?? null,
    };
  } catch {
    return { provider: "unavailable", model: null };
  }
}
