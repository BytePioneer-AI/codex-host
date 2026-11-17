import { describe, expect, it } from "vitest";
import type { HostCommandExecutionItem } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import { CodexTurnProjector } from "../src/index.js";

const turnId = hostTurnIdSchema.parse("turn-1");
const message = {
  type: "agentMessage" as const,
  itemId: hostItemIdSchema.parse("bg-1"),
  text: "",
};
const command: HostCommandExecutionItem = {
  type: "commandExecution",
  itemId: hostItemIdSchema.parse("bash-1"),
  command: "npm run dev",
  cwd: "/workspace",
};

function completedProjector(): CodexTurnProjector {
  const projector = new CodexTurnProjector({
    threadId: "thread-1",
    turnId,
    cwd: "/workspace",
    startedAtMs: 1_000,
  });
  projector.project({ type: "turn.started", turnId }, 1_000);
  projector.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } }, 1_100);
  return projector;
}

describe("Codex UI projector background Items", () => {
  it("starts a background text Item on a completed Turn and streams it like a detached Item", () => {
    const projector = completedProjector();
    projector.project({ type: "item.background.started", turnId, item: message }, 2_000);
    expect(projector.hasOpenDetachedItems).toBe(true);

    const delta = projector.project(
      {
        type: "item.updated",
        turnId,
        itemId: message.itemId,
        update: { type: "text.append", text: "awake\n" },
      },
      2_100,
    );
    expect(delta.messages).toMatchObject([
      { method: "item/started", params: { turnId, item: { id: message.itemId } } },
      { method: "item/agentMessage/delta", params: { itemId: message.itemId, delta: "awake\n" } },
    ]);

    const completed = projector.project(
      {
        type: "item.completed",
        turnId,
        snapshot: { item: { ...message, text: "awake\n" }, outcome: { status: "succeeded" } },
      },
      3_000,
    );
    const completedItem = completed.messages.find(
      (candidate) => candidate.method === "item/completed",
    );
    expect(completedItem).toMatchObject({
      method: "item/completed",
      params: { turnId, item: { id: message.itemId, type: "agentMessage", text: "awake\n" } },
    });
    expect(projector.hasOpenDetachedItems).toBe(false);
    expect(projector.openDetachedWireItems()).toEqual(new Map());
  });

  it("rejects a background Item before the Turn completes", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/workspace",
      startedAtMs: 1_000,
    });
    projector.project({ type: "turn.started", turnId }, 1_000);
    expect(() =>
      projector.project({ type: "item.background.started", turnId, item: message }, 1_100),
    ).toThrow("Host foreground output must use item.started");
  });

  it("rejects non-text background Items and wrong-Turn background output", () => {
    const projector = completedProjector();
    expect(() =>
      projector.project(
        {
          type: "item.background.started",
          turnId,
          item: { type: "commandExecution", ...command },
        },
        2_000,
      ),
    ).toThrow("Only a text Item can start after its Turn completes");
    expect(() =>
      projector.project(
        {
          type: "item.background.started",
          turnId: hostTurnIdSchema.parse("turn-other"),
          item: message,
        },
        2_000,
      ),
    ).toThrow("Host output references another Turn");
  });

  it("sweeps a pending background Item to failed through failureEvents", () => {
    const projector = completedProjector();
    projector.project({ type: "item.background.started", turnId, item: message }, 2_000);
    const events = projector.failureEvents({
      code: "protocolError",
      message: "output stream broke",
      retryable: false,
    });
    expect(events).toContainEqual({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { ...message, text: "" },
        outcome: {
          status: "failed",
          error: { code: "protocolError", message: "output stream broke", retryable: false },
        },
      },
    });
  });
});
