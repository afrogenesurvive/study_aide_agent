import { ipcMain } from "electron";
import {
  checkConfig,
  clearConfig,
  exportConfig,
  getConfig,
  getConfigWithSources,
  importConfig,
  restoreUserConfigDefaults,
  saveConfig,
} from "../config";
import { addLog } from "../logger";
import type { ConfigFileResult } from "../../shared/ipc-types";

/** Configuration channels. Writes invalidate the cache and re-sync `process.env`. */

export function registerConfigIpc(): void {
  ipcMain.handle("config:get", () => getConfig());

  ipcMain.handle("config:getWithSources", () => getConfigWithSources());

  ipcMain.handle("config:check", () => checkConfig());

  ipcMain.handle("config:save", (_event, values: Record<string, unknown>) => {
    const result = saveConfig(values ?? {});
    logWrite("save", result, Object.keys(values ?? {}));
    return result;
  });

  ipcMain.handle("config:clear", () => {
    const result = clearConfig();
    logWrite("clear", result, []);
    return result;
  });

  ipcMain.handle("config:export", () => exportConfig());

  ipcMain.handle("config:import", (_event, raw: string) => {
    const result = importConfig(String(raw ?? ""));
    logWrite("import", result, []);
    return result;
  });

  ipcMain.handle("config:restore-defaults", () => {
    const result = restoreUserConfigDefaults();
    logWrite("restore-defaults", result, []);
    return result;
  });
}

function logWrite(action: string, result: ConfigFileResult, keys: string[]): void {
  if (result.success) {
    addLog(
      "main",
      "info",
      `Config ${action} ok${keys.length ? ` (${keys.join(", ")})` : ""} → ${result.filePath ?? ""}`,
    );
  } else {
    addLog("main", "error", `Config ${action} failed: ${result.error ?? "unknown error"}`);
  }
}
