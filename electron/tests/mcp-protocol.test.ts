import { describe, expect, it } from "vitest";

import {
  JSONRPC_VERSION,
  McpError,
  McpErrorCode,
  clipForLog,
  encodeError,
  encodeNotification,
  encodeRequest,
  isConnectionLost,
  parseLine,
} from "../services/mcp/protocol";

/**
 * The wire format is the contract between this client and the SDK-based servers.
 * A framing bug here would look like a dead server, so every message shape is
 * pinned rather than exercised incidentally through the client.
 */

describe("encodeRequest", () => {
  it("emits one JSON-RPC line, newline terminated", () => {
    const line = encodeRequest(7, "tools/list", {});
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      jsonrpc: JSONRPC_VERSION,
      id: 7,
      method: "tools/list",
      params: {},
    });
  });

  it("omits params rather than sending undefined", () => {
    expect(JSON.parse(encodeRequest(1, "ping"))).not.toHaveProperty("params");
  });

  it("sends no id on a notification", () => {
    const message = JSON.parse(encodeNotification("notifications/initialized"));
    expect(message).not.toHaveProperty("id");
    expect(message.method).toBe("notifications/initialized");
  });

  it("formats an error response", () => {
    const message = JSON.parse(encodeError(3, McpErrorCode.MethodNotFound, "nope"));
    expect(message.id).toBe(3);
    expect(message.error).toEqual({ code: -32601, message: "nope" });
  });
});

describe("parseLine", () => {
  it("reads a success response", () => {
    expect(parseLine('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}')).toEqual({
      kind: "success",
      id: 2,
      result: { tools: [] },
    });
  });

  it("reads a JSON-RPC error, defaulting a missing code", () => {
    const parsed = parseLine('{"jsonrpc":"2.0","id":4,"error":{"message":"boom"}}');
    expect(parsed.kind).toBe("failure");
    if (parsed.kind !== "failure") return;
    expect(parsed.error.message).toBe("boom");
    expect(parsed.error.code).toBe(McpErrorCode.InternalError);
  });

  it("tells a server request from a response", () => {
    // Both carry an id; only a request carries a method. Confusing the two would
    // leave a server waiting forever for an answer we never sent.
    const parsed = parseLine('{"jsonrpc":"2.0","id":9,"method":"roots/list"}');
    expect(parsed.kind).toBe("request");
    if (parsed.kind !== "request") return;
    expect(parsed.method).toBe("roots/list");
  });

  it("reads a notification", () => {
    const parsed = parseLine('{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}');
    expect(parsed).toEqual({
      kind: "notification",
      method: "notifications/message",
      params: { level: "info" },
    });
  });

  it("reports a bad line without throwing", () => {
    // One unreadable line must cost one message, never the connection.
    for (const line of ["", "   ", "not json", "[1,2,3]", '{"jsonrpc":"2.0"}']) {
      const parsed = parseLine(line);
      expect(parsed.kind).toBe("invalid");
    }
  });

  it("refuses an over-long line before parsing it", () => {
    const parsed = parseLine("x".repeat(5_000_000));
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind !== "invalid") return;
    expect(parsed.reason).toContain("too long");
  });

  it("keeps a JSON body that is not an object out of the success path", () => {
    // A bare string is valid JSON but not a valid message.
    expect(parseLine('"hello"').kind).toBe("invalid");
  });
});

describe("clipForLog", () => {
  it("flattens whitespace and caps the length", () => {
    const clipped = clipForLog("a\n\nb   c");
    expect(clipped).toBe("a b c");
    expect(clipForLog("x".repeat(2_000)).length).toBeLessThanOrEqual(501);
  });

  it("survives a value that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(clipForLog(cyclic)).toContain("object");
  });
});

describe("McpError", () => {
  it("carries its code", () => {
    const err = new McpError(McpErrorCode.RequestTimeout, "timed out");
    expect(err.code).toBe(-32001);
    expect(err.message).toBe("timed out");
  });

  it("treats only connection-level codes as lost connections", () => {
    expect(isConnectionLost(new McpError(McpErrorCode.ConnectionClosed, "gone"))).toBe(true);
    expect(isConnectionLost(new McpError(McpErrorCode.RequestTimeout, "slow"))).toBe(true);
    // A bad argument is not a lost connection — retrying it would just fail again.
    expect(isConnectionLost(new McpError(McpErrorCode.InvalidParams, "bad"))).toBe(false);
    expect(isConnectionLost(new Error("plain"))).toBe(false);
  });
});
