import { describe, expect, it } from "vitest";

import { mapGrokReplay, resolveGrokTargetPromptIndex } from "../src/grok-history.js";

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
      "grok",
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
      "grok",
      "session-1",
      "/workspace",
    );
    expect(snapshot.turns[0]?.checkpoint?.checkpointId).toBe("4");
    expect(resolveGrokTargetPromptIndex(snapshot, "4")).toBe(4);
  });
});
