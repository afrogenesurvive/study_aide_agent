import { ipcMain } from "electron";
import {
  getAgentConfig,
  restoreAgentConfigDefaults,
  saveAgentConfigFile,
  type AgentConfigName,
} from "../agent-config";

/** Agent-config channels (pipeline / tools / system prompt). */
export function registerAgentConfigIpc(): void {
  ipcMain.handle("agent-config:get", () => getAgentConfig());

  ipcMain.handle("agent-config:save", (_event, name: AgentConfigName, content: string) =>
    saveAgentConfigFile(name, String(content ?? "")),
  );

  /**
   * Restore is implemented entirely on disk — unlike the reference
   * implementation, whose restore path silently depended on a running helper
   * service and did nothing when it was down.
   */
  ipcMain.handle("agent-config:restore-defaults", () => restoreAgentConfigDefaults());
}
