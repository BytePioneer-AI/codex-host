import { describe, expect, it } from "vitest";
import type { HostCommandExecutionItem } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import { CodexTurnProjector } from "../src/index.js";

const turnId = hostTurnIdSchema.parse("turn-1");
const command: HostCommandExecutionItem = {
  type: "commandExecution",
  itemId: hostItemIdSchema.parse("bash-1"),
  command: "npm run dev",
  cwd: "/workspace",
};

function startedProjector(): CodexTurnProjector {
  const projector = new CodexTurnProjector({
    threadId: "thread-1",
    turnId,
    cwd: "/workspace",
    startedAtMs: 1_000,
  });
  projector.project({ type: "turn.started", turnId }, 1_000);
  projector.project({ type: "item.started", turnId, item: command }, 1_100);
  return projector;
}

describe("Codex UI projector detached command Items", () => {
  it("completes the Turn while a detached command keeps running, then settles it", () => {
    const projector = startedProjector();
    projector.project({ type: "item.detached", turnId, itemId: command.itemId }, 1_200);

    const turn = projector.project(
      { type: "turn.completed", turnId, outcome: { status: "succeeded" } },
      1_300,
    );
    expect(turn.completedTurn).toMatchObject({ status: "completed" });
    expect(projector.hasOpenDetachedItems).toBe(true);

    const delta = projector.project(
      {
        type: "item.updated",
        turnId,
        itemId: command.itemId,
        update: { type: "output.append", text: "ready\n" },
      },
      2_000,
    );
    expect(delta.messages).toMatchObject([
      {
        method: "item/commandExecution/outputDelta",
        params: { turnId, itemId: command.itemId, delta: "ready\n" },
      },
    ]);

    // History projection overlays the unsettled command until its result arrives.
    expect([...projector.openDetachedWireItems()]).toMatchObject([
      [
        command.itemId,
        {
          id: command.itemId,
          type: "commandExecution",
          status: "inProgress",
          aggregatedOutput: "ready\n",
          exitCode: null,
        },
      ],
    ]);

    const completed = projector.project(
      {
        type: "item.completed",
        turnId,
        snapshot: { item: { ...command, output: "ready\n" }, outcome: { status: "succeeded" } },
      },
      3_000,
    );
    expect(completed.messages).toMatchObject([
      {
        method: "item/completed",
        params: { turnId, item: { id: command.itemId, status: "completed" } },
      },
    ]);
    expect(projector.hasOpenDetachedItems).toBe(false);
    expect(projector.openDetachedWireItems()).toEqual(new Map());
  });

  it("still rejects Turn completion with an open Item that was not detached", () => {
    const projector = startedProjector();
    expect(() =>
      projector.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } }),
    ).toThrow("Host Turn completed with active Items");
  });

  it("rejects late output for Items that did not outlive the Turn", () => {
    const projector = startedProjector();
    projector.project({ type: "item.detached", turnId, itemId: command.itemId });
    projector.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    expect(() =>
      projector.project({
        type: "item.updated",
        turnId,
        itemId: hostItemIdSchema.parse("other"),
        update: { type: "output.append", text: "x" },
      }),
    ).toThrow("Host output follows the Turn terminal event");
  });
});
