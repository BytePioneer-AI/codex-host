import { expect, it } from "vitest";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import {
  ChThreadView,
  type ChThread,
  type ChTurn,
} from "../../packages/web-server/src/ch-thread-view.ts";

it("streams consecutive Web Reasoning snapshots without rewriting a displayed prefix", () => {
  const turnId = hostTurnIdSchema.parse("reasoning-turn");
  const itemId = hostItemIdSchema.parse("reasoning");
  const thread: ChThread = {
    id: "reasoning-thread",
    cwd: "/workspace",
    modelProvider: "pi",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "active" },
    turns: [],
  };
  const projector = new CodexTurnProjector({
    threadId: thread.id,
    turnId,
    cwd: thread.cwd,
    startedAtMs: 1_000,
  });
  const view = new ChThreadView(structuredClone(thread), "pi", () => {});
  const update = (turn: unknown) => view.update({ ...thread, turns: [turn as ChTurn] });
  const chunks = ["Reading the con", "fig. Next", " step.\n\nLast result"];
  projector.project({ type: "turn.started", turnId });
  projector.project({
    type: "item.started",
    turnId,
    item: { type: "reasoning", itemId, text: "" },
  });
  for (const text of chunks) {
    projector.project({
      type: "item.updated",
      turnId,
      itemId,
      update: { type: "text.append", text },
    });
    update(projector.snapshotTurn());
  }
  projector.project({
    type: "item.completed",
    turnId,
    snapshot: {
      item: { type: "reasoning", itemId, text: chunks.join("") },
      outcome: { status: "succeeded" },
    },
  });
  const { completedTurn } = projector.project({
    type: "turn.completed",
    turnId,
    outcome: { status: "succeeded" },
  });
  update(projector.snapshotTurn(completedTurn));
  const message = view.log.events.findLast((event) => event.type === "assistant/message");
  expect(message?.data).toMatchObject({
    message: {
      content: [
        { type: "reasoning", text: "**Reading the config**\n\nNext step.\n\n**Last result**" },
      ],
    },
  });
});
