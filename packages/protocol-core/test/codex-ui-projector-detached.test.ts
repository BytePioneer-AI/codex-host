import { describe, expect, it } from "vitest";
import type { HostCommandExecutionItem, HostFileChangeItem } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema, type JsonObject } from "@codexhost/shared-contracts";

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

function itemCompletionsFor(messages: JsonObject[], itemId: string): JsonObject[] {
  return messages.filter(({ method, params }) => {
    if (method !== "item/completed") return false;
    const item = (params as { item?: { id?: string } } | undefined)?.item;
    return item?.id === itemId;
  });
}

describe("Codex UI projector detached command Items", () => {
  it.each(["before", "after"] as const)(
    "keeps a tool-owned diff first reported %s Turn completion",
    (timing) => {
      const projector = startedProjector();
      const messages: JsonObject[] = [];
      const project = (event: Parameters<CodexTurnProjector["project"]>[0]) => {
        const projection = projector.project(event);
        messages.push(...projection.messages);
        return projection;
      };
      const diff: HostFileChangeItem = {
        type: "fileChange",
        itemId: hostItemIdSchema.parse("bash-1-diff"),
        sourceItemIds: [command.itemId],
        changes: [{ path: "a.ts", kind: "update", unifiedDiff: "-before\n+after" }],
      };
      if (timing === "before") project({ type: "item.started", turnId, item: diff });
      project({ type: "item.detached", turnId, itemId: command.itemId });
      if (timing === "before") project({ type: "item.detached", turnId, itemId: diff.itemId });
      expect(
        project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } }).completedTurn,
      ).toMatchObject({ status: "completed" });
      if (timing === "after") project({ type: "item.started", turnId, item: diff });
      project({
        type: "item.completed",
        turnId,
        snapshot: { item: command, outcome: { status: "succeeded" } },
      });
      expect(projector.hasOpenDetachedItems).toBe(true);
      project({
        type: "item.completed",
        turnId,
        snapshot: { item: diff, outcome: { status: "succeeded" } },
      });
      expect(projector.hasOpenDetachedItems).toBe(false);
      expect(itemCompletionsFor(messages, diff.itemId)).toMatchObject([
        {
          params: {
            item: {
              id: diff.itemId,
              type: "fileChange",
              status: "completed",
              changes: [{ path: "a.ts", diff: expect.stringContaining("+after") }],
            },
          },
        },
      ]);
      expect(() =>
        projector.project({
          type: "item.started",
          turnId,
          item: { ...diff, itemId: hostItemIdSchema.parse("late-diff") },
        }),
      ).toThrow(/follows the Turn terminal/u);
    },
  );

  it("updates an already completed file summary without repeating its completion", () => {
    const projector = startedProjector();
    const messages: JsonObject[] = [];
    const project = (event: Parameters<CodexTurnProjector["project"]>[0]) => {
      const projection = projector.project(event);
      messages.push(...projection.messages);
      return projection;
    };
    const firstDiff: HostFileChangeItem = {
      type: "fileChange",
      itemId: hostItemIdSchema.parse("bash-1-diff"),
      sourceItemIds: [command.itemId],
      changes: [{ path: "a.ts", kind: "update", unifiedDiff: "-a\n+a" }],
    };
    const secondCommand: HostCommandExecutionItem = {
      ...command,
      itemId: hostItemIdSchema.parse("bash-2"),
    };
    const secondDiff: HostFileChangeItem = {
      type: "fileChange",
      itemId: hostItemIdSchema.parse("bash-2-diff"),
      sourceItemIds: [secondCommand.itemId],
      changes: [{ path: "b.ts", kind: "update", unifiedDiff: "-b\n+b2" }],
    };
    project({ type: "item.detached", turnId, itemId: command.itemId });
    project({ type: "item.started", turnId, item: firstDiff });
    project({ type: "item.detached", turnId, itemId: firstDiff.itemId });
    project({ type: "item.started", turnId, item: secondCommand });
    project({ type: "item.detached", turnId, itemId: secondCommand.itemId });
    const terminal = project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    project({ type: "item.started", turnId, item: secondDiff });
    project({
      type: "item.completed",
      turnId,
      snapshot: { item: command, outcome: { status: "succeeded" } },
    });
    project({
      type: "item.completed",
      turnId,
      snapshot: { item: firstDiff, outcome: { status: "succeeded" } },
    });
    project({
      type: "item.completed",
      turnId,
      snapshot: { item: secondCommand, outcome: { status: "succeeded" } },
    });
    project({
      type: "item.completed",
      turnId,
      snapshot: { item: secondDiff, outcome: { status: "succeeded" } },
    });
    expect(terminal.completedTurn).toMatchObject({ status: "completed" });
    expect(itemCompletionsFor(messages, firstDiff.itemId)).toHaveLength(1);
    expect(itemCompletionsFor(messages, firstDiff.itemId)[0]).toMatchObject({
      params: { item: { id: firstDiff.itemId, status: "completed" } },
    });
    expect(
      messages.filter((message) => message.method === "item/fileChange/patchUpdated").at(-1),
    ).toMatchObject({
      params: { itemId: firstDiff.itemId, changes: [{ path: "a.ts" }, { path: "b.ts" }] },
    });
    expect(projector.hasOpenDetachedItems).toBe(false);
  });

  it("reads the accumulated file summary across a late detached file change", () => {
    const projector = startedProjector();
    const messages: JsonObject[] = [];
    const project = (event: Parameters<CodexTurnProjector["project"]>[0]) => {
      const projection = projector.project(event);
      messages.push(...projection.messages);
      return projection;
    };
    const firstDiff: HostFileChangeItem = {
      type: "fileChange",
      itemId: hostItemIdSchema.parse("bash-1-diff"),
      sourceItemIds: [command.itemId],
      changes: [{ path: "a.ts", kind: "update", unifiedDiff: "-a\n+a" }],
    };
    const secondCommand: HostCommandExecutionItem = {
      ...command,
      itemId: hostItemIdSchema.parse("bash-2"),
    };
    const secondDiff: HostFileChangeItem = {
      type: "fileChange",
      itemId: hostItemIdSchema.parse("bash-2-diff"),
      sourceItemIds: [secondCommand.itemId],
      changes: [{ path: "b.ts", kind: "update", unifiedDiff: "-b\n+b" }],
    };
    project({ type: "item.started", turnId, item: firstDiff });
    project({
      type: "item.completed",
      turnId,
      snapshot: { item: firstDiff, outcome: { status: "succeeded" } },
    });
    project({
      type: "item.completed",
      turnId,
      snapshot: { item: command, outcome: { status: "succeeded" } },
    });
    project({ type: "item.started", turnId, item: secondCommand });
    project({ type: "item.detached", turnId, itemId: secondCommand.itemId });
    project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    project({ type: "item.started", turnId, item: secondDiff });

    const changePaths = (item: JsonObject | undefined): string[] =>
      ((item as { changes?: { path: string }[] } | undefined)?.changes ?? []).map(
        ({ path }) => path,
      );
    // Live notification, snapshot read, and detached/foreground read-back all
    // agree on the accumulated summary under the first file Item's stable id.
    expect(
      messages.filter(({ method }) => method === "item/fileChange/patchUpdated").at(-1),
    ).toMatchObject({
      params: { itemId: firstDiff.itemId, changes: [{ path: "a.ts" }, { path: "b.ts" }] },
    });
    const snapshotItems = projector.snapshotTurn().items as JsonObject[];
    expect(changePaths(snapshotItems.find(({ id }) => id === firstDiff.itemId))).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(changePaths(projector.openDetachedWireItems().get(firstDiff.itemId))).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(changePaths(projector.foregroundWireItems().get(firstDiff.itemId))).toEqual([
      "a.ts",
      "b.ts",
    ]);
    // Later file Items fold into the summary instead of owning a wire slot.
    expect(projector.foregroundWireItems().has(secondDiff.itemId)).toBe(false);

    for (const item of [secondCommand, secondDiff]) {
      project({
        type: "item.completed",
        turnId,
        snapshot: { item, outcome: { status: "succeeded" } },
      });
    }
    expect(projector.openDetachedWireItems()).toEqual(new Map());
    expect(changePaths(projector.foregroundWireItems().get(firstDiff.itemId))).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("rejects an unrelated file change after Turn completion", () => {
    const projector = startedProjector();
    projector.project({ type: "item.detached", turnId, itemId: command.itemId });
    projector.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    expect(() =>
      projector.project({
        type: "item.started",
        turnId,
        item: {
          type: "fileChange",
          itemId: hostItemIdSchema.parse("unowned-diff"),
          sourceItemIds: [hostItemIdSchema.parse("unknown-tool")],
          changes: [],
        },
      }),
    ).toThrow(/follows the Turn terminal/u);
  });

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
