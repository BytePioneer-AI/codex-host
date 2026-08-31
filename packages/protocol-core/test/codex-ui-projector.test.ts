import { describe, expect, it } from "vitest";
import type {
  HostCommandExecutionItem,
  HostFileChangeItem,
  HostQuestionInteraction,
  HostSubagentDelegationItem,
  HostThreadSnapshot,
  HostToolExecutionItem,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";

import { CodexTurnProjector, projectHistoricalTurn } from "../src/index.js";

const turnId = hostTurnIdSchema.parse("turn-1");
const itemId = (value: string) => hostItemIdSchema.parse(value);

function projector(): CodexTurnProjector {
  return new CodexTurnProjector({
    threadId: "thread-1",
    turnId,
    cwd: "/workspace",
    startedAtMs: 1_000,
  });
}

describe("Codex UI projector", () => {
  it("projects a complete historical Snapshot without replaying notifications", () => {
    const snapshot: HostThreadSnapshot["turns"][number] = {
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: "pi",
        nativeSessionId: "session-1",
        nativeTurnKey: "native-turn-1",
        formatVersion: 1,
      }),
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId: "pi",
        nativeSessionId: "session-1",
        checkpointId: "checkpoint-1",
        formatVersion: 1,
      }),
      input: [{ type: "text", text: "question" }],
      items: [
        {
          item: {
            type: "reasoning",
            itemId: itemId("historical-reasoning"),
            text: "visible analysis",
          },
          outcome: { status: "succeeded" },
        },
        {
          item: { type: "agentMessage", itemId: itemId("historical-agent"), text: "answer" },
          outcome: { status: "succeeded" },
        },
        {
          item: {
            type: "toolExecution",
            itemId: itemId("historical-tool"),
            toolName: "read",
            arguments: { path: "a.txt" },
            output: { content: [{ type: "text", text: "contents" }] },
          },
          outcome: { status: "succeeded" },
        },
        {
          item: {
            type: "subagentDelegation",
            itemId: itemId("historical-subagent"),
            operation: "spawn",
            subagents: [
              {
                subagentId: "historical-agent-1",
                description: "Inspect history",
                background: false,
                status: "completed",
                resultSummary: "Done",
              },
            ],
          },
          outcome: { status: "succeeded" },
        },
      ],
      outcome: { status: "succeeded" },
    };

    expect(projectHistoricalTurn({ turnId, cwd: "/workspace", snapshot })).toEqual({
      id: "turn-1",
      status: "completed",
      items: [
        {
          id: "turn-1-user",
          type: "userMessage",
          clientId: null,
          content: [{ type: "text", text: "question" }],
        },
        {
          id: "historical-reasoning-summary",
          type: "reasoning",
          summary: ["visible analysis"],
          content: [],
        },
        {
          id: "historical-reasoning",
          type: "commandExecution",
          command: "thinking",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "visible analysis",
          exitCode: 0,
          durationMs: null,
        },
        {
          id: "historical-agent",
          type: "agentMessage",
          text: "answer",
          phase: null,
          memoryCitation: null,
        },
        expect.objectContaining({
          id: "historical-tool",
          type: "commandExecution",
          command: "read a.txt",
          aggregatedOutput: "contents",
          status: "completed",
        }),
        expect.objectContaining({
          id: "historical-subagent",
          type: "collabAgentToolCall",
          status: "completed",
          receiverThreadIds: ["historical-agent-1"],
        }),
      ],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      itemsView: "full",
    });
  });

  it("projects Agent Message and Command Execution lifecycles", () => {
    const value = projector();
    const agentId = itemId("agent-1");
    const commandId = itemId("command-1");

    expect(value.project({ type: "turn.started", turnId }).messages).toMatchObject([
      { method: "turn/started", params: { turn: { status: "inProgress" } } },
    ]);
    expect(
      value.project({
        type: "item.started",
        turnId,
        item: { type: "agentMessage", itemId: agentId, text: "" },
      }).messages,
    ).toEqual([]);
    expect(
      value.project({
        type: "item.updated",
        turnId,
        itemId: agentId,
        update: { type: "text.append", text: "done" },
      }).messages,
    ).toMatchObject([
      { method: "item/started", params: { item: { type: "agentMessage", text: "" } } },
      { method: "item/agentMessage/delta", params: { delta: "done" } },
    ]);
    value.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { type: "agentMessage", itemId: agentId, text: "done" },
        outcome: { status: "succeeded" },
      },
    });

    const command: HostCommandExecutionItem = {
      type: "commandExecution",
      itemId: commandId,
      command: "printf done",
    };
    expect(value.project({ type: "item.started", turnId, item: command }).messages).toMatchObject([
      {
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            cwd: "/workspace",
            status: "inProgress",
            source: "agent",
          },
        },
      },
    ]);
    expect(
      value.project({
        type: "item.updated",
        turnId,
        itemId: commandId,
        update: { type: "output.append", text: "done\n" },
      }).messages,
    ).toMatchObject([{ method: "item/commandExecution/outputDelta", params: { delta: "done\n" } }]);
    const commandCompleted = value.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { ...command, output: "done\n", exitCode: 0, durationMs: 25 },
        outcome: { status: "succeeded" },
      },
    });
    expect(commandCompleted.messages).toMatchObject([
      {
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            status: "completed",
            aggregatedOutput: null,
            exitCode: 0,
          },
        },
      },
    ]);

    const completed = value.project(
      { type: "turn.completed", turnId, outcome: { status: "succeeded" } },
      2_500,
    );
    expect(completed.completedTurn).toMatchObject({
      status: "completed",
      durationMs: 1_500,
      items: [{ type: "agentMessage", text: "done" }],
    });
  });

  it("projects Subagent delegation through native collaboration Items", () => {
    const value = projector();
    const delegationId = itemId("delegation-1");
    const startedItem: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: delegationId,
      operation: "spawn",
      subagents: [
        {
          subagentId: "claude-agent-1",
          description: "Inspect implementation",
          role: "Explore",
          background: true,
          status: "pending",
        },
      ],
    };
    value.project({ type: "turn.started", turnId });

    expect(
      value.project({ type: "item.started", turnId, item: startedItem }).messages,
    ).toMatchObject([
      {
        method: "item/started",
        params: {
          item: {
            id: "delegation-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-1",
            receiverThreadIds: ["claude-agent-1"],
            agentsStates: {
              "claude-agent-1": { status: "pendingInit", message: null },
            },
          },
        },
      },
    ]);
    const startedSubagent = startedItem.subagents[0];
    if (!startedSubagent) throw new Error("Test delegation has no Subagent");
    const runningSubagent = { ...startedSubagent, status: "running" as const };
    expect(
      value.project({
        type: "item.updated",
        turnId,
        itemId: delegationId,
        update: { type: "subagents.replace", subagents: [runningSubagent] },
      }).messages,
    ).toMatchObject([
      {
        method: "item/started",
        params: {
          item: {
            type: "collabAgentToolCall",
            agentsStates: {
              "claude-agent-1": { status: "running", message: null },
            },
          },
        },
      },
    ]);
    const completedItem: HostSubagentDelegationItem = {
      ...startedItem,
      subagents: [
        {
          ...startedSubagent,
          status: "completed",
          resultSummary: "Inspection complete",
        },
      ],
    };
    expect(
      value.project({
        type: "item.updated",
        turnId,
        itemId: delegationId,
        update: { type: "subagents.replace", subagents: completedItem.subagents },
      }).messages,
    ).toMatchObject([
      {
        method: "item/started",
        params: {
          item: {
            type: "collabAgentToolCall",
            agentsStates: {
              "claude-agent-1": { status: "completed", message: "Inspection complete" },
            },
          },
        },
      },
    ]);
    expect(
      value.project({
        type: "item.completed",
        turnId,
        snapshot: { item: completedItem, outcome: { status: "succeeded" } },
      }).messages,
    ).toMatchObject([
      {
        method: "item/completed",
        params: {
          item: {
            type: "collabAgentToolCall",
            status: "completed",
            agentsStates: {
              "claude-agent-1": { status: "completed", message: "Inspection complete" },
            },
          },
        },
      },
    ]);
  });

  it("projects native context compaction before the continued Agent reply", () => {
    const value = projector();
    const compactionId = itemId("compaction-1");
    const agentId = itemId("agent-after-compaction");
    value.project({ type: "turn.started", turnId });

    expect(
      value.project({
        type: "item.started",
        turnId,
        item: { type: "contextCompaction", itemId: compactionId },
      }).messages,
    ).toMatchObject([
      {
        method: "item/started",
        params: { item: { id: compactionId, type: "contextCompaction" } },
      },
    ]);
    expect(
      value.project({
        type: "item.completed",
        turnId,
        snapshot: {
          item: { type: "contextCompaction", itemId: compactionId },
          outcome: { status: "succeeded" },
        },
      }).messages,
    ).toMatchObject([
      {
        method: "item/completed",
        params: { item: { id: compactionId, type: "contextCompaction" } },
      },
    ]);

    value.project({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", itemId: agentId, text: "continued" },
    });
    value.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { type: "agentMessage", itemId: agentId, text: "continued" },
        outcome: { status: "succeeded" },
      },
    });
    expect(
      value.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } })
        .completedTurn,
    ).toMatchObject({ items: [{ id: agentId, type: "agentMessage", text: "continued" }] });
  });

  it("projects Reasoning before a deferred Agent Message through one summary part", () => {
    const value = projector();
    const agentId = itemId("deferred-agent");
    const reasoningId = itemId("reasoning-1");
    value.project({ type: "turn.started", turnId });

    expect(
      value.project({
        type: "item.started",
        turnId,
        item: { type: "agentMessage", itemId: agentId, text: "" },
      }).messages,
    ).toEqual([]);
    expect(
      value.project({
        type: "item.started",
        turnId,
        item: { type: "reasoning", itemId: reasoningId, text: "" },
      }).messages,
    ).toEqual([]);
    expect(
      value.project({
        type: "item.updated",
        turnId,
        itemId: reasoningId,
        update: { type: "text.append", text: "visible " },
      }).messages,
    ).toMatchObject([
      {
        method: "item/started",
        params: {
          item: { id: `${reasoningId}-summary`, type: "reasoning", summary: [], content: [] },
        },
      },
      {
        method: "item/started",
        params: {
          item: { id: reasoningId, type: "commandExecution", command: "thinking" },
        },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: reasoningId, delta: "visible " },
      },
      {
        method: "item/reasoning/summaryPartAdded",
        params: { itemId: `${reasoningId}-summary`, summaryIndex: 0 },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        params: { itemId: `${reasoningId}-summary`, summaryIndex: 0, delta: "visible " },
      },
    ]);
    expect(
      value.project({
        type: "item.updated",
        turnId,
        itemId: reasoningId,
        update: { type: "text.append", text: "analysis" },
      }).messages,
    ).toMatchObject([
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: reasoningId, delta: "analysis" },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        params: { itemId: `${reasoningId}-summary`, summaryIndex: 0, delta: "analysis" },
      },
    ]);
    const reasoningCompleted = value.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { type: "reasoning", itemId: reasoningId, text: "visible analysis" },
        outcome: { status: "succeeded" },
      },
    });
    expect(reasoningCompleted.messages).toMatchObject([
      {
        method: "item/completed",
        params: {
          item: {
            id: `${reasoningId}-summary`,
            type: "reasoning",
            summary: ["visible analysis"],
            content: [],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          item: {
            id: reasoningId,
            type: "commandExecution",
            command: "thinking",
            aggregatedOutput: "visible analysis",
          },
        },
      },
    ]);
    expect(JSON.stringify(reasoningCompleted)).not.toContain("summaryTextDelta");

    expect(
      value.project({
        type: "item.updated",
        turnId,
        itemId: agentId,
        update: { type: "text.append", text: "answer" },
      }).messages,
    ).toMatchObject([
      { method: "item/started", params: { item: { id: agentId, type: "agentMessage" } } },
      { method: "item/agentMessage/delta", params: { itemId: agentId, delta: "answer" } },
    ]);
    value.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { type: "agentMessage", itemId: agentId, text: "answer" },
        outcome: { status: "succeeded" },
      },
    });
    const completed = value.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(completed.completedTurn).toMatchObject({
      items: [
        {
          id: `${reasoningId}-summary`,
          type: "reasoning",
          summary: ["visible analysis"],
          content: [],
        },
        {
          id: reasoningId,
          type: "commandExecution",
          command: "thinking",
          aggregatedOutput: "visible analysis",
        },
        { id: agentId, type: "agentMessage", text: "answer" },
      ],
    });
  });

  it("omits an empty deferred Agent Message from a cancelled Turn", () => {
    const value = projector();
    const agentId = itemId("empty-agent");
    value.project({ type: "turn.started", turnId });
    value.project({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", itemId: agentId, text: "" },
    });
    expect(
      value.project({
        type: "item.completed",
        turnId,
        snapshot: {
          item: { type: "agentMessage", itemId: agentId, text: "" },
          outcome: { status: "cancelled" },
        },
      }).messages,
    ).toEqual([]);
    expect(
      value.project({
        type: "turn.completed",
        turnId,
        outcome: { status: "cancelled", reason: "user" },
      }).completedTurn,
    ).toMatchObject({ status: "interrupted", items: [] });
  });

  it("keeps final Command output when no output delta was projected", () => {
    const value = projector();
    const commandId = itemId("command-without-delta");
    const command: HostCommandExecutionItem = {
      type: "commandExecution",
      itemId: commandId,
      command: "printf done",
    };
    value.project({ type: "turn.started", turnId });
    value.project({ type: "item.started", turnId, item: command });
    const completed = value.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { ...command, output: "done\n", exitCode: 0 },
        outcome: { status: "succeeded" },
      },
    });
    expect(completed.messages).toMatchObject([
      {
        method: "item/completed",
        params: { item: { aggregatedOutput: "done\n", exitCode: 0 } },
      },
    ]);
  });

  it("projects Generic Tool output only through the generic dynamic Tool shape", () => {
    const value = projector();
    const toolId = itemId("tool-1");
    const tool: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: toolId,
      toolName: "custom",
      arguments: { value: 1 },
    };
    value.project({ type: "turn.started", turnId });
    const started = value.project({ type: "item.started", turnId, item: tool });
    expect(started.messages).toMatchObject([
      {
        method: "item/started",
        params: {
          item: {
            type: "dynamicToolCall",
            tool: "custom",
            status: "inProgress",
            arguments: { value: 1 },
          },
        },
      },
    ]);
    expect(
      value.project({
        type: "item.updated",
        turnId,
        itemId: toolId,
        update: {
          type: "output.replace",
          output: { content: [{ type: "text", text: "latest" }], truncated: true },
        },
      }).messages,
    ).toEqual([]);
    const toolCompleted = value.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: {
          ...tool,
          output: { content: [{ type: "text", text: "latest" }], truncated: true },
        },
        outcome: { status: "succeeded" },
      },
    });
    expect(toolCompleted.messages).toMatchObject([
      {
        method: "item/completed",
        params: {
          item: {
            type: "dynamicToolCall",
            status: "completed",
            success: true,
            contentItems: [{ type: "inputText", text: "latest" }],
          },
        },
      },
    ]);
    const completed = value.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(completed.completedTurn).toMatchObject({ items: [] });
    expect(JSON.stringify(completed)).not.toContain("mcpToolCall");
  });

  it("lifts Read/Glob/Grep Generic Tools into Command Execution cards with paths", () => {
    const value = projector();
    const readId = itemId("read-1");
    const globId = itemId("glob-1");
    const grepId = itemId("grep-1");
    value.project({ type: "turn.started", turnId });
    expect(
      value.project({
        type: "item.started",
        turnId,
        item: {
          type: "toolExecution",
          itemId: readId,
          toolName: "read",
          arguments: { path: "src/app.ts" },
        },
      }).messages,
    ).toMatchObject([
      {
        method: "item/started",
        params: {
          item: { id: readId, type: "commandExecution", command: "read src/app.ts" },
        },
      },
    ]);
    expect(
      value.project({
        type: "item.started",
        turnId,
        item: {
          type: "toolExecution",
          itemId: globId,
          toolName: "Glob",
          arguments: { pattern: "**/*.mjs" },
        },
      }).messages,
    ).toMatchObject([
      {
        method: "item/started",
        params: { item: { type: "commandExecution", command: "glob **/*.mjs" } },
      },
    ]);
    expect(
      value.project({
        type: "item.started",
        turnId,
        item: {
          type: "toolExecution",
          itemId: grepId,
          toolName: "grep",
          arguments: { pattern: "toolCommandLine", path: "packages" },
        },
      }).messages,
    ).toMatchObject([
      {
        method: "item/started",
        params: {
          item: { type: "commandExecution", command: "grep toolCommandLine packages" },
        },
      },
    ]);
    expect(
      value.project({
        type: "item.updated",
        turnId,
        itemId: readId,
        update: {
          type: "output.replace",
          output: { content: [{ type: "text", text: "export const app = 1;\n" }] },
        },
      }).messages,
    ).toMatchObject([
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: readId, delta: "export const app = 1;\n" },
      },
    ]);
    expect(
      value.project({
        type: "item.completed",
        turnId,
        snapshot: {
          item: {
            type: "toolExecution",
            itemId: readId,
            toolName: "read",
            arguments: { path: "src/app.ts" },
            output: { content: [{ type: "text", text: "export const app = 1;\n" }] },
          },
          outcome: { status: "succeeded" },
        },
      }).messages,
    ).toMatchObject([
      {
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            command: "read src/app.ts",
            status: "completed",
            aggregatedOutput: null,
          },
        },
      },
    ]);
  });

  it("docks Todo tools on turn/plan/updated and hides the name-only card", () => {
    const value = projector();
    const todoId = itemId("todo-1");
    value.project({ type: "turn.started", turnId });
    expect(
      value.project({
        type: "item.started",
        turnId,
        item: {
          type: "toolExecution",
          itemId: todoId,
          toolName: "Todo",
          arguments: {
            todos: [
              { content: "Fix edit cards", status: "in_progress" },
              { content: "Show the plan", status: "pending" },
            ],
          },
        },
      }).messages,
    ).toEqual([
      {
        method: "turn/plan/updated",
        emittedAtMs: 1_000,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: null,
          plan: [
            { step: "Fix edit cards", status: "inProgress" },
            { step: "Show the plan", status: "pending" },
          ],
        },
      },
    ]);
    expect(
      value.project({
        type: "item.completed",
        turnId,
        snapshot: {
          item: {
            type: "toolExecution",
            itemId: todoId,
            toolName: "Todo",
            arguments: {
              todos: [
                { content: "Fix edit cards", status: "completed" },
                { content: "Show the plan", status: "in_progress" },
              ],
            },
          },
          outcome: { status: "succeeded" },
        },
      }).messages,
    ).toMatchObject([
      {
        method: "turn/plan/updated",
        params: {
          plan: [
            { step: "Fix edit cards", status: "completed" },
            { step: "Show the plan", status: "inProgress" },
          ],
        },
      },
    ]);
  });

  it("hides Todo name cards even before arguments arrive and parses Grok todo_write shapes", () => {
    const value = projector();
    const emptyId = itemId("todo-empty");
    value.project({ type: "turn.started", turnId });
    expect(
      value.project({
        type: "item.started",
        turnId,
        item: { type: "toolExecution", itemId: emptyId, toolName: "Todo", arguments: {} },
      }).messages,
    ).toEqual([]);
    expect(
      value.project({
        type: "item.completed",
        turnId,
        snapshot: {
          item: {
            type: "toolExecution",
            itemId: emptyId,
            toolName: "todo_write",
            arguments: {
              merge: false,
              todos: JSON.stringify([
                { id: "1", content: "Fix the dock", status: "in_progress" },
                { id: "2", content: "Keep statuses live", status: "pending" },
              ]),
            },
          },
          outcome: { status: "succeeded" },
        },
      }).messages,
    ).toMatchObject([
      {
        method: "turn/plan/updated",
        params: {
          plan: [
            { step: "Fix the dock", status: "inProgress" },
            { step: "Keep statuses live", status: "pending" },
          ],
        },
      },
    ]);
  });

  it("projects Edit/Write tools as File Change cards with a native kind object", () => {
    const value = projector();
    const editId = itemId("edit-1");
    value.project({ type: "turn.started", turnId });
    const started = value.project({
      type: "item.started",
      turnId,
      item: {
        type: "toolExecution",
        itemId: editId,
        toolName: "Edit",
        arguments: { path: "src/app.ts", old_string: "a", new_string: "b" },
      },
    });
    expect(started.messages.map(({ method }) => method)).toEqual([
      "item/started",
      "item/fileChange/patchUpdated",
      "turn/diff/updated",
    ]);
    expect(started.messages[0]).toMatchObject({
      params: {
        item: {
          id: "edit-1",
          type: "fileChange",
          changes: [
            {
              path: "src/app.ts",
              kind: { type: "update", move_path: null },
              diff: expect.stringContaining("-a"),
            },
          ],
          status: "inProgress",
        },
      },
    });
    expect(started.messages[1]).toMatchObject({
      params: {
        changes: [{ path: "src/app.ts", kind: { type: "update", move_path: null } }],
      },
    });
    expect(
      value.project({
        type: "item.completed",
        turnId,
        snapshot: {
          item: {
            type: "toolExecution",
            itemId: editId,
            toolName: "Edit",
            arguments: { path: "src/app.ts", old_string: "a", new_string: "b" },
          },
          outcome: { status: "succeeded" },
        },
      }).messages,
    ).toMatchObject([
      {
        method: "item/completed",
        params: { item: { type: "fileChange", status: "completed" } },
      },
    ]);
  });

  it("projects reliable File Changes and the current Turn Diff", () => {
    const value = projector();
    const fileId = itemId("file-1");
    const file: HostFileChangeItem = {
      type: "fileChange",
      itemId: fileId,
      changes: [
        {
          path: "sample.txt",
          kind: "update",
          unifiedDiff: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    };
    value.project({ type: "turn.started", turnId });
    const started = value.project({ type: "item.started", turnId, item: file });
    expect(started.messages.map(({ method }) => method)).toEqual([
      "item/started",
      "item/fileChange/patchUpdated",
      "turn/diff/updated",
    ]);
    expect(started.messages[2]).toMatchObject({
      params: { diff: expect.stringContaining("+new") },
    });
    value.project({
      type: "item.completed",
      turnId,
      snapshot: { item: file, outcome: { status: "succeeded" } },
    });
    const secondFile: HostFileChangeItem = {
      type: "fileChange",
      itemId: itemId("file-2"),
      changes: [
        {
          path: "other.txt",
          kind: "add",
          unifiedDiff: "--- /dev/null\n+++ b/other.txt\n@@ -0,0 +1 @@\n+other\n",
        },
      ],
    };
    const secondStarted = value.project({ type: "item.started", turnId, item: secondFile });
    expect(secondStarted.messages[2]).toMatchObject({
      params: {
        diff: expect.stringMatching(/sample\.txt[\s\S]*other\.txt/u),
      },
    });
    value.project({
      type: "item.completed",
      turnId,
      snapshot: { item: secondFile, outcome: { status: "succeeded" } },
    });
    const completed = value.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(completed.completedTurn).toMatchObject({
      items: [
        { type: "fileChange", id: "file-1", status: "completed" },
        { type: "fileChange", id: "file-2", status: "completed" },
      ],
    });
  });

  it("projects standalone Questions through a synthetic Generic Tool lifecycle", () => {
    const value = projector();
    const question: HostQuestionInteraction = {
      type: "question",
      interactionId: hostInteractionIdSchema.parse("interaction-1"),
      turnId,
      title: "Question",
      questions: [
        {
          id: "decision",
          type: "choice",
          prompt: "Continue?",
          options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
          multiple: false,
          allowOther: false,
          optional: false,
        },
      ],
    };
    value.project({ type: "turn.started", turnId });
    const opened = value.projectQuestion(question, itemId("synthetic-question"), 2_000);
    expect(opened.messages).toMatchObject([
      {
        method: "item/started",
        params: {
          item: {
            id: "synthetic-question",
            type: "dynamicToolCall",
            namespace: "codexhost",
            tool: "question",
          },
        },
      },
    ]);
    expect(opened.questionRequest.request).toMatchObject({
      method: "item/tool/requestUserInput",
      params: { itemId: "synthetic-question", turnId: "turn-1" },
    });
    expect(() =>
      value.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } }),
    ).toThrow("pending Interactions");

    const closed = value.project(
      {
        type: "interaction.closed",
        interactionId: question.interactionId,
        turnId,
        reason: "responded",
      },
      2_500,
    );
    expect(closed.messages).toMatchObject([
      {
        method: "item/completed",
        params: {
          item: {
            id: "synthetic-question",
            type: "dynamicToolCall",
            status: "completed",
            success: true,
          },
        },
      },
    ]);
    expect(
      value.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } })
        .completedTurn,
    ).toMatchObject({ status: "completed", items: [] });
  });

  it("associates a Question with an active Generic Tool and protects its lifecycle", () => {
    const value = projector();
    const toolId = itemId("question-tool");
    const tool: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: toolId,
      toolName: "user_question_tool",
      arguments: {},
    };
    const question: HostQuestionInteraction = {
      type: "question",
      interactionId: hostInteractionIdSchema.parse("interaction-tool"),
      turnId,
      itemId: toolId,
      questions: [
        {
          id: "answer",
          type: "text",
          prompt: "Answer",
          multiline: false,
          secret: false,
          optional: false,
        },
      ],
    };
    value.project({ type: "turn.started", turnId });
    value.project({ type: "item.started", turnId, item: tool });
    expect(value.projectQuestion(question, itemId("unused")).messages).toEqual([]);
    expect(() =>
      value.project({
        type: "item.completed",
        turnId,
        snapshot: { item: tool, outcome: { status: "succeeded" } },
      }),
    ).toThrow("pending Interaction");
    expect(
      value.project({
        type: "interaction.closed",
        interactionId: question.interactionId,
        turnId,
        reason: "cancelled",
      }).messages,
    ).toEqual([]);
    value.project({
      type: "item.completed",
      turnId,
      snapshot: { item: tool, outcome: { status: "cancelled" } },
    });
  });

  it("fails a secret Question without mutating synthetic Item state", () => {
    const value = projector();
    value.project({ type: "turn.started", turnId });
    const question: HostQuestionInteraction = {
      type: "question",
      interactionId: hostInteractionIdSchema.parse("interaction-secret"),
      turnId,
      questions: [
        {
          id: "secret",
          type: "text",
          prompt: "Secret value",
          multiline: false,
          secret: true,
          optional: false,
        },
      ],
    };
    expect(() => value.projectQuestion(question, itemId("unused-secret"))).toThrow(
      "does not safely render secret Question input",
    );
    expect(
      value.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } })
        .completedTurn,
    ).toMatchObject({ status: "completed", items: [] });
  });

  it("projects failed Turns through the complete Codex error notification shape", () => {
    const value = projector();
    const message = '503: {"message":"Service temporarily unavailable","type":"api_error"}';
    value.project({ type: "turn.started", turnId });

    const completed = value.project({
      type: "turn.completed",
      turnId,
      outcome: {
        status: "failed",
        error: { code: "nativeFailure", message, retryable: false },
      },
    });

    const error = {
      message,
      codexErrorInfo: "other",
      additionalDetails: null,
    };
    expect(completed.messages).toEqual([
      {
        method: "error",
        params: { error, willRetry: false, threadId: "thread-1", turnId },
      },
      {
        method: "turn/completed",
        emittedAtMs: expect.any(Number),
        params: {
          threadId: "thread-1",
          turn: expect.objectContaining({ status: "failed", error }),
        },
      },
    ]);
    expect(completed.completedTurn).toMatchObject({ status: "failed", error });
  });

  it("rejects invalid ordering and maps cancelled Turns to interrupted", () => {
    const value = projector();
    expect(() =>
      value.project({
        type: "item.started",
        turnId,
        item: { type: "agentMessage", itemId: itemId("early"), text: "" },
      }),
    ).toThrow("precedes turn.started");

    value.project({ type: "turn.started", turnId });
    const completed = value.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "cancelled", reason: "user" },
    });
    expect(completed.completedTurn).toMatchObject({ status: "interrupted", error: null });
    expect(() =>
      value.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } }),
    ).toThrow("follows the Turn terminal");
  });
});
