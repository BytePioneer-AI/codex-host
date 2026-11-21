import { describe, expect, it } from "vitest";
import type { HostCommandExecutionItem } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  it("flushes each background text append so trailing inline code is visible", () => {
    const projector = completedProjector();
    projector.project({ type: "item.background.started", turnId, item: message }, 2_000);

    const first = projector.project(
      {
        type: "item.updated",
        turnId,
        itemId: message.itemId,
        update: { type: "text.append", text: "output: " },
      },
      2_100,
    );
    const second = projector.project(
      {
        type: "item.updated",
        turnId,
        itemId: message.itemId,
        update: { type: "text.append", text: "`X`" },
      },
      2_200,
    );

    expect(first.messages).toContainEqual(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        params: expect.objectContaining({ itemId: message.itemId, delta: "output: " }),
      }),
    );
    expect(second.messages).toContainEqual(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        params: expect.objectContaining({ itemId: message.itemId, delta: "`X`" }),
      }),
    );
    expect(
      [...first.messages, ...second.messages]
        .filter(({ method }) => method === "item/agentMessage/delta")
        .map(({ params }) => (params as { delta: string }).delta)
        .join(""),
    ).toBe("output: `X`");

    const completed = projector.project(
      {
        type: "item.completed",
        turnId,
        snapshot: {
          item: { ...message, text: "output: `X`" },
          outcome: { status: "succeeded" },
        },
      },
      2_300,
    );
    expect(completed.messages).toContainEqual(
      expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          item: expect.objectContaining({
            id: message.itemId,
            type: "agentMessage",
            text: "output: `X`",
          }),
        }),
      }),
    );
  });

  it("keeps foreground trailing inline code held until completion", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/workspace",
      startedAtMs: 1_000,
    });
    projector.project({ type: "turn.started", turnId }, 1_000);
    projector.project({ type: "item.started", turnId, item: message }, 2_000);
    projector.project({
      type: "item.updated",
      turnId,
      itemId: message.itemId,
      update: { type: "text.append", text: "output: " },
    });

    const second = projector.project({
      type: "item.updated",
      turnId,
      itemId: message.itemId,
      update: { type: "text.append", text: "`X`" },
    });
    expect(second.messages).not.toContainEqual(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        params: expect.objectContaining({ itemId: message.itemId, delta: "`X`" }),
      }),
    );

    const completed = projector.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { ...message, text: "output: `X`" },
        outcome: { status: "succeeded" },
      },
    });
    expect(completed.messages).toContainEqual(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        params: expect.objectContaining({ itemId: message.itemId, delta: "`X`" }),
      }),
    );
  });

  it("rebuilds background media from native text at completion", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-background-media-"));
    try {
      await writeFile(path.join(cwd, "a.png"), "synthetic image");
      const chunks = ["![x](", "a.png", ")"];
      const projector = new CodexTurnProjector({
        threadId: "thread-1",
        turnId,
        cwd,
        startedAtMs: 1_000,
      });
      projector.project({ type: "turn.started", turnId }, 1_000);
      projector.project(
        { type: "turn.completed", turnId, outcome: { status: "succeeded" } },
        1_100,
      );
      projector.project({ type: "item.background.started", turnId, item: message }, 2_000);

      const messages = chunks.flatMap(
        (text, index) =>
          projector.project(
            {
              type: "item.updated",
              turnId,
              itemId: message.itemId,
              update: { type: "text.append", text },
            },
            2_100 + index,
          ).messages,
      );
      const completed = projector.project(
        {
          type: "item.completed",
          turnId,
          snapshot: {
            item: { ...message, text: chunks.join("") },
            outcome: { status: "succeeded" },
          },
        },
        2_200,
      );
      const foreground = new CodexTurnProjector({
        threadId: "thread-1",
        turnId,
        cwd,
        startedAtMs: 1_000,
      });
      foreground.project({ type: "turn.started", turnId }, 1_000);
      foreground.project({ type: "item.started", turnId, item: message }, 2_000);
      for (const text of chunks) {
        foreground.project({
          type: "item.updated",
          turnId,
          itemId: message.itemId,
          update: { type: "text.append", text },
        });
      }
      const foregroundCompleted = foreground.project({
        type: "item.completed",
        turnId,
        snapshot: {
          item: { ...message, text: chunks.join("") },
          outcome: { status: "succeeded" },
        },
      });
      const expected = foregroundCompleted.messages.find(
        ({ method }) => method === "item/completed",
      );
      const actual = completed.messages.find(({ method }) => method === "item/completed");
      const expectedText = (expected?.params as { item: { text: string } }).item.text;
      expect(
        messages
          .filter(({ method }) => method === "item/agentMessage/delta")
          .map(({ params }) => (params as { delta: string }).delta)
          .join(""),
      ).toBe(chunks.join(""));
      expect((actual?.params as { item: { text: string } }).item.text).toBe(expectedText);
      expect(projector.snapshotTurn().items).toContainEqual(
        expect.objectContaining({ type: "agentMessage", text: expectedText }),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps background inline code continuation lossless through completion", () => {
    const chunks = ["see `", "X", "` done"];
    const projector = completedProjector();
    projector.project({ type: "item.background.started", turnId, item: message }, 2_000);
    const messages = chunks.flatMap(
      (text, index) =>
        projector.project(
          {
            type: "item.updated",
            turnId,
            itemId: message.itemId,
            update: { type: "text.append", text },
          },
          2_100 + index,
        ).messages,
    );
    const completed = projector.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { ...message, text: chunks.join("") },
        outcome: { status: "succeeded" },
      },
    });
    const foreground = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/workspace",
      startedAtMs: 1_000,
    });
    foreground.project({ type: "turn.started", turnId });
    foreground.project({ type: "item.started", turnId, item: message });
    for (const text of chunks) {
      foreground.project({
        type: "item.updated",
        turnId,
        itemId: message.itemId,
        update: { type: "text.append", text },
      });
    }
    const foregroundCompleted = foreground.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { ...message, text: chunks.join("") },
        outcome: { status: "succeeded" },
      },
    });
    const expected = foregroundCompleted.messages.find(({ method }) => method === "item/completed");
    const actual = completed.messages.find(({ method }) => method === "item/completed");
    expect(
      messages
        .filter(({ method }) => method === "item/agentMessage/delta")
        .map(({ params }) => (params as { delta: string }).delta)
        .join(""),
    ).toBe(chunks.join(""));
    expect((actual?.params as { item: { text: string } }).item.text).toBe(
      (expected?.params as { item: { text: string } }).item.text,
    );
  });

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
    expect([...projector.backgroundWireItems().values()]).toMatchObject([
      { id: message.itemId, type: "agentMessage", text: "awake\n" },
    ]);
  });

  it("announces a background Item that starts with text", () => {
    const projector = completedProjector();
    const started = projector.project(
      { type: "item.background.started", turnId, item: { ...message, text: "awake" } },
      2_000,
    );
    expect(started.messages).toMatchObject([
      { method: "item/started", params: { turnId, item: { id: message.itemId } } },
    ]);
    expect(projector.hasOpenDetachedItems).toBe(true);
  });

  it("keeps foreground and background wire Items separately", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/workspace",
      startedAtMs: 1_000,
    });
    projector.project({ type: "turn.started", turnId }, 1_000);
    const foreground = {
      type: "agentMessage" as const,
      itemId: hostItemIdSchema.parse("foreground-1"),
      text: "same notification",
    };
    projector.project({ type: "item.started", turnId, item: foreground }, 2_000);
    projector.project(
      {
        type: "item.completed",
        turnId,
        snapshot: { item: foreground, outcome: { status: "succeeded" } },
      },
      2_100,
    );
    projector.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } }, 2_150);
    projector.project(
      {
        type: "item.background.started",
        turnId,
        item: { ...message, text: "same notification" },
      },
      2_200,
    );

    expect([...projector.foregroundWireItems().values()]).toMatchObject([
      { id: foreground.itemId, type: "agentMessage", text: foreground.text },
    ]);
    expect([...projector.backgroundWireItems().values()]).toMatchObject([
      { id: message.itemId, type: "agentMessage", text: "same notification" },
    ]);
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
          item: command,
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
