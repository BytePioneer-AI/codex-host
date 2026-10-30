import { describe, expect, it } from "vitest";

import {
  activePiEntries,
  mapPiSnapshot,
  resolvePiForkBoundary,
  resolvePiLastTurnBoundary,
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
          { type: "thinking", thinking: "inspect first", thinkingSignature: "ignored" },
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
        {
          item: {
            type: "reasoning",
            itemId: "pi-item-v1-assistant-1-reasoning-0",
            text: "inspect first",
          },
        },
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

  it("restores durable compaction entries in native order with stable IDs", () => {
    const compactedHistory: PiSessionHistory = {
      entries: [
        {
          id: "user-before-compact",
          parentId: null,
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "work" }] },
        },
        {
          id: "assistant-before-compact",
          parentId: "user-before-compact",
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "done" }],
          },
        },
        {
          id: "native-compact",
          parentId: "assistant-before-compact",
          type: "compaction",
          summary: "native summary",
          firstKeptEntryId: "user-before-compact",
          tokensBefore: 120_000,
        },
        {
          id: "user-after-compact",
          parentId: "native-compact",
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "continue" }] },
        },
        {
          id: "assistant-after-compact",
          parentId: "user-after-compact",
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "continued" }],
          },
        },
      ],
      leafId: "assistant-after-compact",
    };

    const snapshot = mapPiSnapshot(compactedHistory, state);

    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]?.items).toEqual([
      {
        item: {
          type: "agentMessage",
          itemId: "pi-item-v1-assistant-before-compact-assistant-0",
          text: "done",
        },
        outcome: { status: "succeeded" },
      },
      {
        item: {
          type: "contextCompaction",
          itemId: "pi-item-v1-native-compact-compaction-0",
        },
        outcome: { status: "succeeded" },
      },
    ]);
    expect(snapshot.turns[1]?.items).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ text: "continued" }) }),
    ]);
    expect(mapPiSnapshot(compactedHistory, state)).toEqual(snapshot);
  });

  it("replays interleaved Assistant messages and Tools in native order", () => {
    const ids = ["user", "assistant-1", "tool-1", "assistant-2", "tool-2", "assistant-3"];
    const messages = [
      { role: "user", content: [{ type: "text", text: "work" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "one" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "second" },
          { type: "toolCall", id: "call-2", name: "read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "two" }],
      },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "third" }] },
    ];
    const boundaryHistory: PiSessionHistory = {
      entries: messages.map((message, index) => ({
        id: ids[index] as string,
        parentId: ids[index - 1] ?? null,
        type: "message",
        message,
      })),
      leafId: ids.at(-1) as string,
    };

    const items = mapPiSnapshot(boundaryHistory, state).turns[0]?.items ?? [];
    expect(
      items.map(({ item }) =>
        item.type === "agentMessage" ? `agent:${item.text}` : `tool:${item.type}`,
      ),
    ).toEqual([
      "agent:first",
      "tool:toolExecution",
      "agent:second",
      "tool:toolExecution",
      "agent:third",
    ]);
    expect(items.map(({ item }) => item.itemId)).toEqual([
      "pi-item-v1-assistant-1-assistant-0",
      "pi-item-v1-assistant-1-tool-1",
      "pi-item-v1-assistant-2-assistant-0",
      "pi-item-v1-assistant-2-tool-1",
      "pi-item-v1-assistant-3-assistant-0",
    ]);
  });

  it("splits a custom-triggered execution without exposing its control input", () => {
    const controlHistory: PiSessionHistory = {
      entries: [
        {
          id: "human-user",
          parentId: null,
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "human request" }] },
        },
        {
          id: "assistant-before-control",
          parentId: "human-user",
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "before control" }],
          },
        },
        {
          id: "intercom-control",
          parentId: "assistant-before-control",
          type: "message",
          message: {
            role: "custom",
            customType: "intercom_message",
            content: "subAgent completed",
          },
        },
        {
          id: "assistant-after-control",
          parentId: "intercom-control",
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "autonomous follow-up" }],
          },
        },
      ],
      leafId: "assistant-after-control",
    };

    const snapshot = mapPiSnapshot(controlHistory, state);

    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "human-user" },
      input: [{ type: "text", text: "human request" }],
      items: [{ item: { type: "agentMessage", text: "before control" } }],
    });
    expect(snapshot.turns[0]).not.toHaveProperty("checkpoint");
    expect(snapshot.turns[1]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "intercom-control" },
      checkpoint: { checkpointId: "intercom-control" },
      input: [],
      items: [{ item: { type: "agentMessage", text: "autonomous follow-up" } }],
      outcome: { status: "succeeded" },
    });
    expect(() => resolvePiForkBoundary(controlHistory, "human-user")).toThrow();
    expect(resolvePiForkBoundary(controlHistory, "intercom-control")).toEqual({
      targetTurnIndex: 1,
      nextUserEntryId: null,
    });
    expect(resolvePiLastTurnBoundary(controlHistory)?.lastUserEntryId).toBeNull();

    controlHistory.entries.push(
      {
        id: "human-next",
        parentId: controlHistory.leafId,
        type: "message",
        message: { role: "user", content: "next" },
      },
      {
        id: "answer-next",
        parentId: "human-next",
        type: "message",
        message: { role: "assistant", content: "answer", stopReason: "stop" },
      },
    );
    controlHistory.leafId = "answer-next";
    expect(resolvePiForkBoundary(controlHistory, "intercom-control")).toEqual({
      targetTurnIndex: 1,
      nextUserEntryId: "human-next",
    });
    expect(resolvePiLastTurnBoundary(controlHistory)).toEqual({
      lastUserEntryId: "human-next",
      sourceTurnCount: 3,
    });
  });

  it("does not split an in-run custom injection or an untriggered notification", () => {
    const entries = [
      { id: "user", parentId: null, type: "message", message: { role: "user", content: "work" } },
      {
        id: "tool-call",
        parentId: "user",
        type: "message",
        message: { role: "assistant", stopReason: "toolUse", content: "checking" },
      },
      {
        id: "injected",
        parentId: "tool-call",
        type: "custom_message",
        customType: "progress",
        content: "progress",
        display: false,
      },
      {
        id: "answer",
        parentId: "injected",
        type: "message",
        message: { role: "assistant", stopReason: "stop", content: "done" },
      },
      {
        id: "untriggered",
        parentId: "answer",
        type: "custom_message",
        customType: "status",
        content: "status",
        display: false,
      },
    ];
    expect(mapPiSnapshot({ entries, leafId: "untriggered" }, state).turns).toMatchObject([
      { nativeTurnRef: { nativeTurnKey: "user" }, checkpoint: { checkpointId: "user" } },
    ]);
    entries.push({
      id: "auto-answer",
      parentId: "untriggered",
      type: "message",
      message: { role: "assistant", stopReason: "stop", content: "follow-up" },
    });
    const turns = mapPiSnapshot({ entries, leafId: "auto-answer" }, state).turns;
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ nativeTurnRef: { nativeTurnKey: "untriggered" }, input: [] });
  });

  it("does not infer success from reasoning-only history", () => {
    const reasoningOnly: PiSessionHistory = {
      entries: [
        {
          id: "reasoning-user",
          parentId: null,
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "question" }] },
        },
        {
          id: "reasoning-assistant",
          parentId: "reasoning-user",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "visible but not terminal" }],
          },
        },
      ],
      leafId: "reasoning-assistant",
    };

    const turn = mapPiSnapshot(reasoningOnly, state).turns[0];
    expect(turn).toMatchObject({
      outcome: { status: "unknown" },
      items: [{ item: { type: "reasoning", text: "visible but not terminal" } }],
    });
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
