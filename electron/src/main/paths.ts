import path from "node:path";
import { app } from "electron";

/**
 * Where bundled, read-only resources live.
 *
 * Dev:     <repo>/            (i.e. one level up from `electron/`)
 * Packaged: <app>/Contents/Resources   via `extraResources`
 */
export function resourcePath(...segments: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : path.resolve(app.getAppPath(), "..");
  return base ? path.join(base, ...segments) : "";
}

/** Dev-only: absolute path to the repo root. Do not use in packaged builds. */
export function repoRootPath(...segments: string[]): string {
  return path.join(path.resolve(app.getAppPath(), ".."), ...segments);
}

/** Absolute path inside `<userData>`. */
export function userDataPath(...segments: string[]): string {
  return path.join(app.getPath("userData"), ...segments);
}

export function logsDir(): string {
  return userDataPath("logs");
}

export function configPath(): string {
  return userDataPath("config.json");
}

export function configDefaultsPath(): string {
  return userDataPath("config.defaults.json");
}

export function uiStatePath(): string {
  return userDataPath("ui-state.json");
}

export function agentConfigDir(): string {
  return userDataPath("agent-config");
}

export function agentConfigDefaultsDir(): string {
  return path.join(agentConfigDir(), ".defaults");
}

/**
 * SQLite location. Defaults to `<userData>/study.db` so dev and packaged builds
 * behave identically and the repo stays clean; `STUDY_DB_PATH` overrides.
 */
export function studyDbPath(): string {
  const override = process.env.STUDY_DB_PATH?.trim();
  if (override) return path.resolve(override);
  return userDataPath("study.db");
}

/** Committed seed data (syllabi, overlap map, socratic trees). */
export function dataDir(...segments: string[]): string {
  return resourcePath("data", ...segments);
}

/** The staged `shared/` directory (config-loader, model-provider, logger). */
export function sharedDir(...segments: string[]): string {
  return resourcePath("shared", ...segments);
}

/**
 * An MCP server's entry point.
 *
 * `mcp/` sits alongside `shared/` in the resources directory so both resolve the
 * same way in dev and packaged builds. Note that it must be listed in
 * `extraResources` — including each server's own `node_modules`, because the
 * servers depend on the MCP SDK.
 */
export function mcpServerPath(server: string, ...segments: string[]): string {
  return resourcePath("mcp", server, ...segments);
}

/** The staged `mcp/` tree, for a status readout. */
export function mcpDir(...segments: string[]): string {
  return resourcePath("mcp", ...segments);
}

export function preloadPath(): string {
  return path.join(__dirname, "preload.js");
}

/** Renderer bundle: `dist/renderer/index.html`, one level up from `dist/src/main`. */
export function rendererIndexPath(): string {
  return path.join(__dirname, "..", "..", "renderer", "index.html");
}

export const isDev = !app.isPackaged;
export const devServerUrl = "http://localhost:5173";

export interface NodeSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * How to spawn a Node script.
 *
 * Always re-enters Electron's embedded Node, in dev and packaged builds alike.
 * The original dev branch shelled out to a `node` on PATH, which would run the
 * child on whatever version happens to be installed — this machine's default is
 * v18, which the app does not support. Pinning to `process.execPath` makes the
 * child's runtime identical to the main process's in every context.
 */
export function nodeSpawnSpec(scriptPath: string): NodeSpawnSpec {
  return {
    command: process.execPath,
    args: [scriptPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}
