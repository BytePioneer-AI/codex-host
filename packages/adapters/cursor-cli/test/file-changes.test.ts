import { describe, expect, it } from "vitest";
import { applyPatch } from "diff";
import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";
import type { HostEvent } from "@codexhost/harness-adapter";
import { CodexTurnProjector, projectHistoricalTurn } from "@codexhost/protocol-core";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CursorTurnOutput, cursorSnapshot } from "../src/projection.js";

const turnId = hostTurnIdSchema.parse("cursor-edit-turn");
const oldText = "unchanged\n  old value  \n";
const newText = "unchanged\n  new value  \n";
const diff: ToolCallContent = {
  type: "diff",
  path: "/workspace/existing.txt",
  oldText,
  newText,
};
const notification = (update: SessionNotification["update"]): SessionNotification => ({
  sessionId: "cursor-session",
  update,
});
const tool = (content?: ToolCallContent[]) =>
  notification({
    sessionUpdate: "tool_call",
    toolCallId: "native-edit",
    title: "Edit files",
    kind: "edit",
    status: "in_progress",
    rawInput: { _toolName: "edit" },
    ...(content ? { content } : {}),
  });
const completed = notification({
  sessionUpdate: "tool_call_update",
  toolCallId: "native-edit",
  status: "completed",
});
function fixture() {
  const events: HostEvent[] = [];
  const output = new CursorTurnOutput(turnId, (event) => events.push(structuredClone(event)));
  return { output, events };
}
function files(events: HostEvent[]) {
  return events.flatMap((event) =>
    event.type === "item.completed" && event.snapshot.item.type === "fileChange"
      ? [event.snapshot.item]
      : [],
  );
}

describe("Cursor native file changes", () => {
  it("publishes complete multi-file patches only after native tool success, once", () => {
    const f = fixture();
    f.output.update(
      tool([
        diff,
        { type: "diff", path: "/workspace/new.txt", oldText: null, newText: "created\n" },
        { type: "diff", path: "/workspace/empty.txt", oldText: "", newText: "filled\n" },
        { type: "diff", path: "/workspace/noop.txt", oldText: "same\n", newText: "same\n" },
      ]),
    );
    expect(files(f.events)).toEqual([]);
    f.output.update(completed);
    f.output.update(completed);
    f.output.finish({ status: "succeeded" });
    const changes = files(f.events);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changes.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "/workspace/existing.txt", kind: "update" },
      { path: "/workspace/new.txt", kind: "add" },
      { path: "/workspace/empty.txt", kind: "update" },
    ]);
    const [edited, created, filled] = changes[0]?.changes ?? [];
    if (!edited || !created || !filled) throw new Error("Missing native file changes");
    expect(applyPatch(oldText, edited.unifiedDiff)).toBe(newText);
    expect(applyPatch("", created.unifiedDiff)).toBe("created\n");
    expect(created.unifiedDiff).toContain("--- /dev/null");
    expect(applyPatch("", filled.unifiedDiff)).toBe("filled\n");
    expect(
      f.events.filter((event) => event.type === "item.started" && event.item.type === "fileChange"),
    ).toHaveLength(1);
  });

  it("handles an ACP new file with omitted oldText and preserves CRLF and a missing final newline", () => {
    const f = fixture();
    f.output.update(
      tool([
        { type: "diff", path: "/workspace/new.txt", newText: "new file" },
        { type: "diff", path: "/workspace/crlf.txt", oldText: "a\r\nb", newText: "a\r\nc" },
      ]),
    );
    f.output.update(completed);
    const changes = files(f.events)[0]?.changes;
    expect(changes?.map(({ kind }) => kind)).toEqual(["add", "update"]);
    const [created, edited] = changes ?? [];
    if (!created || !edited) throw new Error("Missing native file changes");
    expect(applyPatch("", created.unifiedDiff)).toBe("new file");
    expect(applyPatch("a\r\nb", edited.unifiedDiff)).toBe("a\r\nc");
  });

  it.each(["", "\nCURSOR_DIFF_CREATED"])(
    "omits the malformed new-file diff captured from Cursor 2026.09.10 (%j)",
    (body) => {
      const path = "/workspace/created.txt";
      // The CLI's diffString fallback leaks patch headers into the text fields
      // and loses final-newline information, in live output and session/load.
      const malformed: ToolCallContent = {
        type: "diff",
        path,
        oldText: "-- /dev/null",
        newText: `++ b/${path}${body}`,
      };
      const updates = [
        tool(),
        notification({
          sessionUpdate: "tool_call_update",
          toolCallId: "native-edit",
          status: "completed",
          content: [malformed, diff],
        }),
      ];
      const f = fixture();
      for (const update of updates) f.output.update(update);
      expect(files(f.events)[0]?.changes.map(({ path }) => path)).toEqual([diff.path]);
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          snapshot: expect.objectContaining({
            item: expect.objectContaining({
              type: "toolExecution",
              output: expect.objectContaining({
                content: [{ type: "text", text: expect.stringContaining(malformed.newText) }],
              }),
            }),
          }),
        }),
      );
      const restored = cursorSnapshot(
        "cursor-session",
        [{ id: "native-turn", text: "Edit" }],
        [
          notification({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "Edit" },
          }),
          ...updates,
        ],
      );
      expect(
        restored.turns[0]?.items.flatMap(({ item }) =>
          item.type === "fileChange" ? item.changes.map(({ path }) => path) : [],
        ),
      ).toEqual([diff.path]);
    },
  );

  it("accepts diff content first provided with terminal success", () => {
    const f = fixture();
    f.output.update(tool());
    f.output.update(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "native-edit",
        status: "completed",
        content: [diff],
      }),
    );
    expect(files(f.events)).toHaveLength(1);
  });

  it("replaces earlier content rather than accumulating stale proposed changes", () => {
    const f = fixture();
    f.output.update(tool([{ type: "diff", path: "/workspace/stale.txt", newText: "stale" }]));
    f.output.update(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "native-edit",
        content: [diff],
      }),
    );
    f.output.update(completed);
    expect(files(f.events)[0]?.changes.map(({ path }) => path)).toEqual([diff.path]);
  });

  it.each<{ content: ToolCallContent[] }>([
    { content: [] },
    { content: [{ type: "content", content: { type: "text", text: "No edit" } }] },
  ])(
    "does not publish a diff removed by a replacement content collection ($content)",
    ({ content }) => {
      const f = fixture();
      f.output.update(tool([diff]));
      f.output.update(
        notification({
          sessionUpdate: "tool_call_update",
          toolCallId: "native-edit",
          content,
        }),
      );
      f.output.update(completed);
      expect(files(f.events)).toEqual([]);
    },
  );

  it.each(["failed", "cancelled", "unconfirmed"])(
    "does not turn a %s edit proposal into an applied file change",
    (status) => {
      const f = fixture();
      f.output.update(tool([diff]));
      if (status === "failed")
        f.output.update(
          notification({
            sessionUpdate: "tool_call_update",
            toolCallId: "native-edit",
            status: "failed",
          }),
        );
      f.output.finish({ status: status === "cancelled" ? "cancelled" : "succeeded" });
      expect(files(f.events)).toEqual([]);
    },
  );

  it("retains an already completed edit when the rest of the Turn is cancelled", () => {
    const f = fixture();
    f.output.update(tool([diff]));
    f.output.update(completed);
    f.output.finish({ status: "cancelled" });
    expect(files(f.events)).toHaveLength(1);
  });

  it("keeps tool output instead of inferring a patch when native diff content is absent", () => {
    const f = fixture();
    f.output.update(tool([{ type: "content", content: { type: "text", text: "File updated" } }]));
    f.output.update(completed);
    expect(files(f.events)).toEqual([]);
    expect(f.events.at(-1)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "toolExecution", output: { content: [{ text: "File updated" }] } },
      },
    });
  });

  it("omits an oversized patch rather than publishing a truncated diff", () => {
    const f = fixture();
    f.output.update(
      tool([{ type: "diff", path: "/workspace/large.txt", newText: "x".repeat(100_001) }, diff]),
    );
    f.output.update(completed);
    expect(files(f.events)[0]?.changes.map(({ path }) => path)).toEqual([diff.path]);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        snapshot: expect.objectContaining({
          item: expect.objectContaining({
            type: "toolExecution",
            output: expect.objectContaining({ truncated: true }),
          }),
        }),
      }),
    );
  });

  it("bounds the total patch content per tool without cutting any accepted patch", () => {
    const f = fixture();
    f.output.update(
      tool([
        { type: "diff", path: "/workspace/first.txt", newText: "a".repeat(60_000) },
        { type: "diff", path: "/workspace/second.txt", newText: "b".repeat(60_000) },
        diff,
      ]),
    );
    f.output.update(completed);
    const changes = files(f.events)[0]?.changes;
    expect(changes?.map(({ path }) => path)).toEqual(["/workspace/first.txt", diff.path]);
    if (!changes || !changes[0]) throw new Error("Missing bounded file changes");
    expect(
      changes.reduce((size, change) => size + change.unifiedDiff.length, 0),
    ).toBeLessThanOrEqual(100_000);
    expect(applyPatch("", changes[0].unifiedDiff)).toBe("a".repeat(60_000));
  });

  it("reuses native diffs for history and the existing Desktop patch/Turn Diff projection", () => {
    const f = fixture();
    const updates = [tool([diff]), completed];
    for (const update of updates) f.output.update(update);
    f.output.finish({ status: "succeeded" });
    const projector = new CodexTurnProjector({
      threadId: "host-thread",
      turnId,
      cwd: "/workspace",
      startedAtMs: 1_000,
    });
    projector.project({ type: "turn.started", turnId });
    const messages = f.events.flatMap((event) =>
      event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed"
        ? projector.project(event).messages
        : [],
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "item/fileChange/patchUpdated",
        params: expect.objectContaining({
          changes: [
            expect.objectContaining({
              path: diff.path,
              diff: expect.stringContaining("+  new value  "),
            }),
          ],
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "turn/diff/updated",
        params: expect.objectContaining({ diff: expect.stringContaining("-  old value  ") }),
      }),
    );
    const replay = [
      notification({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Edit files" },
      }),
      ...updates.map((entry) => ({
        ...entry,
        update: { ...entry.update, toolCallId: "replay-0-0" },
      })),
    ];
    const restored = cursorSnapshot(
      "cursor-session",
      [{ id: "native-turn", text: "Edit files" }],
      replay,
    );
    const snapshot = restored.turns[0];
    if (!snapshot) throw new Error("Missing restored Turn");
    const historicalChanges = snapshot.items.flatMap(({ item }) =>
      item.type === "fileChange" ? item.changes : [],
    );
    expect(historicalChanges).toEqual(files(f.events)[0]?.changes);
    expect(snapshot.outcome.status).toBe("unknown");
    expect(projectHistoricalTurn({ turnId, cwd: "/workspace", snapshot })).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          type: "fileChange",
          changes: [expect.objectContaining({ path: diff.path })],
        }),
      ]),
    });
  });
});
