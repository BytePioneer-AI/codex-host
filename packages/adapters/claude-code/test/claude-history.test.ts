import { describe, expect, it } from "vitest";

import { mapClaudeSnapshot } from "../src/claude-history.js";

const sessionId = "claude-session";

function message(type: "user" | "assistant", uuid: string, content: unknown, stopReason?: string) {
  return {
    type,
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: type,
      content,
      ...(stopReason ? { stop_reason: stopReason } : {}),
    },
  };
}

describe("Claude history mapping", () => {
  it("groups human Turns around native Tool messages with stable identities", () => {
    const history = [
      message("user", "user-1", "first"),
      message(
        "assistant",
        "assistant-1",
        [
          { type: "thinking", thinking: "inspect first", signature: "ignored" },
          { type: "text", text: "checking" },
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        ],
        "tool_use",
      ),
      message("user", "tool-result-1", [
        { type: "tool_result", tool_use_id: "tool-1", content: "ignored" },
      ]),
      message(
        "assistant",
        "assistant-2",
        [
          { type: "redacted_thinking", data: "encrypted" },
          { type: "text", text: "done" },
        ],
        "end_turn",
      ),
      message("user", "user-2", [{ type: "text", text: "second" }]),
      message("assistant", "assistant-3", [{ type: "text", text: "answer" }], "end_turn"),
    ];

    const first = mapClaudeSnapshot(history, sessionId);
    const repeated = mapClaudeSnapshot(structuredClone(history), sessionId);

    expect(repeated).toEqual(first);
    expect(first).toEqual({
      turns: [
        {
          nativeTurnRef: {
            harnessId: "claude-code",
            nativeSessionId: sessionId,
            nativeTurnKey: "user-1",
            formatVersion: 1,
          },
          checkpoint: {
            harnessId: "claude-code",
            nativeSessionId: sessionId,
            checkpointId: "assistant-2",
            formatVersion: 1,
          },
          input: [{ type: "text", text: "first" }],
          items: [
            {
              item: {
                type: "reasoning",
                itemId: "claude-item-v2-user-1-reasoning-1",
                text: "inspect first",
              },
              outcome: { status: "succeeded" },
            },
            {
              item: {
                type: "agentMessage",
                itemId: "claude-item-v2-user-1-agentMessage-1",
                text: "checking",
              },
              outcome: { status: "succeeded" },
            },
            {
              item: {
                type: "agentMessage",
                itemId: "claude-item-v2-user-1-agentMessage-2",
                text: "done",
              },
              outcome: { status: "succeeded" },
            },
          ],
          outcome: {
            status: "unknown",
            reason: "Claude history does not include complete Result terminal evidence",
          },
        },
        {
          nativeTurnRef: {
            harnessId: "claude-code",
            nativeSessionId: sessionId,
            nativeTurnKey: "user-2",
            formatVersion: 1,
          },
          checkpoint: {
            harnessId: "claude-code",
            nativeSessionId: sessionId,
            checkpointId: "assistant-3",
            formatVersion: 1,
          },
          input: [{ type: "text", text: "second" }],
          items: [
            {
              item: {
                type: "agentMessage",
                itemId: "claude-item-v2-user-2-agentMessage-1",
                text: "answer",
              },
              outcome: { status: "succeeded" },
            },
          ],
          outcome: {
            status: "unknown",
            reason: "Claude history does not include complete Result terminal evidence",
          },
        },
      ],
    });
  });

  it("omits Claude model controls and metadata without hiding other human commands", () => {
    const synthetic = {
      ...message("user", "synthetic", "synthetic prompt"),
      isSynthetic: true,
    };
    const metadata = {
      ...message("user", "metadata", "metadata prompt"),
      isMeta: true,
    };
    const toolResult = {
      ...message("user", "tool-result", "tool output"),
      toolUseResult: { status: "completed" },
    };
    const history = [
      message("user", "user-1", "first"),
      message("assistant", "assistant-1", "answer", "end_turn"),
      message(
        "user",
        "model-command",
        "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>",
      ),
      message(
        "user",
        "model-output",
        "<local-command-stdout>Set model to claude-opus-4-6</local-command-stdout>",
      ),
      message("user", "model-caveat", [
        {
          type: "text",
          text: "<local-command-caveat>Model changed locally</local-command-caveat>",
        },
      ]),
      synthetic,
      metadata,
      toolResult,
      message(
        "user",
        "diagnose-command",
        "<command-message>diagnose</command-message>\n<command-name>/diagnose</command-name>\n<command-args>auth</command-args>",
      ),
      message("assistant", "assistant-2", "diagnosis", "end_turn"),
      message("user", "user-2", "literal <command-name>/model</command-name> example"),
      message("assistant", "assistant-3", "still visible", "end_turn"),
    ];

    expect(mapClaudeSnapshot(history, sessionId).turns).toMatchObject([
      {
        nativeTurnRef: { nativeTurnKey: "user-1" },
        input: [{ type: "text", text: "first" }],
      },
      {
        nativeTurnRef: { nativeTurnKey: "diagnose-command" },
        input: [
          {
            type: "text",
            text: "<command-message>diagnose</command-message>\n<command-name>/diagnose</command-name>\n<command-args>auth</command-args>",
          },
        ],
      },
      {
        nativeTurnRef: { nativeTurnKey: "user-2" },
        input: [{ type: "text", text: "literal <command-name>/model</command-name> example" }],
      },
    ]);
  });

  it("keeps an incomplete reasoning-only historical Turn without inventing success", () => {
    expect(
      mapClaudeSnapshot(
        [
          message("user", "user-1", "first"),
          message("assistant", "assistant-reasoning", [
            { type: "thinking", thinking: "visible but not terminal", signature: "ignored" },
          ]),
        ],
        sessionId,
      ),
    ).toMatchObject({
      turns: [
        {
          nativeTurnRef: { nativeTurnKey: "user-1" },
          checkpoint: { checkpointId: "assistant-reasoning" },
          items: [{ item: { type: "reasoning", text: "visible but not terminal" } }],
          outcome: { status: "unknown" },
        },
      ],
    });
  });

  it("rejects mismatched Sessions and duplicate native message identities", () => {
    const wrongSession = { ...message("user", "user-1", "first"), session_id: "other" };
    expect(() => mapClaudeSnapshot([wrongSession], sessionId)).toThrow("invalid message identity");
    expect(() =>
      mapClaudeSnapshot(
        [message("user", "same", "first"), message("assistant", "same", "answer", "end_turn")],
        sessionId,
      ),
    ).toThrow("duplicate message IDs");
  });
});
