/**
 * Calendar + Tasks MCP server (stdio).
 *
 * Nine tools: five for events, one for calendar discovery, three for Google
 * Tasks. Registered by `mcp/calendar/package.json`.
 *
 * Same two rules as the Gmail server: stdout carries the protocol only (see
 * `stdout-guard.mjs`), and every user-fixable failure comes back as a tool
 * result rather than a protocol error.
 *
 * Three defects from the implementation this was ported from are fixed here:
 *
 *  - **All-day events.** A bare `2026-06-10` was sent as `{dateTime: …}`, which
 *    the API rejects — the schema advertised all-day support the code could not
 *    deliver.
 *  - **No auth at module load.** The original built its OAuth client at import
 *    time, so an installation without a token crashed the server on boot instead
 *    of reporting "not configured".
 *  - **Friendly calendar names read from a file that never shipped.** The map now
 *    comes from `CALENDARS_FILE` in the child environment, and its absence is a
 *    normal state rather than a silent no-op on a missing script.
 */

// Must be the first import — see stdout-guard.mjs.
import "../lib/stdout-guard.mjs";

import fs from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { calendarTools } from "../../shared/tool-manifest.js";
import {
  calendarRequest,
  describeError,
  missingGoogleConfig,
  readGoogleConfig,
  tasksRequest,
} from "../lib/google-client.mjs";
import { bootstrapEnv } from "../lib/env-bootstrap.mjs";
import { normalizeTaskDue, parseDateTime } from "../lib/dates.mjs";

// Only does anything when this server is launched outside the app.
bootstrapEnv();

const SERVER_NAME = "study-aide-calendar";
const SERVER_VERSION = "1.0.0";

const MAX_RESULTS = 100;
const DEFAULT_TASKLIST = "@default";

function log(message) {
  process.stderr.write(`[calendar] ${message}\n`);
}

function jsonResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ── calendar id resolution ───────────────────────────────────────────────────

/**
 * Resolve a calendar name to an id.
 *
 * The index is written by the app (`<userData>/calendars.json`, refreshed from
 * `calendar_list_calendars`). Its absence is expected — the server is also usable
 * standalone from VS Code — so an unknown value is passed through unchanged and a
 * bare name falls back to the user's primary calendar.
 */
function resolveCalendarId(value) {
  const requested = String(value ?? "").trim();
  if (!requested) return readGoogleConfig().calendarId || "primary";

  const file = readGoogleConfig().calendarsFile;
  if (file) {
    try {
      const index = JSON.parse(fs.readFileSync(file, "utf8"));
      const mapped = index?.byName?.[requested];
      if (typeof mapped === "string" && mapped) return mapped;
    } catch {
      // Missing or malformed: fall through and treat the value as an id.
    }
  }
  return requested;
}

// ── formatting ───────────────────────────────────────────────────────────────

function formatEvent(event) {
  return {
    id: event?.id ?? null,
    summary: event?.summary ?? "",
    description: event?.description ?? "",
    location: event?.location ?? "",
    status: event?.status ?? "",
    start: event?.start ?? null,
    end: event?.end ?? null,
    recurrence: event?.recurrence ?? [],
    recurringEventId: event?.recurringEventId ?? null,
    attendees: (event?.attendees ?? []).map((attendee) => attendee?.email ?? "").filter(Boolean),
    transparency: event?.transparency ?? null,
    colorId: event?.colorId ?? null,
    htmlLink: event?.htmlLink ?? null,
    created: event?.created ?? null,
    updated: event?.updated ?? null,
  };
}

function formatTask(task) {
  return {
    id: task?.id ?? null,
    title: task?.title ?? "",
    notes: task?.notes ?? "",
    status: task?.status ?? "",
    due: task?.due ?? null,
    completed: task?.completed ?? null,
    updated: task?.updated ?? null,
    parent: task?.parent ?? null,
    position: task?.position ?? null,
  };
}

const EVENT_FIELDS =
  "items(id,summary,description,location,status,start,end,recurrence,recurringEventId,attendees,htmlLink,created,updated,colorId,transparency)";

// ── events ───────────────────────────────────────────────────────────────────

async function handleListCalendars() {
  const list = await calendarRequest("/users/me/calendarList", {
    method: "GET",
    query: { fields: "items(id,summary,description,primary,selected,accessRole,timeZone)" },
  });
  const calendars = (list?.items ?? []).map((entry) => ({
    id: entry?.id ?? "",
    name: entry?.summary ?? "",
    description: entry?.description ?? "",
    primary: Boolean(entry?.primary),
    selected: Boolean(entry?.selected),
    accessRole: entry?.accessRole ?? "",
    timeZone: entry?.timeZone ?? null,
  }));
  return jsonResult({ calendars });
}

async function handleListEvents(args = {}) {
  const calendarId = resolveCalendarId(args.calendarId);
  const requested = Number(args.maxResults);
  const maxResults = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 20, MAX_RESULTS);

  const list = await calendarRequest(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "GET",
    query: {
      timeMin: args.timeMin || new Date().toISOString(),
      timeMax: args.timeMax || undefined,
      q: args.query || undefined,
      maxResults,
      singleEvents: args.singleEvents === false ? "false" : "true",
      orderBy: "startTime",
      fields: EVENT_FIELDS,
    },
  });
  return jsonResult({ calendarId, events: (list?.items ?? []).map(formatEvent) });
}

async function handleGetEvent(args = {}) {
  const eventId = String(args.eventId ?? "").trim();
  if (!eventId) return errorResult("calendar_get_event requires an 'eventId'.");
  const calendarId = resolveCalendarId(args.calendarId);
  const event = await calendarRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "GET" },
  );
  return jsonResult(formatEvent(event));
}

async function handleCreateEvent(args = {}) {
  const summary = String(args.summary ?? "").trim();
  if (!summary || !args.start || !args.end) {
    return errorResult("calendar_create_event requires 'summary', 'start' and 'end'.");
  }
  const start = parseDateTime(args.start);
  const end = parseDateTime(args.end);
  if (!start || !end) return errorResult("'start' and 'end' must be ISO 8601 dates or timestamps.");

  const calendarId = resolveCalendarId(args.calendarId);
  const body = { summary, start, end };
  if (args.description !== undefined) body.description = String(args.description);
  if (args.location !== undefined) body.location = String(args.location);
  if (args.attendees !== undefined) body.attendees = toAttendees(args.attendees);
  if (args.recurrence !== undefined) body.recurrence = toStringArray(args.recurrence);
  if (args.transparency !== undefined) body.transparency = String(args.transparency);
  if (args.colorId !== undefined) body.colorId = String(args.colorId);

  const created = await calendarRequest(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    // `none` explicitly: the default emails invitations to every attendee without
    // the user asking, which is not something a study planner should do silently.
    query: { sendUpdates: "none", fields: "id,summary,status,start,end,htmlLink" },
    body,
  });
  return jsonResult(formatEvent(created));
}

async function handleUpdateEvent(args = {}) {
  const eventId = String(args.eventId ?? "").trim();
  if (!eventId) return errorResult("calendar_update_event requires an 'eventId'.");

  const body = {};
  if (args.summary !== undefined) body.summary = String(args.summary);
  if (args.description !== undefined) body.description = String(args.description);
  if (args.location !== undefined) body.location = String(args.location);
  if (args.start !== undefined) body.start = parseDateTime(args.start);
  if (args.end !== undefined) body.end = parseDateTime(args.end);
  if (args.attendees !== undefined) body.attendees = toAttendees(args.attendees);
  if (args.recurrence !== undefined) body.recurrence = toStringArray(args.recurrence);
  if (args.transparency !== undefined) body.transparency = String(args.transparency);
  if (args.colorId !== undefined) body.colorId = String(args.colorId);

  if (Object.keys(body).length === 0) {
    return errorResult("calendar_update_event needs at least one field to change.");
  }

  const calendarId = resolveCalendarId(args.calendarId);
  const updated = await calendarRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "PATCH", query: { sendUpdates: "none" }, body },
  );
  return jsonResult(formatEvent(updated));
}

function toAttendees(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((entry) => (typeof entry === "string" ? { email: entry } : entry))
    .filter((entry) => entry && typeof entry === "object");
}

function toStringArray(value) {
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
}

// ── tasks ────────────────────────────────────────────────────────────────────

async function handleListTasklists() {
  const list = await tasksRequest("/users/@me/lists", {
    method: "GET",
    query: { maxResults: 100, fields: "items(id,title,updated)" },
  });
  return jsonResult({
    tasklists: (list?.items ?? []).map((entry) => ({
      id: entry?.id ?? "",
      title: entry?.title ?? "",
      updated: entry?.updated ?? null,
    })),
  });
}

async function handleListTasks(args = {}) {
  const tasklistId = String(args.tasklistId ?? "").trim() || DEFAULT_TASKLIST;
  const requested = Number(args.maxResults);
  const maxResults = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 50, MAX_RESULTS);

  const list = await tasksRequest(`/lists/${encodeURIComponent(tasklistId)}/tasks`, {
    method: "GET",
    query: {
      maxResults,
      dueMin: args.dueMin || undefined,
      dueMax: args.dueMax || undefined,
      showCompleted: args.showCompleted === false ? "false" : "true",
      showHidden: args.showHidden === true ? "true" : "false",
    },
  });
  return jsonResult({ tasklistId, tasks: (list?.items ?? []).map(formatTask) });
}

async function handleCreateTask(args = {}) {
  const title = String(args.title ?? "").trim();
  if (!title) return errorResult("calendar_create_task requires a 'title'.");
  const tasklistId = String(args.tasklistId ?? "").trim() || DEFAULT_TASKLIST;

  const body = { title, status: args.status === "completed" ? "completed" : "needsAction" };
  if (args.notes !== undefined) body.notes = String(args.notes);
  const due = normalizeTaskDue(args.due);
  if (due) body.due = due;

  const created = await tasksRequest(`/lists/${encodeURIComponent(tasklistId)}/tasks`, {
    method: "POST",
    body,
  });
  return jsonResult(formatTask(created));
}

async function handleUpdateTask(args = {}) {
  const taskId = String(args.taskId ?? "").trim();
  if (!taskId) return errorResult("calendar_update_task requires a 'taskId'.");
  const tasklistId = String(args.tasklistId ?? "").trim() || DEFAULT_TASKLIST;

  const body = {};
  if (args.title !== undefined) body.title = String(args.title);
  if (args.notes !== undefined) body.notes = String(args.notes);
  if (args.due !== undefined) body.due = normalizeTaskDue(args.due);
  if (args.status !== undefined) body.status = String(args.status);
  if (Object.keys(body).length === 0) {
    return errorResult("calendar_update_task needs at least one field to change.");
  }

  const updated = await tasksRequest(
    `/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "PATCH", body },
  );
  return jsonResult(formatTask(updated));
}

// ── server ───────────────────────────────────────────────────────────────────

const HANDLERS = {
  calendar_list_calendars: handleListCalendars,
  calendar_list_events: handleListEvents,
  calendar_get_event: handleGetEvent,
  calendar_create_event: handleCreateEvent,
  calendar_update_event: handleUpdateEvent,
  calendar_list_tasklists: handleListTasklists,
  calendar_list_tasks: handleListTasks,
  calendar_create_task: handleCreateTask,
  calendar_update_task: handleUpdateTask,
};

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: calendarTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Resolved inside the try, so "not configured" is a readable tool result.
  try {
    const missing = missingGoogleConfig();
    if (missing.length) {
      return errorResult(
        `Calendar is not configured. Set ${missing.join(", ")} in Settings, then reconnect Google.`,
      );
    }

    const handler = HANDLERS[name];
    if (!handler) return errorResult(`Unknown tool: ${name}`);

    const result = await handler(args);
    if (result?.isError) log(`${name} refused: ${result.content?.[0]?.text ?? ""}`);
    return result;
  } catch (err) {
    const message = describeError(err);
    log(`${name} failed: ${message}`);
    return errorResult(`Calendar ${name} failed: ${message}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio`);
