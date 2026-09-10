import fs from "node:fs";
import path from "node:path";
import { Validator } from "@cfworker/json-schema";
import { addLog } from "./logger";
import { agentConfigDefaultsDir, agentConfigDir, resourcePath } from "./paths";
import { APP_VERSION } from "./config";
import type { AgentConfigFilePayload, AgentConfigPayload } from "../shared/ipc-types";

/**
 * Agent configuration (pipeline / tools / system prompt).
 *
 * Three-layer pattern mirroring the app config:
 *   - repo  `agent-config/*.template.*`  ← committed, shipped read-only
 *   - live  `<userData>/agent-config/*.json|*.md` ← user-editable, gitignored
 *   - snap  `<userData>/agent-config/.defaults/`  ← restore target
 *
 * Nothing consumes these yet (the agent runner arrives in phase 3), but the
 * directory is seeded on first launch so the runner has something to read, and
 * the Dev panel can already preview and validate the files.
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
  const text =
    readIfExists(path.join(agentConfigDir(), SCHEMA_FILE)) ??
    readIfExists(path.join(templateDir(), SCHEMA_FILE));
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
