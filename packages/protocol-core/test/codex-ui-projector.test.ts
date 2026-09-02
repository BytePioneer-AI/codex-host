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
  harnessIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";

import { CodexTurnProjector, projectHistoricalTurn, toolCommandLine } from "../src/index.js";

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

  it("projects historical Turn timing when timestamps and duration are present", () => {
    const snapshot: HostThreadSnapshot["turns"][number] = {
      nativeTurnRef: {
        harnessId: harnessIdSchema.parse("omp"),
        nativeSessionId: "session-1",
        nativeTurnKey: "turn-key-1",
        formatVersion: 1,
      },
      input: [{ type: "text", text: "question" }],
      items: [
        {
          item: {
            type: "agentMessage",
            itemId: itemId("agent-1"),
            text: "answer",
          },
          outcome: { status: "succeeded" },
        },
      ],
      outcome: { status: "succeeded" },
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_005_250,
      durationMs: 5_250,
    };

    expect(projectHistoricalTurn({ turnId, cwd: "/workspace", snapshot })).toMatchObject({
      id: "turn-1",
      status: "completed",
      startedAt: 1_700_000_000,
      completedAt: 1_700_000_005,
      durationMs: 5_250,
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
      processId: "sleep-600",
      osPid: 535357,
    };
    expect(value.project({ type: "item.started", turnId, item: command }).messages).toMatchObject([
      {
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            cwd: "/workspace",
            status: "inProgress",
            source: "unifiedExecStartup",
            processId: "sleep-600",
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
    ).toMatchObject([
      { method: "item/commandExecution/outputDelta", params: { delta: "done\n" } },
      {
        method: "process/outputDelta",
        params: {
          processId: "sleep-600",
          stream: "stdout",
          deltaBase64: Buffer.from("done\n").toString("base64"),
        },
      },
    ]);
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
            durationMs: 25,
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

  it("keeps a launched background terminal inProgress after the Turn completes", () => {
    const value = projector();
    const commandId = itemId("term-1");
    value.project({ type: "turn.started", turnId });
    value.project({
      type: "item.started",
      turnId,
      item: {
        type: "commandExecution",
        itemId: commandId,
        command: "hub start term-1 -- bash --norc --noprofile",
        processId: "term-1",
      },
    });
    const completed = value.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(completed.completedTurn?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "commandExecution",
          processId: "term-1",
          source: "unifiedExecStartup",
          status: "inProgress",
        }),
      ]),
    );
  });

  it("keeps hub start cards inProgress even without an explicit processId", () => {
    const value = projector();
    const commandId = itemId("hub-start");
    value.project({ type: "turn.started", turnId });
    expect(
      value.project({
        type: "item.started",
        turnId,
        item: {
          type: "commandExecution",
          itemId: commandId,
          command: "hub start terminal-2 -- bash",
        },
      }).messages,
    ).toMatchObject([
      {
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            processId: "terminal-2",
            source: "unifiedExecStartup",
            status: "inProgress",
          },
        },
      },
    ]);
    expect(
      value.project({
        type: "item.completed",
        turnId,
        snapshot: {
          item: {
            type: "commandExecution",
            itemId: commandId,
            command: "hub start terminal-2 -- bash",
          },
          outcome: { status: "succeeded" },
        },
      }).messages,
    ).toEqual([]);
    const completed = value.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(completed.completedTurn?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "commandExecution",
          processId: "terminal-2",
          status: "inProgress",
        }),
      ]),
    );
  });

  it("keeps numeric official PTY session ids inProgress after the Turn completes", () => {
    const value = projector();
    const commandId = itemId("counter-1");
    value.project({ type: "turn.started", turnId });
    value.project({
      type: "item.started",
      turnId,
      item: {
        type: "commandExecution",
        itemId: commandId,
        command: "i=0; while true; do i=$((i+1)); date; sleep 1; done",
        processId: "3495",
      },
    });
    expect(
      value.project({
        type: "item.completed",
        turnId,
        snapshot: {
          item: {
            type: "commandExecution",
            itemId: commandId,
            command: "i=0; while true; do i=$((i+1)); date; sleep 1; done",
            processId: "3495",
            output: "[counter-1] count=1\n",
          },
          outcome: { status: "succeeded" },
        },
      }).messages,
    ).toEqual([]);
    const completed = value.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(completed.completedTurn?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "commandExecution",
          processId: "3495",
          source: "unifiedExecStartup",
          status: "inProgress",
        }),
      ]),
    );
  });

  it("fills completed Command, Tool, and Reasoning duration from Item start time", () => {
    const value = projector();
    const commandId = itemId("timed-command");
    const toolId = itemId("timed-tool");
    const reasoningId = itemId("timed-reasoning");
    const providedId = itemId("provided-duration");
    value.project({ type: "turn.started", turnId });

    expect(
      value.project(
        {
          type: "item.started",
          turnId,
          item: { type: "commandExecution", itemId: commandId, command: "sleep 1" },
        },
        2_000,
      ).messages,
    ).toMatchObject([
      {
        method: "item/started",
        params: {
          startedAtMs: 2_000,
          item: { type: "commandExecution", durationMs: null, status: "inProgress" },
        },
      },
    ]);
    expect(
      value.project(
        {
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "commandExecution",
              itemId: commandId,
              command: "sleep 1",
              output: "ok",
              exitCode: 0,
            },
            outcome: { status: "succeeded" },
          },
        },
        4_500,
      ).messages,
    ).toMatchObject([
      {
        method: "item/completed",
        params: {
          startedAtMs: 2_000,
          completedAtMs: 4_500,
          item: { type: "commandExecution", durationMs: 2_500, exitCode: 0 },
        },
      },
    ]);

    value.project(
      {
        type: "item.started",
        turnId,
        item: {
          type: "commandExecution",
          itemId: providedId,
          command: "printf done",
        },
      },
      5_000,
    );
    expect(
      value.project(
        {
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "commandExecution",
              itemId: providedId,
              command: "printf done",
              exitCode: 0,
              durationMs: 25,
            },
            outcome: { status: "succeeded" },
          },
        },
        8_000,
      ).messages,
    ).toMatchObject([
      {
        method: "item/completed",
        params: {
          startedAtMs: 5_000,
          completedAtMs: 8_000,
          item: { type: "commandExecution", durationMs: 25 },
        },
      },
    ]);

    value.project(
      {
        type: "item.started",
        turnId,
        item: {
          type: "toolExecution",
          itemId: toolId,
          toolName: "Read",
          arguments: { path: "a.ts" },
        },
      },
      9_000,
    );
    expect(
      value.project(
        {
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "toolExecution",
              itemId: toolId,
              toolName: "Read",
              arguments: { path: "a.ts" },
              output: { content: [{ type: "text", text: "contents" }] },
            },
            outcome: { status: "succeeded" },
          },
        },
        10_250,
      ).messages,
    ).toMatchObject([
      {
        method: "item/completed",
        params: {
          startedAtMs: 9_000,
          completedAtMs: 10_250,
          item: {
            type: "commandExecution",
            command: "read a.ts",
            durationMs: 1_250,
          },
        },
      },
    ]);

    value.project(
      {
        type: "item.started",
        turnId,
        item: { type: "reasoning", itemId: reasoningId, text: "" },
      },
      11_000,
    );
    value.project(
      {
        type: "item.updated",
        turnId,
        itemId: reasoningId,
        update: { type: "text.append", text: "thinking" },
      },
      11_500,
    );
    const reasoningCompleted = value.project(
      {
        type: "item.completed",
        turnId,
        snapshot: {
          item: { type: "reasoning", itemId: reasoningId, text: "thinking" },
          outcome: { status: "succeeded" },
        },
      },
      13_000,
    );
    expect(reasoningCompleted.messages).toMatchObject([
      {
        method: "item/completed",
        params: {
          startedAtMs: 11_500,
          completedAtMs: 13_000,
          item: { id: `${reasoningId}-summary`, type: "reasoning" },
        },
      },
    ]);
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
          model: "Grok 4.6",
          reasoningEffort: "high",
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
            model: "Grok 4.6 · High",
            reasoningEffort: "high",
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
  it("lifts Hub, Task, Eval, and Search tools into Command Execution cards", () => {
    const value = projector();
    value.project({ type: "turn.started", turnId });

    const hubStart = value.project({
      type: "item.started",
      turnId,
      item: {
        type: "toolExecution",
        itemId: itemId("hub-1"),
        toolName: "hub",
        arguments: { op: "start", name: "web", application: "bun", args: ["run", "dev"] },
      },
    });
    expect(hubStart.messages).toMatchObject([
      {
        method: "item/started",
        params: { item: { type: "commandExecution", command: "hub start web -- bun run dev" } },
      },
    ]);

    const hubSend = value.project({
      type: "item.started",
      turnId,
      item: {
        type: "toolExecution",
        itemId: itemId("hub-2"),
        toolName: "hub",
        arguments: { op: "send", to: "worker", message: "process ready" },
      },
    });
    expect(hubSend.messages).toMatchObject([
      {
        method: "item/started",
        params: { item: { type: "commandExecution", command: "hub send worker: process ready" } },
      },
    ]);

    const hubWait = value.project({
      type: "item.started",
      turnId,
      item: {
        type: "toolExecution",
        itemId: itemId("hub-3"),
        toolName: "hub",
        arguments: { op: "wait" },
      },
    });
    expect(hubWait.messages).toMatchObject([
      {
        method: "item/started",
        params: { item: { type: "commandExecution", command: "hub wait" } },
      },
    ]);

    const taskTool = value.project({
      type: "item.started",
      turnId,
      item: {
        type: "toolExecution",
        itemId: itemId("task-1"),
        toolName: "task",
        arguments: { task: "Run integration tests" },
      },
    });
    expect(taskTool.messages).toMatchObject([
      {
        method: "item/started",
        params: { item: { type: "commandExecution", command: "task: Run integration tests" } },
      },
    ]);

    const evalTool = value.project({
      type: "item.started",
      turnId,
      item: {
        type: "toolExecution",
        itemId: itemId("eval-1"),
        toolName: "eval",
        arguments: { language: "py", title: "load config" },
      },
    });
    expect(evalTool.messages).toMatchObject([
      {
        method: "item/started",
        params: { item: { type: "commandExecution", command: "eval py: load config" } },
      },
    ]);

    const searchTool = value.project({
      type: "item.started",
      turnId,
      item: {
        type: "toolExecution",
        itemId: itemId("search-1"),
        toolName: "web_search",
        arguments: { query: "vitest documentation" },
      },
    });
    expect(searchTool.messages).toMatchObject([
      {
        method: "item/started",
        params: {
          item: { type: "commandExecution", command: 'web_search "vitest documentation"' },
        },
      },
    ]);
  });

  it("reconstructs descriptive command lines across harness tools", () => {
    expect(
      toolCommandLine("hub", {
        op: "start",
        name: "ticker",
        application: "bun",
        args: ["run", "ticker.js"],
      }),
    ).toBe("hub start ticker -- bun run ticker.js");
    expect(toolCommandLine("hub", { op: "stop", name: "ticker" })).toBe("hub stop ticker");
    expect(toolCommandLine("hub", { op: "restart", name: "ticker" })).toBe("hub restart ticker");
    expect(toolCommandLine("hub", { op: "send", to: "worker", message: "ready" })).toBe(
      "hub send worker: ready",
    );
    expect(toolCommandLine("hub", { op: "wait" })).toBe("hub wait");
    expect(toolCommandLine("hub", { op: "wait", name: "ticker" })).toBe("hub wait ticker");
    expect(toolCommandLine("hub", { op: "jobs" })).toBe("hub jobs");
    expect(toolCommandLine("hub", { op: "ps" })).toBe("hub ps");
    expect(toolCommandLine("hub", { op: "list", status: "parked" })).toBe(
      "hub list --status parked",
    );
    expect(toolCommandLine("hub", { op: "logs", name: "web" })).toBe("hub logs web");
    expect(toolCommandLine("hub", { op: "cancel", ids: ["job-1", "job-2"] })).toBe(
      "hub cancel job-1 job-2",
    );
    expect(toolCommandLine("hub", { op: "describe", name: "web" })).toBe("hub describe web");

    expect(toolCommandLine("task", { task: "Refactor auth" })).toBe("task: Refactor auth");
    expect(
      toolCommandLine("task", {
        tasks: [{ name: "Scout", task: "Find files" }, { name: "Writer" }],
      }),
    ).toBe("task (2 tasks): Scout");

    expect(toolCommandLine("eval", { language: "py", title: "data prep" })).toBe(
      "eval py: data prep",
    );
    expect(toolCommandLine("eval", { language: "js" })).toBe("eval js");

    expect(toolCommandLine("todo", { op: "done", task: "Fix tests" })).toBe(
      'todo done "Fix tests"',
    );
    expect(toolCommandLine("todo", { op: "init" })).toBe("todo init");

    expect(
      toolCommandLine("edit", { input: "[packages/server.ts#A1B2]\nPUT 1.=2:\n+test\n" }),
    ).toBe("edit packages/server.ts");
    expect(toolCommandLine("write", { path: "docs/readme.md" })).toBe("write docs/readme.md");

    expect(toolCommandLine("lsp", { action: "definition", symbol: "toolCommandLine" })).toBe(
      "lsp definition toolCommandLine",
    );
    expect(toolCommandLine("browser", { action: "open", url: "http://localhost:3000" })).toBe(
      "browser open http://localhost:3000",
    );
    expect(toolCommandLine("debug", { action: "launch", program: "src/index.ts" })).toBe(
      "debug launch src/index.ts",
    );
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

  it("renders Claude Task snapshots after the adapter normalizes them to Todo", () => {
    const value = projector();
    const taskId = itemId("claude-task-1");
    value.project({ type: "turn.started", turnId });
    expect(
      value.project({
        type: "item.started",
        turnId,
        item: { type: "toolExecution", itemId: taskId, toolName: "Todo", arguments: {} },
      }).messages,
    ).toEqual([]);
    expect(
      value.project({
        type: "item.completed",
        turnId,
        snapshot: {
          item: {
            type: "toolExecution",
            itemId: taskId,
            toolName: "Todo",
            arguments: {
              todos: [{ id: "1", content: "Run tests", status: "in_progress" }],
            },
          },
          outcome: { status: "succeeded" },
        },
      }).messages,
    ).toMatchObject([
      {
        method: "turn/plan/updated",
        params: { plan: [{ step: "Run tests", status: "inProgress" }] },
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
