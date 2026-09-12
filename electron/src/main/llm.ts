import { pathToFileURL } from "node:url";
import { addLog } from "./logger";
import { getConfig } from "./config";
import { sharedDir } from "./paths";
import { getPricingTable } from "./pricing";
import { setChatModuleLoader, type ChatModule } from "../../services/llm/provider";
import { setSanitizerLoader, type SanitizerModule } from "../../services/llm/sanitize";
import { applyCost } from "../../services/llm/pricing";
import { tryGetDb } from "../../services/database";
import { recordUsage } from "../../services/llm/usage";
import type { LlmUsageRecord, LlmUsageSink } from "../../services/types";

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

  // Optional private pattern set. A build with no `sanitize.private.mjs` simply
  // falls back to the baseline scrub in `services/llm/sanitize.ts`.
  setSanitizerLoader(async () => {
    const file = pathToFileURL(sharedDir("sanitize.mjs")).href;
    const mod = await importEsm(file);
    if (typeof mod.sanitize !== "function") {
      throw new Error("shared/sanitize.mjs did not export sanitize().");
    }
    return mod as unknown as SanitizerModule;
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

    const sink: LlmUsageSink = (record) => {
      if (getConfig().USAGE_TRACKING_ENABLED !== "true") return;
      const db = tryGetDb();
      if (!db) return;
      try {
        recordUsage(db, applyCost(record, getPricingTable()));
      } catch (err) {
        addLog("llm", "warn", `Could not record LLM usage: ${describe(err)}`);
      }
    };

    setUsageSink(sink as unknown as (fn: unknown) => unknown);
  } catch (err) {
    addLog("llm", "debug", `Usage tracking unavailable: ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
