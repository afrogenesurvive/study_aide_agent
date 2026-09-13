/**
 * Gmail MCP server (stdio).
 *
 * Three tools: search, read, send. Registered by `mcp/gmail/package.json`.
 *
 * Two rules govern this file:
 *
 *  1. **stdout is the protocol channel.** One JSON-RPC message per line and
 *     nothing else. `stdout-guard.mjs` is imported first because ESM evaluates
 *     imports before the importing module's body — a redirect called below the
 *     imports would already be too late.
 *  2. **A failure the user can fix is a tool result, not a protocol error.**
 *     Missing credentials are reported as `isError: true` content so a model (or
 *     the Settings panel) can read the message and act on it. The implementation
 *     this was ported from resolved its OAuth client *outside* the handler's
 *     try/catch, so every unconfigured call escaped as an opaque JSON-RPC error
 *     and skipped the tool-call log entirely.
 */

// Must be the first import — see the note above and stdout-guard.mjs.
import "../lib/stdout-guard.mjs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { gmailTools } from "../../shared/tool-manifest.js";
import { describeError, gmailRequest, missingGoogleConfig } from "../lib/google-client.mjs";
import { bootstrapEnv } from "../lib/env-bootstrap.mjs";
import {
  METADATA_HEADERS,
  buildRawMessage,
  findHeaderInjection,
  formatMessage,
  looksLikeEmail,
} from "../lib/mime.mjs";

// Only does anything when this server is launched outside the app; the app
// injects the credentials into the child environment itself.
bootstrapEnv();

const SERVER_NAME = "study-aide-gmail";
const SERVER_VERSION = "1.0.0";

const MAX_RESULTS = 100;
/** Each match needs its own headers call; unbounded fan-out is rude to the API. */
const METADATA_CONCURRENCY = 5;

// ── console discipline ───────────────────────────────────────────────────────

function log(message) {
  process.stderr.write(`[gmail] ${message}\n`);
}

// ── result helpers ───────────────────────────────────────────────────────────

function jsonResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** `Promise.all` with a ceiling, so a 100-message search is 5 calls at a time. */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleListMessages(args = {}) {
  const query = String(args.query ?? "");
  const requested = Number(args.maxResults);
  const maxResults = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 10, MAX_RESULTS);

  const list = await gmailRequest("/messages", { method: "GET", query: { q: query || undefined, maxResults } });
  const ids = (list?.messages ?? []).map((message) => message.id).filter(Boolean);
  if (ids.length === 0) return jsonResult({ messages: [], resultSizeEstimate: list?.resultSizeEstimate ?? 0 });

  const detailed = await mapLimited(ids, METADATA_CONCURRENCY, (id) =>
    gmailRequest(`/messages/${encodeURIComponent(id)}`, {
      method: "GET",
      query: { format: "metadata", metadataHeaders: METADATA_HEADERS },
    }).then((detail) => formatMessage(detail, "metadata")),
  );

  // One unreadable message must not lose the other ninety-nine.
  const messages = detailed.filter(Boolean);
  return jsonResult({ messages, resultSizeEstimate: list?.resultSizeEstimate ?? messages.length });
}

async function handleGetMessage(args = {}) {
  const id = String(args.id ?? "").trim();
  if (!id) return errorResult("gmail_get_message requires an 'id'.");
  const format = args.format === "metadata" ? "metadata" : "full";

  const message = await gmailRequest(`/messages/${encodeURIComponent(id)}`, {
    method: "GET",
    query: { format, metadataHeaders: METADATA_HEADERS },
  });
  if (!message) return errorResult(`No Gmail message with id "${id}".`);
  return jsonResult(formatMessage(message, format));
}

async function handleSendMessage(args = {}) {
  const to = String(args.to ?? "").trim();
  const subject = String(args.subject ?? "");
  const body = String(args.body ?? "");

  if (!to || !subject || !body) {
    return errorResult("gmail_send_message requires 'to', 'subject' and 'body'.");
  }
  // A newline interpolated into a header is header injection: it lets a caller
  // append Bcc or rewrite the MIME structure. Refused rather than stripped, so
  // the caller learns its input was rejected.
  const injected = findHeaderInjection({ to, subject });
  if (injected) return errorResult(`The '${injected}' value must not contain line breaks.`);
  if (!looksLikeEmail(to)) return errorResult(`"${to}" does not look like an email address.`);

  const sent = await gmailRequest("/messages/send", {
    method: "POST",
    body: { raw: buildRawMessage({ to, subject, body }) },
  });
  return jsonResult({ id: sent?.id ?? null, threadId: sent?.threadId ?? null, to, subject });
}

// ── server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: gmailTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Credentials are resolved *inside* the try, so "not configured" arrives as a
  // tool result the caller can act on instead of a JSON-RPC error.
  try {
    const missing = missingGoogleConfig();
    if (missing.length) {
      return errorResult(`Gmail is not configured. Set ${missing.join(", ")} in Settings, then reconnect Google.`);
    }

    switch (name) {
      case "gmail_list_messages":
        return await handleListMessages(args);
      case "gmail_get_message":
        return await handleGetMessage(args);
      case "gmail_send_message":
        return await handleSendMessage(args);
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = describeError(err);
    log(`${name} failed: ${message}`);
    return errorResult(`Gmail ${name} failed: ${message}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio`);
