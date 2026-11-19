import { describe, expect, it } from "vitest";
import { harnessIdSchema, type ThreadTreeNode } from "@codexhost/shared-contracts";
import { planThreadTree } from "../src/tree.js";

const thread = (status: ThreadTreeNode["status"] = "idle", archived = false): ThreadTreeNode => ({
  harnessId: harnessIdSchema.parse("codex"),
  status,
  archived,
});
type TreeInput = Parameters<typeof planThreadTree>[0];
const snapshot = (parents: TreeInput["parents"], nodes: TreeInput["nodes"]): TreeInput => ({
  parents,
  nodes,
});

describe("sidebar Thread tree placement", () => {
  it("places one tree per list at its first mounted member, with nested live activity", () => {
    const plans = planThreadTree(
      snapshot(
        { child: "parent", leaf: "child", other: "parent" },
        {
          parent: thread(),
          child: thread("running"),
          leaf: thread("waiting"),
          other: thread("unknown"),
        },
      ),
      [
        { key: "recent-child", threadId: "child", list: "recents" },
        { key: "recent-parent", threadId: "parent", list: "recents" },
        { key: "project-parent", threadId: "parent", list: "project" },
        { key: "project-leaf", threadId: "leaf", list: "project" },
      ],
    );
    expect(plans.get("recent-child")).toMatchObject({
      kind: "virtual",
      tree: {
        id: "parent",
        activity: { descendants: 3, running: 1, waiting: 1 },
        children: [
          { id: "child", children: [{ id: "leaf" }] },
          { id: "other", node: { status: "unknown" } },
        ],
      },
    });
    expect(plans.get("recent-parent")).toEqual({ kind: "hidden" });
    expect(plans.get("project-parent")).toMatchObject({ kind: "root", tree: { id: "parent" } });
    expect(plans.get("project-leaf")).toEqual({ kind: "hidden" });
  });

  it("leaves unplaceable rows intact and keeps descendants below a promoted Thread", () => {
    const plans = planThreadTree(
      snapshot(
        {
          child: "pinned",
          archived: "parent",
          detached: "archived",
          missing: "not-in-snapshot",
          loop: "loop",
        },
        {
          parent: thread(),
          pinned: thread(),
          child: thread(),
          archived: thread("idle", true),
          detached: thread(),
          missing: thread(),
          loop: thread(),
        },
      ),
      ["parent", "pinned", "child", "archived", "detached", "missing", "loop"].map((threadId) => ({
        key: threadId,
        list: "project",
        threadId,
      })),
    );
    expect([...plans.keys()]).toEqual(["pinned", "child"]);
    expect(plans.get("pinned")).toMatchObject({
      kind: "root",
      tree: { id: "pinned", children: [{ id: "child" }] },
    });
  });
});
