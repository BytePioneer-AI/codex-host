import { describe, expect, it } from "vitest";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodexTurnProjector } from "../src/index.js";

const turnId = hostTurnIdSchema.parse("turn");
const projector = () =>
  new CodexTurnProjector({ threadId: "thread", turnId, cwd: "/workspace", startedAtMs: 1 });

describe("CodexTurnProjector duplicate item.started replay", () => {
  it("treats a replayed item.started for a projected Item as a no-op", () => {
    const ui = projector();
    ui.project({ type: "turn.started", turnId });
    const itemId = hostItemIdSchema.parse("cmd-1");
    const started = {
      type: "item.started" as const,
      turnId,
      item: { type: "commandExecution" as const, itemId, command: "sleep 10" },
    };
    ui.project(started);
    const replay = ui.project(started);
    expect(replay.messages).toEqual([]);
    ui.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { type: "commandExecution", itemId, command: "sleep 10" },
        outcome: { status: "succeeded" as const },
      },
    });
    // The Turn still completes normally after the replay.
    const completed = ui.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" as const },
    });
    expect(completed.completedTurn).toMatchObject({ status: "completed" });
  });

  it("accepts a replayed item.started after updates changed the Item content", () => {
    const ui = projector();
    ui.project({ type: "turn.started", turnId });
    const itemId = hostItemIdSchema.parse("agent-1");
    ui.project({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", itemId, text: "" },
    });
    ui.project({
      type: "item.updated",
      turnId,
      itemId,
      update: { type: "text.append", text: "partial answer" },
    });
    // The replay carries the stale initial content, not the streamed updates.
    const replay = ui.project({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", itemId, text: "" },
    });
    expect(replay.messages).toEqual([]);
  });

  it("still rejects a duplicate ItemId that carries a different Item kind", () => {
    const ui = projector();
    ui.project({ type: "turn.started", turnId });
    const itemId = hostItemIdSchema.parse("clash-1");
    ui.project({
      type: "item.started",
      turnId,
      item: { type: "commandExecution", itemId, command: "ls" },
    });
    expect(() =>
      ui.project({
        type: "item.started",
        turnId,
        item: { type: "agentMessage", itemId, text: "hi" },
      }),
    ).toThrow("Host Item started more than once");
  });

  it("rejects a replayed toolExecution ItemId that carries a different toolName", () => {
    const ui = projector();
    ui.project({ type: "turn.started", turnId });
    const itemId = hostItemIdSchema.parse("tool-1");
    ui.project({
      type: "item.started",
      turnId,
      item: { type: "toolExecution", itemId, toolName: "TodoWrite", arguments: {} },
    });
    expect(() =>
      ui.project({
        type: "item.started",
        turnId,
        item: { type: "toolExecution", itemId, toolName: "Read", arguments: {} },
      }),
    ).toThrow("Host Item started more than once");
  });

  it("rejects a replayed toolExecution ItemId that carries a different namespace", () => {
    const ui = projector();
    ui.project({ type: "turn.started", turnId });
    const itemId = hostItemIdSchema.parse("tool-2");
    ui.project({
      type: "item.started",
      turnId,
      item: { type: "toolExecution", itemId, toolName: "Read", arguments: {} },
    });
    expect(() =>
      ui.project({
        type: "item.started",
        turnId,
        item: {
          type: "toolExecution",
          itemId,
          toolName: "Read",
          namespace: "other",
          arguments: {},
        },
      }),
    ).toThrow("Host Item started more than once");
  });

  it("treats a replayed toolExecution start with the same identity as a no-op", () => {
    const ui = projector();
    ui.project({ type: "turn.started", turnId });
    const itemId = hostItemIdSchema.parse("tool-3");
    const started = {
      type: "item.started" as const,
      turnId,
      item: { type: "toolExecution" as const, itemId, toolName: "Read", arguments: {} },
    };
    ui.project(started);
    expect(ui.hasProjectedItem(itemId)).toBe(true);
    expect(ui.project(started).messages).toEqual([]);
  });
});
