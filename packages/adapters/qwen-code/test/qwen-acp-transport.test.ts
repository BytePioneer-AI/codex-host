import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { transportEvent } from "../src/acp-transport.js";

function update(sessionUpdate: string, fields: Record<string, unknown> = {}): SessionUpdate {
  return { sessionUpdate, ...fields } as unknown as SessionUpdate;
}

describe("Qwen Code transportEvent mapping", () => {
  it("maps current_mode_update through its currentModeId field", () => {
    expect(transportEvent(update("current_mode_update", { currentModeId: "plan" }))).toEqual({
      type: "mode.changed",
      modeId: "plan",
    });
  });

  it("drops a current_mode_update frame without a currentModeId", () => {
    expect(transportEvent(update("current_mode_update", { modeId: "plan" }))).toBeNull();
    expect(transportEvent(update("current_mode_update", {}))).toBeNull();
  });

  it("maps the usage_update extension frame", () => {
    const frame = update("usage_update", { used: 45_091, size: 1_000_000 });
    expect(transportEvent(frame)).toEqual({ type: "usage", update: frame });
  });

  it("maps message chunks with metadata usage to a usage event", () => {
    const metadata = { usage: { inputTokens: 100, totalTokens: 104 } };
    const frame = update("agent_message_chunk", {
      content: { type: "text", text: "" },
    });
    expect(transportEvent(frame, metadata)).toEqual({ type: "usage", metadata });
  });

  it("maps plain text chunks to text events", () => {
    expect(
      transportEvent(update("user_message_chunk", { content: { type: "text", text: "hi" } })),
    ).toEqual({ type: "user.text", text: "hi" });
    expect(
      transportEvent(update("agent_thought_chunk", { content: { type: "text", text: "hmm" } }), {
        timestamp: 1,
      }),
    ).toEqual({ type: "agent.thought", text: "hmm", metadata: { timestamp: 1 } });
    expect(
      transportEvent(update("agent_message_chunk", { content: { type: "text", text: "" } })),
    ).toBeNull();
  });

  it("maps tool_call frames with optional fields", () => {
    expect(
      transportEvent(
        update("tool_call", {
          toolCallId: "t1",
          title: "Run git status",
          kind: "execute",
          status: "completed",
          rawInput: { command: "git status" },
        }),
      ),
    ).toEqual({
      type: "tool.call",
      callId: "t1",
      title: "Run git status",
      kind: "execute",
      status: "completed",
      rawInput: { command: "git status" },
    });
  });
});
