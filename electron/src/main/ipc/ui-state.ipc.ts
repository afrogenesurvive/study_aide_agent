import { ipcMain } from "electron";
import { getUiState, saveUiState, type UiState } from "../ui-state";

/**
 * UI state channels.
 *
 * Contract: the renderer is the single writer. The main process never merges or
 * mutates — it just persists whatever it is handed.
 */
export function registerUiStateIpc(): void {
  ipcMain.handle("ui-state:get", () => getUiState());

  ipcMain.handle("ui-state:save", (_event, state: UiState) => {
    if (!state || typeof state !== "object" || Array.isArray(state)) return false;
    return saveUiState(state);
  });
}
