import { expect, it } from "vitest";

import {
  SIDEBAR_THREAD_TREE_MAX_INDENT_DEPTH,
  planSidebarThreadTree,
  type SidebarThreadTreeRoot,
  type SidebarThreadTreeStatus,
  type SidebarThreadTreeThread,
} from "../src/sidebar-thread-tree.js";

interface Thread {
  parent?: string;
  status?: SidebarThreadTreeStatus;
  archived?: boolean;
  order?: number;
  /** The Host returned no summary for it. */
  unknown?: boolean;
}

/** `rows` are `list:threadId`, in document order. */
function plan(tree: Record<string, Thread>, rows: string[], expanded: string[] = []) {
  const threads = new Map<string, SidebarThreadTreeThread>();
  const parents: Record<string, string> = {};
  for (const [threadId, thread] of Object.entries(tree)) {
    if (thread.parent !== undefined) parents[threadId] = thread.parent;
    if (thread.unknown) continue;
    threads.set(threadId, {
      status: thread.status ?? "idle",
      archived: thread.archived ?? false,
      order: thread.order ?? 0,
    });
  }
  const result = planSidebarThreadTree({
    parents,
    threads,
    rows: rows.map((key) => {
      const [list = "", threadId = ""] = key.split(":");
      return { key, list, threadId };
    }),
    expanded: (threadId) => expanded.includes(threadId),
  });
  const describe = (tree: SidebarThreadTreeRoot) => ({
    root: tree.threadId,
    count: tree.descendants,
    nodes: tree.nodes.map((node) => `${"  ".repeat(node.depth - 1)}${node.threadId}`),
  });
  return {
    plans: Object.fromEntries(
      [...result].map(([key, row]) => [
        key,
        row.kind === "root" || row.kind === "virtual"
          ? { kind: row.kind, ...describe(row.tree) }
          : row.kind === "hidden"
            ? `hidden under ${row.rootId}`
            : "plain",
      ]),
    ),
    raw: result,
  };
}

it("shows a tree on its root's row, newest delegation first, and hides the rows it absorbs", () => {
  const tree = {
    root: {},
    a: { parent: "root", order: 1 },
    b: { parent: "root", order: 3, status: "running" as const },
    c: { parent: "root", order: 2 },
    b1: { parent: "b", status: "question" as const },
    other: {},
  };
  const result = plan(tree, ["p:root", "p:b", "p:other"], ["root", "b"]);
  expect(result.plans).toEqual({
    "p:root": { kind: "root", root: "root", count: 4, nodes: ["b", "  b1", "c", "a"] },
    "p:b": "hidden under root",
    "p:other": "plain",
  });
});

it("draws the tree where its topmost member stands in each list", () => {
  const tree = {
    lead: {},
    worker: { parent: "lead", order: 2 },
    reviewer: { parent: "lead", order: 1 },
  };
  // Recents lists the workers above their lead; the project lists the lead first.
  const result = plan(tree, ["recent:worker", "recent:lead", "recent:reviewer", "project:lead"]);
  expect(result.plans).toEqual({
    "recent:worker": { kind: "virtual", root: "lead", count: 2, nodes: [] },
    "recent:lead": "hidden under lead",
    "recent:reviewer": "hidden under lead",
    "project:lead": { kind: "root", root: "lead", count: 2, nodes: [] },
  });
});

it("gathers a list's children under their root even when the root has no row there", () => {
  const tree = { lead: {}, worker: { parent: "lead" }, helper: { parent: "worker" } };
  const result = plan(tree, ["recent:helper", "recent:worker"], ["lead"]);
  expect(result.plans).toEqual({
    "recent:helper": { kind: "virtual", root: "lead", count: 2, nodes: ["worker"] },
    "recent:worker": "hidden under lead",
  });
});

it("counts what a collapsed row hides, with its live work", () => {
  const tree = {
    root: {},
    a: { parent: "root", status: "running" as const },
    a1: { parent: "a", status: "running" as const },
    a2: { parent: "a", status: "question" as const },
  };
  const collapsed = plan(tree, ["p:root"]);
  expect(collapsed.plans["p:root"]).toEqual({ kind: "root", root: "root", count: 3, nodes: [] });
  const root = collapsed.raw.get("p:root");
  expect(root?.kind === "root" && root.tree).toMatchObject({
    rollup: "question",
    activity: { running: 2, question: 1 },
  });

  const expanded = plan(tree, ["p:root"], ["root"]);
  const node = expanded.raw.get("p:root");
  // The collapsed child reports its own descendants; its own state is not part of its rollup.
  expect(node?.kind === "root" && node.tree.nodes).toEqual([
    {
      threadId: "a",
      depth: 1,
      status: "running",
      descendants: 2,
      expanded: false,
      rollup: "question",
      activity: { running: 1, question: 1 },
    },
  ]);
});

it.each([
  ["archived", { archived: true }],
  ["not described by the Host", { unknown: true }],
])("leaves out a Thread that is %s, with everything below it", (_name, state) => {
  const tree = {
    root: {},
    kept: { parent: "root" },
    dropped: { parent: "root", ...state },
    below: { parent: "dropped" },
  };
  const result = plan(tree, ["p:root", "p:dropped", "p:below"], ["root"]);
  expect(result.plans).toEqual({
    "p:root": { kind: "root", root: "root", count: 1, nodes: ["kept"] },
    // Its own row stays as Desktop shows it; what it delegated forms a tree of its own.
    "p:dropped": "plain",
    "p:below": "plain",
  });
});

it("shows nothing under a root the Host has not described", () => {
  const tree = { root: { unknown: true }, child: { parent: "root" } };
  expect(plan(tree, ["p:root", "p:child"], ["root"]).plans).toEqual({
    "p:root": "plain",
    "p:child": "plain",
  });
});

it("leaves Threads whose ancestry loops in their own rows", () => {
  const tree = { a: { parent: "b" }, b: { parent: "a" }, c: { parent: "a" } };
  expect(plan(tree, ["p:a", "p:b", "p:c"], ["a", "b", "c"]).plans).toEqual({
    "p:a": "plain",
    "p:b": "plain",
    "p:c": "plain",
  });
});

it("reports the real depth of every level; indentation stops at a display limit", () => {
  const tree: Record<string, Thread> = { root: {} };
  for (let index = 1; index <= 6; index += 1)
    tree[`level-${index}`] = { parent: index === 1 ? "root" : `level-${index - 1}` };
  const result = plan(tree, ["p:root"], Object.keys(tree));
  const row = result.raw.get("p:root");
  expect(row?.kind === "root" && row.tree.nodes.map((node) => node.depth)).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
  // The DOM indents and draws guides only this deep.
  expect(SIDEBAR_THREAD_TREE_MAX_INDENT_DEPTH).toBe(3);
});
