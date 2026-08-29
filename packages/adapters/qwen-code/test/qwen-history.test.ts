import { harnessIdSchema, nativeTurnRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import type { QwenCodeTransportEvent } from "../src/acp-transport.js";
import { mapQwenCodeReplay, qwenCodeTurnKey } from "../src/index.js";

const harnessId = harnessIdSchema.parse("qwen-code");
const sessionId = "session-1";

function user(text: string): QwenCodeTransportEvent {
  return { type: "user.text", text };
}

function agent(text: string): QwenCodeTransportEvent {
  return { type: "agent.text", text };
}

function thought(text: string): QwenCodeTransportEvent {
  return { type: "agent.thought", text };
}

describe("Qwen Code history replay", () => {
  it("bounds Turns by their leading user text and assigns stable ordinals", () => {
    const replay = [user("first"), thought("thinking"), agent("one"), user("second"), agent("two")];
    const { turns, turnCount } = mapQwenCodeReplay(replay, harnessId, sessionId, "/tmp");
    expect(turnCount).toBe(2);
    expect(turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      qwenCodeTurnKey(0),
      qwenCodeTurnKey(1),
    ]);
    expect(turns[0]?.input).toEqual([{ type: "text", text: "first" }]);
    expect(turns[0]?.items.map(({ item }) => item.type)).toEqual(["reasoning", "agentMessage"]);
    expect(turns[1]?.items.map(({ item }) => item.type)).toEqual(["agentMessage"]);
    expect(turns.every((turn) => turn.outcome.status === "unknown")).toBe(true);
  });

  it("projects tool calls and diff content into file changes", () => {
    const replay = [
      user("edit"),
      {
        type: "tool.call",
        callId: "t1",
        title: "Replace in /tmp/a.txt",
        kind: "edit",
        status: "completed",
        rawInput: { path: "/tmp/a.txt" },
        content: [
          {
            type: "diff",
            path: "/tmp/a.txt",
            oldText: "a\n",
            newText: "b\n",
          },
          { type: "content", content: { type: "text", text: "done" } },
        ],
      } as QwenCodeTransportEvent,
    ];
    const { turns } = mapQwenCodeReplay(replay, harnessId, sessionId, "/tmp");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.items.map(({ item }) => item.type)).toEqual(["toolExecution", "fileChange"]);
  });

  it("keeps Turns the Host already knows with stable identities on resume", () => {
    const replay = [user("first"), agent("one"), user("second"), agent("two")];
    const knownTurnRef = nativeTurnRefSchema.parse({
      harnessId,
      nativeSessionId: sessionId,
      nativeTurnKey: qwenCodeTurnKey(0),
      formatVersion: 1,
    });
    const { turns, turnCount } = mapQwenCodeReplay(replay, harnessId, sessionId, "/tmp", [
      knownTurnRef,
    ]);
    expect(turnCount).toBe(2);
    expect(turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      qwenCodeTurnKey(0),
      qwenCodeTurnKey(1),
    ]);
    expect(turns[0]?.nativeTurnRef).toEqual(knownTurnRef);
  });

  it("ignores leading events without user text", () => {
    const replay = [agent("orphan"), user("first"), agent("one")];
    const { turns, turnCount } = mapQwenCodeReplay(replay, harnessId, sessionId, "/tmp");
    expect(turnCount).toBe(1);
    expect(turns[0]?.items.map(({ item }) => item.type)).toEqual(["agentMessage"]);
  });

  it("marks failed tool calls as failed Items", () => {
    const replay = [
      user("run"),
      {
        type: "tool.call",
        callId: "t1",
        title: "shell",
        kind: "execute",
        status: "failed",
        rawInput: { command: "boom" },
      } as QwenCodeTransportEvent,
    ];
    const { turns } = mapQwenCodeReplay(replay, harnessId, sessionId, "/tmp");
    expect(turns[0]?.items[0]?.outcome.status).toBe("failed");
  });
});
