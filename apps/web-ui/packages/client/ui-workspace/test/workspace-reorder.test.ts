import assert from "node:assert/strict";
import { it } from "node:test";
import {
  canReorderWorkspaces,
  resolveWorkspaceDropAnchor,
  type ReorderableWorkspace,
} from "../src/client/rows/workspace-reorder.ts";

const makeList = (): ReorderableWorkspace[] => [
  { workspaceId: "r-a1", remote: { hostId: "remote-peer:a" } },
  { workspaceId: "r-a2", remote: { hostId: "remote-peer:a" } },
  { workspaceId: "r-b1", remote: { hostId: "remote-peer:b" } },
  { workspaceId: "l-1" },
  { workspaceId: "l-2" },
  { workspaceId: "l-3" },
];

it("canReorderWorkspaces permits local, same-host remote, cross-host remote, and local↔remote pairs", () => {
  const rows = makeList();
  for (const [source, target] of [
    ["l-1", "l-2"],
    ["r-a1", "r-a2"],
    ["r-a1", "r-b1"],
    ["l-1", "r-a1"],
    ["r-b1", "l-2"],
  ]) {
    assert.equal(canReorderWorkspaces(rows, source, target), true);
  }
});

it("canReorderWorkspaces rejects self-drops, unknown IDs, sectioned rows, and cross-parent nested rows", () => {
  const rows: ReorderableWorkspace[] = [
    ...makeList(),
    { workspaceId: "sec-1" },
    { workspaceId: "l-1-child-a" },
    { workspaceId: "l-1-child-b" },
    { workspaceId: "l-2-child" },
    { workspaceId: "r-a1-child" },
  ];
  const context = {
    sectionOf: new Map([["sec-1", "native-sec"]]),
    parents: new Map<string, string | undefined>([
      ["r-a1", undefined],
      ["r-a2", undefined],
      ["r-b1", undefined],
      ["l-1", undefined],
      ["l-2", undefined],
      ["l-3", undefined],
      ["sec-1", undefined],
      ["l-1-child-a", "l-1"],
      ["l-1-child-b", "l-1"],
      ["l-2-child", "l-2"],
      ["r-a1-child", "r-a1"],
    ]),
  };

  // Same-parent nested siblings can reorder with each other.
  assert.equal(canReorderWorkspaces(rows, "l-1-child-a", "l-1-child-b", context), true);
  // Top-level local and remote workspaces share root parent `undefined`.
  assert.equal(canReorderWorkspaces(rows, "l-1", "r-a1", context), true);

  for (const [source, target] of [
    ["l-1", "l-1"],
    ["l-1", undefined],
    ["missing", "l-1"],
    ["l-1", "missing"],
    ["sec-1", "l-1"],
    ["l-1", "sec-1"],
    ["l-1-child-a", "l-1"],
    ["l-1-child-a", "l-2-child"],
    ["l-1-child-a", "r-a1-child"],
    ["r-a1-child", "r-a1"],
  ] as const) {
    assert.equal(canReorderWorkspaces(rows, source, target, context), false);
  }
});

it("resolveWorkspaceDropAnchor resolves before/after anchors and suppresses no-op drops", () => {
  const rows = makeList(); // [r-a1, r-a2, r-b1, l-1, l-2, l-3]
  assert.deepEqual(resolveWorkspaceDropAnchor(rows, "l-1", { id: "r-a1", half: "before" }), {
    beforeWorkspaceId: "r-a1",
  });
  assert.deepEqual(resolveWorkspaceDropAnchor(rows, "l-1", { id: "r-a1", half: "after" }), {
    beforeWorkspaceId: "r-a2",
  });
  assert.deepEqual(resolveWorkspaceDropAnchor(rows, "r-a1", { id: "l-3", half: "after" }), {
    beforeWorkspaceId: undefined,
  });
  // No-op drops (already immediately before or after the target).
  assert.equal(resolveWorkspaceDropAnchor(rows, "r-a1", { id: "r-a2", half: "before" }), null);
  assert.equal(resolveWorkspaceDropAnchor(rows, "r-a2", { id: "r-a1", half: "after" }), null);
  assert.equal(resolveWorkspaceDropAnchor(rows, "l-1", { id: "l-1", half: "before" }), null);
});

it("resolveWorkspaceDropAnchor keeps after-drop anchored before hidden siblings in collapsed or host-filtered views", () => {
  // Collapsed view shows first 5 rows [r-a1, r-a2, r-b1, l-1, l-2], hiding l-3.
  // Dropping r-a1 after the last visible row (l-2) must anchor before l-3, not append past l-3.
  const full = makeList();
  assert.deepEqual(resolveWorkspaceDropAnchor(full, "r-a1", { id: "l-2", half: "after" }), {
    beforeWorkspaceId: "l-3",
  });

  // Host-filtered view showing only Host A [r-a1, r-a2] while r-b1, l-1, l-2, l-3 follow in full list.
  // Dropping r-a1 after r-a2 (last visible filtered row) must anchor before r-b1, not jump to the very end.
  assert.deepEqual(resolveWorkspaceDropAnchor(full, "r-a1", { id: "r-a2", half: "after" }), {
    beforeWorkspaceId: "r-b1",
  });

  // Dropping after the true last sibling in the full list passes undefined (append).
  assert.deepEqual(resolveWorkspaceDropAnchor(full, "l-1", { id: "l-3", half: "after" }), {
    beforeWorkspaceId: undefined,
  });
});
