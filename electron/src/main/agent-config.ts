import fs from "node:fs";
import path from "node:path";
import { Validator } from "@cfworker/json-schema";
import { addLog } from "./logger";
import { agentConfigDefaultsDir, agentConfigDir, resourcePath } from "./paths";
import { APP_VERSION } from "./config";
import { parsePipelineFile, type PipelineFile } from "../../services/generation/pipeline";
import { mergeToolLists, parseToolList, type ToolDef } from "../../services/generation/tools";
import type { AgentConfigFilePayload, AgentConfigPayload } from "../shared/ipc-types";

/**
 * Agent configuration (pipeline / tools / system prompt).
 *
 * Three-layer pattern mirroring the app config:
 *   - repo  `agent-config/*.template.*`  ← committed, shipped read-only
 *   - live  `<userData>/agent-config/*.json|*.md` ← user-editable, gitignored
 *   - snap  `<userData>/agent-config/.defaults/`  ← restore target
 *
 * Phase 3 consumes these: `loadToolDefinitions()` and `loadPipelineFile()` are
 * what the agent runner plans from.
 */

export type AgentConfigName = "pipeline" | "tools" | "system-prompt";

interface FileSpec {
  name: AgentConfigName;
  live: string;
  template: string;
  kind: "json" | "markdown";
}

const FILES: FileSpec[] = [
  {
    name: "pipeline",
    live: "pipeline.json",
    template: "pipeline.template.json",
    kind: "json",
  },
  { name: "tools", live: "tools.json", template: "tools.template.json", kind: "json" },
  {
    name: "system-prompt",
    live: "system-prompt.md",
    template: "system-prompt.template.md",
    kind: "markdown",
  },
];

const SCHEMA_FILE = "schema.json";

function templateDir(): string {
  return resourcePath("agent-config");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readIfExists(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Seed `<userData>/agent-config` from the shipped templates.
 *
 * Idempotent: existing live files are never overwritten (the user may have
 * edited them), but a missing file is restored from its template.
 */
export function initAgentConfigDir(): { dir: string; seeded: string[] } {
  const dir = agentConfigDir();
  const seeded: string[] = [];
  const source = templateDir();

  try {
    fs.mkdirSync(dir, { recursive: true });

    for (const spec of FILES) {
      const templateFile = path.join(source, spec.template);
      const liveFile = path.join(dir, spec.live);
      if (fs.existsSync(liveFile)) continue;
      const template = readIfExists(templateFile);
      if (template === null) {
        addLog("main", "warn", `Agent config template missing: ${spec.template}`);
        continue;
      }
      writeAtomic(liveFile, template);
      seeded.push(spec.live);
    }

    const schemaSource = path.join(source, SCHEMA_FILE);
    const schemaLive = path.join(dir, SCHEMA_FILE);
    const schemaText = readIfExists(schemaSource);
    if (schemaText !== null && !fs.existsSync(schemaLive)) {
      writeAtomic(schemaLive, schemaText);
      seeded.push(SCHEMA_FILE);
    }

    // Refresh the restore snapshot whenever the shipped schema version changes.
    const snapDir = agentConfigDefaultsDir();
    const versionFile = path.join(snapDir, "version.json");
    const recorded = readIfExists(versionFile);
    let recordedVersion: string | null = null;
    try {
      recordedVersion = recorded ? (JSON.parse(recorded).version ?? null) : null;
    } catch {
      recordedVersion = null;
    }

    if (recordedVersion !== APP_VERSION) {
      fs.mkdirSync(snapDir, { recursive: true });
      for (const spec of FILES) {
        const template = readIfExists(path.join(source, spec.template));
        if (template !== null) writeAtomic(path.join(snapDir, spec.live), template);
      }
      writeAtomic(versionFile, `${JSON.stringify({ version: APP_VERSION }, null, 2)}\n`);
      seeded.push(".defaults/");
    }
  } catch (err) {
    addLog("main", "warn", `Could not initialise agent config: ${describe(err)}`);
  }

  return { dir, seeded };
}

// ── validation ───────────────────────────────────────────────────────────────

interface AgentSchema {
  definitions?: Record<string, object>;
}

function loadSchema(): AgentSchema | null {
  // The schema describes what *this build's code* accepts, so it is always read
  // from the shipped template. A stale `<userData>` copy would reject newly
  // shipped tools and fields, and no user ever needs to edit it.
  const text =
    readIfExists(path.join(templateDir(), SCHEMA_FILE)) ??
    readIfExists(path.join(agentConfigDir(), SCHEMA_FILE));
  if (!text) return null;
  try {
    return JSON.parse(text) as AgentSchema;
  } catch (err) {
    addLog("main", "warn", `agent-config/schema.json is invalid: ${describe(err)}`);
    return null;
  }
}

/** Validate a JSON agent-config file against its sub-schema. */
export function validateAgentConfigFile(name: AgentConfigName, content: string): string[] {
  if (name === "system-prompt") {
    return content.trim() ? [] : ["System prompt is empty."];
  }
  const schema = loadSchema();
  const definitionKey = name === "pipeline" ? "pipeline_file" : "tools_file";
  const definition = schema?.definitions?.[definitionKey];
  if (!schema || !definition) return []; // No schema available: don't block the user.

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return [`Invalid JSON: ${describe(err)}`];
  }

  const validator = new Validator(
    { ...definition, definitions: schema.definitions } as object,
    "7",
    false,
  );
  const result = validator.validate(parsed);
  return result.valid
    ? []
    : result.errors.map((error) => `${error.instanceLocation || "/"}: ${error.error}`).slice(0, 20);
}

// ── loading (what the agent runner plans from) ───────────────────────────────

interface ParsedJsonFile {
  raw: unknown;
  source: "live" | "template" | "none";
  warnings: string[];
}

function parseJson(text: string): { value: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { value: null, error: describe(err) };
  }
}

/** The live file when it parses, otherwise the shipped template. */
function readJsonFile(liveName: string, templateName: string): ParsedJsonFile {
  const warnings: string[] = [];

  const liveText = readIfExists(path.join(agentConfigDir(), liveName));
  if (liveText !== null) {
    const live = parseJson(liveText);
    if (!live.error) return { raw: live.value, source: "live", warnings };
    warnings.push(`${liveName} is not valid JSON (${live.error}); using the shipped template.`);
  }

  const templateText = readIfExists(path.join(templateDir(), templateName));
  if (templateText === null) {
    warnings.push(`Neither ${liveName} nor ${templateName} could be read.`);
    return { raw: null, source: "none", warnings };
  }

  const template = parseJson(templateText);
  if (template.error) {
    warnings.push(`${templateName} is not valid JSON: ${template.error}`);
    return { raw: null, source: "none", warnings };
  }
  return { raw: template.value, source: "template", warnings };
}

function readTemplateJson(name: string): { raw: unknown; warnings: string[] } {
  const text = readIfExists(path.join(templateDir(), name));
  if (text === null) return { raw: null, warnings: [`${name} is missing from the shipped templates.`] };
  const parsed = parseJson(text);
  return parsed.error
    ? { raw: null, warnings: [`${name} is not valid JSON: ${parsed.error}`] }
    : { raw: parsed.value, warnings: [] };
}

/**
 * The tool list a run should use: the user's live file, plus any shipped tool it
 * is missing.
 *
 * Seeding never overwrites an existing live file, so an installation created
 * before phase 3 has no `generate_flashcards` in its `tools.json`. Merging the
 * template in (additively only) is what keeps that install runnable without
 * discarding the user's own edits.
 */
export function loadToolDefinitions(): { tools: ToolDef[]; added: string[]; warnings: string[] } {
  const live = readJsonFile("tools.json", "tools.template.json");
  const template = readTemplateJson("tools.template.json");

  const liveParsed = parseToolList(live.raw ?? []);
  const templateParsed = parseToolList(template.raw);
  const { tools, added } = mergeToolLists(liveParsed.tools, templateParsed.tools);

  return {
    tools,
    added,
    warnings: [
      ...live.warnings,
      ...template.warnings,
      ...liveParsed.warnings.map((w) => `tools.json: ${w}`),
      ...templateParsed.warnings.map((w) => `tools.template.json: ${w}`),
    ],
  };
}

/** The pipeline definition file, live if it parses and the template otherwise. */
export function loadPipelineFile(): {
  file: PipelineFile | null;
  source: "live" | "template" | "none";
  warnings: string[];
} {
  const live = readJsonFile("pipeline.json", "pipeline.template.json");
  if (live.raw === null) return { file: null, source: live.source, warnings: live.warnings };

  const { file, warnings } = parsePipelineFile(live.raw);
  return {
    file,
    source: live.source,
    warnings: [...live.warnings, ...warnings.map((w) => `pipeline.json: ${w}`)],
  };
}

// ── read / write ─────────────────────────────────────────────────────────────

export function getAgentConfig(): AgentConfigPayload {
  const dir = agentConfigDir();
  const files: AgentConfigFilePayload[] = FILES.map((spec) => {
    const content = readIfExists(path.join(dir, spec.live));
    const exists = content !== null;
    const errors = exists ? validateAgentConfigFile(spec.name, content) : ["File is missing."];
    return { name: spec.name, content: content ?? "", exists, valid: errors.length === 0, errors };
  });
  return { dir, files };
}

export function saveAgentConfigFile(
  name: AgentConfigName,
  content: string,
): { success: boolean; errors: string[]; error?: string } {
  const spec = FILES.find((candidate) => candidate.name === name);
  if (!spec) return { success: false, errors: [], error: `Unknown agent config file: ${name}` };

  const errors = validateAgentConfigFile(name, content);
  if (errors.length) return { success: false, errors };

  try {
    writeAtomic(path.join(agentConfigDir(), spec.live), content);
    // Signals a running agent-runner to reload; harmless while there is none.
    fs.writeFileSync(path.join(agentConfigDir(), ".restart-flag"), `${Date.now()}\n`, "utf8");
    return { success: true, errors: [] };
  } catch (err) {
    return { success: false, errors: [], error: describe(err) };
  }
}

/**
 * Restore every live file from the seeded snapshot.
 *
 * Implemented entirely on disk (unlike the reference implementation, whose
 * restore path only worked while a bridge server was running).
 */
export function restoreAgentConfigDefaults(): { success: boolean; written: string[]; error?: string } {
  const snapDir = agentConfigDefaultsDir();
  const written: string[] = [];
  try {
    let restoredFromTemplates = false;
    for (const spec of FILES) {
      let content = readIfExists(path.join(snapDir, spec.live));
      if (content === null) {
        content = readIfExists(path.join(templateDir(), spec.template));
        restoredFromTemplates = true;
      }
      if (content === null) continue;
      writeAtomic(path.join(agentConfigDir(), spec.live), content);
      written.push(spec.live);
    }
    if (restoredFromTemplates) {
      addLog("main", "warn", "No defaults snapshot found; restored from shipped templates.");
    }
    return { success: true, written };
  } catch (err) {
    return { success: false, written, error: describe(err) };
  }
}
