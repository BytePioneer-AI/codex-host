import { describe, expect, it, vi } from "vitest";
import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";

import { mapMuseHostItem, readMuseHistory, snapshotFromMuseHistory } from "../src/history.js";
import { MuseRpcError, type JsonObject, type MuseRpc } from "../src/msp-client.js";

const nativeRef = nativeSessionRefSchema.parse({
  harnessId: "muse",
  nativeSessionId: "session-1",
  formatVersion: 1,
});

function item(kind: string, itemId: string, turnId: string, extra: JsonObject = {}): JsonObject {
  return { kind, itemId, turnId, revision: 1, status: "completed", ...extra };
}

function itemEvent(value: JsonObject): JsonObject {
  return { method: "item/completed", params: { item: value } };
}

function terminal(turnId: string, status: string, extra: JsonObject = {}): JsonObject {
  return { method: "turn/completed", params: { turnId, terminal: status, ...extra } };
}

function historyRpc(items: JsonObject[], pages: JsonObject[][]): MuseRpc {
  let pageIndex = 0;
  return {
    handshake: async () => ({}),
    request: vi.fn(async (method: string): Promise<JsonObject> => {
      if (method === "session/read") return { history: { mode: "inline", items } };
      if (method !== "view/page") throw new Error(`Unexpected request: ${method}`);
      const events = pages[pageIndex++] ?? [];
      return { events, nextCursor: pageIndex < pages.length ? `cursor-${pageIndex}` : null };
    }),
    notify: () => undefined,
    subscribe: () => () => undefined,
    subscribeFailure: () => () => undefined,
    close: async () => undefined,
  };
}

async function readSnapshot(rpc: MuseRpc): Promise<HostThreadSnapshot> {
  return snapshotFromMuseHistory(nativeRef, await readMuseHistory(rpc, "session-1"));
}

describe("Muse durable history", () => {
  it("keeps native user messages as turn input without emitting a second tool item", () => {
    const user = item("userMessage", "user-1", "turn-1", { text: "hello" });

    expect(mapMuseHostItem(user, "fallback")).toBeUndefined();
    const snapshot = snapshotFromMuseHistory(nativeRef, { items: [user] });
    expect(snapshot.turns[0]?.input).toEqual([{ type: "text", text: "hello" }]);
    expect(snapshot.turns[0]?.items).toEqual([]);
  });

  it("decodes native JSON tool arguments for the Host command projector", () => {
    const tool = item("toolCall", "tool-1", "turn-1", {
      tool: "bash",
      args: '{"command":"printf hello","timeout_ms":1000}',
    });

    expect(mapMuseHostItem(tool, "fallback")).toMatchObject({
      type: "toolExecution",
      toolName: "bash",
      arguments: { command: "printf hello", timeout_ms: 1000 },
    });
  });

  it("preserves almost-JSON tool arguments verbatim and generic unknown item kinds", () => {
    const args = '{"command":"printf hello",';
    expect(
      mapMuseHostItem(item("toolCall", "tool-1", "turn-1", { tool: "bash", args }), "fallback"),
    ).toMatchObject({ type: "toolExecution", arguments: args });
    expect(
      mapMuseHostItem(
        item("futureKind", "future-1", "turn-1", { fallbackText: "details" }),
        "fallback",
      ),
    ).toMatchObject({
      type: "toolExecution",
      toolName: "futureKind",
      output: { content: [{ type: "text", text: "details" }] },
    });
  });

  it("keeps paged replies between the correct user turns across page boundaries", async () => {
    const firstUser = item("userMessage", "user-1", "turn-1", { text: "first" });
    const secondUser = item("userMessage", "user-2", "turn-2", { text: "second" });
    const firstReply = item("agentMessage", "reply-1", "turn-1", { text: "first answer" });
    const secondReply = item("agentMessage", "reply-2", "turn-2", { text: "second answer" });
    const rpc = historyRpc(
      [firstUser, secondUser],
      [
        [itemEvent(firstUser), itemEvent(firstReply), terminal("turn-1", "completed")],
        [itemEvent(secondUser), itemEvent(secondReply), terminal("turn-2", "completed")],
      ],
    );

    const history = await readMuseHistory(rpc, "session-1");
    const snapshot = snapshotFromMuseHistory(nativeRef, history);

    expect((history?.items as JsonObject[]).map((item) => item.itemId)).toEqual([
      "user-1",
      "reply-1",
      "user-2",
      "reply-2",
    ]);
    expect(snapshot.turns.map((turn) => turn.items.map(({ item }) => item.itemId))).toEqual([
      ["reply-1"],
      ["reply-2"],
    ]);
    expect(snapshot.turns.map((turn) => turn.outcome.status)).toEqual(["succeeded", "succeeded"]);
    expect(rpc.request).toHaveBeenLastCalledWith("view/page", {
      sessionId: "session-1",
      direction: "forward",
      limit: 1000,
      cursor: "cursor-1",
    });
  });

  it("uses the native turn id to join steered input and late items to their owning turn", async () => {
    const rpc = historyRpc(
      [],
      [
        [
          itemEvent(
            item("userMessage", "user-1", "native-1", { commandId: "command-1", text: "start" }),
          ),
          itemEvent(
            item("userMessage", "steer-1", "native-1", {
              commandId: "command-2",
              text: "also",
              steered: true,
            }),
          ),
          terminal("native-1", "completed"),
          itemEvent(item("userMessage", "user-2", "native-2", { text: "next" })),
          itemEvent(item("toolCall", "late-tool", "native-1", { tool: "bash" })),
          terminal("native-2", "cancelled"),
        ],
      ],
    );

    const snapshot = await readSnapshot(rpc);

    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]?.nativeTurnRef.nativeTurnKey).toBe("native-1");
    expect(snapshot.turns[0]?.input).toEqual([
      { type: "text", text: "start" },
      { type: "text", text: "also" },
    ]);
    expect(snapshot.turns[0]?.items[0]?.item.itemId).toBe("late-tool");
    expect(snapshot.turns[1]?.items).toEqual([]);
  });

  it("preserves failures, cancellations and unknown or missing native turn terminals", async () => {
    const users = ["failed", "cancelled", "future", "running"].map((turnId) =>
      item("userMessage", `user-${turnId}`, turnId, { text: turnId }),
    );
    const rpc = historyRpc(users, [
      [
        ...users.map(itemEvent),
        terminal("failed", "failed", {
          error: { kind: "modelError", message: "provider failed", retryable: true },
        }),
        terminal("cancelled", "cancelled", { reason: "stopped by user" }),
        terminal("future", "newNativeTerminal"),
      ],
    ]);

    const snapshot = await readSnapshot(rpc);

    expect(snapshot.turns.map((turn) => turn.outcome)).toEqual([
      {
        status: "failed",
        error: { code: "nativeFailure", message: "provider failed", retryable: true },
      },
      { status: "cancelled", reason: "stopped by user" },
      { status: "unknown", reason: expect.stringContaining("newNativeTerminal") },
      { status: "unknown", reason: expect.any(String) },
    ]);
  });

  it("maps item terminal failures and cancellation without losing partial text", async () => {
    const rpc = historyRpc(
      [
        item("userMessage", "user-1", "turn-1", { text: "run tools" }),
        item("toolCall", "failed-tool", "turn-1", {
          status: "failed",
          failureReason: "command failed",
          tool: "bash",
        }),
        item("toolCall", "cancelled-tool", "turn-1", {
          status: "cancelled",
          failureReason: "cancelled by user",
          tool: "bash",
        }),
        item("agentMessage", "partial", "turn-1", { status: "inProgress", text: "partial reply" }),
      ],
      [],
    );

    const snapshot = await readSnapshot(rpc);

    expect(snapshot.turns[0]?.outcome.status).toBe("unknown");
    expect(snapshot.turns[0]?.items[0]?.outcome).toMatchObject({
      status: "failed",
      error: { message: "command failed" },
    });
    expect(snapshot.turns[0]?.items[1]?.outcome).toEqual({
      status: "cancelled",
      reason: "cancelled by user",
    });
    expect(snapshot.turns[0]?.items[2]?.item).toMatchObject({ text: "partial reply" });
  });

  it("applies item revisions monotonically while preserving their first position", async () => {
    const user = item("userMessage", "user-1", "turn-1", { text: "hello" });
    const current = item("agentMessage", "reply-1", "turn-1", {
      text: "latest answer",
      revision: 3,
    });
    const rpc = historyRpc(
      [user, current],
      [
        [
          itemEvent(user),
          itemEvent({ ...current, text: "old answer", revision: 1 }),
          itemEvent({ ...current, text: "older replay", revision: 2 }),
          terminal("turn-1", "completed"),
        ],
      ],
    );

    const snapshot = await readSnapshot(rpc);

    expect(snapshot.turns[0]?.items).toHaveLength(1);
    expect(snapshot.turns[0]?.items[0]?.item).toMatchObject({ text: "latest answer" });
  });

  it("keeps session/read history visible and unconfirmed when paging is unavailable", async () => {
    const rpc = historyRpc([], []);
    rpc.request = async (method) => {
      if (method === "view/page") throw new MuseRpcError("not implemented", -32601);
      return {
        history: {
          items: [
            { kind: "userMessage", itemId: "user-1", commandId: "command-1", text: "hello" },
            { kind: "agentMessage", itemId: "reply-1", text: "legacy reply" },
          ],
        },
      };
    };

    const snapshot = await readSnapshot(rpc);

    expect(snapshot.turns[0]?.outcome.status).toBe("unknown");
    expect(snapshot.turns[0]?.items[0]?.item).toMatchObject({ text: "legacy reply" });
  });
});
