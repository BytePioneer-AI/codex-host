import { describe, expect, it } from "vitest";

import { CodexTurnProjector } from "../src/codex-ui-projector.js";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

const turnId = hostTurnIdSchema.parse("turn-1");
const itemId = hostItemIdSchema.parse("item-1");

describe("CodexTurnProjector pending Turn", () => {
  it("includes explicitly projected input for an externally started Turn", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/synthetic",
      startedAtMs: 1_000,
      initialInput: [{ type: "text", text: "Review auth" }],
    });

    const started = projector.project({ type: "turn.started", turnId });

    expect(started.messages).toMatchObject([
      {
        method: "turn/started",
        params: {
          turn: {
            items: [
              {
                id: `${turnId}-user`,
                type: "userMessage",
                content: [{ type: "text", text: "Review auth" }],
              },
            ],
          },
        },
      },
    ]);
    expect(projector.pendingTurn()).toMatchObject({
      items: [
        {
          id: `${turnId}-user`,
          type: "userMessage",
          content: [{ type: "text", text: "Review auth" }],
        },
      ],
    });
  });

  it("includes the current visible Agent message but excludes reasoning activity", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/synthetic",
      startedAtMs: 1_000,
    });
    projector.project({ type: "turn.started", turnId });
    projector.project({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", itemId, text: "" },
    });
    projector.project({
      type: "item.updated",
      turnId,
      itemId,
      update: { type: "text.append", text: "Checking auth." },
    });
    const reasoningId = hostItemIdSchema.parse("reasoning-1");
    projector.project({
      type: "item.started",
      turnId,
      item: { type: "reasoning", itemId: reasoningId, text: "hidden" },
    });

    expect(projector.pendingTurn()).toMatchObject({
      status: "inProgress",
      items: [
        {
          id: itemId,
          type: "agentMessage",
          text: "Checking auth.",
        },
      ],
    });
    expect(JSON.stringify(projector.pendingTurn())).not.toContain("hidden");
  });
});
