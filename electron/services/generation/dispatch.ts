/**
 * Running the pipeline steps that are not model calls.
 *
 * Until phase 4 the registry classified steps but nothing executed them: the
 * `pre` reads were already done in code by `scope.ts`, and the one `commit` step
 * (`materials_save`) was really `commitGeneration` writing to the database. The
 * Google tools have no such shortcut — a calendar event cannot be derived from
 * the syllabus — so they need a real dispatcher.
 *
 * Scope is deliberately narrow:
 *
 *  - Only steps the registry marks `mcpServer` are touched. `syllabus_*` reads
 *    keep coming from `scope.ts`, and `materials_save` keeps being the database
 *    commit; re-running either here would duplicate work that already works.
 *  - `pre` results become the `{{toolContext}}` block in a prompt. `commit` steps
 *    run **after** the database commit, and are in a separate function for
 *    exactly that reason: a Google call must not hold a SQLite savepoint open,
 *    and a failed email must not roll back cards the user already approved.
 *
 * Nothing here throws. A step that fails becomes an outcome with `ok: false`, so
 * the caller can report it without unwinding the run.
 */

import type { GoogleCallResult } from "../google";
import type { ServiceLogger } from "../types";
import { interpolate, type PlaceholderVars, type ResolvedStep, type RunPlan } from "./pipeline";
import { executorFor } from "./tools";

/** The Google-side dependency, structurally satisfied by `GoogleGateway`. */
export interface GoogleToolRunner {
  callTool(tool: string, args?: Record<string, unknown>): Promise<GoogleCallResult>;
}

export interface ToolOutcome {
  stepId: string;
  tool: string;
  label: string;
  ok: boolean;
  error: string | null;
  /** One line for the run progress list. */
  summary: string;
  data: unknown;
}

export interface ToolRunResult {
  outcomes: ToolOutcome[];
  /** Successful payloads, keyed by step id. */
  results: Record<string, unknown>;
  /** The rendered block for `{{toolContext}}`; empty when there is nothing to say. */
  context: string;
  /** True when every step that ran succeeded. */
  ok: boolean;
}

/** How much of the gathered context may be inlined into a prompt. */
export const TOOL_CONTEXT_MAX_CHARS = 6_000;

/** The Google steps in a plan for one stage, in declaration order. */
export function googleSteps(plan: RunPlan, stage: "pre" | "commit"): ResolvedStep[] {
  return plan.steps.filter(
    (step) => step.enabled && step.stage === stage && Boolean(executorFor(step.toolName)?.mcpServer),
  );
}

/**
 * Fill a step's declared arguments.
 *
 * Recurses through objects and arrays because a tool argument is often a list —
 * `recurrence: ["RRULE:FREQ=WEEKLY;BYDAY={{studyDay}}"]` — and a template that is
 * only interpolated at the top level would silently send the placeholder text.
 */
export function interpolateArgs(
  args: Record<string, unknown>,
  vars: PlaceholderVars,
): Record<string, unknown> {
  return interpolateValue(args, vars) as Record<string, unknown>;
}

function interpolateValue(value: unknown, vars: PlaceholderVars): unknown {
  if (typeof value === "string") return interpolate(value, vars);
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolateValue(item, vars);
    }
    return out;
  }
  return value;
}

/**
 * Run the `pre` Google reads and render their results for a prompt.
 *
 * Sequential rather than parallel: a pipeline is a description of an ordered
 * process, and the context block reads in declaration order.
 */
export async function runPreTools(
  google: GoogleToolRunner,
  plan: RunPlan,
  vars: PlaceholderVars,
  log?: ServiceLogger,
): Promise<ToolRunResult> {
  return run(google, googleSteps(plan, "pre"), vars, log);
}

/** Run the `commit` Google writes, after the database commit has succeeded. */
export async function runCommitTools(
  google: GoogleToolRunner,
  plan: RunPlan,
  vars: PlaceholderVars,
  log?: ServiceLogger,
): Promise<ToolRunResult> {
  return run(google, googleSteps(plan, "commit"), vars, log);
}

async function run(
  google: GoogleToolRunner,
  steps: ResolvedStep[],
  vars: PlaceholderVars,
  log?: ServiceLogger,
): Promise<ToolRunResult> {
  const outcomes: ToolOutcome[] = [];
  const results: Record<string, unknown> = {};

  for (const step of steps) {
    const executor = executorFor(step.toolName);
    if (!executor?.available) {
      outcomes.push({
        stepId: step.id,
        tool: step.toolName,
        label: step.label,
        ok: false,
        error: executor?.note ? `Not available: ${executor.note}` : "Not available.",
        summary: `${step.label} — skipped`,
        data: null,
      });
      continue;
    }

    const args = interpolateArgs(step.args, vars);
    const result = await google.callTool(step.toolName, args);

    if (!result.ok) {
      log?.("warn", `${step.toolName} failed: ${result.error}`);
      outcomes.push({
        stepId: step.id,
        tool: step.toolName,
        label: step.label,
        ok: false,
        error: result.error,
        summary: `${step.label} — failed`,
        data: null,
      });
      continue;
    }

    results[step.id] = result.data;
    outcomes.push({
      stepId: step.id,
      tool: step.toolName,
      label: step.label,
      ok: true,
      error: null,
      summary: summarize(step.toolName, args, result.data),
      data: result.data,
    });
  }

  return {
    outcomes,
    results,
    context: renderContext(steps, results),
    ok: outcomes.every((outcome) => outcome.ok),
  };
}

/**
 * A short description of what a tool did.
 *
 * Written per tool rather than generated, because "Created “Equilibrium revision”"
 * is what a user needs to see at the review gate and a generic success message is
 * not.
 */
function summarize(tool: string, args: Record<string, unknown>, data: unknown): string {
  const text = (key: string): string => {
    const value = args[key];
    return typeof value === "string" ? value : "";
  };
  const payload = (data ?? {}) as Record<string, unknown>;
  const fromPayload = (key: string): string => {
    const value = payload[key];
    return typeof value === "string" ? value : "";
  };

  switch (tool) {
    case "gmail_send_message":
      return `Emailed “${text("subject")}” to ${text("to")}`;
    case "gmail_list_messages": {
      const messages = payload.messages;
      const count = Array.isArray(messages) ? messages.length : 0;
      return `Read ${count} message${count === 1 ? "" : "s"}`;
    }
    case "gmail_get_message":
      return `Read message ${text("id") || fromPayload("id")}`;
    case "calendar_list_calendars": {
      const calendars = payload.calendars;
      const count = Array.isArray(calendars) ? calendars.length : 0;
      return `Found ${count} calendar${count === 1 ? "" : "s"}`;
    }
    case "calendar_list_events": {
      const events = payload.events;
      const count = Array.isArray(events) ? events.length : 0;
      return `Found ${count} event${count === 1 ? "" : "s"}`;
    }
    case "calendar_get_event":
      return `Read event ${text("eventId")}`;
    case "calendar_create_event":
      return `Created “${text("summary") || fromPayload("summary")}”`;
    case "calendar_update_event":
      return `Updated “${text("summary") || fromPayload("summary") || text("eventId")}”`;
    case "calendar_list_tasklists":
      return "Listed task lists";
    case "calendar_list_tasks": {
      const tasks = payload.tasks;
      const count = Array.isArray(tasks) ? tasks.length : 0;
      return `Found ${count} task${count === 1 ? "" : "s"}`;
    }
    case "calendar_create_task":
      return `Added task “${text("title") || fromPayload("title")}”`;
    case "calendar_update_task":
      return `Updated task “${text("title") || fromPayload("title") || text("taskId")}”`;
    default:
      return "Completed";
  }
}

/**
 * Render the gathered results for `{{toolContext}}`.
 *
 * Bounded: this text is inlined into a prompt, and an unbounded mailbox listing
 * would both cost tokens and give an attacker an easier place to hide an
 * instruction. The truncation is reported rather than silent.
 */
function renderContext(steps: ResolvedStep[], results: Record<string, unknown>): string {
  const blocks: string[] = [];
  let budget = TOOL_CONTEXT_MAX_CHARS;

  for (const step of steps) {
    if (!(step.id in results)) continue;
    const heading = `### ${step.label} (${step.toolName})`;
    let body: string;
    try {
      body = JSON.stringify(results[step.id], null, 2) ?? "null";
    } catch {
      body = "[unserialisable]";
    }

    if (body.length > budget) {
      body = `${body.slice(0, Math.max(0, budget))}\n… (truncated)`;
      budget = 0;
    } else {
      budget -= body.length;
    }

    blocks.push(`${heading}\n${body}`);
    if (budget <= 0) break;
  }

  return blocks.join("\n\n");
}
