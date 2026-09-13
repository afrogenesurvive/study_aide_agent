/**
 * The JSON-RPC 2.0 subset that MCP uses over stdio.
 *
 * Hand-rolled rather than taken from `@modelcontextprotocol/sdk`, because the
 * SDK would become a dependency of the *main process* — 16 transitive packages
 * including Express and Hono, all of which would then have to be bundled at
 * packaging time for a handful of method names. The servers still use the SDK,
 * so the wire format is the contract between them and this file is the client
 * half of it. Nothing here depends on Electron, so it is unit-testable.
 *
 * The framing is newline-delimited JSON: one message per line, nothing else, on
 * both sides. That is the same shape `agent-runner/protocol.ts` established for
 * the generation child, and it carries the same hazard — anything that prints to
 * stdout corrupts the stream.
 */

export const JSONRPC_VERSION = "2.0";

/**
 * The version this client asks for.
 *
 * The server answers with the version it will actually speak, which may differ;
 * `client.ts` reports a mismatch rather than failing, because MCP requires the
 * server to downgrade rather than error.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** MCP's own error codes, plus the two the transport adds. */
export const McpErrorCode = {
  /** The child exited while a request was outstanding. */
  ConnectionClosed: -32000,
  /** No reply within the per-request timeout. */
  RequestTimeout: -32001,
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type McpErrorCode = (typeof McpErrorCode)[keyof typeof McpErrorCode];

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number;
  error: JsonRpcErrorShape;
}

/** A failure at the protocol level, as opposed to a tool that reported an error. */
export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

/** Which of MCP's message shapes a decoded line is. */
export type McpIncoming =
  | { kind: "success"; id: number; result: unknown }
  | { kind: "failure"; id: number; error: JsonRpcErrorShape }
  /** The server asking *us* for something. Answered with "method not found". */
  | { kind: "request"; id: number; method: string; params?: unknown }
  | { kind: "notification"; method: string; params?: unknown }
  /** A line that is not decodable. Logged and skipped, never fatal. */
  | { kind: "invalid"; raw: string; reason: string };

const MAX_INCOMING_LINE = 4_000_000;
const MAX_ERROR_TEXT = 500;

/** One message, framed for the wire. The newline is part of the frame. */
export function encodeMessage(message: JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure): string {
  return `${JSON.stringify(message)}\n`;
}

export function encodeRequest(id: number, method: string, params?: unknown): string {
  return encodeMessage({ jsonrpc: JSONRPC_VERSION, id, method, params });
}

export function encodeNotification(method: string, params?: unknown): string {
  return encodeMessage({ jsonrpc: JSONRPC_VERSION, method, params });
}

export function encodeError(id: number, code: number, message: string): string {
  return encodeMessage({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode one line.
 *
 * Never throws: a malformed line becomes `{kind: "invalid"}`, because a single
 * bad line should cost one message, not the connection. An over-long line is
 * refused before it is parsed, so a runaway child cannot exhaust memory.
 */
export function parseLine(line: string): McpIncoming {
  const text = line.trim();
  if (!text) return { kind: "invalid", raw: "", reason: "empty line" };
  if (text.length > MAX_INCOMING_LINE) {
    return { kind: "invalid", raw: "", reason: `line too long (${text.length} bytes)` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", raw: clipForLog(text), reason: "not JSON" };
  }
  if (!isRecord(parsed)) {
    return { kind: "invalid", raw: clipForLog(text), reason: "not a JSON object" };
  }

  const method = typeof parsed.method === "string" ? parsed.method : null;
  const hasId = typeof parsed.id === "number";
  const id = hasId ? (parsed.id as number) : -1;

  // A message with both an id and a method is the server calling us.
  if (method && hasId) return { kind: "request", id, method, params: parsed.params };
  if (method) return { kind: "notification", method, params: parsed.params };

  if (!hasId) return { kind: "invalid", raw: clipForLog(text), reason: "no id and no method" };

  if (isRecord(parsed.error)) {
    const error = parsed.error;
    return {
      kind: "failure",
      id,
      error: {
        code: typeof error.code === "number" ? error.code : McpErrorCode.InternalError,
        message: typeof error.message === "string" ? error.message : "Unknown MCP error",
        data: error.data,
      },
    };
  }
  return { kind: "success", id, result: parsed.result };
}

/**
 * A one-line, length-capped rendering of anything.
 *
 * Error text from a child is written into the log file and shown in the Dev
 * panel, so it is flattened and bounded rather than passed through.
 */
export function clipForLog(value: unknown, max = MAX_ERROR_TEXT): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A message for a `McpError`, safe to log and to show a user. */
export function describeMcpError(err: unknown): string {
  if (err instanceof McpError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** True for the two codes that mean "the connection is gone", not "bad request". */
export function isConnectionLost(err: unknown): boolean {
  return (
    err instanceof McpError &&
    (err.code === McpErrorCode.ConnectionClosed || err.code === McpErrorCode.RequestTimeout)
  );
}
