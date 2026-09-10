import fs from "node:fs";
import { uiStatePath } from "./paths";

/**
 * Persisted, high-frequency UI state (selected panel, sub-tabs, filters,
 * in-progress drafts).
 *
 * Deliberately separate from config.json: config changes restart child services
 * and are user-authored settings, whereas this is throwaway view state written
 * on every interaction. The renderer is the single writer — there is no
 * main-side merge.
 */
export type UiState = Record<string, unknown>;

export function getUiState(): UiState {
  try {
    const raw = fs.readFileSync(uiStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as UiState;
  } catch {
    // Missing or corrupt: start clean rather than blocking startup.
    return {};
  }
}

export function saveUiState(state: UiState): boolean {
  try {
    const target = uiStatePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state ?? {}, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

export function clearUiState(): boolean {
  return saveUiState({});
}
