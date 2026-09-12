import fs from "node:fs";
import { addLog } from "./logger";
import { dataDir, userDataPath } from "./paths";
import {
  EMPTY_PRICING,
  parsePricingTable,
  type PricingTable,
} from "../../services/llm/pricing";

/**
 * Disk side of model pricing.
 *
 * The committed seed lives in `data/model-pricing.json`; a user override at
 * `<userData>/model-pricing.json` replaces it wholesale, so rates can be
 * corrected without touching the repository. Both are optional — with neither,
 * costs stay unknown (NULL) rather than being reported as zero.
 */

let cached: PricingTable | null = null;

export function getPricingTable(): PricingTable {
  if (cached) return cached;
  cached = loadPricingTable();
  return cached;
}

/** Drop the cache so the next read picks up an edited file. */
export function reloadPricing(): PricingTable {
  cached = null;
  return getPricingTable();
}

function loadPricingTable(): PricingTable {
  const override = userDataPath("model-pricing.json");
  const seed = dataDir("model-pricing.json");

  const fromOverride = readTable(override, true);
  if (fromOverride) return fromOverride;

  return readTable(seed, false) ?? EMPTY_PRICING;
}

function readTable(file: string, isOverride: boolean): PricingTable | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    // A missing seed is only worth mentioning in dev; a broken override is not.
    if (isOverride && (err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      addLog("llm", "warn", `Could not read ${file}: ${describe(err)}`);
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    addLog("llm", "warn", `Model pricing at ${file} is not valid JSON: ${describe(err)}`);
    return null;
  }

  const { table, warnings } = parsePricingTable(parsed);
  for (const warning of warnings) addLog("llm", "warn", `Model pricing: ${warning}`);
  if (isOverride && Object.keys(table.models).length === 0) {
    addLog("llm", "warn", `Model pricing override at ${file} contained no usable rates.`);
    return null;
  }
  return table;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
