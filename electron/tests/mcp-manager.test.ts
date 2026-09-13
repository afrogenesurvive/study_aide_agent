import { describe, expect, it } from "vitest";

import { McpManager, type McpServerSpec } from "../services/mcp/manager";
import { fakeServer, textToolResult, type FakeTransport } from "./helpers/mcp-fixtures";

/**
 * The manager's two pieces of policy are what the phase-4 design turns on: a
 * child starts only when it is needed, and it is replaced when the credentials
 * behind it change. Both are asserted here against fake transports, so no test
 * spawns anything.
 */

interface Harness {
  manager: McpManager;
  transports: FakeTransport[];
  setFingerprint: (value: string) => void;
  transportsMade: () => number;
}

/** A spec whose fingerprint is under the test's control, as Settings would be. */
function harness(onCall?: (name: string) => unknown): Harness {
  let fingerprint = "v1";
  const transports: FakeTransport[] = [];

  const spec: McpServerSpec = {
    name: "calendar",
    createTransport: () => {
      const transport = fakeServer({
        tools: ["calendar_list_events"],
        onCall: () => onCall?.("calendar_list_events") ?? textToolResult({ events: [] }),
      });
      transports.push(transport);
      return transport;
    },
    fingerprint: () => fingerprint,
  };

  return {
    manager: new McpManager([spec], { version: "0.0.0" }),
    transports,
    setFingerprint: (value) => {
      fingerprint = value;
    },
    transportsMade: () => transports.length,
  };
}

describe("McpManager lazy start", () => {
  it("spawns nothing until a call needs it", async () => {
    const { manager, transportsMade } = harness();
    expect(transportsMade()).toBe(0);
    expect(manager.snapshot()[0]).toMatchObject({ name: "calendar", state: "idle", toolCount: null });

    await manager.call("calendar", "calendar_list_events", {});
    expect(transportsMade()).toBe(1);
    expect(manager.snapshot()[0]).toMatchObject({ state: "ready", toolCount: 1 });
  });

  it("reuses the live child for later calls", async () => {
    const { manager, transportsMade } = harness();
    await manager.call("calendar", "calendar_list_events", {});
    await manager.call("calendar", "calendar_list_events", {});
    expect(transportsMade()).toBe(1);
  });

  it("does not spawn a second child when two calls arrive together", async () => {
    // The per-server chain exists so a double-click cannot race two handshakes.
    const { manager, transportsMade } = harness();
    await Promise.all([
      manager.call("calendar", "calendar_list_events", {}),
      manager.call("calendar", "calendar_list_events", {}),
    ]);
    expect(transportsMade()).toBe(1);
  });
});

describe("McpManager credential recycling", () => {
  it("replaces the child when the fingerprint changes", async () => {
    const { manager, transports, setFingerprint, transportsMade } = harness();
    await manager.call("calendar", "calendar_list_events", {});
    expect(transportsMade()).toBe(1);

    // What a token edit in Settings looks like.
    setFingerprint("v2");
    await manager.call("calendar", "calendar_list_events", {});

    expect(transportsMade()).toBe(2);
    expect(transports[0].closed).toBe(true);
    expect(transports[1].closed).toBe(false);
  });

  it("keeps the child when the fingerprint is unchanged", async () => {
    const { manager, transportsMade } = harness();
    await manager.call("calendar", "calendar_list_events", {});
    await manager.call("calendar", "calendar_list_events", {});
    expect(transportsMade()).toBe(1);
  });

  it("replaces a child that died", async () => {
    const { manager, transports, transportsMade } = harness();
    await manager.call("calendar", "calendar_list_events", {});
    transports[0].exit(1, null);

    await manager.call("calendar", "calendar_list_events", {});
    expect(transportsMade()).toBe(2);
  });
});

describe("McpManager failure reporting", () => {
  it("answers with a failure for an unknown server instead of throwing", async () => {
    const { manager } = harness();
    const result = await manager.call("gmail", "gmail_list_messages", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No MCP server named");
  });

  it("reports a refused tool as a failure and keeps the message", async () => {
    const { manager } = harness(() => ({
      content: [{ type: "text", text: "Calendar is not configured." }],
      isError: true,
    }));
    const result = await manager.call("calendar", "calendar_list_events", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Calendar is not configured.");
  });

  it("reports a child that will not start, and tries again next time", async () => {
    let attempts = 0;
    const manager = new McpManager(
      [
        {
          name: "gmail",
          createTransport: () => {
            attempts += 1;
            const transport = fakeServer();
            transport.startError = new Error("spawn ENOENT");
            return transport;
          },
          fingerprint: () => "v1",
        },
      ],
      { version: "0.0.0" },
    );

    const first = await manager.call("gmail", "gmail_list_messages", {});
    expect(first.ok).toBe(false);
    expect(first.retryable).toBe(true);
    expect(manager.snapshot()[0].lastError).toContain("ENOENT");

    // A retry is worthwhile: the failure was transient, so the manager must not
    // have cached the broken client.
    await manager.call("gmail", "gmail_list_messages", {});
    expect(attempts).toBe(2);
  });
});

describe("McpManager lifecycle", () => {
  it("snapshot never starts a child", async () => {
    const { manager, transportsMade } = harness();
    expect(manager.snapshot()).toHaveLength(1);
    expect(transportsMade()).toBe(0);
  });

  it("restart drops the child so the next call rebuilds it", async () => {
    const { manager, transports, transportsMade } = harness();
    await manager.call("calendar", "calendar_list_events", {});

    await manager.restart();
    expect(transports[0].closed).toBe(true);
    expect(manager.snapshot()[0].state).toBe("idle");

    await manager.call("calendar", "calendar_list_events", {});
    expect(transportsMade()).toBe(2);
  });

  it("stopAll closes every child", async () => {
    const { manager, transports } = harness();
    await manager.call("calendar", "calendar_list_events", {});
    await manager.stopAll();
    expect(transports[0].closed).toBe(true);
    expect(manager.snapshot()[0].state).toBe("idle");
  });

  it("reports its server names", () => {
    const { manager } = harness();
    expect(manager.names()).toEqual(["calendar"]);
    expect(manager.has("calendar")).toBe(true);
    expect(manager.has("gmail")).toBe(false);
  });
});

describe("McpManager.describe", () => {
  it("connects, because that is what a test-connection button wants", async () => {
    const { manager } = harness();
    const state = await manager.describe("calendar");
    expect(state).toMatchObject({ state: "ready", toolCount: 1, lastError: null });
  });

  it("returns null for an unknown server", async () => {
    const { manager } = harness();
    expect(await manager.describe("nope")).toBeNull();
  });
});
