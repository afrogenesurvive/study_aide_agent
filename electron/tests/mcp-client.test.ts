import { afterEach, describe, expect, it, vi } from "vitest";

import { McpClient } from "../services/mcp/client";
import { McpErrorCode } from "../services/mcp/protocol";
import { FakeTransport, fakeServer, textToolResult, type SentMessage } from "./helpers/mcp-fixtures";

/**
 * The client is driven entirely by `FakeTransport`, so nothing here starts a
 * process, opens a socket or needs a credential.
 */

function connect(transport: FakeTransport, requestTimeoutMs?: number): McpClient {
  return new McpClient({
    name: "test",
    version: "0.0.0",
    transport,
    requestTimeoutMs,
  });
}

describe("McpClient handshake", () => {
  it("initializes, then announces itself", async () => {
    const transport = fakeServer({ name: "study-aide-gmail" });
    const client = connect(transport);

    await client.connect();

    expect(transport.startCalls).toBe(1);
    expect(client.getState()).toBe("ready");
    // Order matters: the notification must follow the initialize request.
    expect(transport.sent.map((message) => message.method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(client.getServerInfo()).toEqual({ name: "study-aide-gmail", version: "1.0.0" });
  });

  it("advertises no capabilities", async () => {
    // Declaring `roots` or `sampling` would have the server send us requests we
    // can only refuse, so the empty object is a contract, not an oversight.
    const transport = fakeServer();
    await connect(transport).connect();
    expect((transport.requestsTo("initialize")[0].params as { capabilities: unknown }).capabilities).toEqual({});
  });

  it("tolerates a server that answers with a different protocol version", async () => {
    const transport = fakeServer({ protocolVersion: "2024-11-05" });
    const client = connect(transport);
    await client.connect();
    expect(client.getState()).toBe("ready");
  });

  it("reports a transport that cannot start, and does not stay half-open", async () => {
    const transport = fakeServer();
    transport.startError = new Error("spawn ENOENT");
    const client = connect(transport);

    await expect(client.connect()).rejects.toThrow(/Could not start test/);
    expect(client.getState()).toBe("closed");
  });

  it("refuses a request before connect", async () => {
    const client = connect(fakeServer());
    await expect(client.listTools()).rejects.toThrow(/has not been started/);
  });

  it("is idempotent", async () => {
    const transport = fakeServer();
    const client = connect(transport);
    await client.connect();
    await client.connect();
    expect(transport.startCalls).toBe(1);
  });
});

describe("McpClient.listTools", () => {
  it("returns what the server advertises", async () => {
    const transport = fakeServer({ tools: ["gmail_list_messages", "gmail_get_message"] });
    const client = connect(transport);
    await client.connect();

    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      "gmail_list_messages",
      "gmail_get_message",
    ]);
  });

  it("drops an entry with no name rather than throwing", async () => {
    const transport = fakeServer();
    transport.handler = (message) => {
      if (message.method === "initialize") return { protocolVersion: "2025-06-18" };
      if (message.method === "tools/list") return { tools: [{ name: "" }, { name: "ok" }] };
      return undefined;
    };
    const client = connect(transport);
    await client.connect();
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["ok"]);
  });
});

describe("McpClient.callTool", () => {
  it("parses a JSON payload out of the text block", async () => {
    const transport = fakeServer({ onCall: () => textToolResult({ messages: [{ id: "m1" }] }) });
    const client = connect(transport);
    await client.connect();

    const result = await client.callTool("gmail_list_messages", { maxResults: 1 });

    expect(result).toMatchObject({ ok: true, error: null, retryable: false });
    expect(result.data).toEqual({ messages: [{ id: "m1" }] });
    const call = transport.requestsTo("tools/call")[0];
    expect(call.params).toEqual({ name: "gmail_list_messages", arguments: { maxResults: 1 } });
  });

  it("returns a tool-reported error as a resolved failure, not a rejection", async () => {
    // MCP carries {isError: true} inside a normal response, so a caller that had
    // to try/catch would be handling the common case as an exception.
    const transport = fakeServer({
      onCall: () => ({ content: [{ type: "text", text: "Gmail is not configured." }], isError: true }),
    });
    const client = connect(transport);
    await client.connect();

    const result = await client.callTool("gmail_list_messages", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Gmail is not configured.");
    expect(result.retryable).toBe(false);
  });

  it("prefers structuredContent when the server sends it", async () => {
    const transport = fakeServer({
      onCall: () => ({ content: [{ type: "text", text: "ignored" }], structuredContent: { calendars: [] } }),
    });
    const client = connect(transport);
    await client.connect();

    const result = await client.callTool("calendar_list_calendars", {});
    expect(result.data).toEqual({ calendars: [] });
  });

  it("falls back to raw text when the payload is not JSON", async () => {
    const transport = fakeServer({ onCall: () => ({ content: [{ type: "text", text: "just words" }] }) });
    const client = connect(transport);
    await client.connect();

    const result = await client.callTool("calendar_list_calendars", {});
    expect(result.data).toBe("just words");
  });

  it("treats an empty payload as null rather than a parse failure", async () => {
    const transport = fakeServer({ onCall: () => ({ content: [] }) });
    const client = connect(transport);
    await client.connect();
    expect((await client.callTool("calendar_list_calendars", {})).data).toBeNull();
  });

  it("reports a JSON-RPC error as a failure", async () => {
    const transport = fakeServer();
    const client = connect(transport);
    await client.connect();

    transport.handler = () => undefined;
    const pending = client.callTool("gmail_list_messages", {});
    transport.deliverError(2, McpErrorCode.MethodNotFound, "no such tool");

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no such tool");
  });
});

describe("McpClient failure handling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out a request rather than hanging forever", async () => {
    vi.useFakeTimers();
    const transport = fakeServer();
    // tools/call is never answered.
    const client = connect(transport, 1_000);
    await client.connect();

    const pending = client.callTool("gmail_list_messages", {});
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not answer");
    // A timeout is a lost connection, so a caller may reasonably try again.
    expect(result.retryable).toBe(true);
  });

  it("fails everything in flight when the child exits", async () => {
    const transport = fakeServer();
    const client = connect(transport);
    await client.connect();

    const pending = client.callTool("gmail_list_messages", {});
    transport.exit(1, null);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited");
    expect(result.retryable).toBe(true);
    expect(client.getState()).toBe("closed");
  });

  it("reports a write failure instead of leaving the request pending", async () => {
    const transport = fakeServer();
    const client = connect(transport);
    await client.connect();

    transport.sendError = new Error("EPIPE");
    const result = await client.callTool("gmail_list_messages", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Could not write");
  });

  it("refuses a server-initiated request instead of staying silent", async () => {
    // We declared no capabilities, so silence would hang the server.
    const transport = fakeServer();
    const client = connect(transport);
    await client.connect();

    transport.deliver({ jsonrpc: "2.0", id: 99, method: "roots/list" });

    const refusal = transport.sent.find((message) => message.id === 99) as
      | { id: number; error?: { code: number; message: string } }
      | undefined;
    expect(refusal?.error?.code).toBe(McpErrorCode.MethodNotFound);
    expect(refusal?.error?.message).toContain("roots/list");
  });

  it("survives an unreadable line", async () => {
    const transport = fakeServer({ onCall: () => textToolResult({ calendars: [] }) });
    const client = connect(transport);
    await client.connect();

    transport.deliverRaw("{ this is not json");
    expect(client.getState()).toBe("ready");
    expect((await client.callTool("calendar_list_calendars", {})).ok).toBe(true);
  });

  it("ignores a reply that arrives after its timeout", async () => {
    vi.useFakeTimers();
    const transport = fakeServer();
    const client = connect(transport, 1_000);
    await client.connect();

    const pending = client.callTool("gmail_list_messages", {});
    await vi.advanceTimersByTimeAsync(1_500);
    // Late answer: must not throw and must not be attributed to anything else.
    transport.deliver({ jsonrpc: "2.0", id: 2, result: textToolResult({ messages: [] }) });

    expect((await pending).ok).toBe(false);
  });
});

describe("McpClient.close", () => {
  it("closes the transport and rejects anything pending", async () => {
    const transport = fakeServer();
    const client = connect(transport);
    await client.connect();

    const pending = client.callTool("gmail_list_messages", {});
    await client.close();

    expect(transport.closed).toBe(true);
    expect(client.getState()).toBe("closed");
    expect((await pending).ok).toBe(false);
  });

  it("refuses new work once closed", async () => {
    const transport = fakeServer();
    const client = connect(transport);
    await client.connect();
    await client.close();

    const result = await client.callTool("gmail_list_messages", {});
    expect(result.ok).toBe(false);
    // Retryable: a closed connection is precisely what the manager recovers from
    // by spawning a fresh child on the next call.
    expect(result.retryable).toBe(true);
  });
});
