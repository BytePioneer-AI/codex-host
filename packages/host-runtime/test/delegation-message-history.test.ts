import type { JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it } from "vitest";

import { delegationCliHelp } from "../src/delegation-cli-help.js";
import { compactDelegationOutput } from "../src/delegation-cli-output.js";
import { textDelegationOutput } from "../src/delegation-cli-text.js";
import { projectDelegationThreadSnapshot } from "../src/delegation-snapshot.js";

function user(id: string, text: string): JsonObject {
  return { id, type: "userMessage", content: [{ type: "text", text }] };
}
function agent(id: string, text: string, phase?: string): JsonObject {
  return { id, type: "agentMessage", text, ...(phase ? { phase } : {}) };
}
function read(
  turns: JsonObject[],
  options: { from?: number; to?: number; view?: "result" | "messages"; running?: boolean } = {},
) {
  return projectDelegationThreadSnapshot({
    threadId: "thread",
    harnessId: "pi",
    thread: {},
    turns,
    running: false,
    view: "messages",
    ...options,
  });
}
function history(count: number): JsonObject[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    status: "completed",
    items: [user(`u${i + 1}`, `Task ${i + 1}`), agent(`a${i + 1}`, `Answer ${i + 1}`, "final")],
  }));
}
function numbers(snapshot: ReturnType<typeof read>) {
  return snapshot.turns?.map(({ turnNumber }) => turnNumber);
}

describe("delegation Turn-range messages", () => {
  it.each(["read", "wait"])(
    "documents %s absolute ranges without message pagination",
    (command) => {
      const help = delegationCliHelp(["thread", command, "--help"]);
      for (const text of ["newest first", "totalTurns", "--from", "--to", "latest 10", "50 Turns"])
        expect(help).toContain(text);
      for (const text of ["--cursor", "--limit", "hasMore", "nextCursor", "incremental"])
        expect(help).not.toContain(text);
    },
  );

  it("defaults to the latest 10 whole Turns, newest first", () => {
    const snapshot = read(history(15));
    expect(snapshot).toMatchObject({ totalTurns: 15, from: 6, to: 15 });
    expect(numbers(snapshot)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
    expect(
      snapshot.turns?.every(
        ({ messages }) => messages.map(({ role }) => role).join() === "user,agent",
      ),
    ).toBe(true);
  });

  it("keeps absolute numbers and explicit ranges stable after appending Turns", () => {
    const turns = history(12);
    const before = read(turns, { from: 3, to: 5 });
    expect(numbers(before)).toEqual([5, 4, 3]);
    const after = read(history(14), { from: 3, to: 5 });
    expect(after.turns).toEqual(before.turns);
    expect(after.totalTurns).toBe(14);
    expect(read(turns, { from: 3, to: 5 })).toEqual(before);
  });

  it.each([
    [{ from: 8 }, 8, 15],
    [{ to: 12 }, 3, 12],
    [{ to: 3 }, 1, 3],
    [{ from: 13, to: 999 }, 13, 15],
    [{ to: 999 }, 6, 15],
    [{ from: 16 }, null, null],
    [{ from: 99, to: 100 }, null, null],
  ] as const)("resolves and clips range %j", (options, from, to) => {
    const snapshot = read(history(15), options);
    expect(snapshot).toMatchObject({ totalTurns: 15, from, to });
    expect(snapshot.turns?.length).toBe(from === null || to === null ? 0 : to - from + 1);
  });

  it("reports empty ranges and counts Turns before message filtering", () => {
    expect(read([])).toMatchObject({ totalTurns: 0, from: null, to: null, turns: [] });
    const snapshot = read([
      { id: "empty", status: "failed", items: [] },
      { id: "blank", status: "interrupted", items: [user("u", " \n"), agent("a", " \n")] },
    ]);
    expect(snapshot).toMatchObject({
      totalTurns: 2,
      from: 1,
      to: 2,
      turns: [
        { turnNumber: 2, status: "interrupted", messages: [] },
        { turnNumber: 1, status: "failed", messages: [] },
      ],
    });
    expect(textDelegationOutput("thread read", snapshot, "messages")).toContain("#1 failed");
  });

  it.each([
    { from: 0 },
    { to: -1 },
    { from: 1.2 },
    { to: NaN },
    { from: Infinity },
    { to: Number.MAX_SAFE_INTEGER + 1 },
    { from: 4, to: 3 },
    { view: "result" as const, from: 1 },
  ])("rejects invalid range %j", (options) => {
    expect(() => read(history(10), options)).toThrow();
  });

  it("rejects effective ranges over 50 Turns rather than silently truncating", () => {
    const turns = history(60);
    expect(read(turns, { from: 11 }).turns).toHaveLength(50);
    expect(() => read(turns, { from: 10 })).toThrow("at most 50 Turns");
    expect(() => read(turns, { from: 1, to: 999 })).toThrow("at most 50 Turns");
    expect(read(history(3), { from: 1, to: 999 }).turns).toHaveLength(3);
  });

  it("omits all intermediate commentary in JSON, compact and text, preserving user order", () => {
    const snapshot = read([
      {
        id: "t",
        status: "completed",
        items: [
          user("u1", "Question"),
          agent("p", "Hidden intermediate", "commentary"),
          user("u2", "Authorization"),
          agent("a", "Final answer", "final"),
          agent("tail", "Trailing intermediate", "commentary"),
        ],
      },
    ]);
    expect(snapshot.turns?.[0]?.messages.map(({ id }) => id)).toEqual(["u1", "u2", "a"]);
    expect(snapshot.progress).toEqual([]);
    for (const output of [
      JSON.stringify(snapshot),
      JSON.stringify(compactDelegationOutput("thread read", snapshot, "messages")),
      textDelegationOutput("thread read", snapshot, "messages"),
    ])
      expect(output).not.toContain("intermediate");
  });

  it.each([undefined, "commentary"])(
    "uses the terminal Turn's last nonempty Agent message without a final marker (%s)",
    (phase) => {
      const snapshot = read([
        {
          id: "t",
          status: "completed",
          items: [
            user("u", "Task"),
            agent("p", "Intermediate", phase),
            agent("a", "Last reply", phase),
            agent("blank", " \n", phase),
          ],
        },
      ]);
      expect(snapshot.turns?.[0]?.messages).toEqual([
        { id: "u", role: "user", text: "Task" },
        { id: "a", role: "agent", phase: "final", text: "Last reply" },
      ]);
    },
  );

  it("selects only the last nonempty final; an empty final does not fall back to commentary", () => {
    const snapshot = read([
      {
        id: "t1",
        status: "completed",
        items: [
          agent("a", "First final", "final"),
          agent("b", "Last final", "final"),
          agent("blank", " ", "final"),
        ],
      },
      {
        id: "t2",
        status: "completed",
        items: [agent("p", "Commentary", "commentary"), agent("blank", " ", "final")],
      },
    ]);
    expect(snapshot.turns?.[0]?.messages).toEqual([]);
    expect(snapshot.turns?.[1]?.messages).toEqual([
      { id: "b", role: "agent", text: "Last final", phase: "final" },
    ]);
  });

  it.each(["failed", "interrupted", "cancelled"])(
    "preserves historical %s status with or without a reply",
    (status) => {
      const snapshot = read([
        { id: "empty", status, items: [] },
        { id: "partial", status, items: [user("u", "Task"), agent("a", "Partial outcome")] },
        ...history(1),
      ]);
      const expected = status === "cancelled" ? "interrupted" : status;
      expect(snapshot.status).toBe("completed");
      expect(snapshot.turns).toMatchObject([
        { turnNumber: 3, status: "completed" },
        { turnNumber: 2, status: expected, messages: [{ role: "user" }, { role: "agent" }] },
        { turnNumber: 1, status: expected, messages: [] },
      ]);
      expect(compactDelegationOutput("thread read", snapshot, "messages")).toMatchObject({
        turns: [{ status: "completed" }, { status: expected }, { status: expected }],
      });
      expect(textDelegationOutput("thread read", snapshot, "messages")).toContain(`#1 ${expected}`);
    },
  );

  it("keeps a running Turn input-only, and result compact's latest progress unchanged", () => {
    const turns: JsonObject[] = [
      {
        id: "t",
        status: "inProgress",
        items: [
          user("u", "Task"),
          agent("p1", "Earlier progress", "commentary"),
          agent("p2", "Latest progress", "commentary"),
          agent("final", "Not yet stopped", "final"),
        ],
      },
    ];
    const snapshot = read(turns, { running: true });
    expect(snapshot.turns).toEqual([
      {
        turnId: "t",
        turnNumber: 1,
        status: "running",
        messages: [{ id: "u", role: "user", text: "Task" }],
      },
    ]);
    expect(snapshot.progress).toEqual([]);
    expect(snapshot.result).toEqual({ availability: "pending" });
    const result = read(turns, { running: true, view: "result" });
    expect(compactDelegationOutput("thread read", result)).toMatchObject({
      progress: "Latest progress",
    });
    const stopped = read([{ ...turns[0], status: "completed" }], { view: "result" });
    expect(compactDelegationOutput("thread read", stopped)).not.toHaveProperty("progress");
    expect(textDelegationOutput("thread read", stopped)).not.toContain("progress:");
  });

  it("does not truncate text inside a Turn", () => {
    const text = "x".repeat(1_000_000);
    expect(
      read([{ id: "t", status: "completed", items: [agent("a", text, "final")] }]).turns?.[0]
        ?.messages[0]?.text,
    ).toBe(text);
  });
});
