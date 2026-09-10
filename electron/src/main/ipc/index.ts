import { registerAgentConfigIpc } from "./agent-config.ipc";
import { registerAppIpc } from "./app.ipc";
import { registerConfigIpc } from "./config.ipc";
import { registerDatabaseIpc } from "./database.ipc";
import { registerLogsIpc } from "./logs.ipc";
import { registerSyllabusIpc } from "./syllabus.ipc";
import { registerUiStateIpc } from "./ui-state.ipc";

/**
 * Register every IPC handler.
 *
 * Split into one registrar per domain rather than a single thousands-of-lines
 * `index.ts` — the reference implementation's main file had grown past 3,600
 * lines, mostly IPC, which made it the hardest thing in the codebase to change.
 */
export function registerAllIpc(): void {
  registerAppIpc();
  registerConfigIpc();
  registerUiStateIpc();
  registerLogsIpc();
  registerDatabaseIpc();
  registerAgentConfigIpc();
  registerSyllabusIpc();
}
