import assert from "node:assert/strict";
import { it } from "node:test";
import type { WorkspaceId } from "@deepseek-ai/dsh-api-workspace-controller/types";
import { canReorderWorkspaces } from "../src/client/rows/workspace-reorder.ts";
import {
  computeWorkspaceParents,
  partitionRootWorkspaceGroups,
  resolveWorkspaceSectionOwners,
} from "../src/client/rows/workspace-sections.ts";
import { UNGROUPED_KEY } from "../src/client/tree.ts";

const wid = (id: string) => id as WorkspaceId;

it("places pinned workspaces in pinned order, overrides custom sections, and restores original section or order on unpin", () => {
  const rootGroups = [
    { key: "atlas" },
    { key: "boreal" },
    { key: "compass" },
    { key: "delta" },
    { key: UNGROUPED_KEY },
  ];
  const nativeSections = [{ id: "design", workspaceIds: [wid("compass")] }];

  // Initial: Atlas pinned from Desktop; Compass in Design; Boreal & Delta in Workspaces.
  const initialPinned = ["atlas"];
  const initialOwners = resolveWorkspaceSectionOwners(nativeSections, new Set(initialPinned));
  const initial = partitionRootWorkspaceGroups(
    rootGroups,
    nativeSections,
    initialPinned,
    initialOwners.sectionOf,
  );
  assert.deepEqual(
    initial.pinnedGroups.map((g) => g.key),
    ["atlas"],
  );
  assert.deepEqual(
    initial.sectionRoots.get("design")?.map((g) => g.key),
    ["compass"],
  );
  assert.deepEqual(
    initial.workspaceRoots.map((g) => g.key),
    ["boreal", "delta"],
  );

  // Pinning Compass (from Design) and Boreal (from Workspaces) puts newest Web pin first in Pinned.
  const pinnedBoth = ["compass", "boreal", "atlas"];
  const bothOwners = resolveWorkspaceSectionOwners(nativeSections, new Set(pinnedBoth));
  const both = partitionRootWorkspaceGroups(
    rootGroups,
    nativeSections,
    pinnedBoth,
    bothOwners.sectionOf,
  );
  assert.deepEqual(
    both.pinnedGroups.map((g) => g.key),
    ["compass", "boreal", "atlas"],
  );
  assert.deepEqual(both.sectionRoots.get("design"), []);
  assert.deepEqual(
    both.workspaceRoots.map((g) => g.key),
    ["delta"],
  );
  assert.equal(bothOwners.nativeSectionOf.get("compass"), "design");

  // Unpinning Compass restores it to Design; unpinning Boreal restores its original position before Delta.
  const restoredPinned = ["atlas"];
  const restoredOwners = resolveWorkspaceSectionOwners(nativeSections, new Set(restoredPinned));
  const restored = partitionRootWorkspaceGroups(
    rootGroups,
    nativeSections,
    restoredPinned,
    restoredOwners.sectionOf,
  );
  assert.deepEqual(
    restored.pinnedGroups.map((g) => g.key),
    ["atlas"],
  );
  assert.deepEqual(
    restored.sectionRoots.get("design")?.map((g) => g.key),
    ["compass"],
  );
  assert.deepEqual(
    restored.workspaceRoots.map((g) => g.key),
    ["boreal", "delta"],
  );
});

it("keeps unpinned nested child workspaces attached to a pinned parent and restores a pinned child on unpin", () => {
  const workspaces = [
    { workspaceId: wid("parent"), path: "/repo" },
    { workspaceId: wid("child"), path: "/repo/packages/app" },
    { workspaceId: wid("sibling"), path: "/other" },
  ];
  const nativeSections = [{ id: "design", workspaceIds: [wid("parent"), wid("child")] }];

  // Pinning parent makes parent a top-level pinned root while child stays nested under parent.
  const parentPinned = new Set(["parent"]);
  const { nativeSectionOf, sectionOf } = resolveWorkspaceSectionOwners(
    nativeSections,
    parentPinned,
  );
  const parentsWithParentPinned = computeWorkspaceParents(
    workspaces,
    true,
    nativeSectionOf,
    parentPinned,
  );
  assert.equal(parentsWithParentPinned.get("parent"), undefined);
  assert.equal(parentsWithParentPinned.get("child"), wid("parent"));
  assert.equal(parentsWithParentPinned.get("sibling"), undefined);

  // Drag reorder between pinned workspace and unpinned workspace is blocked.
  assert.equal(
    canReorderWorkspaces(workspaces, "parent", "sibling", {
      sectionOf,
      parents: parentsWithParentPinned,
    }),
    false,
  );

  // Pinning child promotes child to a top-level pinned root; unpinning returns child under parent.
  const childPinned = new Set(["child"]);
  const parentsWithChildPinned = computeWorkspaceParents(
    workspaces,
    true,
    nativeSectionOf,
    childPinned,
  );
  assert.equal(parentsWithChildPinned.get("child"), undefined);

  const parentsAfterUnpin = computeWorkspaceParents(workspaces, true, nativeSectionOf, new Set());
  assert.equal(parentsAfterUnpin.get("child"), wid("parent"));
});
