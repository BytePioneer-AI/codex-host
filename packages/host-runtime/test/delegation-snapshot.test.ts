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
    expect(repeated).toEqual(second);
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
