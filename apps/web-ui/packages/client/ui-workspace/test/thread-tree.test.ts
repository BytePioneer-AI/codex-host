import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceView } from "@deepseek-ai/dsh-api-workspace-controller/client";
import { buildThreadTree, visibleThreadRows } from "../src/client/thread-tree.ts";
import {
  deriveFlat,
  deriveGroups,
  deriveSearchResults,
  orderByRecency,
  reconcileManualOrder,
  type SessionRowState,
} from "../src/client/tree.ts";
import { threadTreeOrderSource, workspaceTreeMembers } from "../src/client/thread-tree-order.ts";
import {
  archiveCandidates,
  isLocalThreadTreeMember,
  runningSubagentsInThreadSubtree,
  runningThreadSubtree,
} from "../src/client/thread-tree-catalog.ts";
import { sidebarWindow } from "../src/client/rows/sidebar-window.ts";
import { createWorkspaceViewStore } from "../src/client/stores.ts";
import { pinOrderAccounts, pinOrderSource } from "../src/client/pin-order.ts";

const id = SessionId;
function row(key: string, parent: string | null = null, updatedAt = 1): SessionSummary {
  return {
    id: id(key),
    title: key,
    displayTitle: key,
    running: false,
    blank: false,
    retainedBy: {},
    updatedAt,
    projectionValues: { threadTreeParent: parent, threadReference: { hostId: "local" } },
  };
}
function catalog(...rows: SessionSummary[]): SessionListState {
  return {
    ids: rows.map((row) => row.id),
    byId: Object.fromEntries(rows.map((row) => [row.id, row])),
    phase: "ready",
    projectionsBySession: {},
  };
}
function workspace(key: string, ...ids: string[]): WorkspaceView {
  return {
    workspaceId: key as WorkspaceView["workspaceId"],
    path: `/${key}`,
    title: key,
    sessionIds: ids.map(id),
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}
const state: SessionRowState = {
  pinnedSessionIds: [],
  archivedSessionIds: [],
  archivedFilter: "default",
};

it("builds a three-layer tree with descendant IDs, depth, recency and all activity kinds", () => {
  const source = [
    { id: "a", parent: null, updatedAt: 1, running: false, completed: false },
    { id: "b", parent: "a", updatedAt: 3, running: true, completed: false },
    {
      id: "c",
      parent: "b",
      updatedAt: 10,
      running: true,
      pendingInteraction: "approval",
      completed: true,
    },
  ];
  // Repeated catalog entries must not inflate either descendants or activity.
  source.push({ id: "b", parent: "a", updatedAt: 3, running: true, completed: false });
  const before = structuredClone(source);
  const roots = buildThreadTree(source, (row) => row.parent);
  assert.equal(roots.length, 1);
  const root = roots[0];
  assert.ok(root);
  assert.deepEqual(root.tree.descendantIds, ["b", "c"]);
  assert.equal(root.tree.descendantCount, 2);
  assert.equal(root.tree.updatedAt, 10);
  assert.deepEqual(root.tree.activity, {
    running: 2,
    pendingInteraction: 1,
    completed: 1,
  });
  assert.equal(root.tree.children[0]?.tree.depth, 1);
  assert.equal(root.tree.children[0]?.tree.children[0]?.tree.depth, 2);
  assert.deepEqual(source, before);
});

it("promotes orphans, invisible parents, self-links and every cycle member without losing rows", () => {
  const list = catalog(
    row("a", "b"),
    row("b", "a"),
    row("c", "a"),
    row("self", "self"),
    row("orphan", "missing"),
  );
  const roots = deriveFlat(list, list.ids, state, new Map());
  assert.deepEqual(
    roots.map((node) => node.id),
    ["a", "b", "self", "orphan"],
  );
  assert.deepEqual(roots[0]?.tree?.descendantIds, ["c"]);
  assert.deepEqual(
    visibleThreadRows(roots, { a: true })
      .map((node) => node.id)
      .sort(),
    list.ids.toSorted(),
  );
  for (const parent of [
    { ...row("p"), blank: true },
    { ...row("p"), origin: "subagent" as const },
  ]) {
    const hidden = catalog(parent, row("child", "p"));
    assert.deepEqual(
      deriveFlat(hidden, hidden.ids, state, new Map()).map((node) => node.id),
      ["child"],
    );
  }
  const archived = catalog(row("p"), row("child", "p"));
  assert.deepEqual(
    deriveFlat(archived, archived.ids, { ...state, archivedSessionIds: [id("p")] }, new Map()).map(
      (node) => node.id,
    ),
    ["child"],
  );
});

it("places a promoted child's subtree in pins using Host parents, outside the original parent's group", () => {
  const list = catalog(row("a", null, 1), row("b", null, 2), row("c", "b", 10));
  const rowState = { ...state, pinnedSessionIds: [id("b")] };
  const groups = deriveGroups(
    list,
    [workspace("x", "a"), workspace("y", "b", "c")],
    rowState,
    new Map(),
    { expandedGroups: ["x", "y"], excludePinned: true },
  );
  assert.deepEqual(
    groups[0]?.sessions.map((node) => node.id),
    ["a"],
  );
  assert.equal(groups[1]?.sessions.length, 0);
  assert.deepEqual(groups[0]?.sessions[0]?.tree?.descendantIds, []);
  assert.equal(groups[0]?.sessions[0]?.tree?.updatedAt, 1);
  const pins = deriveFlat(list, rowState.pinnedSessionIds, rowState, new Map());
  assert.equal(pins[0]?.pinned, true);
  assert.deepEqual(pins[0]?.tree?.descendantIds, ["c"]);
  assert.equal(pins[0]?.tree?.updatedAt, 10);
  assert.deepEqual(pinOrderSource([workspace("y", "b", "c")], list, rowState).members.y, ["b"]);
  assert.deepEqual(rowState.pinnedSessionIds, ["b"]);
});

it("pins a whole subtree once, outside ordinary workspace and flat roots", () => {
  const list = catalog(row("a"), row("b", "a"), row("other"));
  const rowState = { ...state, pinnedSessionIds: [id("a")] };
  const pins = deriveFlat(list, rowState.pinnedSessionIds, rowState, new Map());
  assert.equal(pins[0]?.pinned, true);
  assert.deepEqual(pins[0]?.tree?.descendantIds, ["b"]);
  const groups = deriveGroups(list, [workspace("x", "a", "b", "other")], rowState, new Map(), {
    expandedGroups: ["x"],
    excludePinned: true,
  });
  assert.deepEqual(
    groups[0]?.sessions.map((node) => node.id),
    ["other"],
  );
});

it("also shows a tree, once, in the Workspace of a child whose root lives elsewhere", () => {
  const list = catalog(
    row("root", null, 1),
    row("child", "root", 5),
    row("grandchild", "child", 6),
    row("other", null, 2),
  );
  const order = threadTreeOrderSource(list, state);
  const own = workspaceTreeMembers([id("root")], order);
  const elsewhere = workspaceTreeMembers([id("child"), id("grandchild"), id("other")], order);
  assert.deepEqual(own.memberIds, ["root"]);
  assert.equal(own.linkedRootIds.size, 0);
  assert.deepEqual(elsewhere.memberIds, ["root", "other"]);
  assert.deepEqual([...elsewhere.linkedRootIds], ["root"]);
  // A tree that stays in one Workspace keeps its single root row there.
  assert.deepEqual(workspaceTreeMembers([id("root"), id("child")], order).memberIds, ["root"]);
  const groups = deriveGroups(
    list,
    [workspace("x", ...own.memberIds), workspace("y", ...elsewhere.memberIds)],
    state,
    new Map(),
    { expandedGroups: ["x", "y"] },
  );
  assert.deepEqual(
    groups[1]?.sessions.map((node) => node.id),
    ["root", "other"],
  );
  for (const group of groups.slice(0, 2))
    assert.deepEqual(group.sessions[0]?.tree?.descendantIds, ["child", "grandchild"]);

  const sectioned = { ...state, sectionedSessionIds: new Set([id("root")]) };
  const ordinaryGroups = deriveGroups(
    list,
    [workspace("x", ...own.memberIds), workspace("y", ...elsewhere.memberIds)],
    sectioned,
    new Map(),
    { expandedGroups: ["x", "y"], excludePinned: true },
  );
  assert.deepEqual(ordinaryGroups.find((group) => group.key === "x")?.sessions, []);
  assert.deepEqual(
    ordinaryGroups.find((group) => group.key === "y")?.sessions.map((node) => node.id),
    ["other"],
  );
  assert.deepEqual(deriveFlat(list, [id("root")], sectioned, new Map())[0]?.tree?.descendantIds, [
    "child",
    "grandchild",
  ]);
});

it("keeps a linked root's manual slot when an unrelated Thread is pinned", () => {
  const list = catalog(row("p", null, 1), row("c", "p", 5), row("x", null, 3), row("y", null, 2));
  const workspaces = [workspace("a", "p", "y"), workspace("b", "c", "x")];
  const view = createWorkspaceViewStore().create();
  view.actions.setSessionOrder(
    "b",
    [id("p"), id("x")],
    {},
    pinOrderSource(workspaces, list, state),
  );
  const pinned = { ...state, pinnedSessionIds: [id("y")] };
  view.actions.pinSessionOrder(
    id("y"),
    pinOrderAccounts(workspaces, id("y")),
    pinOrderSource(workspaces, list, pinned),
  );
  assert.deepEqual(view.getSnapshot().sessionOrderByAccount.b, ["p", "x"]);
  assert.deepEqual(view.getSnapshot().sessionOrderByAccount.a?.[0], "y");
});

it("uses subtree recency for roots but own recency for children, and reconciles only root manual slots", () => {
  const list = catalog(
    row("a", null, 1),
    row("b", "a", 5),
    row("c", "a", 7),
    row("grandchild", "b", 100),
    row("z", null, 10),
  );
  const order = threadTreeOrderSource(list, state);
  const members = list.ids.filter((id) => order.rootIds.has(id));
  assert.deepEqual(members, ["a", "z"]);
  assert.deepEqual(orderByRecency(members, order.summaries), ["a", "z"]);
  const manual = reconcileManualOrder(members, ["b", "z", "c", "a"], order.summaries, state);
  assert.deepEqual(manual, ["z", "a"]);
  const roots = deriveFlat(list, manual, state, new Map());
  assert.deepEqual(
    roots[1]?.tree?.children.map((node) => node.id),
    ["c", "b"],
  );
  const recent = deriveGroups(list, [], state, new Map(), { expandedGroups: [""] });
  assert.deepEqual(
    recent[0]?.sessions.map((node) => node.id),
    ["a", "z"],
  );
});

it("keeps roots outside the window for running, pending or selected descendants, but not unread completion alone", () => {
  const list = catalog(...Array.from({ length: 8 }, (_, i) => row(`root${i}`)), {
    ...row("running", "root7"),
    running: true,
  });
  let roots = deriveFlat(list, list.ids, state, new Map());
  assert.deepEqual(
    sidebarWindow(roots, 2).rows.map((node) => node.id),
    ["root0", "root1", "root7"],
  );
  list.byId[id("running")] = row("running", "root7");
  roots = deriveFlat(
    list,
    list.ids,
    state,
    new Map([
      [
        id("running"),
        {
          running: false,
          completionUnread: true,
          pendingInteraction: { kind: "question", key: "q", sessionId: id("running") },
        },
      ],
    ]),
  );
  assert.equal(roots.at(-1)?.tree?.activity.pendingInteraction, 1);
  assert.equal(sidebarWindow(roots, 2).rows.at(-1)?.id, "root7");
  roots = deriveFlat(
    list,
    list.ids,
    state,
    new Map([
      [id("running"), { running: false, completionUnread: true, pendingInteraction: undefined }],
    ]),
  );
  assert.equal(roots.at(-1)?.tree?.activity.completed, 1);
  assert.equal(sidebarWindow(roots, 2, "running").rows.at(-1)?.id, "root7");
  assert.equal(sidebarWindow(roots, 2, undefined, "running").rows.at(-1)?.id, "root7");
  assert.equal(sidebarWindow(roots, 2).rows.length, 2);
});

it("retains arbitrary depth with explicit expansion", () => {
  const list = catalog(...Array.from({ length: 12 }, (_, i) => row(`${i}`, i ? `${i - 1}` : null)));
  const roots = deriveFlat(list, list.ids, state, new Map());
  assert.equal(visibleThreadRows(roots, {}).length, 1);
  const expansion = Object.fromEntries(list.ids.map((id) => [id, true]));
  const visible = visibleThreadRows(roots, expansion);
  assert.equal(visible.length, 12);
  assert.equal(visible.at(-1)?.tree?.depth, 11);
});

it("keeps remote sessions flat and outside the local delegation tree", () => {
  const remote = {
    ...row("remote", "a"),
    projectionValues: {
      remoteHost: { hostId: "other", displayName: "Other", state: "connected" },
      threadTreeParent: "a",
    },
  };
  const list = catalog(row("a"), remote);
  assert.deepEqual(
    deriveFlat(list, list.ids, state, new Map()).map((node) => node.id),
    ["a", "remote"],
  );
  assert.equal(isLocalThreadTreeMember(remote), false);
  const crossHost = catalog(remote, row("local", "remote"));
  assert.deepEqual(
    deriveFlat(crossHost, crossHost.ids, state, new Map()).map((node) => node.id),
    ["remote", "local"],
  );
});

it("keeps search flat and supplies the display-parent title without using native lineage", () => {
  const list = catalog(row("parent"), { ...row("match", "parent"), parentId: id("unrelated") });
  const result = deriveSearchResults(
    list,
    [],
    "match",
    [],
    "default",
    new Map(),
    { items: [], hasMore: false },
    10,
  );
  assert.deepEqual(
    result.items.map((node) => [node.id, node.parentTitle]),
    [["match", "parent"]],
  );
});

it("lists running threads at every descendant level for archive confirmation", () => {
  const list = catalog(
    row("a"),
    { ...row("b", "a"), running: true },
    { ...row("c", "b"), running: true },
    { ...row("unrelated"), running: true },
  );
  assert.deepEqual(
    runningThreadSubtree(list, "a").map((row) => row.id),
    ["b", "c"],
  );
  assert.deepEqual(
    runningThreadSubtree(list, "c").map((row) => row.id),
    ["c"],
  );
});

it("preserves native Subagent confirmation lines across the whole display subtree", () => {
  const list = catalog(row("a"), row("b", "a"), {
    ...row("native"),
    origin: "subagent",
    running: true,
  });
  const snapshot = {
    state: "ready" as const,
    error: null,
    values: {
      subagentCatalog: [
        { id: id("native"), mode: "unknown" as const, createdAt: 1, label: "Worker" },
      ],
    },
  };
  list.projectionsBySession = { [id("b")]: snapshot };
  assert.deepEqual(runningSubagentsInThreadSubtree(list, "a"), [{ id: "native", label: "Worker" }]);
});

it("keeps hidden and undiscovered order slots without letting visible children into manual accounts", () => {
  const list = catalog(row("a"), row("child", "a"), row("archive"));
  const onlyArchived = {
    ...state,
    archivedSessionIds: [id("archive")],
    archivedFilter: "only" as const,
  };
  const archiveOrder = threadTreeOrderSource(list, onlyArchived);
  assert.ok(archiveOrder.rootIds.has(id("a")));
  const source = pinOrderSource([workspace("x", "a", "child", "unloaded")], list, state);
  assert.deepEqual(source.members.x, ["a", "unloaded"]);
});

it("defaults Thread folds to collapsed and keeps Thread and Workspace folds independent", () => {
  const view = createWorkspaceViewStore().create();
  assert.deepEqual(view.getSnapshot().threadExpansion, {});
  view.actions.setThreadsExpanded(["a", "b"], true);
  view.actions.setGroupExpanded("a", false);
  assert.equal(view.getSnapshot().threadExpansion?.a, true);
  view.actions.setThreadsExpanded(["a"], false);
  assert.equal(view.getSnapshot().threadExpansion?.a, false);
  assert.equal(view.getSnapshot().threadExpansion?.b, true);
});

it("captures all unarchived local descendants when the tree is collapsed or search only shows the parent", () => {
  const fork = row("fork");
  const pinnedFork = row("pinned-fork");
  const remote = row("remote", "root");
  const list = catalog(
    row("root"),
    row("fold", "root"),
    row("hidden", "fold"),
    row("archived", "root"),
    { ...fork, projectionValues: { ...fork.projectionValues, archiveForkParent: "fold" } },
    row("fork-child", "fork"),
    {
      ...pinnedFork,
      projectionValues: { ...pinnedFork.projectionValues, archiveForkParent: null },
    },
    row("pinned-fork-child", "pinned-fork"),
    row("pinned-delegation"),
    row("pinned-delegation-child", "pinned-delegation"),
    { ...row("subagent", "root"), origin: "subagent" },
    {
      ...remote,
      projectionValues: {
        ...remote.projectionValues,
        remoteHost: { hostId: "other", displayName: "Other", state: "ready" },
      },
    },
  );
  const rowState = {
    ...state,
    pinnedSessionIds: [id("pinned-fork"), id("pinned-delegation")],
    archivedSessionIds: [id("archived")],
    sectionedSessionIds: new Set([id("fork")]),
  };
  const collapsed = visibleThreadRows(deriveFlat(list, list.ids, rowState, new Map()), {});
  assert.ok(!collapsed.some((node) => node.id === id("hidden")));
  const search = deriveSearchResults(
    list,
    [],
    "root",
    rowState.archivedSessionIds,
    "default",
    new Map(),
    { items: [], hasMore: false },
    10,
  );
  assert.deepEqual(
    search.items.map((node) => node.id),
    [id("root")],
  );
  const [parent] = search.items;
  assert.ok(parent);
  const selection = archiveCandidates(list, parent.id, new Set(rowState.archivedSessionIds));
  assert.deepEqual(
    selection.map(({ id, title }) => [id, title]).sort(),
    ["fold", "fork", "fork-child", "hidden"].map((key) => [id(key), key]),
  );
});
