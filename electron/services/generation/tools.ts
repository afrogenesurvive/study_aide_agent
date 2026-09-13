/**
 * The tool registry.
 *
 * `agent-config/tools.json` is declarative: it says which tools exist, what they
 * do and what arguments they take. It deliberately does **not** say how they run,
 * because that is not something a user should have to get right — this registry
 * owns it.
 *
 * The split that matters is which *process* executes a step. The child process
 * is LLM-only and never opens the database, so only steps that call a model run
 * there; everything else — syllabus reads, the review gate, the commit — runs in
 * the main process, which is the single writer.
 */

/** Where a step sits in a run's lifecycle. */
export type StepStage =
  /** Main process, before the runner is spawned. Produces the job input. */
  | "pre"
  /** Inside the child process. These are the model calls. */
  | "work"
  /** Main process. Blocks on the user's answer. */
  | "gate"
  /** Main process, after approval. Writes to the database. */
  | "commit";

export interface ToolExecutor {
  /** Which process runs it. */
  executor: "child" | "main";
  /** Where it sits in a run. */
  stage: StepStage;
  /** False for tools whose implementation lands in a later phase. */
  available: boolean;
  /** Shown in validation output so the Dev panel can say *why* it is unavailable. */
  note?: string;
  /**
   * For a main-process tool that reaches a Google API: which MCP server runs it.
   *
   * This is the *only* routing table the app uses — the tool manifest declares
   * the same mapping for the servers themselves, and a test asserts the two
   * agree. Absent for every tool that does not call Google.
   */
  mcpServer?: "gmail" | "calendar";
}

const MAIN = "main" as const;
const CHILD = "child" as const;

/**
 * Every tool the app knows how to run.
 *
 * Anything used by a pipeline but missing here is reported by
 * `validatePipeline` rather than silently skipped at run time.
 */
export const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  // ── syllabus + scheduling reads (phase 1/2) ──
  syllabus_list_topics: { executor: MAIN, stage: "pre", available: true },
  syllabus_get_topic: { executor: MAIN, stage: "pre", available: true },
  syllabus_get_overlay: { executor: MAIN, stage: "pre", available: true },
  fsrs_list_due: { executor: MAIN, stage: "pre", available: false, note: "lands in phase 6" },

  // ── material generation (phase 3) ──
  generate_flashcards: { executor: CHILD, stage: "work", available: true },
  generate_quiz: { executor: CHILD, stage: "work", available: true },
  review_gate: { executor: MAIN, stage: "gate", available: true },
  materials_save: { executor: MAIN, stage: "commit", available: true },

  // ── later phases ──
  socratic_reply: { executor: CHILD, stage: "work", available: false, note: "lands in phase 6" },
  analytics_weekly_digest: { executor: MAIN, stage: "pre", available: false, note: "lands in phase 6" },
  fsrs_rate_card: { executor: MAIN, stage: "commit", available: false, note: "lands in phase 6" },

  // ── Google, via the MCP servers (phase 4) ──
  //
  // `stage` places the step in a run: reads sit in `pre` so their output can
  // become prompt context, and every tool that changes remote state sits in
  // `commit`, which is what puts it behind the review gate (`terminal_tools` in
  // `pipeline.template.json` lists the same five — `validateAgentConfig` enforces
  // the pairing in all three places).
  //
  // The five mutating tools are terminal because none of them can be undone from
  // inside the app: there is no delete or unsend tool anywhere in the set.
  gmail_list_messages: { executor: MAIN, stage: "pre", available: true, mcpServer: "gmail" },
  gmail_get_message: { executor: MAIN, stage: "pre", available: true, mcpServer: "gmail" },
  gmail_send_message: { executor: MAIN, stage: "commit", available: true, mcpServer: "gmail" },
  calendar_list_calendars: { executor: MAIN, stage: "pre", available: true, mcpServer: "calendar" },
  calendar_list_events: { executor: MAIN, stage: "pre", available: true, mcpServer: "calendar" },
  calendar_get_event: { executor: MAIN, stage: "pre", available: true, mcpServer: "calendar" },
  calendar_create_event: { executor: MAIN, stage: "commit", available: true, mcpServer: "calendar" },
  calendar_update_event: { executor: MAIN, stage: "commit", available: true, mcpServer: "calendar" },
  calendar_list_tasklists: { executor: MAIN, stage: "pre", available: true, mcpServer: "calendar" },
  calendar_list_tasks: { executor: MAIN, stage: "pre", available: true, mcpServer: "calendar" },
  calendar_create_task: { executor: MAIN, stage: "commit", available: true, mcpServer: "calendar" },
  calendar_update_task: { executor: MAIN, stage: "commit", available: true, mcpServer: "calendar" },
};

export function executorFor(toolName: string): ToolExecutor | null {
  return TOOL_EXECUTORS[toolName] ?? null;
}

/** Declarative tool definition, as it appears in `agent-config/tools.json`. */
export interface ToolDef {
  name: string;
  description: string;
  terminal: boolean;
  handler: string;
  inputSchema: Record<string, unknown>;
}

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Parse a tools file.
 *
 * Forgiving by design: one malformed entry is dropped with a warning instead of
 * invalidating the whole file, because the file is user-editable and a broken
 * tool would otherwise make every pipeline unrunnable.
 */
export function parseToolList(raw: unknown): { tools: ToolDef[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!Array.isArray(raw)) {
    return { tools: [], warnings: ["Tools file is not a JSON array."] };
  }

  const tools: ToolDef[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const value = entry as Record<string, unknown> | null;
    if (!value || typeof value !== "object") {
      warnings.push(`Tool #${index} is not an object.`);
      continue;
    }
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!TOOL_NAME.test(name)) {
      warnings.push(`Tool #${index} has an invalid name ("${name}").`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`Tool "${name}" is defined more than once.`);
      continue;
    }
    seen.add(name);
    tools.push({
      name,
      description: typeof value.description === "string" ? value.description : "",
      terminal: value.terminal === true,
      handler: typeof value.handler === "string" ? value.handler : "direct",
      inputSchema:
        value.inputSchema && typeof value.inputSchema === "object"
          ? (value.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    });
  }

  return { tools, warnings };
}

/**
 * Merge the shipped template into the user's live tools file.
 *
 * Seeding is deliberately non-destructive, so an existing installation keeps its
 * `tools.json` and never receives newly shipped tools. Without this merge a
 * phase 3 install would have no `generate_flashcards` and the pipeline would be
 * unrunnable. The merge only ever *adds* names the live file lacks — user edits
 * to a tool that already exists are always preserved.
 */
export function mergeToolLists(
  live: ToolDef[],
  template: ToolDef[],
): { tools: ToolDef[]; added: string[] } {
  const existing = new Set(live.map((tool) => tool.name));
  const added = template.filter((tool) => !existing.has(tool.name));
  return { tools: [...live, ...added], added: added.map((tool) => tool.name) };
}

export function toolNames(tools: ToolDef[]): string[] {
  return tools.map((tool) => tool.name);
}

export function findTool(tools: ToolDef[], name: string): ToolDef | null {
  return tools.find((tool) => tool.name === name) ?? null;
}
