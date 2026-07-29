import { describe, expect, it } from "vitest";
import type {
  HostCommandExecutionItem,
  HostFileChangeItem,
  HostToolExecutionItem,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import { CodexTurnProjector } from "../src/index.js";

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
  it("projects Agent Message and Command Execution lifecycles", () => {
    const value = projector();
    const agentId = itemId("agent-1");
    const commandId = itemId("command-1");

    expect(value.project({ type: "turn.started", turnId }).messages).toMatchObject([
      { method: "turn/started", params: { turn: { status: "inProgress" } } },
    ]);
    value.project({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", itemId: agentId, text: "" },
    });
    expect(
      value.project({
        type: "item.updated",
        turnId,
        itemId: agentId,
        update: { type: "text.append", text: "done" },
      }).messages,
    ).toMatchObject([{ method: "item/agentMessage/delta", params: { delta: "done" } }]);
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
    expect(completed.completedTurn).toMatchObject({ items: [] });
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
