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
