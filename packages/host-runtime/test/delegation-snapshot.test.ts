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
      {
        id: "user-1",
        type: "userMessage",
        content: [{ type: "text", text: "inspect auth" }],
      },
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
        const snapshot = projectDelegationThreadSnapshot({
          threadId: "thread-1",
          harnessId: "pi",
          thread: {},
          turns: [turn],
          running: false,
          view,
        });
        expect(snapshot).toMatchObject({
          status: "completed",
          result: { availability: "available", text },
        });
        if (view === "messages")
          expect(snapshot.messages).toEqual([
            { id: "answer", turnId: "turn-1", role: "agent", phase: "final", text },
          ]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns only visible progress and the final Agent result by default", () => {
    const snapshot = projectDelegationThreadSnapshot({
      threadId: "thread-1",
      harnessId: "pi",
      thread: { status: { type: "idle" } },
      turns: completedTurns,
      running: false,
      view: "result",
    });

    expect(snapshot).toMatchObject({
      status: "completed",
      progress: [{ id: "progress-1", text: "Checking auth." }],
      result: { availability: "available", text: "Found two issues." },
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret output");
    expect(JSON.stringify(snapshot)).not.toContain("cat secret");
    expect(JSON.stringify(snapshot)).not.toContain("hidden");
    expect(snapshot).not.toHaveProperty("messages");
  });

  it("pages visible user and Agent messages with a non-consuming cursor", () => {
    const first = projectDelegationThreadSnapshot({
      threadId: "thread-1",
      harnessId: "pi",
      thread: { status: { type: "idle" } },
      turns: completedTurns,
      running: false,
      view: "messages",
      limit: 2,
    });
    expect(first.messages).toEqual([
      { id: "user-1", turnId: "turn-1", role: "user", text: "inspect auth" },
      {
        id: "progress-1",
        turnId: "turn-1",
        role: "agent",
        phase: "commentary",
        text: "Checking auth.",
      },
    ]);
    if (!first.nextCursor) throw new Error("Expected message cursor");

    const second = projectDelegationThreadSnapshot({
      threadId: "thread-1",
      harnessId: "pi",
      thread: { status: { type: "idle" } },
      turns: completedTurns,
      running: false,
      view: "messages",
      cursor: first.nextCursor,
      limit: 2,
    });
    const repeated = projectDelegationThreadSnapshot({
      threadId: "thread-1",
      harnessId: "pi",
      thread: { status: { type: "idle" } },
      turns: completedTurns,
      running: false,
      view: "messages",
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.messages).toEqual([
      {
        id: "final-1",
        turnId: "turn-1",
        role: "agent",
        phase: "final",
        text: "Found two issues.",
      },
    ]);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(repeated).toEqual(second);
  });

  it("filters whitespace without spending the page limit or breaking saved cursor offsets", () => {
    const turns = [
      {
        id: "turn-1",
        status: "completed",
        items: [
          { id: "blank", type: "agentMessage", phase: "commentary", text: "\n\n" },
          { id: "answer", type: "agentMessage", phase: "final", text: "Answer" },
          { id: "trailing-blank", type: "agentMessage", phase: "commentary", text: " " },
        ],
      },
    ];
    const input = {
      threadId: "thread-1",
      harnessId: "pi" as const,
      thread: {},
      turns,
      running: false,
    };
    const page = projectDelegationThreadSnapshot({ ...input, view: "messages", limit: 1 });
    expect(page.messages?.map(({ text }) => text)).toEqual(["Answer"]);
    expect(page.progress).toEqual([]);
    expect(page.hasMore).toBe(false);
    const checkpoint = projectDelegationThreadSnapshot({ ...input, view: "result" });
    const cursor = checkpoint.nextCursor;
    if (!cursor) throw new Error("Missing incremental cursor");
    const encoded = cursor.slice("codexhost:thread-messages:v1:".length);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString()).offset).toBe(3);
    turns[0]?.items.push({
      id: "new-answer",
      type: "agentMessage",
      phase: "final",
      text: "New answer",
    });
    const next = projectDelegationThreadSnapshot({ ...input, view: "messages", cursor, limit: 1 });
    expect(next.messages?.map(({ text }) => text)).toEqual(["New answer"]);
    expect(next.hasMore).toBe(false);
    const after = projectDelegationThreadSnapshot({
      ...input,
      view: "messages",
      cursor: next.nextCursor ?? "",
      limit: 1,
    });
    expect(after.messages).toEqual([]);
    expect(after.hasMore).toBe(false);
    expect(after.nextCursor).toBe(next.nextCursor);
  });

  it("keeps result fields stable while message pagination advances", () => {
    const first = projectDelegationThreadSnapshot({
      threadId: "thread-1",
      harnessId: "pi",
      thread: { status: { type: "idle" } },
      turns: completedTurns,
      running: false,
      view: "messages",
      limit: 1,
    });
    if (!first.nextCursor) throw new Error("Expected message cursor");
    const second = projectDelegationThreadSnapshot({
      threadId: "thread-1",
      harnessId: "pi",
      thread: { status: { type: "idle" } },
      turns: completedTurns,
      running: false,
      view: "messages",
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.result).toEqual(first.result);
    expect(second.turn).toEqual(first.turn);
    expect(second.status).toBe(first.status);
  });

  it("reports a running checkpoint without inventing a result", () => {
    const snapshot = projectDelegationThreadSnapshot({
      threadId: "thread-1",
      harnessId: "pi",
      thread: { status: { type: "active" } },
      turns: [
        {
          id: "turn-running",
          status: "inProgress",
          items: [
            {
              id: "progress",
              type: "agentMessage",
              phase: "commentary",
              text: "Still checking.",
            },
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
