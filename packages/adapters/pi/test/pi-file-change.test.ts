import os from "node:os";
import path from "node:path";

import type { JsonObject } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { piToolFileChanges } from "../src/pi-file-change.js";
import { mapPiSnapshot, type PiSessionHistory } from "../src/pi-history.js";

const cwd = path.join(os.tmpdir(), "pi-file-change-project");
const home = os.homedir().replaceAll("\\", "/");

function chain(messages: JsonObject[]): PiSessionHistory {
  const entries = messages.map((message, index) => ({
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    type: "message",
    message,
  }));
  return { entries, leafId: entries.at(-1)?.id ?? null };
}

function toolTurn(name: string, args: JsonObject, result: JsonObject): PiSessionHistory {
  return chain([
    { role: "user", content: [{ type: "text", text: "change files" }] },
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
    },
    { role: "toolResult", toolCallId: "call-1", toolName: name, content: [], ...result },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
  ]);
}

function fileChangeItems(history: PiSessionHistory, withCwd: string | null = cwd) {
  const snapshot = mapPiSnapshot(history, {
    sessionId: "pi-session",
    model: null,
    ...(withCwd ? { cwd: withCwd } : {}),
  });
  return snapshot.turns.flatMap((turn) =>
    turn.items.flatMap(({ item }) => (item.type === "fileChange" ? [item] : [])),
  );
}

describe("Pi tool file changes", () => {
  it("reads Pi's raw-path patch headers without stripping real a/ directories", () => {
    const patch = "--- a/foo.txt\n+++ a/foo.txt\n@@ -1 +1 @@\n-old\n+new\n";
    expect(piToolFileChanges("edit", { path: "a/foo.txt" }, { details: { patch } }, cwd)).toEqual([
      { path: "a/foo.txt", kind: "update", unifiedDiff: patch },
    ]);

    const gitStyle = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1 +1 @@\n-old\n+new\n";
    expect(
      piToolFileChanges("edit", { path: "foo.txt" }, { details: { patch: gitStyle } }, cwd),
    ).toMatchObject([{ path: "foo.txt" }]);
  });

  it("projects each edits[] replacement as a fragment when the result has no patch", () => {
    const changes = piToolFileChanges(
      "edit",
      {
        path: "src/a.txt",
        edits: [
          { oldText: "one", newText: "uno" },
          { oldText: "two", newText: "" },
        ],
      },
      { content: [] },
      cwd,
    );
    expect(changes).toMatchObject([
      { path: "src/a.txt", kind: "update", diffScope: "fragment" },
      { path: "src/a.txt", kind: "update", diffScope: "fragment" },
    ]);
    expect(changes?.[0]?.unifiedDiff).toContain("+uno");
    expect(changes?.[1]?.unifiedDiff).toContain("-two");
  });

  it("keeps every replacement when edits[] and legacy oldText/newText are both given", () => {
    const changes = piToolFileChanges(
      "edit",
      {
        path: "src/a.txt",
        edits: [{ oldText: "one", newText: "uno" }],
        oldText: "two",
        newText: "dos",
      },
      { content: [] },
      cwd,
    );
    expect(changes?.map((change) => change.unifiedDiff)).toEqual([
      expect.stringContaining("+uno"),
      expect.stringContaining("+dos"),
    ]);
  });

  it("leaves plain write arguments to the Host and resolves Pi-only path forms itself", () => {
    expect(piToolFileChanges("write", { path: "new.txt", content: "x" }, {}, cwd)).toBeNull();
    // The Host's other argument keys: left to it on plain paths, resolved here on Pi-only ones.
    expect(piToolFileChanges("write", { path: "new.txt", file_text: "x" }, {}, cwd)).toBeNull();
    expect(
      piToolFileChanges("edit", { path: "@old.txt", old: "a", new: "b" }, {}, cwd),
    ).toMatchObject([{ path: "old.txt", kind: "update" }]);
    expect(piToolFileChanges("write", { path: "@out/a.txt", content: "x" }, {}, cwd)).toMatchObject(
      [{ path: "out/a.txt", kind: "add" }],
    );
    expect(piToolFileChanges("write", { path: "~/notes.md", content: "" }, {}, cwd)).toMatchObject([
      { path: `${home}/notes.md`, kind: "add" },
    ]);
  });
});

describe("Pi history file changes", () => {
  it("rebuilds an edit's file change from its saved patch with stable ids", () => {
    const patch = "--- src/a.txt\n+++ src/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const history = toolTurn(
      "edit",
      { path: "src/a.txt", edits: [{ oldText: "old", newText: "new" }] },
      { isError: false, details: { patch } },
    );
    const items = fileChangeItems(history);
    expect(items).toEqual([
      {
        type: "fileChange",
        itemId: "pi-item-v1-entry-1-file-0",
        sourceItemIds: ["pi-item-v1-entry-1-tool-0"],
        changes: [{ path: "src/a.txt", kind: "update", unifiedDiff: patch }],
      },
    ]);
    expect(fileChangeItems(history)).toEqual(items);
  });

  it("skips failed edits and snapshots without a cwd", () => {
    const args = { path: "src/a.txt", edits: [{ oldText: "old", newText: "new" }] };
    expect(fileChangeItems(toolTurn("edit", args, { isError: true }))).toEqual([]);
    expect(fileChangeItems(toolTurn("edit", args, { isError: false }), null)).toEqual([]);
  });

  it("rebuilds successful edit and write calls a tool made through ctx.executeTool()", () => {
    const history = toolTurn(
      "codemode",
      { code: "..." },
      {
        isError: true,
        nestedCalls: {
          complete: false,
          calls: [
            {
              name: "edit",
              status: "ok",
              arguments: { path: "src/b.txt", edits: [{ oldText: "b", newText: "B" }] },
            },
            { name: "write", status: "ok", arguments: { path: "empty.txt", content: "" } },
            {
              name: "edit",
              status: "ok",
              arguments: {
                path: "src/e.txt",
                edits: [{ oldText: "e", newText: "E" }],
                oldText: "f",
                newText: "F",
              },
            },
            { name: "edit", status: "error", arguments: { path: "src/c.txt", edits: [] } },
            { name: "read", status: "ok", arguments: { path: "src/d.txt" } },
            { name: "write", status: "ok" },
          ],
        },
      },
    );
    expect(fileChangeItems(history)).toMatchObject([
      {
        itemId: "pi-item-v1-entry-1-nested-0-file-0",
        sourceItemIds: ["pi-item-v1-entry-1-tool-0"],
        changes: [{ path: "src/b.txt", kind: "update", diffScope: "fragment" }],
      },
      {
        itemId: "pi-item-v1-entry-1-nested-1-file-0",
        changes: [{ path: "empty.txt", kind: "add" }],
      },
      {
        itemId: "pi-item-v1-entry-1-nested-2-file-0",
        changes: [{ path: "src/e.txt" }, { path: "src/e.txt" }],
      },
    ]);
  });
});
