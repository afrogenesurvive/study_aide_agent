import fs from "node:fs";
import path from "node:path";

import {
  MATERIAL_GENERATION,
  resolveRunPlan,
  selectPipeline,
  parsePipelineFile,
} from "../../services/generation/pipeline";
import { parseToolList, type ToolDef } from "../../services/generation/tools";
import { DEFAULTS } from "../../src/shared/config-defaults";
import type { AppConfig } from "../../src/shared/ipc-types";
import type { PipelineFile, RunPlan } from "../../services/generation/pipeline";
import type { GenerationTopicInput } from "../../src/shared/generation-types";

/**
 * Fixtures for the orchestration suites.
 *
 * The pipeline and tool files are read from the committed `agent-config/`
 * templates rather than hand-written: they are shipped content, and a test that
 * builds its own copy would pass while the app was unable to run at all.
 */

function readTemplate(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "..", "agent-config", name), "utf8"));
}

export const PIPELINE_FILE: PipelineFile = parsePipelineFile(readTemplate("pipeline.template.json")).file;
export const TOOLS: ToolDef[] = parseToolList(readTemplate("tools.template.json")).tools;

/** The shipped material-generation plan, resolved against the shipped tools. */
export function materialPlan(): RunPlan {
  const pipeline = selectPipeline(PIPELINE_FILE, MATERIAL_GENERATION);
  if (!pipeline) throw new Error("The shipped pipeline template has no material-generation pipeline.");
  return resolveRunPlan(pipeline, TOOLS, { maxSteps: PIPELINE_FILE.maxPipelineSteps });
}

/** An effective config with a key set, so the provider check passes. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return {
    ...DEFAULTS,
    LLM_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-key",
    ...overrides,
  };
}

export const TOPICS: GenerationTopicInput[] = [
  {
    topicId: 1,
    code: "1.1",
    title: "Atomic structure",
    subject: "chemistry",
    section: "Section 1",
    syllabusId: 1,
    themes: [],
  },
];

export const SYSTEM_PROMPT = "Ground rules for generated material.";
