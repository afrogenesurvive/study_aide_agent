import type { McpExit, McpTransport } from "../../services/mcp";

/**
 * An in-memory MCP server.
 *
 * The whole point of the `McpTransport` seam is that no test in this repository
 * ever spawns a process, so this stands in for the child: `send` records what the
 * client wrote and answers from `handler`, exactly as a server would.
 */

export interface SentMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
}

export class FakeTransport implements McpTransport {
  readonly sent: SentMessage[] = [];

  startCalls = 0;
  closed = false;
  /** Make `start` fail, as a spawn error would. */
  startError: Error | null = null;
  /** Make every `send` fail, as a broken pipe would. */
  sendError: Error | null = null;
  /**
   * Answer a request. Return `undefined` to leave it unanswered, which is how a
   * hang is simulated.
   */
  handler: (message: SentMessage) => unknown = () => undefined;

  private lineHandler: ((line: string) => void) | null = null;
  private exitHandler: ((info: McpExit) => void) | null = null;

  start(): Promise<void> {
    this.startCalls += 1;
    return this.startError ? Promise.reject(this.startError) : Promise.resolve();
  }

  send(line: string): Promise<void> {
    const message = JSON.parse(line) as SentMessage;
    this.sent.push(message);
    if (this.sendError) return Promise.reject(this.sendError);

    // Answered synchronously, which is safe: the client registers its pending
    // entry before it calls `send`.
    if (message.id !== undefined && message.method) {
      const result = this.handler(message);
      if (result !== undefined) {
        this.deliver({ jsonrpc: "2.0", id: message.id, result });
      }
    }
    return Promise.resolve();
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onExit(handler: (info: McpExit) => void): void {
    this.exitHandler = handler;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  // ── test controls ──────────────────────────────────────────────────────────

  deliver(message: unknown): void {
    this.lineHandler?.(JSON.stringify(message));
  }

  deliverRaw(line: string): void {
    this.lineHandler?.(line);
  }

  deliverError(id: number, code: number, message: string): void {
    this.deliver({ jsonrpc: "2.0", id, error: { code, message } });
  }

  exit(code: number | null = 1, signal: string | null = null): void {
    this.exitHandler?.({ code, signal });
  }

  requestsTo(method: string): SentMessage[] {
    return this.sent.filter((message) => message.method === method);
  }
}

export interface FakeServerOptions {
  name?: string;
  version?: string;
  protocolVersion?: string;
  tools?: string[];
  /** Answer anything beyond initialize / tools/list. */
  onCall?: (message: SentMessage) => unknown;
}

/** A transport that completes a handshake and lists tools. */
export function fakeServer(options: FakeServerOptions = {}): FakeTransport {
  const transport = new FakeTransport();
  const tools = options.tools ?? ["gmail_list_messages"];

  transport.handler = (message) => {
    if (message.method === "initialize") {
      return {
        protocolVersion: options.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: options.name ?? "fake-server", version: options.version ?? "1.0.0" },
      };
    }
    if (message.method === "tools/list") {
      return {
        tools: tools.map((name) => ({
          name,
          description: `${name} description`,
          inputSchema: { type: "object" },
        })),
      };
    }
    if (message.method === "tools/call") return options.onCall?.(message);
    return undefined;
  };

  return transport;
}

/** A successful `tools/call` whose payload is JSON in a text block, as the servers send it. */
export function textToolResult(payload: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}
