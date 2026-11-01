import type { HostAgentMessageItem, HostTurnSnapshot } from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexTurnProjector, projectHistoricalTurn } from "../src/index.js";

const turnId = hostTurnIdSchema.parse("code-media");
const spans = [
  "``![example](a.png)``",
  "``![example](a.png) `not a closer` ![another](a.png)``",
  "``![example](a.png) ```not a closer``` ![another](a.png)``",
  "`first\n![example](a.png)\nlast`",
  "``first\n![example](a.png)\n`not a closer`\nlast``",
];

describe("agent media code spans", () => {
  let cwd: string;
  let outside: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "codex-code-media-"));
    await writeFile(path.join(cwd, "a.png"), "synthetic image");
    outside = `![outside](<${path.join(cwd, "a.png").replaceAll("\\", "/").replaceAll("%", "%2525")}>)`;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(spans)("preserves %j through character-sized live updates", (span) => {
    const raw = `${span}\nafter ![outside](<a.png>)`;
    const expected = `${span}\nafter ${outside}`;
    const item: HostAgentMessageItem = {
      type: "agentMessage",
      itemId: hostItemIdSchema.parse("answer"),
      text: "",
    };
    const live = new CodexTurnProjector({ threadId: "external", turnId, cwd, startedAtMs: 1 });
    live.project({ type: "turn.started", turnId });
    const wire: JsonObject[] = live.project({ type: "item.started", turnId, item }).messages;
    for (const text of raw) {
      wire.push(
        ...live.project({
          type: "item.updated",
          turnId,
          itemId: item.itemId,
          update: { type: "text.append", text },
        }).messages,
      );
      const published = wire
        .filter(({ method }) => method === "item/agentMessage/delta")
        .map(({ params }) => (params as JsonObject).delta)
        .join("");
      expect(expected.startsWith(published)).toBe(true);
    }
    wire.push(
      ...live.project({
        type: "item.completed",
        turnId,
        snapshot: { item: { ...item, text: raw }, outcome: { status: "succeeded" } },
      }).messages,
    );
    expect(
      wire
        .filter(({ method }) => method === "item/agentMessage/delta")
        .map(({ params }) => (params as JsonObject).delta)
        .join(""),
    ).toBe(expected);
    expect(wire.filter(({ method }) => method === "item/completed")).toMatchObject([
      { params: { item: { type: "agentMessage", text: expected } } },
    ]);
    expect(
      live.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } })
        .completedTurn,
    ).toMatchObject({ items: [{ text: expected, phase: "final_answer" }] });
  });

  it.each(spans)("preserves %j through historical projection", (span) => {
    const snapshot: HostTurnSnapshot = {
      nativeTurnRef: nativeTurnRefSchema.parse({
        formatVersion: 1,
        harnessId: "pi",
        nativeSessionId: "session",
        nativeTurnKey: "turn",
      }),
      input: [],
      items: [
        {
          item: {
            type: "agentMessage",
            itemId: hostItemIdSchema.parse("answer"),
            text: `${span}\nafter ![outside](<a.png>)`,
          },
          outcome: { status: "succeeded" },
        },
      ],
      outcome: { status: "succeeded" },
    };
    expect(projectHistoricalTurn({ turnId, cwd, snapshot }).items).toMatchObject([
      { type: "userMessage" },
      { type: "agentMessage", text: `${span}\nafter ${outside}`, phase: "final_answer" },
    ]);
  });
});
