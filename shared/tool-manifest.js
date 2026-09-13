/**
 * The MCP tool schemas — the single source of truth for both servers.
 *
 * `mcp/gmail` and `mcp/calendar` import their list from here and never inline a
 * schema, so a tool cannot exist in one place and be missing in the other.
 *
 * Dependency-free on purpose: `electron/tests/google-manifest.test.ts` imports
 * this module and cross-checks it against `TOOL_EXECUTORS`
 * (`electron/services/generation/tools.ts`) and the committed
 * `agent-config/tools.template.json`, so the three descriptions of the same tool
 * cannot drift.
 *
 * Two things were removed from the implementation this was ported from:
 *
 *  - **The `userId` property on every Gmail tool.** It existed to pick between
 *    two hard-coded accounts, one of which was a real person's clinic address
 *    printed into the schema descriptions.
 *  - **The second account entirely.** One OAuth token, one account.
 */

/** Gmail. Three tools: search, read, send. */
export const gmailTools = [
  {
    name: "gmail_list_messages",
    description:
      "Search the connected Gmail account. Returns headers and a snippet for each match, not full bodies. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Gmail search query, using the same syntax as the Gmail search box (e.g. 'is:unread newer_than:7d').",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of messages to return (default 10, capped at 100).",
          default: 10,
        },
      },
    },
  },
  {
    name: "gmail_get_message",
    description:
      "Fetch one Gmail message by id. Use format 'metadata' for headers only, or 'full' to include the decoded plain-text body.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The Gmail message id." },
        format: {
          type: "string",
          enum: ["full", "metadata"],
          description: "'full' returns the decoded body plus headers; 'metadata' returns headers and snippet.",
          default: "full",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gmail_send_message",
    description:
      "Send a plain-text email to one recipient. Irreversible once sent, so it always passes through the review gate.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject. Must not contain line breaks." },
        body: { type: "string", description: "Plain-text body." },
      },
      required: ["to", "subject", "body"],
    },
  },
];

/** Calendar events, calendar discovery, and Google Tasks. Nine tools. */
export const calendarTools = [
  {
    name: "calendar_list_calendars",
    description:
      "List the calendars on the connected account, with their ids, names and access roles. Use this to find a calendar id for the other tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "calendar_list_events",
    description: "List events in a time window. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: {
          type: "string",
          description: "Calendar id, or a friendly name from the local calendar index. Defaults to 'primary'.",
        },
        timeMin: { type: "string", description: "Start of the window, ISO 8601. Defaults to now." },
        timeMax: { type: "string", description: "End of the window, ISO 8601. Optional." },
        query: { type: "string", description: "Free-text search across event fields." },
        maxResults: { type: "number", description: "Maximum events to return (default 20, capped at 100).", default: 20 },
        singleEvents: {
          type: "boolean",
          description: "Expand recurring events into individual instances (default true).",
          default: true,
        },
      },
    },
  },
  {
    name: "calendar_get_event",
    description: "Fetch one calendar event by id. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar id or friendly name. Defaults to 'primary'." },
        eventId: { type: "string", description: "The event id." },
      },
      required: ["eventId"],
    },
  },
  {
    name: "calendar_create_event",
    description:
      "Create a calendar event, such as a study block or an exam countdown. Requires the review gate: it changes state on the calendar.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar id or friendly name. Defaults to 'primary'." },
        summary: { type: "string", description: "Event title." },
        start: {
          type: "string",
          description:
            "Start as an ISO 8601 timestamp (e.g. '2026-06-10T14:00:00-05:00'), or a date alone (e.g. '2026-06-10') for an all-day event.",
        },
        end: {
          type: "string",
          description:
            "End, in the same form as start and after it. For an all-day event this is the date after the last day.",
        },
        description: { type: "string", description: "Event description." },
        location: { type: "string", description: "Event location." },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses." },
        recurrence: {
          type: "array",
          items: { type: "string" },
          description: "RRULE strings, e.g. ['RRULE:FREQ=WEEKLY;BYDAY=MO'].",
        },
        transparency: {
          type: "string",
          enum: ["opaque", "transparent"],
          description: "'opaque' marks the time busy; 'transparent' leaves it free.",
        },
        colorId: { type: "string", description: "Calendar colour id, 1-11." },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "calendar_update_event",
    description:
      "Change fields on an existing event. Only the fields you supply are modified. Requires the review gate.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar id or friendly name. Defaults to 'primary'." },
        eventId: { type: "string", description: "The event id to change." },
        summary: { type: "string", description: "New title." },
        start: { type: "string", description: "New start, ISO 8601 timestamp or a date for all-day." },
        end: { type: "string", description: "New end, same form as start." },
        description: { type: "string", description: "New description." },
        location: { type: "string", description: "New location." },
        attendees: { type: "array", items: { type: "string" }, description: "Replacement attendee list." },
        recurrence: {
          type: "array",
          items: { type: "string" },
          description: "Replacement RRULE list. An empty array clears the recurrence.",
        },
        transparency: { type: "string", enum: ["opaque", "transparent"], description: "Busy or free." },
        colorId: { type: "string", description: "Calendar colour id, 1-11." },
      },
      required: ["eventId"],
    },
  },
  {
    name: "calendar_list_tasklists",
    description: "List the task lists on the connected account. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "calendar_list_tasks",
    description: "List tasks from a task list, optionally filtered by due date. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        tasklistId: {
          type: "string",
          description: "Task list id (default '@default'). Use calendar_list_tasklists to find others.",
          default: "@default",
        },
        maxResults: { type: "number", description: "Maximum tasks to return (default 50, capped at 100).", default: 50 },
        dueMin: { type: "string", description: "Lower bound on the due date, RFC 3339. Optional." },
        dueMax: { type: "string", description: "Upper bound on the due date, RFC 3339. Optional." },
        showCompleted: { type: "boolean", description: "Include completed tasks (default true).", default: true },
        showHidden: { type: "boolean", description: "Include hidden tasks (default false).", default: false },
      },
    },
  },
  {
    name: "calendar_create_task",
    description:
      "Add a task to a Google Tasks list, such as today's study items. Requires the review gate: it changes state on the task list.",
    inputSchema: {
      type: "object",
      properties: {
        tasklistId: { type: "string", description: "Task list id (default '@default').", default: "@default" },
        title: { type: "string", description: "Task title." },
        notes: { type: "string", description: "Task notes." },
        due: { type: "string", description: "Due date as an RFC 3339 timestamp." },
        status: {
          type: "string",
          enum: ["needsAction", "completed"],
          description: "Task status (default 'needsAction').",
          default: "needsAction",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "calendar_update_task",
    description: "Change fields on an existing Google Task. Only the fields you supply are modified. Requires the review gate.",
    inputSchema: {
      type: "object",
      properties: {
        tasklistId: { type: "string", description: "Task list id (default '@default').", default: "@default" },
        taskId: { type: "string", description: "The task id to change." },
        title: { type: "string", description: "New title." },
        notes: { type: "string", description: "New notes." },
        due: { type: "string", description: "New due date, RFC 3339." },
        status: { type: "string", enum: ["needsAction", "completed"], description: "New status." },
      },
      required: ["taskId"],
    },
  },
];

/** All twelve Google tools. */
export const googleTools = [...gmailTools, ...calendarTools];

/**
 * Which server owns each tool.
 *
 * The servers each register only their own subset, and the app-side gateway uses
 * this to decide which child to ask.
 */
export const GOOGLE_TOOL_SERVERS = Object.freeze({
  gmail_list_messages: "gmail",
  gmail_get_message: "gmail",
  gmail_send_message: "gmail",
  calendar_list_calendars: "calendar",
  calendar_list_events: "calendar",
  calendar_get_event: "calendar",
  calendar_create_event: "calendar",
  calendar_update_event: "calendar",
  calendar_list_tasklists: "calendar",
  calendar_list_tasks: "calendar",
  calendar_create_task: "calendar",
  calendar_update_task: "calendar",
});

/** The server a tool belongs to, or null when the tool is unknown. */
export function serverForTool(name) {
  return GOOGLE_TOOL_SERVERS[name] ?? null;
}

/** The tools registered by one server. */
export function toolsForServer(server) {
  return googleTools.filter((tool) => GOOGLE_TOOL_SERVERS[tool.name] === server);
}

/** Every tool name, in declaration order. */
export const GOOGLE_TOOL_NAMES = Object.freeze(googleTools.map((tool) => tool.name));

/** Throw early if a tool is added without naming its server. */
for (const name of GOOGLE_TOOL_NAMES) {
  if (!GOOGLE_TOOL_SERVERS[name]) {
    throw new Error(`shared/tool-manifest.js: "${name}" has no entry in GOOGLE_TOOL_SERVERS.`);
  }
}
