import { describe, expect, it, vi } from "vitest";
import { snapshotSchema } from "../src/protocol.js";
import { readHistory } from "../src/read-history.js";
import { ZcodeTransport } from "../src/transport.js";

const snapshot = snapshotSchema.parse({
  protocol: { name: "ZCode Protocol", version: 1 },
  session: {
    sessionId: "parent",
    workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    title: "Fixture",
    status: "idle",
    mode: "build",
    sessionKind: "interactive",
    createdAt: 1,
    updatedAt: 2,
  },
  settings: {
    model: { current: { providerId: "fixture", modelId: "model" }, available: [] },
    thoughtLevel: { enabled: false, available: [] },
    mode: { current: "build" },
  },
  projection: { status: "idle", contextUsed: 0, contextWindow: 100 },
  runtime: {},
  messages: [
    {
      info: { messageId: "user", sessionId: "parent", role: "user", time: { created: 1 } },
      parts: [],
    },
    {
      info: {
        messageId: "assistant",
        sessionId: "parent",
        role: "assistant",
        time: { created: 1, completed: 2 },
        finish: "stop",
      },
      parts: ["first", "last"].map((id) => ({
        partId: id,
        callId: id,
        messageId: "assistant",
        sessionId: "parent",
        type: "tool",
        tool: "Agent",
        state: { status: "completed", input: { description: id }, output: "Done" },
      })),
    },
  ],
});

describe("ZCode subagent history", () => {
  it("restores child links from every native page", async () => {
    const transport = new ZcodeTransport({ cwd: "/fixture", environment: {} });
    const request = vi
      .spyOn(transport, "request")
      .mockResolvedValueOnce({
        running: [],
        ended: {
          items: [{ childSessionId: "one", toolCallId: "first", status: "success" }],
          nextCursor: "older",
        },
      })
      .mockResolvedValueOnce({
        running: [],
        ended: { items: [{ childSessionId: "two", toolCallId: "last", status: "success" }] },
      });
    const result = await readHistory(transport, snapshot);
    expect(request).toHaveBeenLastCalledWith("session/subagents", {
      sessionId: "parent",
      endedLimit: 100,
      endedCursor: "older",
    });
    expect(
      result.turns
        .flatMap((turn) => turn.items)
        .flatMap(({ item }) =>
          item.type === "subagentDelegation"
            ? item.subagents.map((child) => child.nativeSubagentId)
            : [],
        ),
    ).toEqual(["one", "two"]);
  });
  it("rejects a repeated cursor instead of returning incomplete history", async () => {
    const transport = new ZcodeTransport({ cwd: "/fixture", environment: {} });
    vi.spyOn(transport, "request").mockResolvedValue({ ended: { items: [], nextCursor: "same" } });
    await expect(readHistory(transport, snapshot)).rejects.toMatchObject({ code: "protocolError" });
  });
});
