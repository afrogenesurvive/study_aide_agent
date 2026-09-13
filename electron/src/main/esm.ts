/**
 * Loading ESM from the CommonJS main process.
 *
 * `shared/**` and `mcp/**` are ESM living outside the `electron/` package, and
 * the main process is CommonJS `tsc` output. `tsc` downlevels a dynamic
 * `import()` into `require()`, which cannot load an ESM module at all — let alone
 * one with top-level `await`, which `shared/sanitize.mjs` has. Building the
 * import through the `Function` constructor keeps it out of the compiler's reach.
 *
 * (`src/main/llm.ts` and `agent-runner/index.ts` each carry their own copy of the
 * three-line expression, deliberately, so neither depends on this file. New code
 * should use this one.)
 */

import { pathToFileURL } from "node:url";

import { mcpDir, sharedDir } from "./paths";

/* eslint-disable @typescript-eslint/no-implied-eval */
const importEsm = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

/** Import an ESM module by absolute path. */
export function loadEsm(absolutePath: string): Promise<Record<string, unknown>> {
  return importEsm(pathToFileURL(absolutePath).href);
}

/** Import a module from the staged `shared/` directory. */
export function loadSharedModule(fileName: string): Promise<Record<string, unknown>> {
  return loadEsm(sharedDir(fileName));
}

/** Import a module from `mcp/lib/`. */
export function loadMcpLib(fileName: string): Promise<Record<string, unknown>> {
  return loadEsm(mcpDir("lib", fileName));
}
