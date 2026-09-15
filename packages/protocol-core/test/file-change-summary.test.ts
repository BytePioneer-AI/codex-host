import { describe, expect, it } from "vitest";
import { applyPatch, createTwoFilesPatch } from "diff";
import type {
  HostFileChange,
  HostItem,
  HostItemSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import {
  CodexTurnProjector,
  projectHistoricalTurn,
  fileChangeFromTool,
} from "../src/codex-ui-projector.js";
import { summarizeFileChanges } from "../src/file-change-summary.js";

const turnId = hostTurnIdSchema.parse("files-turn");
const id = (value: string) => hostItemIdSchema.parse(value);
const change = (before: string, after: string, path = "a.txt"): HostFileChange => ({
  path,
  kind: "update",
  unifiedDiff: createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after),
});
const file = (key: string, changes: HostFileChange[]): HostItem => ({
  type: "fileChange",
  itemId: id(key),
  changes,
});
type FileCard = { id: string; type: string; changes: { path: string; diff: string }[] };
const files = (turn: JsonObject | undefined) =>
  (turn?.items as unknown as FileCard[]).filter((item) => item.type === "fileChange");

describe("external Harness file summaries", () => {
  it.each(["native", "inferred"])(
    "coalesces %s edits across live, pending, completed and historical output",
    (source) => {
      const projector = new CodexTurnProjector({
        threadId: "thread",
        turnId,
        cwd: "/workspace",
        startedAtMs: 1000,
      });
      projector.project({ type: "turn.started", turnId });
      const snapshots: HostItemSnapshot[] = [];
      const messages: JsonObject[] = [];
      const edits: [string, string][] = [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
      ];
      for (const [index, [before, after]] of edits.entries()) {
        const item: HostItem =
          source === "native"
            ? file(`file-${index}`, [change(before + "\n", after + "\n")])
            : {
                type: "toolExecution",
                itemId: id(`file-${index}`),
                toolName: "Edit",
                arguments: { path: "a.txt", old_string: before + "\n", new_string: after + "\n" },
              };
        const snapshot: HostItemSnapshot = { item, outcome: { status: "succeeded" } };
        snapshots.push(snapshot);
        messages.push(...projector.project({ type: "item.started", turnId, item }).messages);
        messages.push(...projector.project({ type: "item.completed", turnId, snapshot }).messages);
        expect(files(projector.pendingTurn())).toHaveLength(1);
        expect(files(projector.pendingTurn())[0]?.changes).toHaveLength(1);
      }
      expect(messages.filter((message) => message.method === "item/started")).toHaveLength(1);
      expect(messages.filter((message) => message.method === "item/completed")).toHaveLength(0);
      const completed = projector.project({
        type: "turn.completed",
        turnId,
        outcome: { status: "succeeded" },
      });
      expect(
        completed.messages.filter((message) => message.method === "item/completed"),
      ).toHaveLength(1);
      const summary = files(completed.completedTurn)[0];
      if (!summary) throw new Error("Missing file summary");
      expect(summary.changes).toHaveLength(1);
      if (source === "native") {
        expect(applyPatch("a\n", summary.changes[0]?.diff ?? "")).toBe("d\n");
        expect(summary.changes[0]?.diff ?? "").not.toMatch(/^[+-][bc]$/m);
      } else {
        expect(summary.changes[0]?.diff ?? "").toContain("-a");
        expect(summary.changes[0]?.diff ?? "").toContain("+d");
      }
      const snapshot: HostTurnSnapshot = {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: "pi",
          nativeSessionId: "session",
          nativeTurnKey: "turn",
          formatVersion: 1,
        }),
        input: [],
        items: snapshots,
        outcome: { status: "succeeded" },
      };
      expect(files(projectHistoricalTurn({ turnId, cwd: "/workspace", snapshot }))).toEqual([
        summary,
      ]);
    },
  );

  it("replaces cumulative native results, supersedes tool previews and retracts rejected previews", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread",
      turnId,
      cwd: "/workspace",
      startedAtMs: 1000,
    });
    projector.project({ type: "turn.started", turnId });
    const tool: HostItem = {
      type: "toolExecution",
      itemId: id("edit"),
      toolName: "Edit",
      arguments: { path: "a.txt", old_string: "a", new_string: "b" },
    };
    projector.project({ type: "item.started", turnId, item: tool });
    projector.project({
      type: "item.completed",
      turnId,
      snapshot: { item: tool, outcome: { status: "succeeded" } },
    });
    const native: HostItem = {
      type: "fileChange",
      itemId: id("native"),
      changes: [change("a\n", "b\n")],
      sourceItemIds: [tool.itemId],
    };
    projector.project({ type: "item.started", turnId, item: native });
    const latest = [change("a\n", "c\n")];
    projector.project({
      type: "item.updated",
      turnId,
      itemId: native.itemId,
      update: { type: "fileChanges.replace", changes: latest },
    });
    expect(applyPatch("a\n", files(projector.pendingTurn())[0]?.changes[0]?.diff ?? "")).toBe(
      "c\n",
    );
    projector.project({
      type: "item.completed",
      turnId,
      snapshot: { item: { ...native, changes: latest }, outcome: { status: "succeeded" } },
    });
    const preview = file("rejected", [change("c\n", "WRONG\n")]);
    projector.project({ type: "item.started", turnId, item: preview });
    projector.project({
      type: "item.completed",
      turnId,
      snapshot: { item: preview, outcome: { status: "cancelled", reason: "denied" } },
    });
    const completed = projector.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "cancelled", reason: "cancelled later" },
    });
    expect(applyPatch("a\n", files(completed.completedTurn)[0]?.changes[0]?.diff ?? "")).toBe(
      "c\n",
    );
  });

  it("composes distant hunks and line shifts without leaking unknown context", () => {
    const before = Array.from({ length: 45 }, (_, i) => `line ${i}\n`).join("");
    const middle = before.replace("line 2\n", "first\nextra\n");
    const after = middle.replace("line 40\n", "last\n");
    const summary = summarizeFileChanges(
      [change(before, middle), change(middle, after)],
      "/workspace",
    );
    expect(summary).toHaveLength(1);
    expect(applyPatch(before, summary[0]?.unifiedDiff ?? "")).toBe(after);
  });

  it("clears reverted changes and handles create/edit/delete plus missing final newlines", () => {
    expect(summarizeFileChanges([change("a", "b"), change("b", "a")], "/workspace")).toEqual([]);
    const add = { ...change("", "new"), kind: "add" as const };
    const edit = change("new", "final");
    const summary = summarizeFileChanges([add, edit], "/workspace");
    expect(summary[0]?.kind).toBe("add");
    expect(applyPatch("", summary[0]?.unifiedDiff ?? "")).toBe("final");
    expect(
      summarizeFileChanges([add, edit, { ...change("final", ""), kind: "delete" }], "/workspace"),
    ).toEqual([]);
  });

  it("groups Windows aliases without folding case-sensitive POSIX paths", () => {
    expect(
      summarizeFileChanges(
        [change("a", "b", "src/a.txt"), change("b", "c", "C:\\repo\\SRC\\a.txt")],
        "C:\\repo",
      ),
    ).toHaveLength(1);
    expect(
      summarizeFileChanges([change("a", "b", "A.txt"), change("a", "b", "a.txt")], "/repo"),
    ).toHaveLength(2);
  });

  it("preserves line endings and empty-file existence when composing native patches", () => {
    const emptied = fileChangeFromTool("Edit", {
      input: { path: "a.txt", old_string: "  a\n", new_string: "" },
    });
    expect(applyPatch("  a\n", emptied?.[0]?.unifiedDiff ?? "")).toBe("");
    for (const [before, middle, after] of [
      ["a\r\nb\r\n", "a\r\nx\r\nb\r\n", "z\r\na\r\nx\r\n"],
      ["a\nb\nc", "b\nc", "b\nz\nc"],
      ["", "a\n", "b"],
    ]) {
      if (before === undefined || middle === undefined || after === undefined)
        throw new Error("Invalid example");
      const summary = summarizeFileChanges(
        [change(before, middle), change(middle, after)],
        "/repo",
      );
      expect(applyPatch(before, summary[0]?.unifiedDiff ?? "")).toBe(after);
    }
    const emptyAdd: HostFileChange = { ...change("", ""), kind: "add" };
    expect(summarizeFileChanges([emptyAdd, change("", "")], "/repo")[0]?.kind).toBe("add");
    expect(
      summarizeFileChanges([emptyAdd, { ...change("", ""), kind: "delete" }], "/repo"),
    ).toEqual([]);
  });

  it("retains both unpositioned fragments instead of fabricating first-old/last-new content", () => {
    const summary = summarizeFileChanges(
      [change("first old\n", "first new\n"), change("last old\n", "last new\n")],
      "/repo",
    );
    expect(summary).toHaveLength(1);
    expect(summary[0]?.unifiedDiff ?? "").toContain("-first old");
    expect(summary[0]?.unifiedDiff ?? "").toContain("+first new");
    expect(summary[0]?.unifiedDiff ?? "").toContain("-last old");
    expect(summary[0]?.unifiedDiff ?? "").toContain("+last new");
    const matchingFragments = summarizeFileChanges(
      [
        { ...change("a\n", "b\n"), diffScope: "fragment" },
        { ...change("b\n", "c\n"), diffScope: "fragment" },
      ],
      "/repo",
    );
    expect(matchingFragments[0]?.unifiedDiff ?? "").toContain("+b");
    expect(matchingFragments[0]?.unifiedDiff ?? "").toContain("-b");
  });
});
