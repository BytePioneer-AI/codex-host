import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChThreadView, type ChThread } from "../src/ch-thread-view.ts";
import { defined } from "./support/defined.ts";

const DIFF = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,1 @@
-old line
+new line
`;

function thread(turns: ChThread["turns"]): ChThread {
  return {
    id: "t1",
    cwd: "/w",
    modelProvider: "claude-code",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns,
  };
}

function toolCall(view: ChThreadView): { name: string; arguments: unknown } {
  const event = defined(view.log.events.find((entry) => entry.type === "tool/call"));
  const data = event.data as { name: string; arguments: string };
  return { name: data.name, arguments: JSON.parse(data.arguments) as unknown };
}

function toolResultMeta(view: ChThreadView): unknown {
  const event = defined(view.log.events.find((entry) => entry.type === "tool/result"));
  return (event.data as { meta?: unknown }).meta;
}

describe("CH fileChange to DSH diff cards", () => {
  it("maps a completed Codex fileChange onto edit arguments and meta.diffs", () => {
    const view = new ChThreadView(
      thread([
        {
          id: "turn-1",
          status: "completed",
          items: [
            { id: "u", type: "userMessage", content: [{ type: "text", text: "edit it" }] },
            {
              id: "fc",
              type: "fileChange",
              status: "completed",
              changes: [
                {
                  path: "src/app.ts",
                  kind: { type: "update", move_path: null },
                  diff: DIFF,
                },
              ],
            },
          ],
        },
      ]),
      "claude-code",
      () => {},
    );
    view.update(view.thread);

    assert.deepEqual(toolCall(view), {
      name: "edit",
      arguments: {
        file_path: "src/app.ts",
        old_string: "old line",
        new_string: "new line",
        files: [
          {
            path: "src/app.ts",
            kind: "update",
            old_string: "old line",
            new_string: "new line",
          },
        ],
      },
    });
    assert.deepEqual(toolResultMeta(view), {
      diffs: [{ path: "src/app.ts", oldText: "old line", newText: "new line" }],
    });
  });

  it("maps a create fileChange onto write", () => {
    const view = new ChThreadView(
      thread([
        {
          id: "turn-1",
          status: "completed",
          items: [
            { id: "u", type: "userMessage", content: [{ type: "text", text: "create it" }] },
            {
              id: "fc",
              type: "fileChange",
              status: "completed",
              changes: [
                {
                  path: "src/new.ts",
                  kind: { type: "add" },
                  diff: "+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+hello\n",
                },
              ],
            },
          ],
        },
      ]),
      "claude-code",
      () => {},
    );
    view.update(view.thread);

    assert.deepEqual(toolCall(view), {
      name: "write",
      arguments: {
        file_path: "src/new.ts",
        content: "hello",
        files: [
          {
            path: "src/new.ts",
            kind: "add",
            old_string: "",
            new_string: "hello",
            content: "hello",
          },
        ],
      },
    });
  });

  it("waits for a path before opening the DSH edit call", () => {
    const row = thread([
      {
        id: "turn-live",
        status: "inProgress",
        items: [
          { id: "u", type: "userMessage", content: [{ type: "text", text: "edit it" }] },
          { id: "fc", type: "fileChange", status: "inProgress", changes: [] },
        ],
      },
    ]);
    row.status = { type: "active" };
    const view = new ChThreadView(structuredClone(row), "claude-code", () => {});
    view.update(structuredClone(row));
    assert.equal(
      view.log.events.some((event) => event.type === "tool/call"),
      false,
    );

    const live = defined(row.turns[0]);
    defined(live.items[1]).changes = [
      { path: "src/app.ts", kind: { type: "update", move_path: null }, diff: DIFF },
    ];
    view.update(structuredClone(row));

    assert.deepEqual(toolCall(view), {
      name: "edit",
      arguments: {
        file_path: "src/app.ts",
        old_string: "old line",
        new_string: "new line",
        files: [
          {
            path: "src/app.ts",
            kind: "update",
            old_string: "old line",
            new_string: "new line",
          },
        ],
      },
    });
  });

  it("keeps every path on a multi-file fileChange call", () => {
    const view = new ChThreadView(
      thread([
        {
          id: "turn-1",
          status: "completed",
          items: [
            { id: "u", type: "userMessage", content: [{ type: "text", text: "edit them" }] },
            {
              id: "fc",
              type: "fileChange",
              status: "completed",
              changes: [
                {
                  path: "a.ts",
                  kind: { type: "update", move_path: null },
                  diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
                },
                {
                  path: "b.ts",
                  kind: { type: "update", move_path: null },
                  diff: "--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n",
                },
              ],
            },
          ],
        },
      ]),
      "claude-code",
      () => {},
    );
    view.update(view.thread);
    const call = toolCall(view);
    assert.equal(call.name, "edit");
    assert.deepEqual(
      (call.arguments as { files: Array<{ path: string }> }).files.map((file) => file.path),
      ["a.ts", "b.ts"],
    );
    assert.deepEqual(
      (toolResultMeta(view) as { diffs: Array<{ path: string }> }).diffs.map((diff) => diff.path),
      ["a.ts", "b.ts"],
    );
  });
});

describe("CH file summary that grows during a live Turn", () => {
  const fileItem = (paths: string[], status: string) => ({
    id: "fc",
    type: "fileChange",
    status,
    changes: paths.map((path) => ({
      path,
      kind: { type: "update", move_path: null },
      diff: DIFF.replaceAll("src/app.ts", path),
    })),
  });
  const turn = (paths: string[], status: string, turnStatus: string) => ({
    id: "turn-1",
    status: turnStatus,
    items: [
      { id: "u", type: "userMessage", content: [{ type: "text", text: "edit" }] },
      fileItem(paths, status),
    ],
  });

  it("settles each growth of a completed summary as its own call with cumulative changes", () => {
    const view = new ChThreadView(
      thread([turn(["a.ts"], "completed", "inProgress")] as ChThread["turns"]),
      "pi",
      () => {},
    );
    view.update(view.thread);
    view.update(
      thread([turn(["a.ts", "b.ts", "c.ts"], "completed", "inProgress")] as ChThread["turns"]),
    );
    view.update(
      thread([turn(["a.ts", "b.ts", "c.ts"], "completed", "completed")] as ChThread["turns"]),
    );
    const results = view.log.events
      .filter((entry) => entry.type === "tool/result")
      .map((entry) =>
        (entry.data as { meta: { diffs: Array<{ path: string }> } }).meta.diffs.map(
          (diff) => diff.path,
        ),
      );
    assert.deepEqual(results, [["a.ts"], ["a.ts", "b.ts", "c.ts"]]);
  });
});
