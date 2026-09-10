import { app, ipcMain, shell } from "electron";
import { addLog } from "../logger";
import { APP_VERSION } from "../config";
import type { LogLevel } from "../../shared/ipc-types";

/** App-level channels: identity, external links, logging, window control. */

const ALLOWED_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

export function registerAppIpc(): void {
  ipcMain.handle("app:version", () => APP_VERSION);

  ipcMain.handle("app:name", () => app.getName());

  ipcMain.handle("app:paths", () => ({
    userData: app.getPath("userData"),
    logs: app.getPath("logs"),
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    platform: process.platform,
  }));

  /** Renderer-owned log lines (e.g. a caught UI exception) go through the same pipeline. */
  ipcMain.handle(
    "app:log",
    (_event, level: LogLevel, message: string, subSource?: string) => {
      const safeLevel: LogLevel = ["debug", "info", "warn", "error"].includes(level) ? level : "info";
      addLog("renderer", safeLevel, String(message ?? ""), subSource);
      return true;
    },
  );

  ipcMain.handle("app:openExternal", async (_event, url: string) => {
    try {
      const parsed = new URL(String(url));
      if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        return { success: false, error: `Blocked protocol: ${parsed.protocol}` };
      }
      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("app:openPath", async (_event, target: string) => {
    try {
      const error = await shell.openPath(String(target));
      return error ? { success: false, error } : { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("app:showItemInFolder", (_event, target: string) => {
    shell.showItemInFolder(String(target));
    return true;
  });

  ipcMain.handle("app:quitApp", () => {
    addLog("main", "info", "Quit requested from the renderer.");
    app.quit();
    return true;
  });

  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    app.exit(0);
    return true;
  });
}
