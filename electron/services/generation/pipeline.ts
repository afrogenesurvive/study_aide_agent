import { executorFor, findTool, type StepStage, type ToolDef } from "./tools";

/**
 * The pipeline definition and the run plan derived from it.
 *
 * `agent-config/pipeline.json` is read at run time, so a user can disable a step
 * or reword a prompt without a code change. This module turns that JSON into a
 * typed plan; it does no I/O and never touches a database, so it is directly
 * unit-testable.
 */

export interface PipelineStep {
  id: string;
  toolName: string;
  label: string;
  description: string;
  systemPromptTemplate: string;
  hintTemplate: string;
  enabled: boolean;
  isTerminal: boolean;
}

export interface PipelineDefinition {
  name: string;
  label: string;
  description: string;
  steps: PipelineStep[];
}

export interface PipelineFile {
  maxPipelineSteps: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  llmContextWindow: number;
  terminalTools: string[];
  pipelines: PipelineDefinition[];
}

/** The pipeline phase 3 runs. */
export const MATERIAL_GENERATION = "material-generation";

/** Bounds mirroring `agent-config/schema.json`, applied when a value is absent. */
const LIMITS = {
  maxPipelineSteps: { min: 1, max: 40, fallback: 20 },
  maxRetries: { min: 0, max: 10, fallback: 3 },
  retryBaseDelayMs: { min: 250, max: 60_000, fallback: 4000 },
  llmContextWindow: { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 },
};

/**
 * Placeholders the app knows how to fill.
 *
 * Anything else is left verbatim in the rendered prompt (so a typo is visible
 * rather than silently blank) and reported by `resolveRunPlan`, because a prompt
 * that still contains `{{topicTitel}}` is a bug worth surfacing.
 */
export const KNOWN_PLACEHOLDERS = new Set([
  "topicCode",
  "topicTitle",
  "subject",
  "section",
  "overlayThemes",
  "maxCards",
  "questionCount",
  "topicList",
  "topicCount",
  "syllabusIds",
]);

// ── parsing ──────────────────────────────────────────────────────────────────

export function parsePipelineFile(raw: unknown): { file: PipelineFile; warnings: string[] } {
  const warnings: string[] = [];
  const file: PipelineFile = {
    maxPipelineSteps: LIMITS.maxPipelineSteps.fallback,
    maxRetries: LIMITS.maxRetries.fallback,
    retryBaseDelayMs: LIMITS.retryBaseDelayMs.fallback,
    llmContextWindow: LIMITS.llmContextWindow.fallback,
    terminalTools: [],
    pipelines: [],
  };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { file, warnings: ["Pipeline file is not a JSON object."] };
  }

  const source = raw as Record<string, unknown>;
  file.maxPipelineSteps = bounded(source.max_pipeline_steps, LIMITS.maxPipelineSteps, warnings, "max_pipeline_steps");
  file.maxRetries = bounded(source.max_retries, LIMITS.maxRetries, warnings, "max_retries");
  file.retryBaseDelayMs = bounded(source.retry_base_delay_ms, LIMITS.retryBaseDelayMs, warnings, "retry_base_delay_ms");
  file.llmContextWindow = bounded(source.llm_context_window, LIMITS.llmContextWindow, warnings, "llm_context_window");

  if (Array.isArray(source.terminal_tools)) {
    file.terminalTools = source.terminal_tools.filter((name): name is string => typeof name === "string");
  }

  if (!Array.isArray(source.pipelines)) {
    warnings.push("Pipeline file has no `pipelines` array.");
    return { file, warnings };
  }

  for (const entry of source.pipelines) {
    const pipeline = parsePipeline(entry, warnings);
    if (pipeline) file.pipelines.push(pipeline);
  }

  return { file, warnings };
}

function parsePipeline(raw: unknown, warnings: string[]): PipelineDefinition | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") {
    warnings.push("A pipeline entry is not an object.");
    return null;
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) {
    warnings.push("A pipeline entry has no name and was skipped.");
    return null;
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    warnings.push(`Pipeline "${name}" has no steps and was skipped.`);
    return null;
  }

  const steps: PipelineStep[] = [];
  for (const [index, rawStep] of value.steps.entries()) {
    const step = rawStep as Record<string, unknown> | null;
    if (!step || typeof step !== "object") {
      warnings.push(`Pipeline "${name}" step #${index} is not an object.`);
      continue;
    }
    const toolName = typeof step.toolName === "string" ? step.toolName.trim() : "";
    if (!toolName) {
      warnings.push(`Pipeline "${name}" step #${index} has no toolName.`);
      continue;
    }
    steps.push({
      id: typeof step.id === "string" ? step.id : `step-${index}`,
      toolName,
      label: typeof step.label === "string" ? step.label : toolName,
      description: typeof step.description === "string" ? step.description : "",
      systemPromptTemplate:
        typeof step.systemPromptTemplate === "string" ? step.systemPromptTemplate : "",
      hintTemplate: typeof step.hintTemplate === "string" ? step.hintTemplate : "",
      // Default to enabled: a missing flag should not silently drop a step.
      enabled: step.enabled !== false,
      isTerminal: step.isTerminal === true,
    });
  }

  return {
    name,
    label: typeof value.label === "string" ? value.label : name,
    description: typeof value.description === "string" ? value.description : "",
    steps,
  };
}

export function selectPipeline(file: PipelineFile, name: string): PipelineDefinition | null {
  return file.pipelines.find((pipeline) => pipeline.name === name) ?? null;
}

// ── the run plan ─────────────────────────────────────────────────────────────

export interface ResolvedStep extends PipelineStep {
  /** 1-based position in the executed plan. */
  index: number;
  executor: "child" | "main";
  stage: StepStage;
  available: boolean;
}

export interface RunPlan {
  pipeline: string;
  label: string;
  steps: ResolvedStep[];
  /** Main-process reads that build the job input. */
  pre: ResolvedStep[];
  /** Model calls, executed by the child process. */
  work: ResolvedStep[];
  /** The review gate, if the pipeline declares one. */
  gate: ResolvedStep | null;
  /** The write, executed in the main process after approval. */
  commit: ResolvedStep | null;
  errors: string[];
  warnings: string[];
  ok: boolean;
}

/**
 * Turn a pipeline definition into an executable plan.
 *
 * `errors` mean the run cannot start; `warnings` mean it will start but the user
 * should know something is off (a disabled step, a template typo, a pipeline
 * with no review gate). Callers require the stages they actually need — this
 * function does not assume it is looking at material generation.
 */
export function resolveRunPlan(
  pipeline: PipelineDefinition,
  tools: ToolDef[],
  options: { maxSteps?: number } = {},
): RunPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const steps: ResolvedStep[] = [];

  const enabled = pipeline.steps.filter((step) => step.enabled);
  const disabledCount = pipeline.steps.length - enabled.length;
  if (disabledCount > 0) {
    warnings.push(`${disabledCount} step(s) are disabled in the pipeline config and will not run.`);
  }

  const maxSteps = Math.max(1, options.maxSteps ?? enabled.length);
  if (enabled.length > maxSteps) {
    warnings.push(
      `Pipeline has ${enabled.length} steps but max_pipeline_steps is ${maxSteps}; the rest were dropped.`,
    );
  }

  const seenIds = new Set<string>();
  for (const step of enabled.slice(0, maxSteps)) {
    if (seenIds.has(step.id)) {
      errors.push(`Duplicate step id "${step.id}" — step ids must be unique.`);
      continue;
    }
    seenIds.add(step.id);

    const tool = findTool(tools, step.toolName);
    if (!tool) {
      errors.push(
        `Step "${step.id}" uses tool "${step.toolName}", which is not defined in agent-config/tools.json.`,
      );
      continue;
    }

    const executor = executorFor(step.toolName);
    if (!executor) {
      errors.push(`Step "${step.id}" uses tool "${step.toolName}", which has no registered executor.`);
      continue;
    }

    if (!executor.available) {
      warnings.push(
        `Tool "${step.toolName}" is not implemented yet${executor.note ? ` (${executor.note})` : ""} — this run will fail at that step.`,
      );
    }

    // A terminal step performs an irreversible side effect, so it must sit
    // behind the gate. Flag it when the pipeline declares one without the other.
    if (tool.terminal && !pipeline.steps.some((other) => other.enabled && other.toolName === "review_gate")) {
      warnings.push(
        `Step "${step.id}" calls terminal tool "${step.toolName}" with no review gate in this pipeline.`,
      );
    }

    for (const placeholder of findPlaceholders(`${step.systemPromptTemplate} ${step.hintTemplate}`)) {
      if (!KNOWN_PLACEHOLDERS.has(placeholder)) {
        warnings.push(`Step "${step.id}" uses unknown placeholder "{{${placeholder}}}".`);
      }
    }

    steps.push({
      ...step,
      index: steps.length + 1,
      executor: executor.executor,
      stage: executor.stage,
      available: executor.available,
    });
  }

  if (steps.length === 0) errors.push("No runnable steps — nothing would happen.");

  const byStage = (stage: StepStage) => steps.filter((step) => step.stage === stage);

  return {
    pipeline: pipeline.name,
    label: pipeline.label,
    steps,
    pre: byStage("pre"),
    work: byStage("work"),
    gate: byStage("gate")[0] ?? null,
    commit: byStage("commit")[0] ?? null,
    errors,
    warnings,
    ok: errors.length === 0,
  };
}

// ── templates ────────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export type PlaceholderVars = Record<string, string | number | null | undefined>;

/**
 * Fill `{{name}}` placeholders.
 *
 * An unknown placeholder is left in the text rather than replaced with an empty
 * string: a prompt that still reads `{{topicTitel}}` is obviously broken, whereas
 * a silently blanked one is not.
 */
export function interpolate(template: string, vars: PlaceholderVars): string {
  if (!template) return "";
  return String(template).replace(PLACEHOLDER, (match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}

export function findPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const match of String(template ?? "").matchAll(PLACEHOLDER)) found.add(match[1]);
  return [...found];
}

function bounded(
  value: unknown,
  limits: { min: number; max: number; fallback: number },
  warnings: string[],
  label: string,
): number {
  if (value === undefined || value === null) return limits.fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < limits.min || parsed > limits.max) {
    warnings.push(`${label} must be between ${limits.min} and ${limits.max}; using ${limits.fallback}.`);
    return limits.fallback;
  }
  return Math.floor(parsed);
}
