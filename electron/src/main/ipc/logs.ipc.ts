import { ipcMain } from "electron";
import { clearLogs, currentLogFile, getLogLevel, getLogs, setLogLevel } from "../logger";
import { logsDir } from "../paths";
import type { LogLevel } from "../../shared/ipc-types";

/** Log channels. Live entries additionally arrive over the `log` push channel. */
export function registerLogsIpc(): void {
  ipcMain.handle("logs:get", (_event, limit?: number) => getLogs(limit ?? 500));

  ipcMain.handle("logs:clear", () => {
    clearLogs();
    return true;
  });

  ipcMain.handle("logs:info", () => ({
    dir: logsDir(),
    file: currentLogFile(),
    level: getLogLevel(),
  }));

  ipcMain.handle("logs:setLevel", (_event, level: LogLevel) => {
    setLogLevel(level);
    return getLogLevel();
  });
}
