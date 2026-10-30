import { describe, expect, it } from "vitest";
import type { HarnessError } from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import { CodexTurnProjector } from "../src/index.js";

const turnId = hostTurnIdSchema.parse("turn");
const error: HarnessError = {
  code: "protocolError",
  message: "Invalid Harness output",
  retryable: false,
};
const projector = () =>
  new CodexTurnProjector({ threadId: "thread", turnId, cwd: "/workspace", startedAtMs: 1 });

describe("CodexTurnProjector failure recovery", () => {
  it.each([false, true])(
    "closes pending Questions and Items before failing (attached: %s)",
    (attached) => {
      const ui = projector();
      ui.project({ type: "turn.started", turnId });
      const itemId = hostItemIdSchema.parse("tool");
      ui.project({
        type: "item.started",
        turnId,
        item: { type: "toolExecution", itemId, toolName: "question", arguments: {} },
      });
      ui.projectQuestion(
        {
          type: "question",
          turnId,
          interactionId: hostInteractionIdSchema.parse("question"),
          ...(attached ? { itemId } : {}),
          questions: [
            {
              id: "answer",
              type: "text",
              prompt: "Continue?",
              multiline: false,
              secret: false,
              optional: false,
            },
          ],
        },
        hostItemIdSchema.parse("synthetic-question"),
      );
      const events = ui.failureEvents(error);
      expect(events[0]).toMatchObject({ type: "interaction.closed", reason: "cancelled" });
      const projections = events.map((event) => ui.project(event));
      expect(projections.at(-1)?.completedTurn).toMatchObject({
        status: "failed",
        error: { message: error.message },
      });
      expect(ui.completed).toBe(true);
      expect(ui.failureEvents(error)).toEqual([]);
    },
  );

  it("starts a not-yet-started Turn before failing it", () => {
    const ui = projector();
    const events = ui.failureEvents(error);
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect(events.map((event) => ui.project(event)).at(-1)?.completedTurn).toMatchObject({
      status: "failed",
    });
  });

  it("settles detached Items without replacing an already completed Turn", () => {
    const ui = projector();
    const itemId = hostItemIdSchema.parse("background");
    ui.project({ type: "turn.started", turnId });
    ui.project({
      type: "item.started",
      turnId,
      item: { type: "commandExecution", itemId, command: "sleep 10" },
    });
    ui.project({ type: "item.detached", turnId, itemId });
    ui.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    const events = ui.failureEvents(error);
    expect(events.map((event) => event.type)).toEqual(["item.completed"]);
    events.forEach((event) => ui.project(event));
    expect(ui.hasOpenDetachedItems).toBe(false);
    expect(ui.failureEvents(error)).toEqual([]);
  });
});
