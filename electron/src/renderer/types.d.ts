import type {
  AgentConfigPayload,
  AppConfig,
  BackupResult,
  ConfigCheckResult,
  ConfigFileResult,
  ConfigSourcesPayload,
  DbStatus,
  LlmUsageSummary,
  LogEntry,
  LogLevel,
  StorageUsage,
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
import type {
  CardInput,
  CardPatch,
  CardReviewRow,
  DueCard,
  DueSummary,
  GradeResult,
  Rating,
  RatingPreview,
  ReviewFilter,
  ReviewStats,
  SubjectDue,
  TopicCardCount,
  UndoResult,
} from "../shared/review-types";
import type {
  PlanRequest,
  PlanSnapshot,
  ResolvedTheme,
  SessionCompleteInput,
  SessionStartResult,
  SessionSummary,
  StreakInfo,
  StudySessionRow,
  TodaySummary,
} from "../shared/scheduler-types";

/**
 * Hand-maintained mirror of `src/main/preload.ts`.
 *
 * Kept in sync by hand rather than derived, so the renderer does not have to
 * type-check against Electron's types. Optional (`electronAPI?`) so the UI still
 * renders in a plain browser during `vite dev` without the preload present.
 */

export interface ElectronAPI {
  platform: string;

  getVersion(): Promise<string>;
  getName(): Promise<string>;
  getPaths(): Promise<{
    userData: string;
    logs: string;
    appPath: string;
    isPackaged: boolean;
    platform: string;
  }>;
  getInfo(): Promise<{ version: string; recordCounts: Record<string, number> }>;
  log(level: LogLevel, message: string, subSource?: string): Promise<boolean>;
  openExternal(url: string): Promise<{ success: boolean; error?: string }>;
  openPath(target: string): Promise<{ success: boolean; error?: string }>;
  showItemInFolder(target: string): Promise<boolean>;
  quitApp(): Promise<boolean>;
  relaunch(): Promise<boolean>;

  getConfig(): Promise<AppConfig>;
  getConfigWithSources(): Promise<ConfigSourcesPayload>;
  checkConfig(): Promise<ConfigCheckResult>;
  saveConfig(values: Record<string, unknown>): Promise<ConfigFileResult>;
  clearConfig(): Promise<ConfigFileResult>;
  exportConfig(): Promise<string>;
  importConfig(raw: string): Promise<ConfigFileResult>;
  restoreConfigDefaults(): Promise<ConfigFileResult>;

  getUiState(): Promise<Record<string, unknown>>;
  saveUiState(state: Record<string, unknown>): Promise<boolean>;

  getLogs(limit?: number): Promise<LogEntry[]>;
  clearLogs(): Promise<boolean>;
  getLogInfo(): Promise<{ dir: string; file: string | null; level: LogLevel }>;
  setLogLevel(level: LogLevel): Promise<LogLevel>;
  onLog(callback: (entry: LogEntry) => void): () => void;

  getStorageUsage(): Promise<StorageUsage>;
  getDbStatus(): Promise<DbStatus>;
  getDbTables(): Promise<string[]>;
  backupDb(): Promise<BackupResult>;

  getUsageSummary(): Promise<LlmUsageSummary>;
  clearUsage(): Promise<number>;

  getAgentConfig(): Promise<AgentConfigPayload>;
  saveAgentConfig(
    name: "pipeline" | "tools" | "system-prompt",
    content: string,
  ): Promise<{ success: boolean; errors: string[]; error?: string }>;
  restoreAgentConfigDefaults(): Promise<{ success: boolean; written: string[]; error?: string }>;

  listSyllabi(): Promise<SyllabusSummary[]>;
  getActiveSyllabus(): Promise<SyllabusDetail | null>;
  getSyllabus(syllabusId: number): Promise<SyllabusDetail | null>;
  parseSyllabus(request: {
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
  }): Promise<ParseResult>;
  previewSyllabusImport(request: {
    canonical: CanonicalSyllabus;
    format: ImportFormat;
    sourceFile?: string | null;
    syllabusId?: number | null;
    examDate?: string | null;
    title?: string | null;
  }): Promise<ImportPreview>;
  commitSyllabusImport(request: {
    canonical: CanonicalSyllabus;
    format: ImportFormat;
    sourceFile?: string | null;
    syllabusId?: number | null;
    examDate?: string | null;
    title?: string | null;
  }): Promise<ImportCommitResult>;
  listSyllabusImports(syllabusId?: number): Promise<SyllabusImportRow[]>;
  rollbackSyllabusImport(importId: number): Promise<{ success: boolean; error?: string }>;
  getCoverage(syllabusId?: number): Promise<CoverageReport | null>;
  setActiveSyllabus(syllabusId: number, active?: boolean): Promise<boolean>;
  setTopicProgress(
    topicId: number,
    patch: { status?: TopicStatus; valence?: Valence | null },
  ): Promise<boolean>;
  updateTopic(
    topicId: number,
    patch: {
      code?: string;
      title?: string;
      section?: string | null;
      estHours?: number | null;
      parentId?: number | null;
    },
  ): Promise<{ success: boolean; error?: string }>;
  createTopic(
    syllabusId: number,
    topic: { code?: string; title: string; section?: string | null; estHours?: number | null },
  ): Promise<{ success: boolean; topicId?: number; error?: string }>;
  deleteTopic(topicId: number): Promise<{ success: boolean }>;
  restoreTopic(topicId: number): Promise<{ success: boolean }>;
  reorderTopic(topicId: number, orderIndex: number): Promise<{ success: boolean }>;
  deleteSyllabus(syllabusId: number): Promise<{ success: boolean }>;

  getReviewSummary(): Promise<DueSummary>;
  getDueBySubject(): Promise<SubjectDue[]>;
  getReviewQueue(filter?: ReviewFilter): Promise<DueCard[]>;
  getReviewStats(filter?: ReviewFilter): Promise<ReviewStats>;
  listCards(filter?: ReviewFilter): Promise<DueCard[]>;
  getCard(cardId: number): Promise<DueCard | null>;
  previewCard(cardId: number): Promise<RatingPreview[] | null>;
  rateCard(request: {
    cardId: number;
    rating: Rating;
    sessionId?: number | null;
    durationMs?: number | null;
  }): Promise<GradeResult>;
  undoReview(cardId: number): Promise<UndoResult>;
  createCard(input: CardInput): Promise<{ success: boolean; cardId?: number; error?: string }>;
  updateCard(cardId: number, patch: CardPatch): Promise<{ success: boolean; error?: string }>;
  archiveCard(cardId: number, archived?: boolean): Promise<{ success: boolean }>;
  setCardValence(cardId: number, valence: Valence | null): Promise<{ success: boolean }>;
  deleteCard(cardId: number): Promise<{ success: boolean }>;
  getCardHistory(cardId: number, limit?: number): Promise<CardReviewRow[]>;
  getTopicCardCounts(syllabusId?: number): Promise<TopicCardCount[]>;

  getThemes(syllabusId?: number): Promise<ResolvedTheme[]>;
  getTheme(theme: string, syllabusId?: number): Promise<ResolvedTheme | null>;
  getThemesForTopic(topicId: number, syllabusId?: number): Promise<ResolvedTheme[]>;
  getPlan(request?: PlanRequest): Promise<PlanSnapshot>;
  regeneratePlan(request?: PlanRequest): Promise<PlanSnapshot>;
  completePlan(planId: number, completed?: boolean): Promise<boolean>;
  getToday(): Promise<TodaySummary>;
  getStreak(): Promise<StreakInfo>;

  startSession(theme?: string | null): Promise<SessionStartResult>;
  completeSession(input: SessionCompleteInput): Promise<SessionSummary>;
  listSessions(limit?: number): Promise<StudySessionRow[]>;
  getSession(sessionId: number): Promise<StudySessionRow | null>;
  getSessionReviews(sessionId: number): Promise<CardReviewRow[]>;
  getSessionReviewCount(sessionId: number): Promise<number>;

  showNotification(title: string, body: string): Promise<boolean>;
  onNotification(callback: (payload: { title: string; body: string }) => void): () => void;

  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
