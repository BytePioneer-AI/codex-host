import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceView } from "@deepseek-ai/dsh-api-workspace-controller/client";
import { buildThreadTree, threadAncestors, visibleThreadRows } from "../src/client/thread-tree.ts";
import {
  deriveFlat,
  deriveGroups,
  deriveSearchResults,
  orderByRecency,
  reconcileManualOrder,
  type SessionRowState,
} from "../src/client/tree.ts";
import { threadTreeOrderSource } from "../src/client/thread-tree-order.ts";
import {
  canPlaceThread,
  runningSubagentsInThreadSubtree,
  runningThreadSubtree,
  threadPlacementCandidates,
} from "../src/client/thread-tree-catalog.ts";
import { sidebarWindow } from "../src/client/rows/sidebar-window.ts";
import { createWorkspaceViewStore } from "../src/client/stores.ts";
import { pinOrderSource } from "../src/client/pin-order.ts";

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
      running: false,
      pendingInteraction: "approval",
      completed: true,
    },
  ];
  const before = structuredClone(source);
  const roots = buildThreadTree(source, (row) => row.parent);
  assert.equal(roots.length, 1);
  const root = roots[0];
  assert.ok(root);
  assert.deepEqual(root.tree.descendantIds, ["b", "c"]);
  assert.equal(root.tree.descendantCount, 2);
  assert.equal(root.tree.updatedAt, 10);
  assert.deepEqual(root.tree.activity, {
    running: true,
    pendingInteraction: true,
    completed: true,
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

it("puts a cross-workspace subtree only in its root workspace and ignores the child's shared pin", () => {
  const list = catalog(row("a"), row("b", "a"), row("c", "b"));
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
  assert.deepEqual(groups[0]?.sessions[0]?.tree?.descendantIds, ["b", "c"]);
  assert.equal(groups[0]?.sessions[0]?.tree?.children[0]?.pinned, false);
  assert.equal(deriveFlat(list, rowState.pinnedSessionIds, rowState, new Map()).length, 0);
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
  assert.equal(roots.at(-1)?.tree?.activity.pendingInteraction, true);
  assert.equal(sidebarWindow(roots, 2).rows.at(-1)?.id, "root7");
  roots = deriveFlat(
    list,
    list.ids,
    state,
    new Map([
      [id("running"), { running: false, completionUnread: true, pendingInteraction: undefined }],
    ]),
  );
  assert.equal(roots.at(-1)?.tree?.activity.completed, true);
  assert.equal(sidebarWindow(roots, 2, "running").rows.at(-1)?.id, "root7");
  assert.equal(sidebarWindow(roots, 2, undefined, "running").rows.at(-1)?.id, "root7");
  assert.equal(sidebarWindow(roots, 2).rows.length, 2);
});

it("retains arbitrary depth with explicit expansion and cycle-safe ancestor navigation", () => {
  const list = catalog(...Array.from({ length: 12 }, (_, i) => row(`${i}`, i ? `${i - 1}` : null)));
  const roots = deriveFlat(list, list.ids, state, new Map());
  assert.equal(visibleThreadRows(roots, {}).length, 1);
  const expansion = Object.fromEntries(list.ids.map((id) => [id, true]));
  const visible = visibleThreadRows(roots, expansion);
  assert.equal(visible.length, 12);
  assert.equal(visible.at(-1)?.tree?.depth, 11);
  assert.deepEqual(
    threadAncestors("c", (id) => ({ c: "b", b: "a", a: "b" })[id]),
    ["b", "a"],
  );
});

it("keeps remote sessions flat and excludes them from placement", () => {
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
  assert.equal(canPlaceThread(remote), false);
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

it("filters placement by host, archive, submission, native Subagent and all descendant levels; searches title and folder", () => {
  const list = catalog(
    row("source"),
    row("child", "source"),
    row("grandchild", "child"),
    row("target"),
    { ...row("folder"), cwd: "/project" },
    row("archived"),
    { ...row("draft"), blank: true },
    { ...row("native"), origin: "subagent" },
    {
      ...row("remote"),
      projectionValues: { remoteHost: { hostId: "r", displayName: "R", state: "connected" } },
    },
    {
      ...row("foreign"),
      projectionValues: { threadTreeParent: null, threadReference: { hostId: "foreign" } },
    },
  );
  assert.deepEqual(
    threadPlacementCandidates(list, "source", ["archived"], "").map((node) => node.id),
    ["folder", "target"],
  );
  assert.deepEqual(
    threadPlacementCandidates(list, "source", ["archived"], "TARGET").map((node) => node.id),
    ["target"],
  );
  assert.deepEqual(
    threadPlacementCandidates(list, "source", ["archived"], "project").map((node) => node.id),
    ["folder"],
  );
  assert.deepEqual(threadPlacementCandidates(list, "remote", [], ""), []);
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
