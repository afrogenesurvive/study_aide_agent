import fs from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { addLog } from "../logger";
import { getConfig } from "../config";
import { getDb } from "../../../services/database";
import { parseSyllabus } from "../../../services/syllabus/parsers";
import { buildCoverage } from "../../../services/syllabus/coverage";
import { applyImport, previewImport, rollbackImport } from "../../../services/syllabus/import";
import * as repo from "../../../services/syllabus/repo";
import type {
  CanonicalSyllabus,
  ImportFormat,
  ImportFormatHint,
  ParseResult,
  Subject,
  SyllabusDetail,
  TopicStatus,
  Valence,
} from "../../shared/syllabus-types";

/** Syllabus channels: list/detail, import (parse → preview → commit → rollback), coverage, editing. */

const TEXT_EXTENSIONS = new Set(["json", "csv", "tsv", "md", "markdown", "txt"]);

interface ParseRequest {
  /** Absolute path from a file picker or drop. Bytes never cross the IPC boundary. */
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
}

interface CommitRequest {
  canonical: CanonicalSyllabus;
  format: ImportFormat;
  sourceFile?: string | null;
  syllabusId?: number | null;
  examDate?: string | null;
  title?: string | null;
}

function fail(error: string) {
  addLog("syllabus", "warn", error);
  return { success: false, error };
}

export function registerSyllabusIpc(): void {
  ipcMain.handle("syllabus:list", () => repo.listSyllabi(getDb()));

  ipcMain.handle("syllabus:active", (): SyllabusDetail | null => {
    const db = getDb();
    const configured = Number(getConfig().SYLLABUS_ACTIVE_ID || 0) || null;
    const syllabus = repo.getActiveSyllabus(db, configured);
    if (!syllabus) return null;
    return { syllabus, topics: repo.getTopics(db, syllabus.id) };
  });

  ipcMain.handle("syllabus:get", (_event, syllabusId: number): SyllabusDetail | null => {
    const db = getDb();
    const syllabus = repo.getSyllabus(db, Number(syllabusId));
    if (!syllabus) return null;
    return { syllabus, topics: repo.getTopics(db, syllabus.id) };
  });

  ipcMain.handle("syllabus:parse", async (_event, request: ParseRequest): Promise<ParseResult> => {
    const loaded = loadSource(request);
    if (loaded.error) {
      return { ok: false, canonical: null, format: "text", warnings: [], error: loaded.error, usedLlm: false };
    }

    const result = await parseSyllabus(
      {
        text: loaded.text,
        bytes: loaded.bytes,
        fileName: loaded.fileName,
        format: request.format,
      },
      {
        subject: request.subject ?? null,
        board: request.board,
        level: request.level,
        examDate: request.examDate,
        title: request.title,
        allowLlm: request.allowLlm,
      },
    );

    addLog(
      "syllabus",
      result.ok ? "info" : "warn",
      result.ok
        ? `Parsed ${result.canonical?.topics.length ?? 0} topics from ${result.format}${result.usedLlm ? " (LLM-assisted)" : ""}`
        : `Parse failed: ${result.error ?? "unknown error"}`,
    );
    return result;
  });

  ipcMain.handle("syllabus:previewImport", (_event, request: CommitRequest) => {
    const db = getDb();
    return previewImport(db, {
      canonical: request.canonical,
      format: request.format,
      sourceFile: request.sourceFile ?? null,
      syllabusId: request.syllabusId ?? null,
      examDate: request.examDate ?? null,
      title: request.title ?? null,
    });
  });

  ipcMain.handle("syllabus:commitImport", (_event, request: CommitRequest) => {
    const db = getDb();
    const result = applyImport(db, {
      canonical: request.canonical,
      format: request.format,
      sourceFile: request.sourceFile ?? null,
      syllabusId: request.syllabusId ?? null,
      examDate: request.examDate ?? null,
      title: request.title ?? null,
    });
    if (result.success) {
      const counts = result.diff?.counts;
      addLog(
        "syllabus",
        "info",
        `Import applied to syllabus ${result.syllabusId}: ${counts?.added ?? 0} added, ${counts?.changed ?? 0} updated, ${counts?.removed ?? 0} archived, ${counts?.unchanged ?? 0} unchanged`,
      );
    } else {
      addLog("syllabus", "error", `Import failed: ${result.error ?? "unknown error"}`);
    }
    return result;
  });

  ipcMain.handle("syllabus:imports", (_event, syllabusId?: number) =>
    repo.listImports(getDb(), syllabusId ? Number(syllabusId) : undefined),
  );

  ipcMain.handle("syllabus:rollback", (_event, importId: number) => {
    const result = rollbackImport(getDb(), Number(importId));
    addLog(
      "syllabus",
      result.success ? "info" : "error",
      result.success ? `Rolled back import ${importId}` : `Rollback failed: ${result.error}`,
    );
    return result;
  });

  ipcMain.handle("syllabus:coverage", (_event, syllabusId?: number) => {
    const db = getDb();
    const configured = Number(getConfig().SYLLABUS_ACTIVE_ID || 0) || null;
    const syllabus = syllabusId
      ? repo.getSyllabus(db, Number(syllabusId))
      : repo.getActiveSyllabus(db, configured);
    if (!syllabus) return null;
    return buildCoverage(syllabus, repo.getTopics(db, syllabus.id, { includeArchived: true }));
  });

  ipcMain.handle("syllabus:setActive", (_event, syllabusId: number, active: boolean) => {
    repo.setActiveSyllabus(getDb(), Number(syllabusId), active !== false);
    return true;
  });

  ipcMain.handle(
    "syllabus:setProgress",
    (_event, topicId: number, patch: { status?: TopicStatus; valence?: Valence | null }) => {
      repo.updateTopicProgress(getDb(), Number(topicId), patch ?? {});
      return true;
    },
  );

  ipcMain.handle(
    "syllabus:updateTopic",
    (
      _event,
      topicId: number,
      patch: {
        code?: string;
        title?: string;
        section?: string | null;
        estHours?: number | null;
        /** `null` detaches the topic from its parent. */
        parentId?: number | null;
      },
    ) => {
      const db = getDb();
      const id = Number(topicId);
      const existing = repo.getTopic(db, id);
      if (!existing) return fail("That topic no longer exists.");
      try {
        repo.updateTopicFields(db, id, patch ?? {});
        return { success: true };
      } catch (err) {
        return fail(
          `Could not save the topic (${err instanceof Error ? err.message : String(err)}). Codes must be unique within a syllabus.`,
        );
      }
    },
  );

  ipcMain.handle(
    "syllabus:createTopic",
    (
      _event,
      syllabusId: number,
      topic: { code: string; title: string; section?: string | null; estHours?: number | null },
    ) => {
      const db = getDb();
      const id = Number(syllabusId);
      if (!repo.getSyllabus(db, id)) return fail("That syllabus no longer exists.");
      if (!topic?.title?.trim()) return fail("A topic needs a title.");
      try {
        const code = topic.code?.trim() || topic.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const topicId = repo.upsertTopic(db, id, {
          code,
          title: topic.title.trim(),
          section: topic.section ?? null,
          orderIndex: repo.nextOrderIndex(db, id),
          estHours: topic.estHours ?? null,
        });
        return { success: true, topicId };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  ipcMain.handle("syllabus:deleteTopic", (_event, topicId: number) => {
    // Archiving, not deleting: review history may already reference this topic.
    repo.archiveTopic(getDb(), Number(topicId));
    return { success: true };
  });

  ipcMain.handle("syllabus:restoreTopic", (_event, topicId: number) => {
    repo.restoreTopic(getDb(), Number(topicId));
    return { success: true };
  });

  ipcMain.handle("syllabus:reorderTopic", (_event, topicId: number, orderIndex: number) => {
    repo.reorderTopic(getDb(), Number(topicId), Number(orderIndex));
    return { success: true };
  });

  ipcMain.handle("syllabus:deleteSyllabus", (_event, syllabusId: number) => {
    repo.deleteSyllabus(getDb(), Number(syllabusId));
    addLog("syllabus", "warn", `Deleted syllabus ${syllabusId} and all of its topics.`);
    return { success: true };
  });
}

interface LoadedSource {
  text?: string;
  bytes?: Uint8Array;
  fileName?: string;
  error?: string;
}

/**
 * Read an import source. Files are read here rather than in the renderer so
 * multi-megabyte PDFs never cross the IPC boundary.
 */
function loadSource(request: ParseRequest): LoadedSource {
  if (request.text !== undefined && request.text !== null) {
    return { text: String(request.text), fileName: request.fileName };
  }
  if (!request.filePath) {
    return { error: "Nothing to import — choose a file or paste some text." };
  }

  const filePath = path.resolve(String(request.filePath));
  const fileName = path.basename(filePath);
  const extension = fileName.toLowerCase().split(".").pop() ?? "";

  try {
    if (TEXT_EXTENSIONS.has(extension)) {
      return { text: fs.readFileSync(filePath, "utf8"), fileName };
    }
    return { bytes: new Uint8Array(fs.readFileSync(filePath)), fileName };
  } catch (err) {
    return { error: `Could not read ${fileName}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
