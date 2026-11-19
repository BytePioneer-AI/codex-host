import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { HostAgentMessageItem } from "@codexhost/harness-adapter";
import { CodexTurnProjector, projectHistoricalTurn } from "@codexhost/protocol-core";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import {
  ChThreadView,
  type ChThread,
  type ChTurn,
} from "../../packages/web-server/src/ch-thread-view.ts";

it("keeps Web native Markdown stable across live snapshots and Desktop-projected history", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "web-native-media-%2F-"));
  try {
    // Desktop protects literal percent twice; Web decodes authored URL escapes once.
    await writeFile(path.join(cwd, "image.png"), "synthetic image");
    const text = "Output: ![image](image.png)";
    const item: HostAgentMessageItem = {
      type: "agentMessage",
      itemId: hostItemIdSchema.parse("answer"),
      text: "",
    };
    const turnId = hostTurnIdSchema.parse("media-turn");
    const projector = new CodexTurnProjector({
      threadId: "media-thread",
      turnId,
      cwd,
      startedAtMs: 1000,
      snapshotInput: [{ type: "text", text: "Show an image" }],
    });
    const thread: ChThread = {
      id: "media-thread",
      cwd,
      modelProvider: "pi",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "active" },
      turns: [],
    };
    const view = new ChThreadView(structuredClone(thread), "pi", () => {});
    const update = (turn: unknown) => view.update({ ...thread, turns: [turn as ChTurn] });
    projector.project({ type: "turn.started", turnId });
    projector.project({ type: "item.started", turnId, item });
    for (const character of text) {
      projector.project({
        type: "item.updated",
        turnId,
        itemId: item.itemId,
        update: { type: "text.append", text: character },
      });
      update(projector.snapshotTurn());
    }
    const completedItem = { ...item, text };
    projector.project({
      type: "item.completed",
      turnId,
      snapshot: { item: completedItem, outcome: { status: "succeeded" } },
    });
    const completed = projector.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    update(projector.snapshotTurn(completed.completedTurn));
    const historical = projectHistoricalTurn({
      turnId,
      cwd,
      snapshot: {
        nativeTurnRef: nativeTurnRefSchema.parse({
          formatVersion: 1,
          harnessId: "pi",
          nativeSessionId: "session",
          nativeTurnKey: "turn",
        }),
        input: [{ type: "text", text: "Show an image" }],
        items: [{ item: completedItem, outcome: { status: "succeeded" } }],
        outcome: { status: "succeeded" },
      },
    });
    expect(historical.items).toContainEqual(
      expect.objectContaining({
        type: "agentMessage",
        codexhostNativeText: text,
        text: expect.stringContaining("web-native-media-%25252F-"),
      }),
    );
    const reopened = new ChThreadView(structuredClone(thread), "pi", () => {});
    reopened.update({ ...thread, turns: [historical as unknown as ChTurn] });
    for (const candidate of [view, reopened]) {
      const message = candidate.log.events.findLast((event) => event.type === "assistant/message");
      expect(message?.data).toMatchObject({ message: { content: [{ type: "text", text }] } });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
