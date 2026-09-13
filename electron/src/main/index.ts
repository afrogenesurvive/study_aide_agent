import path from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  APP_VERSION,
  loadDotEnv,
  syncConfigToEnv,
} from "./config";
import { addLog, setLogLevel, subscribe, unsubscribeAll } from "./logger";
import { isDev, devServerUrl, preloadPath, rendererIndexPath, studyDbPath, dataDir } from "./paths";
import { registerAllIpc } from "./ipc";
import { setGenerationProgressSink } from "./ipc/generation.ipc";
import { closeDb, getDb, initDatabase } from "../../services/database";
import { markStaleJobsFailed } from "../../services/generation";
import { seedOverlayMapFile } from "../../services/scheduler/overlay";
import { initAgentConfigDir } from "./agent-config";
import { registerSharedModules } from "./llm";
import { initRunner, killActiveRun } from "./runner";
import { initMcp, stopMcp } from "./mcp";
import type { LogEntry } from "../shared/ipc-types";

/**
 * Main-process entry point.
 *
 * Ordering here matters:
 *   1. `app.setName` before anything resolves `userData`, so dev and packaged
 *      builds share one config/database folder.
 *   2. `.env` is loaded before the config is read, so the environment layer is
 *      populated when the first `getConfig()` call happens.
 *   3. The config is synced into `process.env` so modules that resolve settings
 *      per call (the model provider) always see the current values.
 */

app.setName("Study Aide");

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

// ── config bootstrap ─────────────────────────────────────────────────────────

const dotEnv = loadDotEnv();

// ── single instance ──────────────────────────────────────────────────────────

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // Another instance owns the app. `app.quit()` is asynchronous, so this branch
  // returning is not enough on its own — `whenReady` is guarded below too, or
  // this instance still builds a window on the way out.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// ── window ───────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: "Study Aide",
    backgroundColor: "#0d1117",
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // Required so the preload can use Node built-ins; the renderer itself still
      // has no direct access (contextIsolation + no nodeIntegration above).
      sandbox: false,
      spellcheck: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  // External links open in the real browser, never in the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("close", (event) => {
    // On macOS, closing the window should not quit the app.
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    // `npm run dev` serves the renderer from Vite. `npm start` runs unpackaged
    // from a built tree with no dev server, so fall back rather than showing an
    // ERR_CONNECTION_REFUSED page.
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL) => {
        if (!validatedURL || !validatedURL.startsWith(devServerUrl)) return;
        addLog(
          "main",
          "warn",
          `Dev server unreachable at ${devServerUrl} (${errorDescription || errorCode}); loading the built renderer instead.`,
        );
        void window.loadFile(rendererIndexPath());
      },
    );
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(rendererIndexPath());
  }

  return window;
}

// ── logging bridge ───────────────────────────────────────────────────────────

function pipeLogsToRenderer(): () => void {
  return subscribe((entry: LogEntry) => {
    mainWindow?.webContents.send("log", entry);
  });
}

// ── lifecycle ────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;

  syncConfigToEnv();
  setLogLevel((process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") || "info");

  addLog("main", "info", `Study Aide ${APP_VERSION} starting (packaged=${app.isPackaged}).`);
  addLog(
    "main",
    "info",
    `Config: ${dotEnv.path}${dotEnv.loaded ? ` (${dotEnv.loaded} value${dotEnv.loaded === 1 ? "" : "s"} loaded)` : " (not found, using defaults/environment)"}`,
  );

  registerAllIpc();
  registerSharedModules();
  // Created once at boot so the single-run guard exists before any window can ask
  // for a run; it spawns nothing until a pipeline is actually started.
  initRunner();
  // Like the runner, this spawns nothing yet: an MCP server starts on the first
  // Google tool call, so an app that never touches Google starts no children.
  initMcp();

  const dbStatus = initDatabase(studyDbPath(), (level, message) => addLog("db", level, message));
  if (!dbStatus.ok) {
    addLog("db", "error", `Database unavailable: ${dbStatus.error ?? "unknown error"}`);
  } else {
    // A run's work happens in a child process, so a crash or a force-quit can
    // leave a job marked `running` with nothing left alive to finish it.
    const stale = markStaleJobsFailed(getDb());
    if (stale > 0) {
      addLog("generate", "info", `Marked ${stale} interrupted generation run(s) as failed.`);
    }
  }

  const agentConfig = initAgentConfigDir();
  if (agentConfig.seeded.length) {
    addLog("main", "info", `Seeded agent config: ${agentConfig.seeded.join(", ")}`);
  }

  // Overlay themes drive interleaving, so they are refreshed from the committed
  // map on every boot. A failure here must not stop the app: without themes the
  // scheduler falls back to plain most-overdue-per-subject ordering.
  if (dbStatus.ok) {
    try {
      const overlays = seedOverlayMapFile(getDb(), dataDir("overlap-map.json"));
      for (const warning of overlays.warnings) addLog("scheduler", "warn", `Overlay map: ${warning}`);
      if (overlays.themes) {
        addLog(
          "scheduler",
          "info",
          `Overlay themes seeded: ${overlays.themes} theme(s), ${overlays.connections} topic link(s)` +
            (overlays.removed ? `, ${overlays.removed} stale link(s) removed.` : "."),
        );
      }
    } catch (error) {
      addLog("scheduler", "warn", `Could not seed overlay themes: ${(error as Error).message}`);
    }
  }

  const unsubscribe = pipeLogsToRenderer();

  mainWindow = createWindow();
  // Late-bound, like the log bridge: the sink is only ever called while a run is
  // in flight, which is long after the window exists.
  setGenerationProgressSink((progress) =>
    mainWindow?.webContents.send("generation:progress", progress),
  );

  // Native notification channel, used from phase 5 onwards.
  ipcMain.handle("notification:show", (_event, title: string, body: string) => {
    if (!mainWindow) return false;
    mainWindow.webContents.send("notification", { title, body });
    return true;
  });

  app.on("activate", () => {
    if (!mainWindow) mainWindow = createWindow();
    else mainWindow.show();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    unsubscribe();
    unsubscribeAll();
    // Synchronous and best-effort: the run is signalled here and the database is
    // closed immediately afterwards rather than waiting for the child to exit.
    killActiveRun();
    // Also best-effort, and deliberately not awaited: closing a child ends its
    // stdin and falls back to SIGTERM then SIGKILL, which `close()` bounds itself.
    void stopMcp();
    closeDb((level, message) => addLog("db", level, message));
  });
});

// Keep the app alive on macOS when all windows are closed, as users expect.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

process.on("uncaughtException", (error) => {
  addLog("main", "error", `Uncaught exception: ${error.message}`);
});

process.on("unhandledRejection", (reason) => {
  addLog("main", "error", `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
