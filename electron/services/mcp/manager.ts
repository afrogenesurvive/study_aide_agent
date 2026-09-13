/**
 * The MCP server pool.
 *
 * Owns one `McpClient` per server and decides when a child has to be replaced.
 *
 * Two pieces of policy live here rather than in `src/main/mcp.ts`, because they
 * are logic and the spawn call is not:
 *
 *  - **Lazy start.** A child is spawned on the first tool call, not at boot, so a
 *    user who never touches Google never pays for two Node processes.
 *  - **Recycle on a credential change.** Each spec exposes a *fingerprint* of the
 *    settings the child reads from its environment. It is checked before every
 *    call, so editing the client id or the refresh token in Settings takes effect
 *    on the next call instead of needing an app restart. The implementation this
 *    was ported from had no equivalent: its MCP children were started once at
 *    boot, so a new token did nothing until the whole app restarted.
 *
 * Calls to one server are serialised. Servers are separate processes, but nothing
 * is gained by racing two `calendar_create_event` calls at the same calendar, and
 * MCP gives no ordering guarantee for concurrent requests.
 */

import type { ServiceLogger } from "../types";
import { McpClient, type McpClientState, type McpToolResult, type McpTransport } from "./client";
import { McpError, McpErrorCode, describeMcpError } from "./protocol";

export interface McpServerSpec {
  /** Matches the tool manifest's `GOOGLE_TOOL_SERVERS` values. */
  name: string;
  /** Builds a fresh transport. Called on first use and after a recycle. */
  createTransport: () => McpTransport;
  /**
   * Everything the child reads from its environment, hashed or concatenated.
   *
   * When this changes, the live child is holding stale credentials and must be
   * replaced.
   */
  fingerprint: () => string;
}

export interface McpServerState {
  name: string;
  state: McpClientState;
  /** The server's own name and version, once it has hand-shaken. */
  serverName: string | null;
  serverVersion: string | null;
  toolCount: number | null;
  lastError: string | null;
}

export interface McpManagerOptions {
  /** The app version, sent as the MCP client version. */
  version: string;
  requestTimeoutMs?: number;
  log?: ServiceLogger;
}

interface Entry {
  spec: McpServerSpec;
  client: McpClient | null;
  fingerprint: string;
  toolCount: number | null;
  lastError: string | null;
}

export class McpManager {
  private readonly entries = new Map<string, Entry>();
  private readonly options: McpManagerOptions;
  private readonly log: ServiceLogger;
  /** One promise chain per server, so calls to a server never overlap. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(specs: McpServerSpec[], options: McpManagerOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    for (const spec of specs) {
      this.entries.set(spec.name, {
        spec,
        client: null,
        fingerprint: "",
        toolCount: null,
        lastError: null,
      });
    }
  }

  /** True when a spec exists for this server. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Every configured server, in declaration order. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Run a tool. Never throws — a missing server, a failed spawn and a tool that
   * reported an error all come back as `{ok: false}`.
   */
  call(server: string, tool: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const entry = this.entries.get(server);
    if (!entry) {
      return Promise.resolve({
        ok: false,
        data: null,
        error: `No MCP server named "${server}".`,
        retryable: false,
      });
    }

    return this.chain(server, async () => {
      try {
        const client = await this.ensureClient(entry);
        return await client.callTool(tool, args);
      } catch (err) {
        const message = describeMcpError(err);
        entry.lastError = message;
        // A failure to start or hand-shake is worth retrying: the child may have
        // died between calls, and the next call spawns a fresh one.
        return { ok: false, data: null, error: message, retryable: true };
      }
    });
  }

  /**
   * Ask one server what it exposes.
   *
   * Used by the Settings panel, so it reports rather than throws.
   */
  async describe(name: string): Promise<McpServerState | null> {
    const entry = this.entries.get(name);
    if (!entry) return null;
    return this.chain(name, async () => {
      try {
        const client = await this.ensureClient(entry);
        entry.lastError = null;
        const info = client.getServerInfo();
        return {
          name,
          state: client.getState(),
          serverName: info?.name ?? null,
          serverVersion: info?.version ?? null,
          toolCount: entry.toolCount,
          lastError: null,
        };
      } catch (err) {
        const message = describeMcpError(err);
        entry.lastError = message;
        return {
          name,
          state: entry.client?.getState() ?? "idle",
          serverName: null,
          serverVersion: null,
          toolCount: null,
          lastError: message,
        };
      }
    });
  }

  /** Every server's state, for the status payload. */
  async describeAll(): Promise<McpServerState[]> {
    const states = await Promise.all(this.names().map((name) => this.describe(name)));
    return states.filter((state): state is McpServerState => state !== null);
  }

  /**
   * Report every server's state **without starting anything**.
   *
   * `describe` connects, which is right for a "test connection" button and wrong
   * for a status panel: opening Settings should not spawn two Node processes.
   */
  snapshot(): McpServerState[] {
    return this.names().map((name) => {
      const entry = this.entries.get(name);
      const info = entry?.client?.getServerInfo() ?? null;
      return {
        name,
        state: entry?.client?.getState() ?? "idle",
        serverName: info?.name ?? null,
        serverVersion: info?.version ?? null,
        toolCount: entry?.toolCount ?? null,
        lastError: entry?.lastError ?? null,
      };
    });
  }

  /**
   * Drop the live child, optionally just one.
   *
   * The next call to that server spawns a fresh process. Exposed to the Settings
   * panel for the case where something is wrong and retrying is the obvious move.
   */
  async restart(name?: string): Promise<void> {
    const targets = name ? [name] : this.names();
    await Promise.all(
      targets.map((target) =>
        this.chain(target, async () => {
          const entry = this.entries.get(target);
          if (!entry?.client) return;
          await entry.client.close();
          entry.client = null;
          entry.fingerprint = "";
          entry.toolCount = null;
        }),
      ),
    );
  }

  /** Close every child. Called from `before-quit`. */
  async stopAll(): Promise<void> {
    await Promise.all(
      this.names().map((name) =>
        this.chain(name, async () => {
          const entry = this.entries.get(name);
          if (!entry?.client) return;
          await entry.client.close();
          entry.client = null;
          entry.fingerprint = "";
          entry.toolCount = null;
        }),
      ),
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * The live client for this server, spawning or replacing the child as needed.
   *
   * Throws (a `McpError`) when the child cannot be started, so `call` and
   * `describe` can each report it in the shape their caller wants.
   */
  private async ensureClient(entry: Entry): Promise<McpClient> {
    const fingerprint = entry.spec.fingerprint();

    if (entry.client && entry.fingerprint === fingerprint) {
      const state = entry.client.getState();
      if (state === "ready") return entry.client;
      // "closed" means the child died. Fall through and replace it.
      if (state !== "closed") return entry.client;
    }

    if (entry.client) {
      if (entry.fingerprint !== fingerprint) {
        this.log("info", `${entry.spec.name}: settings changed, restarting the MCP server.`);
      }
      await entry.client.close();
      entry.client = null;
    }

    const client = new McpClient({
      name: entry.spec.name,
      version: this.options.version,
      transport: entry.spec.createTransport(),
      requestTimeoutMs: this.options.requestTimeoutMs,
      log: this.log,
    });

    try {
      await client.connect();
      // Listing validates that the server actually exposes tools, and gives the
      // status panel a count without a second round trip later.
      entry.toolCount = (await client.listTools()).length;
    } catch (err) {
      entry.lastError = describeMcpError(err);
      await client.close().catch(() => {});
      throw err instanceof McpError
        ? err
        : new McpError(McpErrorCode.ConnectionClosed, `Could not start ${entry.spec.name}: ${describeMcpError(err)}`);
    }

    entry.client = client;
    entry.fingerprint = fingerprint;
    entry.lastError = null;
    this.log("info", `${entry.spec.name}: MCP server ready (${entry.toolCount} tool(s)).`);
    return client;
  }

  /** Run `fn` after whatever is already queued for this server. */
  private chain<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(name) ?? Promise.resolve();
    // `then(fn, fn)` so one failed call does not wedge the queue behind it.
    const next = previous.then(fn, fn);
    this.chains.set(
      name,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}
