import { ipcMain } from "electron";

import { getDb } from "../../../services/database";
import { checkConfigValues } from "../../shared/config-defaults";
import {
  cancelGeneration,
  commitGeneration,
  discardGeneration,
  getJob,
  getJobInput,
  getJobOutput,
  listJobs,
  listPendingReview,
  MATERIAL_GENERATION,
  prepareGeneration,
  rejectGeneration,
  startGeneration,
  toSummary,
  validateAgentConfig,
} from "../../../services/generation";
import { describeProvider } from "../../../services/llm/provider";
import { applyCost } from "../../../services/llm/pricing";
import { recordUsage } from "../../../services/llm/usage";
import { themesForTopicCodes } from "../../../services/scheduler/overlay";
import { getTopics, listSyllabi } from "../../../services/syllabus/repo";
import { loadPipelineFile, loadSystemPrompt, loadToolDefinitions } from "../agent-config";
import { getConfig } from "../config";
import { addLog } from "../logger";
import { getPricingTable } from "../pricing";
import { initRunner, tryGetRunner } from "../runner";
import type {
  GenerationJobDetail,
  GenerationOutput,
  GenerationProgress,
  GenerationRequest,
  GenerationRunOutcome,
  GenerationStatusPayload,
  GenerationTopicOption,
} from "../../shared/generation-types";
import type { SyllabusSummary } from "../../shared/syllabus-types";

/**
 * Generation channels: what a run needs, running one, and answering its gate.
 *
 * The service layer does the work; this file is the boundary. Three rules it
 * follows:
 *
 *  - the config and the agent-config files are read *here*, at the edge, and
 *    passed down — no service reaches for a file or a global
 *  - the one place LLM cost is priced is the `onUsage` hook below, so a run's
 *    spend lands in `llm_usage` exactly as a non-run call would
 *  - every refusal comes back as data (`{ok:false, errors}`), not as a throw:
 *    "no API key" is an answer the panel has to render, not a crash
 */

/** Set by the main entry point once a window exists, mirroring the log bridge. */
let progressSink: ((progress: GenerationProgress) => void) | null = null;

export function setGenerationProgressSink(sink: ((progress: GenerationProgress) => void) | null): void {
  progressSink = sink;
}

function fail(error: string) {
  addLog("generate", "warn", error);
  return { success: false as const, error };
}

function refusal(errors: string[], warnings: string[] = []): GenerationRunOutcome {
  for (const error of errors) addLog("generate", "warn", error);
  return { ok: false, jobId: null, status: null, cards: 0, questions: 0, warnings, errors };
}

/**
 * Fall back to the active syllabus when the caller named none.
 *
 * Same idiom as `review:topicCounts`: an empty list means "the user has not
 * chosen yet", so the configured default is the best available answer, and an
 * untouched install with no syllabus still gets the honest "choose one" error
 * rather than a confusing empty scope.
 */
function withActiveSyllabus(request: GenerationRequest): GenerationRequest {
  const ids = Array.isArray(request?.syllabusIds) ? request.syllabusIds : [];
  if (ids.length > 0) return { ...request, syllabusIds: ids };

  const configured = Number(getConfig().SYLLABUS_ACTIVE_ID || 0) || null;
  return { ...request, syllabusIds: configured ? [configured] : [] };
}

/** Coerce whatever crossed the boundary into the shape the commit expects. */
function outputOf(raw: GenerationOutput | null | undefined): GenerationOutput {
  return {
    cards: Array.isArray(raw?.cards) ? raw.cards : [],
    questions: Array.isArray(raw?.questions) ? raw.questions : [],
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.filter((w) => typeof w === "string") : [],
  };
}

export function registerGenerationIpc(): void {
  ipcMain.handle("generation:status", async (): Promise<GenerationStatusPayload> => {
    const db = getDb();
    const config = getConfig();
    const provider = await describeProvider();

    const pipeline = loadPipelineFile();
    const tools = loadToolDefinitions();
    const validation = pipeline.file
      ? validateAgentConfig({
          file: pipeline.file,
          tools: tools.tools,
          addedTools: tools.added,
        })
      : {
          ok: false,
          errors: ["agent-config/pipeline.json could not be read."],
          warnings: [] as string[],
          runnable: [] as string[],
        };

    const runner = tryGetRunner();
    const configCheck = checkConfigValues(config);
    return {
      enabled: String(config.AGENT_RUNNER_ENABLED ?? "").trim().toLowerCase() === "true",
      provider: provider.provider,
      model: provider.model,
      ready: configCheck.ok,
      missing: configCheck.missing,
      configOk: validation.runnable.includes(MATERIAL_GENERATION),
      configErrors: validation.errors,
      configWarnings: [
        ...pipeline.warnings,
        ...tools.warnings,
        ...validation.warnings,
      ],
      running: runner?.isRunning() ?? false,
      activeJobId: runner?.activeJobId() ?? null,
      awaitingReview: listPendingReview(db).length,
    };
  });

  ipcMain.handle("generation:syllabi", (): SyllabusSummary[] => listSyllabi(getDb()));

  ipcMain.handle("generation:topics", (_event, syllabusId: number): GenerationTopicOption[] =>
    getTopics(getDb(), Number(syllabusId)).map((topic) => ({
      id: topic.id,
      code: topic.code,
      title: topic.title,
      section: topic.section,
      status: topic.status,
      themes: themesForTopicCodes(getDb(), [topic.code]),
    })),
  );

  ipcMain.handle(
    "generation:start",
    async (_event, request: GenerationRequest): Promise<GenerationRunOutcome> => {
      const db = getDb();

      try {
        const pipeline = loadPipelineFile();
        if (!pipeline.file) {
          return refusal(
            pipeline.warnings.length
              ? pipeline.warnings
              : ["agent-config/pipeline.json could not be read."],
          );
        }

        const tools = loadToolDefinitions();
        const prompt = loadSystemPrompt();
        const scoped = withActiveSyllabus(request);

        const prepared = prepareGeneration(db, {
          request: scoped,
          file: pipeline.file,
          tools: tools.tools,
          systemPrompt: prompt.text,
        });

        if (!prepared.ok || !prepared.plan) {
          return refusal(prepared.errors, prepared.warnings);
        }

        // Created here rather than at boot so a crash inside the runner setup
        // cannot take the app down before a window exists.
        const runner = tryGetRunner() ?? initRunner();

        return await startGeneration(
          db,
          runner,
          {
            request: scoped,
            config: getConfig(),
            plan: prepared.plan,
            topics: prepared.topics,
            systemPrompt: prompt.text,
          },
          {
            onProgress: (progress) => progressSink?.(progress),
            onUsage: (record) => {
              try {
                recordUsage(db, applyCost(record, getPricingTable()));
              } catch (error) {
                addLog("generate", "warn", `Could not record LLM usage: ${(error as Error).message}`);
              }
            },
            log: (level, message) => addLog("generate", level, message),
          },
        );
      } catch (error) {
        return refusal([(error as Error).message || "The run could not be started."]);
      }
    },
  );

  ipcMain.handle("generation:cancel", (_event, jobId: number) => {
    const runner = tryGetRunner();
    if (!runner) return fail("No agent runner is running.");
    return cancelGeneration(getDb(), runner, Number(jobId));
  });

  ipcMain.handle("generation:job", (_event, jobId: number): GenerationJobDetail | null => {
    const db = getDb();
    const id = Number(jobId);
    const row = getJob(db, id);
    if (!row) return null;

    return {
      summary: toSummary(row),
      input: getJobInput(db, id),
      output: getJobOutput(db, id) ?? { cards: [], questions: [], warnings: [] },
    };
  });

  ipcMain.handle("generation:commit", (_event, jobId: number, output: GenerationOutput) => {
    const result = commitGeneration(getDb(), Number(jobId), outputOf(output));
    if (!result.success && result.error) addLog("generate", "warn", result.error);
    return result;
  });

  ipcMain.handle("generation:reject", (_event, jobId: number) =>
    rejectGeneration(getDb(), Number(jobId)),
  );

  ipcMain.handle("generation:discard", (_event, jobId: number) =>
    discardGeneration(getDb(), Number(jobId)),
  );

  ipcMain.handle("generation:history", () => listJobs(getDb()).map(toSummary));
}
