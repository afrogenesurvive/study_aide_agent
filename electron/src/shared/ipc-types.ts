/**
 * Types shared by the main process, the service layer and the renderer.
 * Lives under `src/shared` so both tsconfigs (main + renderer) pick it up.
 */

export type ConfigValueSource = "user_config" | "environment" | "default";

export interface ConfigValueInfo {
  value: string;
  source: ConfigValueSource;
  /** True when the value is scrubbed before crossing the IPC boundary. */
  secret: boolean;
}

/** The config is a flat string map so it can round-trip through .env and config.json. */
export type AppConfig = Record<string, string>;

export interface ConfigSourcesPayload {
  values: Record<string, ConfigValueInfo>;
  configPath: string;
  defaultsPath: string;
  count: number;
}

export interface ConfigCheckResult {
  ok: boolean;
  missing: string[];
  warnings: string[];
  /** Provider/key pair that would block the first LLM call, if any. */
  activeProvider: string;
}

export interface ConfigFileResult {
  success: boolean;
  error?: string;
  filePath?: string;
  count?: number;
}

export type LogSource =
  | "main"
  | "renderer"
  | "db"
  | "syllabus"
  | "llm"
  | "mcp"
  | "review"
  | "scheduler";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: number;
  source: LogSource;
  subSource?: string;
  level: LogLevel;
  message: string;
}

export interface StorageUsage {
  userData: string;
  logsDir: string;
  dbPath: string;
  dbBytes: number;
  logBytes: number;
  configPath: string;
}

export interface DbStatus {
  ok: boolean;
  path: string;
  sizeBytes: number;
  schemaVersion: number;
  tableCount: number;
  journalMode: string;
  error?: string;
}

export interface BackupResult {
  success: boolean;
  filePath?: string;
  bytes?: number;
  error?: string;
}

export interface AgentConfigFilePayload {
  name: "pipeline" | "tools" | "system-prompt";
  content: string;
  exists: boolean;
  valid: boolean;
  errors: string[];
}

export interface AgentConfigPayload {
  dir: string;
  files: AgentConfigFilePayload[];
}

export interface LlmUsageSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  lastCallAt: number | null;
  byModel: Array<{ model: string; provider: string; calls: number; totalTokens: number }>;
}

export interface MenuCommand {
  id: string;
  label: string;
}
