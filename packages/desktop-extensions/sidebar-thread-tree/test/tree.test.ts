import { describe, expect, it } from "vitest";
import {
  SIDEBAR_THREAD_TREE_MAX_INDENT_DEPTH,
  mostUrgentSidebarThreadStatus,
  planSidebarThreadTree,
  type SidebarThreadTreeThread,
} from "../src/tree.js";

const thread = (
  status: SidebarThreadTreeThread["status"] = "idle",
  order = 0,
  archived = false,
): SidebarThreadTreeThread => ({
  status,
  archived,
  order,
});

describe("sidebar Thread tree placement", () => {
  it("places one tree per list at its first mounted member, with nested live activity and rollup", () => {
    const expanded = new Set(["parent", "child"]);
    const plans = planSidebarThreadTree({
      parents: { child: "parent", leaf: "child", other: "parent" },
      threads: new Map([
        ["parent", thread("idle", 10)],
        ["child", thread("running", 20)],
        ["leaf", thread("pending", 30)],
        ["other", thread("unknown", 15)],
      ]),
      rows: [
        { key: "recent-child", threadId: "child", list: "recents" },
        { key: "recent-parent", threadId: "parent", list: "recents" },
        { key: "project-parent", threadId: "parent", list: "project" },
        { key: "project-leaf", threadId: "leaf", list: "project" },
      ],
      expanded: (id) => expanded.has(id),
    });

    expect(plans.get("recent-child")).toEqual({
      kind: "virtual",
      tree: {
        threadId: "parent",
        status: "idle",
        descendants: 3,
        expanded: true,
        rollup: "pending",
        activity: { running: 1, pending: 1 },
        nodes: [
          {
            threadId: "child",
            depth: 1,
            status: "running",
            descendants: 1,
            expanded: true,
            rollup: "pending",
            activity: { running: 0, pending: 1 },
          },
          {
            threadId: "leaf",
            depth: 2,
            status: "pending",
            descendants: 0,
            expanded: false,
            rollup: "idle",
            activity: { running: 0, pending: 0 },
          },
          {
            threadId: "other",
            depth: 1,
            status: "unknown",
            descendants: 0,
            expanded: false,
            rollup: "idle",
            activity: { running: 0, pending: 0 },
          },
        ],
      },
    });
    expect(plans.get("recent-parent")).toEqual({ kind: "hidden", rootId: "parent" });
    expect(plans.get("project-parent")).toMatchObject({
      kind: "root",
      tree: { threadId: "parent", descendants: 3, expanded: true },
    });
    expect(plans.get("project-leaf")).toEqual({ kind: "hidden", rootId: "parent" });
  });

  it("omits nodes while collapsed while still counting descendants and activity", () => {
    const plans = planSidebarThreadTree({
      parents: { child: "parent", leaf: "child" },
      threads: new Map([
        ["parent", thread("idle")],
        ["child", thread("running")],
        ["leaf", thread("pending")],
      ]),
      rows: [
        { key: "parent", threadId: "parent", list: "project" },
        { key: "child", threadId: "child", list: "project" },
      ],
      expanded: () => false,
    });

    expect(plans.get("parent")).toEqual({
      kind: "root",
      tree: {
        threadId: "parent",
        status: "idle",
        descendants: 2,
        expanded: false,
        rollup: "pending",
        activity: { running: 1, pending: 1 },
        nodes: [],
      },
    });
    expect(plans.get("child")).toEqual({ kind: "hidden", rootId: "parent" });
  });

  it("leaves unplaceable rows plain and keeps descendants below a promoted Thread", () => {
    const plans = planSidebarThreadTree({
      parents: {
        child: "pinned",
        archived: "parent",
        detached: "archived",
        missing: "not-in-snapshot",
        loop: "loop",
      },
      threads: new Map([
        ["parent", thread()],
        ["pinned", thread()],
        ["child", thread()],
        ["archived", thread("idle", 0, true)],
        ["detached", thread()],
        ["missing", thread()],
        ["loop", thread()],
      ]),
      rows: ["parent", "pinned", "child", "archived", "detached", "missing", "loop"].map(
        (threadId) => ({
          key: threadId,
          list: "project",
          threadId,
        }),
      ),
      expanded: () => true,
    });

    expect(plans.get("pinned")).toMatchObject({
      kind: "root",
      tree: { threadId: "pinned", descendants: 1, nodes: [{ threadId: "child", depth: 1 }] },
    });
    expect(plans.get("child")).toEqual({ kind: "hidden", rootId: "pinned" });
    for (const key of ["parent", "archived", "detached", "missing", "loop"]) {
      expect(plans.get(key)).toEqual({ kind: "plain" });
    }
  });

  it("ranks pending > running > unknown > idle without conflating unknown with idle", () => {
    expect(SIDEBAR_THREAD_TREE_MAX_INDENT_DEPTH).toBe(3);
    expect(mostUrgentSidebarThreadStatus(["idle", "unknown"])).toBe("unknown");
    expect(mostUrgentSidebarThreadStatus(["unknown", "running"])).toBe("running");
    expect(mostUrgentSidebarThreadStatus(["running", "pending", "unknown"])).toBe("pending");
    expect(mostUrgentSidebarThreadStatus([])).toBe("idle");
  });
});
