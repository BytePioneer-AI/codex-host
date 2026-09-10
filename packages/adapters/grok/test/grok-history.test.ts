import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  mapGrokReplay,
  resolveGrokLastTurnPromptIndex,
  resolveGrokTargetPromptIndex,
} from "../src/grok-history.js";

const grokHarnessId = harnessIdSchema.parse("grok");

describe("Grok history Fork mapping", () => {
  it("assigns Native Prompt Index Checkpoints and skips synthetic user runs", () => {
    const snapshot = mapGrokReplay(
      [
        { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
        { type: "agent.text", text: "answer-1" },
        { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
        {
          type: "user.text",
          text: "<system-reminder>\nBackground task done.\n</system-reminder>",
          metadata: { eventId: "user-bg" },
        },
        { type: "turn.completed", nativeTurnKey: "task-completed-1", stopReason: "end_turn" },
        { type: "user.text", text: "second", metadata: { eventId: "user-2" } },
        { type: "agent.text", text: "answer-2" },
        { type: "turn.completed", nativeTurnKey: "prompt-2", stopReason: "end_turn" },
      ],
      grokHarnessId,
      "session-1",
      "/workspace",
    );

    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "prompt-1" },
      checkpoint: { checkpointId: "0", nativeSessionId: "session-1" },
      input: [{ text: "first" }],
    });
    expect(snapshot.turns[1]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "prompt-2" },
      checkpoint: { checkpointId: "2", nativeSessionId: "session-1" },
      input: [{ text: "second" }],
    });
    expect(resolveGrokTargetPromptIndex(snapshot, "0")).toBe(0);
    expect(resolveGrokTargetPromptIndex(snapshot, "2")).toBe(2);
    expect(resolveGrokTargetPromptIndex(snapshot, "1")).toBeNull();
    expect(resolveGrokLastTurnPromptIndex(snapshot)).toBe(2);
    expect(resolveGrokLastTurnPromptIndex({ turns: [] })).toBeNull();
  });

  it("applies rewind_marker by dropping the target Prompt Index and later Turns", () => {
    const snapshot = mapGrokReplay(
      [
        { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
        { type: "agent.text", text: "answer-1" },
        { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
        { type: "user.text", text: "second", metadata: { eventId: "user-2" } },
        { type: "agent.text", text: "answer-2" },
        { type: "turn.completed", nativeTurnKey: "prompt-2", stopReason: "end_turn" },
        { type: "user.text", text: "third", metadata: { eventId: "user-3" } },
        { type: "agent.text", text: "answer-3" },
        { type: "turn.completed", nativeTurnKey: "prompt-3", stopReason: "end_turn" },
        { type: "rewind.marker", targetPromptIndex: 2 },
      ],
      grokHarnessId,
      "session-1",
      "/workspace",
    );
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      "prompt-1",
      "prompt-2",
    ]);
    expect(resolveGrokLastTurnPromptIndex(snapshot)).toBe(1);
  });

  it("reconstructs mid-Turn auto-compaction Items and ignores compact outside a Turn", () => {
    const snapshot = mapGrokReplay(
      [
        {
          type: "compaction.completed",
          outcome: "succeeded",
          tokensAfter: 12,
        },
        { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
        { type: "agent.thought", text: "thinking-before" },
        {
          type: "compaction.started",
          tokensUsed: 80,
          contextWindowTokens: 100,
        },
        {
          type: "compaction.completed",
          outcome: "succeeded",
          tokensBefore: 80,
          tokensAfter: 12,
        },
        { type: "agent.text", text: "answer" },
        { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
        {
          type: "compaction.completed",
          outcome: "failed",
          errorMessage: "after turn",
        },
      ],
      grokHarnessId,
      "session-1",
      "/workspace",
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.items).toMatchObject([
      {
        item: { type: "reasoning", text: "thinking-before" },
        outcome: { status: "succeeded" },
      },
      {
        item: { type: "contextCompaction" },
        outcome: { status: "succeeded" },
      },
      {
        item: { type: "agentMessage", text: "answer" },
        outcome: { status: "succeeded" },
      },
    ]);
  });

  it("prefers an explicit promptIndex on the user event", () => {
    const snapshot = mapGrokReplay(
      [
        {
          type: "user.text",
          text: "later",
          metadata: { eventId: "user-4", promptIndex: 4 },
        },
        { type: "agent.text", text: "answer" },
        { type: "turn.completed", nativeTurnKey: "prompt-4", stopReason: "end_turn" },
      ],
      grokHarnessId,
      "session-1",
      "/workspace",
    );
    expect(snapshot.turns[0]?.checkpoint?.checkpointId).toBe("4");
    expect(resolveGrokTargetPromptIndex(snapshot, "4")).toBe(4);
  });

  it("projects spawn_subagent as a Subagent delegation and settles on wait", () => {
    const snapshot = mapGrokReplay(
      [
        { type: "user.text", text: "delegate", metadata: { eventId: "user-1" } },
        {
          type: "tool.call",
          callId: "spawn-1",
          title: "spawn_subagent",
          name: "spawn_subagent",
          rawInput: {
            description: "Inspect implementation",
            prompt: "Look at the repo",
            subagent_type: "explore",
            background: true,
          },
          status: "in_progress",
        },
        {
          type: "tool.update",
          callId: "spawn-1",
          title: "Inspect implementation",
          rawInput: { variant: "Task", task_id: "child-session", run_in_background: true },
        },
        {
          type: "tool.update",
          callId: "spawn-1",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Subagent started in background.\nsubagent_id: child-session\n",
              },
            },
          ],
        },
        {
          type: "tool.call",
          callId: "wait-1",
          title: "Wait for child",
          name: "get_command_or_subagent_output",
          rawInput: { task_ids: ["child-session"], timeout_ms: 30_000 },
          status: "in_progress",
        },
        {
          type: "tool.update",
          callId: "wait-1",
          status: "completed",
          rawOutput: {
            type: "TaskOutput",
            MultiResult: {
              mode: "wait_all",
              results: [
                { task_id: "child-session", status: "completed", output: "Inspection done" },
              ],
            },
          },
        },
        { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
      ],
      grokHarnessId,
      "session-1",
      "/workspace",
    );

    expect(snapshot.turns[0]?.items).toMatchObject([
      {
        item: {
          type: "subagentDelegation",
          operation: "spawn",
          prompt: "Look at the repo",
          subagents: [
            {
              nativeSubagentId: "child-session",
              description: "Inspect implementation",
              role: "explore",
              background: true,
              status: "completed",
            },
          ],
        },
        outcome: { status: "succeeded" },
      },
      {
        item: {
          type: "toolExecution",
          toolName: "get_command_or_subagent_output",
        },
        outcome: { status: "succeeded" },
      },
    ]);
  });

  it.each([
    { model: undefined, reportedModel: undefined },
    { model: "grok-4.5", reportedModel: undefined },
    { model: "grok-4.5", reportedModel: "grok-4.6" },
    { model: undefined, reportedModel: "provider/child-model" },
  ])("restores only explicit child Model metadata: %j", ({ model, reportedModel }) => {
    const replay: Parameters<typeof mapGrokReplay>[0] = [
      { type: "user.text", text: "delegate", metadata: { eventId: "user-1" } },
      {
        type: "tool.call",
        callId: "spawn-1",
        title: "spawn_subagent",
        name: "spawn_subagent",
        rawInput: {
          description: "Inspect",
          subagent_id: "child-session",
          ...(model ? { model } : {}),
        },
      },
      ...(reportedModel
        ? [
            {
              type: "subagent.spawned" as const,
              nativeSubagentId: "child-session",
              model: reportedModel,
            },
          ]
        : []),
      { type: "subagent.finished", nativeSubagentId: "child-session", status: "completed" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
    ];
    const snapshot = mapGrokReplay(replay, grokHarnessId, "session-1", "/workspace");
    expect(mapGrokReplay(replay, grokHarnessId, "session-1", "/workspace")).toEqual(snapshot);
    const item = snapshot.turns[0]?.items[0]?.item;
    if (item?.type !== "subagentDelegation") throw new Error("Expected Subagent delegation");
    expect(item.subagents[0]?.model).toBe(reportedModel ?? model);
    expect(item.subagents[0]).not.toHaveProperty("reasoningEffort");
    if (!reportedModel && !model) expect(item.subagents[0]).not.toHaveProperty("model");
  });

  it("restores Command output and Generic Tool results from Native history", () => {
    const snapshot = mapGrokReplay(
      [
        { type: "user.text", text: "inspect", metadata: { eventId: "user-1" } },
        {
          type: "tool.call",
          callId: "bash-1",
          title: "Run tests",
          name: "bash",
          rawInput: { command: "npm test" },
          status: "in_progress",
        },
        {
          type: "tool.update",
          callId: "bash-1",
          status: "completed",
          rawOutput: { type: "Bash", output: [...Buffer.from("passed")], exit_code: 0 },
        },
        {
          type: "tool.call",
          callId: "read-1",
          title: "Read a.txt",
          name: "read_file",
          rawInput: { target_file: "/workspace/a.txt" },
          status: "in_progress",
        },
        {
          type: "tool.update",
          callId: "read-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "file body" } }],
        },
        {
          type: "tool.call",
          callId: "list-1",
          title: "List workspace",
          name: "list_dir",
          rawInput: { target_directory: "/workspace" },
          status: "in_progress",
        },
        {
          type: "tool.update",
          callId: "list-1",
          status: "completed",
          rawOutput: { type: "ListDir", content: "a.ts\nb.ts" },
        },
        { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
      ],
      grokHarnessId,
      "session-1",
      "/workspace",
    );

    expect(snapshot.turns[0]?.items).toMatchObject([
      {
        item: {
          type: "commandExecution",
          command: "npm test",
          output: "passed",
          exitCode: 0,
        },
        outcome: { status: "succeeded" },
      },
      {
        item: {
          type: "toolExecution",
          toolName: "read_file",
          arguments: { target_file: "/workspace/a.txt" },
          output: { content: [{ type: "text", text: "file body" }] },
        },
        outcome: { status: "succeeded" },
      },
      {
        item: {
          type: "toolExecution",
          toolName: "list_dir",
          output: { content: [{ type: "text", text: "a.ts\nb.ts" }] },
        },
        outcome: { status: "succeeded" },
      },
    ]);
  });
});

describe("Grok history local media Markdown", () => {
  it("rewrites session-relative video images onto absolute paths", async () => {
    const sessionDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-grok-media-"));
    const videoPath = path.join(sessionDirectory, "videos", "1.mp4");
    try {
      await mkdir(path.dirname(videoPath), { recursive: true });
      await writeFile(videoPath, "mp4");
      const snapshot = mapGrokReplay(
        [
          { type: "user.text", text: "make a clip" },
          { type: "agent.text", text: "![clip](videos/1.mp4)" },
          { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
        ],
        grokHarnessId,
        "session-1",
        sessionDirectory,
        [],
        undefined,
        sessionDirectory,
      );
      expect(snapshot.turns[0]?.items).toMatchObject([
        {
          item: { type: "agentMessage", text: `![clip](${videoPath})` },
          outcome: { status: "succeeded" },
        },
      ]);
    } finally {
      await rm(sessionDirectory, { recursive: true, force: true });
    }
  });
});
