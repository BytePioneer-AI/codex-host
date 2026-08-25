import { describe, expect, it } from "vitest";

import { mapClaudeSnapshot, mapClaudeSubagentSnapshot } from "../src/claude-history.js";

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
                itemId: "claude-item-v1-assistant-1-reasoning",
                text: "inspect first",
              },
              outcome: { status: "succeeded" },
            },
            {
              item: {
                type: "agentMessage",
                itemId: "claude-item-v1-assistant-1",
                text: "checking",
              },
              outcome: { status: "succeeded" },
            },
            {
              item: {
                type: "toolExecution",
                itemId: "claude-item-v1-assistant-1-tool-2",
                toolName: "Read",
                arguments: {},
                output: { content: [{ type: "text", text: "ignored" }] },
              },
              outcome: { status: "succeeded" },
            },
            {
              item: {
                type: "agentMessage",
                itemId: "claude-item-v1-assistant-2",
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
                itemId: "claude-item-v1-assistant-3",
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

  it("restores root Bash calls and failed tool calls from Claude history", () => {
    const history = [
      message("user", "user-1", "inspect and edit"),
      message("assistant", "assistant-1", [
        { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "pwd" } },
        { type: "tool_use", id: "write-1", name: "Write", input: { path: "a.txt" } },
      ]),
      message("user", "tool-results", [
        { type: "tool_result", tool_use_id: "bash-1", content: "/work/project" },
        {
          type: "tool_result",
          tool_use_id: "write-1",
          content: "permission denied",
          is_error: true,
        },
      ]),
    ];

    expect(mapClaudeSnapshot(history, sessionId)).toMatchObject({
      turns: [
        {
          nativeTurnRef: { nativeTurnKey: "user-1" },
          items: [
            {
              item: {
                type: "commandExecution",
                itemId: "claude-item-v1-assistant-1-tool-0",
                command: "pwd",
                output: "/work/project",
              },
              outcome: { status: "succeeded" },
            },
            {
              item: {
                type: "toolExecution",
                itemId: "claude-item-v1-assistant-1-tool-1",
                toolName: "Write",
                arguments: { path: "a.txt" },
                output: { content: [{ type: "text", text: "permission denied" }] },
              },
              outcome: {
                status: "failed",
                error: { code: "nativeFailure", message: "Write failed", retryable: false },
              },
            },
          ],
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
        "compact-command",
        "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>Keep implementation details</command-args>",
      ),
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

  it("projects init and recap command envelopes without treating them as control records", () => {
    const history = [
      message("user", "user-1", "first"),
      message("assistant", "assistant-1", "answer", "end_turn"),
      message(
        "user",
        "init-command",
        "<command-name>/init</command-name>\n<command-message>init</command-message>\n<command-args></command-args>",
      ),
      message("assistant", "assistant-init", "Created CLAUDE.md", "end_turn"),
      message(
        "user",
        "recap-command",
        "<command-name>/recap</command-name>\n<command-message>recap</command-message>\n<command-args></command-args>",
      ),
      message(
        "user",
        "recap-output",
        "<local-command-stdout>Built compact command and subagent projection.</local-command-stdout>",
      ),
      message("user", "user-2", "next"),
      message("assistant", "assistant-2", "ok", "end_turn"),
    ];

    expect(mapClaudeSnapshot(history, sessionId).turns).toMatchObject([
      {
        nativeTurnRef: { nativeTurnKey: "user-1" },
        input: [{ type: "text", text: "first" }],
      },
      {
        nativeTurnRef: { nativeTurnKey: "init-command" },
        input: [{ type: "text", text: "/init" }],
        items: [{ item: { type: "agentMessage", text: "Created CLAUDE.md" } }],
      },
      {
        nativeTurnRef: { nativeTurnKey: "recap-command" },
        input: [{ type: "text", text: "/recap" }],
        items: [
          { item: { type: "agentMessage", text: "Built compact command and subagent projection." } },
        ],
      },
      {
        nativeTurnRef: { nativeTurnKey: "user-2" },
        input: [{ type: "text", text: "next" }],
      },
    ]);
  });

  it("omits Claude background task-notification records without hiding later human Turns", () => {
    const notification = `<task-notification>
<task-id>a7b2e1021a9dc42e0</task-id>
<tool-use-id>call_oIKmvIhI8V7NLb7dB7DFwZkN</tool-use-id>
<summary>Agent finished</summary>
<result>cwd is /tmp</result>
</task-notification>`;
    const originated = {
      ...message("user", "notification-origin", notification),
      origin: { kind: "task-notification" },
    };
    const wrapped = message("user", "notification-xml", [{ type: "text", text: notification }]);
    const history = [
      message("user", "user-1", "start three agents"),
      message("assistant", "assistant-1", "agents started", "end_turn"),
      originated,
      message("assistant", "assistant-2", "first agent finished", "end_turn"),
      wrapped,
      message("assistant", "assistant-3", "all agents finished", "end_turn"),
      message("user", "user-2", "literal <task-notification> mention"),
      message("assistant", "assistant-4", "still visible", "end_turn"),
    ];

    expect(mapClaudeSnapshot(history, sessionId).turns).toMatchObject([
      {
        nativeTurnRef: { nativeTurnKey: "user-1" },
        input: [{ type: "text", text: "start three agents" }],
        items: [
          { item: { type: "agentMessage", text: "agents started" } },
          { item: { type: "agentMessage", text: "first agent finished" } },
          { item: { type: "agentMessage", text: "all agents finished" } },
        ],
      },
      {
        nativeTurnRef: { nativeTurnKey: "user-2" },
        input: [{ type: "text", text: "literal <task-notification> mention" }],
        items: [{ item: { type: "agentMessage", text: "still visible" } }],
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

  it("projects official Subagent history when the SDK omits the initial User prompt", () => {
    const history = [
      message("assistant", "subagent-thinking", [
        { type: "thinking", thinking: "check directory", signature: "ignored" },
      ]),
      message("assistant", "subagent-tool", [
        {
          type: "tool_use",
          id: "bash-1",
          name: "Bash",
          input: { command: "pwd", description: "Print working directory" },
        },
      ]),
      message("user", "subagent-tool-result", [
        {
          type: "tool_result",
          tool_use_id: "bash-1",
          content: "/work/project",
          is_error: false,
        },
      ]),
      message("assistant", "subagent-final", [{ type: "text", text: "Inspection complete." }]),
    ];

    const withPrompt = mapClaudeSubagentSnapshot(
      [message("user", "subagent-user", "inspect files"), ...history],
      sessionId,
      "native-agent-1",
    );
    const parentHistory = [
      message("assistant", "root-agent", [
        {
          type: "tool_use",
          id: "agent-call",
          name: "Agent",
          input: { prompt: "inspect files", description: "Inspect files" },
        },
      ]),
      message("user", "root-agent-result", [
        {
          type: "tool_result",
          tool_use_id: "agent-call",
          content: "done\nagentId: native-agent-1 (use SendMessage to continue)",
        },
      ]),
    ];
    const first = mapClaudeSubagentSnapshot(history, sessionId, "native-agent-1", parentHistory);
    const repeated = mapClaudeSubagentSnapshot(
      structuredClone(history),
      sessionId,
      "native-agent-1",
      structuredClone(parentHistory),
    );

    expect(withPrompt.turns[0]?.nativeTurnRef).toEqual(first.turns[0]?.nativeTurnRef);
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      turns: [
        {
          nativeTurnRef: { nativeTurnKey: "subagent-native-agent-1-initial" },
          input: [{ type: "text", text: "inspect files" }],
          items: [
            { item: { type: "reasoning", text: "check directory" } },
            {
              item: {
                type: "commandExecution",
                command: "pwd",
                output: "/work/project",
                exitCode: 0,
              },
            },
            { item: { type: "agentMessage", text: "Inspection complete." } },
          ],
        },
      ],
    });
  });

  it("projects Subagent command executions and intermediate Assistant output", () => {
    const history = [
      message("user", "subagent-user", "inspect files"),
      message("assistant", "subagent-thinking", [
        { type: "thinking", thinking: "check directory", signature: "ignored" },
      ]),
      message("assistant", "subagent-pending-tool", [
        {
          type: "tool_use",
          id: "bash-pending",
          name: "Bash",
          input: { command: "sleep 1", description: "Pending command" },
        },
      ]),
      message("assistant", "subagent-tool", [
        {
          type: "tool_use",
          id: "bash-1",
          name: "Bash",
          input: { command: "pwd", description: "Print working directory" },
        },
      ]),
      message("user", "subagent-tool-result", [
        {
          type: "tool_result",
          tool_use_id: "bash-1",
          content: "/work/project",
          is_error: false,
        },
      ]),
      message("assistant", "subagent-intermediate", [{ type: "text", text: "Directory checked." }]),
      message("assistant", "subagent-final", [{ type: "text", text: "Inspection complete." }]),
    ];

    expect(mapClaudeSubagentSnapshot(history, sessionId, "native-agent-1")).toMatchObject({
      turns: [
        {
          input: [{ type: "text", text: "inspect files" }],
          items: [
            { item: { type: "reasoning", text: "check directory" } },
            {
              item: {
                type: "commandExecution",
                command: "pwd",
                output: "/work/project",
                exitCode: 0,
              },
            },
            { item: { type: "agentMessage", text: "Directory checked." } },
            { item: { type: "agentMessage", text: "Inspection complete." } },
          ],
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
