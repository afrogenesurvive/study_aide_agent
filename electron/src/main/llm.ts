import { pathToFileURL } from "node:url";
import { addLog } from "./logger";
import { getConfig } from "./config";
import { sharedDir } from "./paths";
import { setChatModuleLoader, type ChatModule } from "../../services/llm/provider";
import { tryGetDb } from "../../services/database";
import { recordUsage } from "../../services/llm/usage";
import type { LlmUsageRecord } from "../../services/types";

/**
 * Bridges the Electron main process to the shared ESM modules in `shared/`.
 *
 * Those modules are plain `.mjs` and live outside the `electron/` package, so
 * they are resolved at runtime rather than bundled into the `tsc` output.
 */

/**
 * A genuine dynamic `import()`.
 *
 * `tsc` downlevels `import()` to `require()` in CommonJS output, and `require()`
 * cannot load an ESM module that uses top-level await. Routing through
 * `new Function` keeps a real dynamic import at runtime, so `shared/*.mjs` loads
 * exactly as written.
 */
const importEsm = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let usageSinkInstalled = false;

export function registerSharedModules(): void {
  setChatModuleLoader(async () => {
    const file = pathToFileURL(sharedDir("model-provider.mjs")).href;
    const mod = await importEsm(file);
    if (typeof mod.callChat !== "function") {
      throw new Error("shared/model-provider.mjs did not export callChat().");
    }
    return mod as unknown as ChatModule;
  });

  void installUsageSink();
}

/**
 * Route recorded LLM calls into the local `llm_usage` table.
 *
 * The reference implementation pushed these to an external service; Study Aide
 * is local-first, so the Dev panel reads them straight out of SQLite.
 */
async function installUsageSink(): Promise<void> {
  if (usageSinkInstalled) return;
  usageSinkInstalled = true;

  try {
    const file = pathToFileURL(sharedDir("usage-tracker.mjs")).href;
    const mod = await importEsm(file);
    const setUsageSink = mod.setUsageSink as ((fn: unknown) => unknown) | undefined;
    if (typeof setUsageSink !== "function") return;

    setUsageSink((record: unknown) => {
      if (getConfig().USAGE_TRACKING_ENABLED !== "true") return;
      const db = tryGetDb();
      if (!db) return;
      try {
        recordUsage(db, record as LlmUsageRecord);
      } catch (err) {
        addLog("llm", "warn", `Could not record LLM usage: ${describe(err)}`);
      }
    });
  } catch (err) {
    addLog("llm", "debug", `Usage tracking unavailable: ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
