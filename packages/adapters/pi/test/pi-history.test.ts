import { describe, expect, it } from "vitest";

import {
  activePiEntries,
  mapPiSnapshot,
  resolvePiForkBoundary,
  type PiSessionHistory,
} from "../src/pi-history.js";
import { encodePiModelRef } from "../src/pi-model-catalog.js";

const history: PiSessionHistory = {
  entries: [
    {
      id: "model-1",
      parentId: null,
      type: "model_change",
      provider: "provider-a",
      modelId: "model-a",
    },
    {
      id: "user-1",
      parentId: "model-1",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "first" }] },
    },
    {
      id: "assistant-1",
      parentId: "user-1",
      type: "message",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "checking" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
        ],
      },
    },
    {
      id: "tool-1",
      parentId: "assistant-1",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "contents" }],
      },
    },
    {
      id: "model-2",
      parentId: "tool-1",
      type: "model_change",
      provider: "provider-b",
      modelId: "model-b",
    },
    {
      id: "user-2",
      parentId: "model-2",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "second" }] },
    },
    {
      id: "assistant-2",
      parentId: "user-2",
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
      },
    },
    {
      id: "sibling-user",
      parentId: "user-1",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "not active" }] },
    },
  ],
  leafId: "assistant-2",
};

const state = {
  sessionId: "pi-session",
  model: { provider: "provider-b", id: "model-b" },
};

describe("Pi active-branch history", () => {
  it("walks only the parent chain ending at leafId", () => {
    expect(activePiEntries(history).map(({ id }) => id)).toEqual([
      "model-1",
      "user-1",
      "assistant-1",
      "tool-1",
      "model-2",
      "user-2",
      "assistant-2",
    ]);
  });

  it("projects deterministic Turns, Items, terminal identity, and Checkpoints", () => {
    const snapshot = mapPiSnapshot(history, state);

    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: {
        harnessId: "pi",
        nativeSessionId: "pi-session",
        nativeTurnKey: "user-1",
      },
      checkpoint: { checkpointId: "user-1" },
      input: [{ type: "text", text: "first" }],
      model: encodePiModelRef({ provider: "provider-a", id: "model-a" }),
      outcome: { status: "succeeded" },
      items: [
        { item: { type: "agentMessage", text: "checking" } },
        {
          item: {
            type: "toolExecution",
            toolName: "read",
            arguments: { path: "a.txt" },
            output: { content: [{ type: "text", text: "contents" }] },
          },
          outcome: { status: "succeeded" },
        },
      ],
    });
    expect(snapshot.turns[1]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "user-2" },
      checkpoint: { checkpointId: "user-2" },
      model: encodePiModelRef({ provider: "provider-b", id: "model-b" }),
      items: [{ item: { type: "agentMessage", text: "done" } }],
    });
    expect(mapPiSnapshot(history, state)).toEqual(snapshot);
  });

  it("resolves middle and terminal logical Fork boundaries", () => {
    expect(resolvePiForkBoundary(history, "user-1")).toEqual({
      targetTurnIndex: 0,
      nextUserEntryId: "user-2",
    });
    expect(resolvePiForkBoundary(history, "user-2")).toEqual({
      targetTurnIndex: 1,
      nextUserEntryId: null,
    });
    expect(() => resolvePiForkBoundary(history, "sibling-user")).toThrow(
      "not on the active branch",
    );
  });

  it("rejects broken active-branch identity", () => {
    expect(() => activePiEntries({ entries: history.entries, leafId: "missing" })).toThrow(
      "missing Entry",
    );
  });
});
