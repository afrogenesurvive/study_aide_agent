import path from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  APP_VERSION,
  loadDotEnv,
  syncConfigToEnv,
} from "./config";
import { addLog, setLogLevel, subscribe, unsubscribeAll } from "./logger";
import { isDev, devServerUrl, preloadPath, rendererIndexPath, studyDbPath } from "./paths";
import { registerAllIpc } from "./ipc";
import { closeDb, initDatabase } from "../../services/database";
import { initAgentConfigDir } from "./agent-config";
import { registerSharedModules } from "./llm";
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

if (!app.requestSingleInstanceLock()) {
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

  const dbStatus = initDatabase(studyDbPath(), (level, message) => addLog("db", level, message));
  if (!dbStatus.ok) {
    addLog("db", "error", `Database unavailable: ${dbStatus.error ?? "unknown error"}`);
  }

  const agentConfig = initAgentConfigDir();
  if (agentConfig.seeded.length) {
    addLog("main", "info", `Seeded agent config: ${agentConfig.seeded.join(", ")}`);
  }

  const unsubscribe = pipeLogsToRenderer();

  mainWindow = createWindow();

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
