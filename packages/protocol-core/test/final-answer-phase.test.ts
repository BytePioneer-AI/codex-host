import { describe, expect, it } from "vitest";
import type { HostItemSnapshot, HostThreadSnapshot, TurnOutcome } from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";

import { CodexTurnProjector, projectHistoricalTurn } from "../src/index.js";

const turnId = hostTurnIdSchema.parse("turn-1");
const itemId = (value: string) => hostItemIdSchema.parse(value);
const succeeded = { status: "succeeded" } as const;

function liveTurn(
  items: HostItemSnapshot[],
  outcome: TurnOutcome = succeeded,
): { messages: Record<string, unknown>[]; completedTurn: unknown } {
  const projector = new CodexTurnProjector({
    threadId: "thread-1",
    turnId,
    cwd: "/workspace",
    startedAtMs: 1_000,
  });
  projector.project({ type: "turn.started", turnId });
  for (const [index, snapshot] of items.entries()) {
    projector.project({ type: "item.started", turnId, item: snapshot.item }, 1_100 + index * 100);
    projector.project({ type: "item.completed", turnId, snapshot }, 1_150 + index * 100);
  }
  const completed = projector.project({ type: "turn.completed", turnId, outcome }, 3_000);
  return { messages: completed.messages, completedTurn: completed.completedTurn };
}

function historicalTurn(
  items: HostItemSnapshot[],
  outcome: HostThreadSnapshot["turns"][number]["outcome"] = succeeded,
) {
  return projectHistoricalTurn({
    turnId,
    cwd: "/workspace",
    snapshot: {
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: "pi",
        nativeSessionId: "session-1",
        nativeTurnKey: "native-turn-1",
        formatVersion: 1,
      }),
      input: [{ type: "text", text: "question" }],
      items,
      outcome,
    },
  });
}

const progress: HostItemSnapshot = {
  item: { type: "agentMessage", itemId: itemId("progress"), text: "Checking." },
  outcome: succeeded,
};
const command: HostItemSnapshot = {
  item: { type: "commandExecution", itemId: itemId("command"), command: "ls", exitCode: 0 },
  outcome: succeeded,
};
const answer: HostItemSnapshot = {
  item: { type: "agentMessage", itemId: itemId("answer"), text: "Done." },
  outcome: succeeded,
};

describe("final answer phase inference", () => {
  it("replays the reply that ends a succeeded live Turn as its final answer", () => {
    const { messages, completedTurn } = liveTurn([progress, command, answer]);

    expect(messages.map(({ method }) => method)).toEqual(["item/completed", "turn/completed"]);
    expect(messages[0]).toMatchObject({
      params: {
        startedAtMs: 1_300,
        completedAtMs: 1_350,
        item: { id: "answer", type: "agentMessage", text: "Done.", phase: "final_answer" },
      },
    });
    expect(completedTurn).toMatchObject({
      items: [
        { id: "progress", phase: null },
        { id: "answer", phase: "final_answer" },
      ],
    });
  });

  it("projects the same final answer for a historical Turn", () => {
    expect(historicalTurn([progress, command, answer])).toMatchObject({
      items: [
        { type: "userMessage" },
        { id: "progress", phase: null },
        { id: "command", type: "commandExecution" },
        { id: "answer", phase: "final_answer" },
      ],
    });
  });

  it("keeps an explicit Adapter phase and replays nothing", () => {
    const commentary: HostItemSnapshot = {
      item: { type: "agentMessage", itemId: itemId("answer"), text: "Done.", phase: "commentary" },
      outcome: succeeded,
    };
    const live = liveTurn([command, commentary]);

    expect(live.messages.map(({ method }) => method)).toEqual(["turn/completed"]);
    expect(live.completedTurn).toMatchObject({ items: [{ id: "answer", phase: "commentary" }] });
    expect(historicalTurn([command, commentary])).toMatchObject({
      items: [{ type: "userMessage" }, { id: "command" }, { id: "answer", phase: "commentary" }],
    });
  });

  it("does not infer when visible work follows the last reply", () => {
    const live = liveTurn([progress, command]);

    expect(live.messages.map(({ method }) => method)).toEqual(["turn/completed"]);
    expect(live.completedTurn).toMatchObject({ items: [{ id: "progress", phase: null }] });
    expect(historicalTurn([progress, command])).toMatchObject({
      items: [{ type: "userMessage" }, { id: "progress", phase: null }, { id: "command" }],
    });
  });

  it("does not infer for Turns that did not succeed", () => {
    const cancelled = { status: "cancelled", reason: "stopped" } as const;
    const live = liveTurn([command, answer], cancelled);

    expect(live.messages.map(({ method }) => method)).toEqual(["turn/completed"]);
    expect(live.completedTurn).toMatchObject({ items: [{ id: "answer", phase: null }] });
    expect(historicalTurn([command, answer], cancelled)).toMatchObject({
      items: [{ type: "userMessage" }, { id: "command" }, { id: "answer", phase: null }],
    });
    expect(
      historicalTurn([command, answer], { status: "unknown", reason: "no terminal record" }),
    ).toMatchObject({
      items: [{ type: "userMessage" }, { id: "command" }, { id: "answer", phase: null }],
    });
  });
});
