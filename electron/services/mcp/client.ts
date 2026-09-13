/**
 * The MCP client: one connection to one stdio server.
 *
 * The transport is an injected interface, not a spawn call, for the same reason
 * `generation/transport.ts` takes a `RunnerTransport`: a test can drive the whole
 * protocol — handshake, tool listing, a tool call, a timeout, a mid-request exit
 * — without starting a process or touching the network. `src/main/mcp.ts` is the
 * only place that spawns anything.
 *
 * Two behaviours worth knowing:
 *
 *  - **A tool that reports an error is a success at the protocol level.** MCP
 *    carries `{isError: true}` inside a normal response, so `callTool` resolves;
 *    the caller branches on `result.ok`. Only framing failures, timeouts and a
 *    lost child become rejections, and `callTool` converts those too, so the
 *    layer above never has to try/catch.
 *  - **A dying child rejects everything in flight.** Without that, a tool call
 *    would hang until its timeout and the reason would be lost.
 */

import type { ServiceLogger } from "../types";
import {
  MCP_PROTOCOL_VERSION,
  McpError,
  McpErrorCode,
  clipForLog,
  describeMcpError,
  encodeError,
  encodeNotification,
  encodeRequest,
  isConnectionLost,
  parseLine,
} from "./protocol";

export interface McpExit {
  code: number | null;
  signal: string | null;
}

/**
 * How the client reaches a server.
 *
 * `onLine` is called once per stdout line and `onExit` once when the child ends,
 * in either order — implementations must tolerate a line arriving after an exit.
 */
export interface McpTransport {
  start(): Promise<void>;
  send(line: string): Promise<void>;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (info: McpExit) => void): void;
  close(): Promise<void>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpToolResult {
  ok: boolean;
  /** The decoded payload — the server sends JSON in a text block. */
  data: unknown;
  error: string | null;
  /** True when the failure was a lost connection, so trying again may help. */
  retryable: boolean;
}

export type McpClientState = "idle" | "connecting" | "ready" | "closed";

export interface McpClientOptions {
  /** Used in every message, so a log line says which server failed. */
  name: string;
  version: string;
  transport: McpTransport;
  requestTimeoutMs?: number;
  log?: ServiceLogger;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The joined text of a tool result's content blocks. */
function textOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null) {
        const typed = block as { type?: unknown; text?: unknown };
        if (typed.type === "text" && typeof typed.text === "string") return typed.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export class McpClient {
  readonly name: string;

  private readonly log: ServiceLogger;
  private readonly transport: McpTransport;
  private readonly requestTimeoutMs: number;
  private readonly version: string;

  private nextId = 1;
  private pending = new Map<number, Pending>();
  private state: McpClientState = "idle";
  private closed = false;
  private serverInfo: { name: string; version: string } | null = null;
  private negotiatedVersion: string | null = null;

  constructor(options: McpClientOptions) {
    this.name = options.name;
    this.version = options.version;
    this.transport = options.transport;
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.log = options.log ?? (() => {});
    this.transport.onLine((line) => this.handleLine(line));
    this.transport.onExit((info) => this.handleExit(info));
  }

  getState(): McpClientState {
    return this.state;
  }

  getServerInfo(): { name: string; version: string } | null {
    return this.serverInfo;
  }

  /**
   * Start the transport and complete the MCP handshake.
   *
   * Throws on failure; the manager turns that into a reported state rather than
   * letting it escape to a caller.
   */
  async connect(): Promise<void> {
    if (this.state === "ready") return;
    if (this.closed) throw new McpError(McpErrorCode.ConnectionClosed, `${this.name} is closed.`);

    this.state = "connecting";
    try {
      await this.transport.start();
    } catch (err) {
      this.state = "closed";
      throw new McpError(
        McpErrorCode.ConnectionClosed,
        `Could not start ${this.name}: ${describeMcpError(err)}`,
      );
    }

    try {
      const result = await this.request("initialize", {
        // We advertise no client capabilities on purpose: no `roots`, no
        // `sampling`, no `elicitation`. Declaring one we do not implement would
        // have the server send us requests we can only refuse.
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "study-aide", version: this.version },
      });

      const info = result as { protocolVersion?: unknown; serverInfo?: unknown } | null;
      this.negotiatedVersion =
        typeof info?.protocolVersion === "string" ? info.protocolVersion : MCP_PROTOCOL_VERSION;

      const serverInfo = info?.serverInfo as { name?: unknown; version?: unknown } | undefined;
      if (serverInfo) {
        this.serverInfo = {
          name: typeof serverInfo.name === "string" ? serverInfo.name : this.name,
          version: typeof serverInfo.version === "string" ? serverInfo.version : "",
        };
      }

      if (this.negotiatedVersion !== MCP_PROTOCOL_VERSION) {
        // MCP requires the server to answer with a version it supports rather
        // than fail, so this is informational: the message shapes we use are
        // stable across the versions that matter.
        this.log(
          "info",
          `${this.name} negotiated MCP protocol ${this.negotiatedVersion} (asked for ${MCP_PROTOCOL_VERSION}).`,
        );
      }

      await this.transport.send(encodeNotification("notifications/initialized"));
      this.state = "ready";
    } catch (err) {
      this.state = "closed";
      await this.safeClose();
      throw err instanceof McpError
        ? err
        : new McpError(McpErrorCode.InternalError, `Could not hand-shake with ${this.name}: ${describeMcpError(err)}`);
    }
  }

  /** Ask the server what it can do. Throws; `callTool` is the forgiving path. */
  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request("tools/list", {})) as { tools?: unknown } | null;
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools
      .map((tool) => {
        const entry = tool as { name?: unknown; description?: unknown; inputSchema?: unknown };
        return {
          name: typeof entry.name === "string" ? entry.name : "",
          description: typeof entry.description === "string" ? entry.description : "",
          inputSchema: entry.inputSchema ?? null,
        };
      })
      .filter((tool) => tool.name);
  }

  /**
   * Run one tool.
   *
   * Never throws and never rejects: a tool-level failure, a protocol failure and
   * a dead child all come back as `{ok: false}`. Callers report the error rather
   * than unwinding a run.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    try {
      const result = (await this.request("tools/call", { name, arguments: args })) as {
        isError?: unknown;
        structuredContent?: unknown;
      } | null;

      const text = textOf(result);
      if (result?.isError) {
        return {
          ok: false,
          data: null,
          error: clipForLog(text || `${this.name} reported an error.`),
          retryable: false,
        };
      }
      if (result?.structuredContent !== undefined) {
        return { ok: true, data: result.structuredContent, error: null, retryable: false };
      }
      return { ok: true, data: parsePayload(text), error: null, retryable: false };
    } catch (err) {
      return {
        ok: false,
        data: null,
        error: describeMcpError(err),
        retryable: isConnectionLost(err),
      };
    }
  }

  /** Close the connection. Safe to call twice. */
  async close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
    this.failPending(
      new McpError(McpErrorCode.ConnectionClosed, `${this.name} was closed.`),
    );
    await this.safeClose();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private request(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.closed || this.state === "closed") {
      return Promise.reject(new McpError(McpErrorCode.ConnectionClosed, `${this.name} is not connected.`));
    }
    if (this.state === "idle") {
      return Promise.reject(new McpError(McpErrorCode.ConnectionClosed, `${this.name} has not been started.`));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpError(
            McpErrorCode.RequestTimeout,
            `${this.name} did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`,
          ),
        );
      }, timeoutMs);
      // A pending request must not be the only thing keeping the process alive —
      // the app owns its own lifetime, and a forgotten timer would delay a quit.
      timer.unref?.();

      this.pending.set(id, { method, resolve, reject, timer });

      this.transport.send(encodeRequest(id, method, params)).catch((err) => {
        this.settleFailure(
          id,
          new McpError(McpErrorCode.ConnectionClosed, `Could not write to ${this.name}: ${describeMcpError(err)}`),
        );
      });
    });
  }

  private handleLine(line: string): void {
    const incoming = parseLine(line);

    switch (incoming.kind) {
      case "success": {
        const entry = this.pending.get(incoming.id);
        if (!entry) return; // Late reply to something already timed out.
        this.pending.delete(incoming.id);
        clearTimeout(entry.timer);
        entry.resolve(incoming.result);
        return;
      }
      case "failure": {
        this.settleFailure(
          incoming.id,
          new McpError(incoming.error.code, incoming.error.message, incoming.error.data),
        );
        return;
      }
      case "request": {
        // Nothing here implements roots, sampling or elicitation, and we declared
        // none of them. Refusing is correct; staying silent would hang the server.
        this.log("debug", `${this.name} asked for "${incoming.method}"; refusing (not supported).`);
        void this.transport
          .send(encodeError(incoming.id, McpErrorCode.MethodNotFound, `Not supported: ${incoming.method}`))
          .catch(() => {});
        return;
      }
      case "notification": {
        // `notifications/message` (logging) and progress updates are the common
        // ones. Debug level: a server that logs on every request would otherwise
        // flood the Dev panel.
        this.log("debug", `${this.name} → ${incoming.method}`);
        return;
      }
      case "invalid": {
        // One bad line costs one message. Logged with the reason, not the payload.
        this.log("warn", `${this.name} sent an unreadable message (${incoming.reason}).`);
      }
    }
  }

  private handleExit(info: McpExit): void {
    const how = info.signal ? `signal ${info.signal}` : `code ${info.code ?? "unknown"}`;
    this.state = "closed";
    this.closed = true;
    this.log("warn", `${this.name} exited (${how}).`);
    this.failPending(
      new McpError(McpErrorCode.ConnectionClosed, `${this.name} exited (${how}).`),
    );
  }

  private settleFailure(id: number, error: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  private failPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private async safeClose(): Promise<void> {
    try {
      await this.transport.close();
    } catch {
      // Already gone. Nothing useful to report.
    }
  }
}

/**
 * The servers send JSON in a text block. Fall back to the raw text so a server
 * that returns prose still yields something a caller can show.
 */
function parsePayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}
