import { resolveRunPlan, type PipelineFile } from "./pipeline";
import { findTool, type ToolDef } from "./tools";

/**
 * Agent-config health checks.
 *
 * `schema.json` (validated in `src/main/agent-config.ts`) only checks *shape*: it
 * cannot know that a step's `toolName` refers to a tool that exists, or that a
 * tool marked `terminal` is actually reachable behind a review gate. Those are
 * the mistakes that make a pipeline fail at run time, so they are checked here.
 *
 * Nothing here throws: a broken config produces a report, and the caller decides
 * whether to refuse to run.
 */

export interface ConfigIssue {
  level: "error" | "warn";
  message: string;
}

export interface ConfigValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Pipelines that could actually start, by name. */
  runnable: string[];
}

export interface ValidateAgentConfigInput {
  file: PipelineFile;
  tools: ToolDef[];
  /** Tools merged in from the shipped template because the live file lacked them. */
  addedTools?: string[];
}

export function validateAgentConfig({
  file,
  tools,
  addedTools = [],
}: ValidateAgentConfigInput): ConfigValidation {
  const issues: ConfigIssue[] = [];
  const add = (level: ConfigIssue["level"], message: string) => issues.push({ level, message });

  if (addedTools.length > 0) {
    add(
      "warn",
      `agent-config/tools.json is missing ${addedTools.length} shipped tool(s) — added from the template for this session: ${addedTools.join(", ")}. Use Dev → Agent config → Restore defaults to make it permanent.`,
    );
  }

  validateTerminalTools(file, tools, add);

  const runnable: string[] = [];
  for (const pipeline of file.pipelines) {
    const plan = resolveRunPlan(pipeline, tools, { maxSteps: file.maxPipelineSteps });
    for (const message of plan.errors) add("error", `${pipeline.name}: ${message}`);
    for (const message of plan.warnings) add("warn", `${pipeline.name}: ${message}`);
    if (plan.ok) runnable.push(pipeline.name);
  }

  const errors = issues.filter((issue) => issue.level === "error").map((issue) => issue.message);
  const warnings = issues.filter((issue) => issue.level === "warn").map((issue) => issue.message);

  return { ok: errors.length === 0, errors, warnings, runnable };
}

/**
 * Keep the three places that describe "this does something irreversible" in
 * agreement: the tool's `terminal` flag, the step's `isTerminal` flag, and the
 * file-level `terminal_tools` list.
 *
 * The file-level list is what a run consults before executing a step, so a tool
 * missing from it is the dangerous case — it would be treated as reversible.
 */
function validateTerminalTools(
  file: PipelineFile,
  tools: ToolDef[],
  add: (level: ConfigIssue["level"], message: string) => void,
): void {
  const terminalTools = new Set(file.terminalTools);

  for (const name of file.terminalTools) {
    if (!findTool(tools, name)) {
      add("error", `terminal_tools lists "${name}", which is not a defined tool.`);
    }
  }

  for (const tool of tools) {
    if (tool.terminal && !terminalTools.has(tool.name)) {
      add(
        "error",
        `Tool "${tool.name}" is marked terminal but is missing from terminal_tools — a run would treat it as reversible.`,
      );
    }
    if (!tool.terminal && terminalTools.has(tool.name)) {
      add("warn", `"${tool.name}" is listed in terminal_tools but the tool is not marked terminal.`);
    }
  }

  for (const pipeline of file.pipelines) {
    for (const step of pipeline.steps) {
      if (!step.enabled) continue;
      const tool = findTool(tools, step.toolName);
      if (!tool) continue;

      if (step.isTerminal && !tool.terminal) {
        add(
          "warn",
          `${pipeline.name}: step "${step.id}" is marked isTerminal but tool "${step.toolName}" is not terminal.`,
        );
      }
      if (tool.terminal && !step.isTerminal) {
        add(
          "warn",
          `${pipeline.name}: step "${step.id}" calls terminal tool "${step.toolName}" but is not marked isTerminal.`,
        );
      }
    }
  }
}
