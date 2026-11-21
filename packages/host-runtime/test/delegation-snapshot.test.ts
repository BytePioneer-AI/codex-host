import { projectHistoricalTurn } from "@codexhost/protocol-core";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { projectDelegationThreadSnapshot } from "../src/delegation-snapshot.js";

const completedTurns = [
  {
    id: "turn-1",
    status: "completed",
    items: [
      { id: "user-1", type: "userMessage", content: [{ type: "text", text: "inspect auth" }] },
      { id: "reason-1", type: "reasoning", summary: ["hidden"] },
      {
        id: "tool-1",
        type: "dynamicToolCall",
        tool: "bash",
        arguments: { command: "cat secret" },
        contentItems: [{ type: "inputText", text: "secret output" }],
      },
      { id: "progress-1", type: "agentMessage", phase: "commentary", text: "Checking auth." },
      { id: "final-1", type: "agentMessage", phase: "final", text: "Found two issues." },
    ],
  },
];

const input = {
  threadId: "thread-1",
  harnessId: "pi" as const,
  thread: { status: { type: "idle" }, cwd: "/workspace" },
  turns: completedTurns,
  running: false,
};

describe("delegation snapshot", () => {
  it("passes projected relative-image Markdown through result and message views", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "delegation-media%41-"));
    try {
      await writeFile(path.join(cwd, "shot.png"), "synthetic image");
      const turn = projectHistoricalTurn({
        turnId: hostTurnIdSchema.parse("turn-1"),
        cwd,
        snapshot: {
          nativeTurnRef: nativeTurnRefSchema.parse({
            formatVersion: 1,
            harnessId: "pi",
            nativeSessionId: "session",
            nativeTurnKey: "1",
          }),
          input: [],
          outcome: { status: "succeeded" },
          items: [
            {
              item: {
                type: "agentMessage",
                itemId: hostItemIdSchema.parse("answer"),
                text: "![shot](shot.png)",
              },
              outcome: { status: "succeeded" },
            },
          ],
        },
      });
      const text = `![shot](${path.join(cwd, "shot.png").replaceAll("\\", "/").replaceAll("%", "%2525")})`;
      for (const view of ["result", "messages"] as const) {
        const snapshot = projectDelegationThreadSnapshot({ ...input, turns: [turn], view });
        expect(snapshot).toMatchObject({
          status: "completed",
          result: { availability: "available", text },
        });
        if (view === "messages")
          expect(snapshot.turns).toEqual([
            {
              turnId: "turn-1",
              turnNumber: 1,
              status: "completed",
              messages: [{ id: "answer", role: "agent", phase: "final", text }],
            },
          ]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves the default result snapshot without exposing tool output or reasoning", () => {
    const snapshot = projectDelegationThreadSnapshot({ ...input, view: "result" });
    expect(snapshot).toMatchObject({
      cwd: "/workspace",
      status: "completed",
      progress: [{ id: "progress-1", text: "Checking auth." }],
      result: { availability: "available", text: "Found two issues." },
    });
    for (const hidden of ["secret output", "cat secret", "hidden"])
      expect(JSON.stringify(snapshot)).not.toContain(hidden);
    for (const field of ["turns", "totalTurns", "from", "to", "nextCursor", "hasMore"])
      expect(snapshot).not.toHaveProperty(field);
  });

  it("returns only user input and the final reply in a whole Turn", () => {
    const snapshot = projectDelegationThreadSnapshot({
      ...input,
      view: "messages",
      from: 1,
      to: 1,
    });
    expect(snapshot).toMatchObject({
      totalTurns: 1,
      from: 1,
      to: 1,
      progress: [],
      turns: [
        {
          turnId: "turn-1",
          turnNumber: 1,
          status: "completed",
          messages: [
            { id: "user-1", role: "user", text: "inspect auth" },
            { id: "final-1", role: "agent", phase: "final", text: "Found two issues." },
          ],
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("Checking auth.");
    expect(snapshot).not.toHaveProperty("nextCursor");
    expect(snapshot).not.toHaveProperty("hasMore");
  });

  it("reports a running result checkpoint without inventing a result", () => {
    const snapshot = projectDelegationThreadSnapshot({
      ...input,
      thread: { status: { type: "active" } },
      turns: [
        {
          id: "turn-running",
          status: "inProgress",
          items: [
            { id: "progress", type: "agentMessage", phase: "commentary", text: "Still checking." },
          ],
        },
      ],
      running: true,
      view: "result",
    });
    expect(snapshot).toMatchObject({
      status: "running",
      result: { availability: "pending" },
      progress: [{ text: "Still checking." }],
    });
  });
});
