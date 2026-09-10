import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentConfigPayload,
  AppConfig,
  ConfigCheckResult,
  ConfigFileResult,
  ConfigSourcesPayload,
  DbStatus,
  LogEntry,
  LogLevel,
  StorageUsage,
  BackupResult,
  LlmUsageSummary,
} from "../shared/ipc-types";
import type {
  CanonicalSyllabus,
  CoverageReport,
  ImportCommitResult,
  ImportFormat,
  ImportFormatHint,
  ImportPreview,
  ParseResult,
  Subject,
  SyllabusDetail,
  SyllabusImportRow,
  SyllabusSummary,
  TopicStatus,
  Valence,
} from "../shared/syllabus-types";

/**
 * The entire renderer-facing surface.
 *
 * Every privileged operation is an explicit, named method — the renderer has no
 * `nodeIntegration` and no generic "run this query" escape hatch. Event
 * subscriptions return an unsubscribe closure so React effects can clean up.
 */

const api = {
  platform: process.platform,
  isPackaged: process.env.NODE_ENV === "production",

  // ── app ──
  getVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  getName: (): Promise<string> => ipcRenderer.invoke("app:name"),
  getPaths: (): Promise<{ userData: string; logs: string; appPath: string; isPackaged: boolean; platform: string }> =>
    ipcRenderer.invoke("app:paths"),
  getInfo: (): Promise<{ version: string; recordCounts: Record<string, number> }> =>
    ipcRenderer.invoke("app:info"),
  log: (level: LogLevel, message: string, subSource?: string): Promise<boolean> =>
    ipcRenderer.invoke("app:log", level, message, subSource),
  openExternal: (url: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("app:openExternal", url),
  openPath: (target: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("app:openPath", target),
  showItemInFolder: (target: string): Promise<boolean> =>
    ipcRenderer.invoke("app:showItemInFolder", target),
  quitApp: (): Promise<boolean> => ipcRenderer.invoke("app:quitApp"),
  relaunch: (): Promise<boolean> => ipcRenderer.invoke("app:relaunch"),

  // ── config ──
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke("config:get"),
  getConfigWithSources: (): Promise<ConfigSourcesPayload> =>
    ipcRenderer.invoke("config:getWithSources"),
  checkConfig: (): Promise<ConfigCheckResult> => ipcRenderer.invoke("config:check"),
  saveConfig: (values: Record<string, unknown>): Promise<ConfigFileResult> =>
    ipcRenderer.invoke("config:save", values),
  clearConfig: (): Promise<ConfigFileResult> => ipcRenderer.invoke("config:clear"),
  exportConfig: (): Promise<string> => ipcRenderer.invoke("config:export"),
  importConfig: (raw: string): Promise<ConfigFileResult> => ipcRenderer.invoke("config:import", raw),
  restoreConfigDefaults: (): Promise<ConfigFileResult> =>
    ipcRenderer.invoke("config:restore-defaults"),

  // ── ui state ──
  getUiState: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("ui-state:get"),
  saveUiState: (state: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke("ui-state:save", state),

  // ── logs ──
  getLogs: (limit?: number): Promise<LogEntry[]> => ipcRenderer.invoke("logs:get", limit),
  clearLogs: (): Promise<boolean> => ipcRenderer.invoke("logs:clear"),
  getLogInfo: (): Promise<{ dir: string; file: string | null; level: LogLevel }> =>
    ipcRenderer.invoke("logs:info"),
  setLogLevel: (level: LogLevel): Promise<LogLevel> => ipcRenderer.invoke("logs:setLevel", level),
  onLog: (callback: (entry: LogEntry) => void): (() => void) => {
    const listener = (_event: unknown, entry: LogEntry) => callback(entry);
    ipcRenderer.on("log", listener);
    return () => ipcRenderer.removeListener("log", listener);
  },

  // ── storage / database ──
  getStorageUsage: (): Promise<StorageUsage> => ipcRenderer.invoke("storage:usage"),
  getDbStatus: (): Promise<DbStatus> => ipcRenderer.invoke("db:status"),
  getDbTables: (): Promise<string[]> => ipcRenderer.invoke("db:tables"),
  backupDb: (): Promise<BackupResult> => ipcRenderer.invoke("db:backup"),

  // ── llm usage ──
  getUsageSummary: (): Promise<LlmUsageSummary> => ipcRenderer.invoke("usage:summary"),
  clearUsage: (): Promise<number> => ipcRenderer.invoke("usage:clear"),

  // ── agent config ──
  getAgentConfig: (): Promise<AgentConfigPayload> => ipcRenderer.invoke("agent-config:get"),
  saveAgentConfig: (
    name: "pipeline" | "tools" | "system-prompt",
    content: string,
  ): Promise<{ success: boolean; errors: string[]; error?: string }> =>
    ipcRenderer.invoke("agent-config:save", name, content),
  restoreAgentConfigDefaults: (): Promise<{ success: boolean; written: string[]; error?: string }> =>
    ipcRenderer.invoke("agent-config:restore-defaults"),

  // ── syllabus ──
  listSyllabi: (): Promise<SyllabusSummary[]> => ipcRenderer.invoke("syllabus:list"),
  getActiveSyllabus: (): Promise<SyllabusDetail | null> => ipcRenderer.invoke("syllabus:active"),
  getSyllabus: (syllabusId: number): Promise<SyllabusDetail | null> =>
    ipcRenderer.invoke("syllabus:get", syllabusId),
  parseSyllabus: (request: {
    filePath?: string;
    text?: string;
    fileName?: string;
    format?: ImportFormatHint;
    subject?: Subject;
    board?: string;
    level?: string;
    examDate?: string;
    title?: string;
    allowLlm?: boolean;
  }): Promise<ParseResult> => ipcRenderer.invoke("syllabus:parse", request),
  previewSyllabusImport: (request: {
    canonical: CanonicalSyllabus;
    format: ImportFormat;
    sourceFile?: string | null;
    syllabusId?: number | null;
    examDate?: string | null;
    title?: string | null;
  }): Promise<ImportPreview> => ipcRenderer.invoke("syllabus:previewImport", request),
  commitSyllabusImport: (request: {
    canonical: CanonicalSyllabus;
    format: ImportFormat;
    sourceFile?: string | null;
    syllabusId?: number | null;
    examDate?: string | null;
    title?: string | null;
  }): Promise<ImportCommitResult> => ipcRenderer.invoke("syllabus:commitImport", request),
  listSyllabusImports: (syllabusId?: number): Promise<SyllabusImportRow[]> =>
    ipcRenderer.invoke("syllabus:imports", syllabusId),
  rollbackSyllabusImport: (importId: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("syllabus:rollback", importId),
  getCoverage: (syllabusId?: number): Promise<CoverageReport | null> =>
    ipcRenderer.invoke("syllabus:coverage", syllabusId),
  setActiveSyllabus: (syllabusId: number, active?: boolean): Promise<boolean> =>
    ipcRenderer.invoke("syllabus:setActive", syllabusId, active ?? true),
  setTopicProgress: (
    topicId: number,
    patch: { status?: TopicStatus; valence?: Valence | null },
  ): Promise<boolean> => ipcRenderer.invoke("syllabus:setProgress", topicId, patch),
  updateTopic: (
    topicId: number,
    patch: { code?: string; title?: string; section?: string | null; estHours?: number | null },
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("syllabus:updateTopic", topicId, patch),
  createTopic: (
    syllabusId: number,
    topic: { code?: string; title: string; section?: string | null; estHours?: number | null },
  ): Promise<{ success: boolean; topicId?: number; error?: string }> =>
    ipcRenderer.invoke("syllabus:createTopic", syllabusId, topic),
  deleteTopic: (topicId: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke("syllabus:deleteTopic", topicId),
  restoreTopic: (topicId: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke("syllabus:restoreTopic", topicId),
  reorderTopic: (topicId: number, orderIndex: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke("syllabus:reorderTopic", topicId, orderIndex),
  deleteSyllabus: (syllabusId: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke("syllabus:deleteSyllabus", syllabusId),

  // ── notifications ──
  showNotification: (title: string, body: string): Promise<boolean> =>
    ipcRenderer.invoke("notification:show", title, body),
  onNotification: (callback: (payload: { title: string; body: string }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { title: string; body: string }) => callback(payload);
    ipcRenderer.on("notification", listener);
    return () => ipcRenderer.removeListener("notification", listener);
  },

  /**
   * Resolve a real filesystem path for a dragged or picked File.
   *
   * `File.path` was removed in Electron 32; this is the supported replacement and
   * lets us hand the main process a path instead of shipping file bytes over IPC.
   */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronApi = typeof api;
