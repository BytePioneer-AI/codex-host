import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceId, WorkspaceView } from "@deepseek-ai/dsh-api-workspace-controller/client";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { deriveFlat, deriveGroups, type SessionRowState } from "../src/client/tree.ts";
import { threadTreeOrderSource, workspaceTreeMembers } from "../src/client/thread-tree-order.ts";
import {
  DEFAULT_HOST_SCOPE_FILTER_STATE,
  HOST_SCOPE_FILTER_STORAGE_KEY,
  countSelectedWorkspacesForHost,
  deriveAvailableHosts,
  ensureWorkspaceVisibleInHostScope,
  filterSessionsByHostScope,
  filterWorkspacesByHostScope,
  hasRemotePeerWorkspaces,
  hasRemoteWorkspaces,
  isHostScopeFiltered,
  loadHostScopeFilter,
  parseHostScopeFilter,
  pruneUnavailableHostScopeFilter,
  reconcileHostScopeFilter,
  resetHostScopeFilter,
  saveHostScopeFilter,
  setHostSelectedWorkspaceIds,
  setHostWorkspaceScopeMode,
  toggleHostWorkspaceSelection,
  type HostScopeFilterState,
} from "../src/client/rows/host-scope-filter.ts";

function makeWorkspace(input: {
  id: string;
  title?: string;
  path?: string;
  sessionIds?: string[];
  remote?: { hostId: string; displayName: string; state: string; color?: string };
}): WorkspaceView {
  return {
    workspaceId: input.id as WorkspaceId,
    title: input.title ?? input.id,
    path: input.path ?? `/work/${input.id}`,
    sessionIds: (input.sessionIds ?? []) as SessionId[],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(input.remote ? { remote: input.remote } : {}),
  };
}

const sampleWorkspaces = (): WorkspaceView[] => [
  makeWorkspace({ id: "ws-local-1", title: "local-a", sessionIds: ["s-local-1", "s-local-2"] }),
  makeWorkspace({
    id: "ws-us-1",
    title: "us-api",
    sessionIds: ["s-us-1"],
    remote: {
      hostId: "remote-peer:us-vps",
      displayName: "美VPS",
      state: "connected",
      color: "purple",
    },
  }),
  makeWorkspace({ id: "ws-local-2", title: "local-b", sessionIds: ["s-local-3"] }),
  makeWorkspace({
    id: "ws-us-2",
    title: "us-web",
    sessionIds: ["s-us-2"],
    remote: {
      hostId: "remote-peer:us-vps",
      displayName: "美VPS",
      state: "connected",
      color: "purple",
    },
  }),
  makeWorkspace({
    id: "ws-jp-1",
    title: "jp-worker",
    sessionIds: ["s-jp-1"],
    remote: { hostId: "remote-peer:jp-box", displayName: "日VPS", state: "disconnected" },
  }),
];

describe("deriveAvailableHosts", () => {
  it("returns empty list when there are no workspaces", () => {
    assert.deepEqual(deriveAvailableHosts([]), []);
    assert.equal(hasRemoteWorkspaces([]), false);
    assert.equal(hasRemotePeerWorkspaces([]), false);
  });

  it("derives local plus unique remote hosts in stable appearance order", () => {
    const workspaces = sampleWorkspaces();
    const hosts = deriveAvailableHosts(workspaces);
    assert.deepEqual(
      hosts.map((host) => ({
        key: host.key,
        hostId: host.hostId,
        displayName: host.displayName,
        state: host.state,
        color: host.color,
        workspaceCount: host.workspaceCount,
        workspaceIds: host.workspaces.map((w) => w.workspaceId),
      })),
      [
        {
          key: "local",
          hostId: undefined,
          displayName: undefined,
          state: undefined,
          color: undefined,
          workspaceCount: 2,
          workspaceIds: ["ws-local-1", "ws-local-2"],
        },
        {
          key: "remote-peer:us-vps",
          hostId: "remote-peer:us-vps",
          displayName: "美VPS",
          state: "connected",
          color: "purple",
          workspaceCount: 2,
          workspaceIds: ["ws-us-1", "ws-us-2"],
        },
        {
          key: "remote-peer:jp-box",
          hostId: "remote-peer:jp-box",
          displayName: "日VPS",
          state: "disconnected",
          color: undefined,
          workspaceCount: 1,
          workspaceIds: ["ws-jp-1"],
        },
      ],
    );
    assert.equal(hasRemoteWorkspaces(workspaces), true);
    assert.equal(hasRemotePeerWorkspaces(workspaces), true);
  });

  it("includes local even when only remote workspaces exist", () => {
    const remoteOnly = [
      makeWorkspace({
        id: "ws-r1",
        remote: { hostId: "ssh:dev", displayName: "Dev", state: "connecting" },
      }),
    ];
    const hosts = deriveAvailableHosts(remoteOnly);
    assert.equal(hosts.length, 2);
    assert.equal(hosts[0]?.key, "local");
    assert.equal(hosts[0]?.workspaceCount, 0);
    assert.equal(hosts[1]?.key, "ssh:dev");
    assert.equal(hasRemoteWorkspaces(remoteOnly), true);
    assert.equal(hasRemotePeerWorkspaces(remoteOnly), false);
  });
});

describe("filterWorkspacesByHostScope", () => {
  it("returns all workspaces when unfiltered", () => {
    const workspaces = sampleWorkspaces();
    assert.equal(isHostScopeFiltered(DEFAULT_HOST_SCOPE_FILTER_STATE, workspaces), false);
    assert.deepEqual(
      filterWorkspacesByHostScope(workspaces, DEFAULT_HOST_SCOPE_FILTER_STATE).map(
        (w) => w.workspaceId,
      ),
      ["ws-local-1", "ws-us-1", "ws-local-2", "ws-us-2", "ws-jp-1"],
    );
  });

  it("filters to local workspaces only", () => {
    const workspaces = sampleWorkspaces();
    const state: HostScopeFilterState = { selectedHost: "local", perHost: {} };
    assert.equal(isHostScopeFiltered(state, workspaces), true);
    assert.deepEqual(
      filterWorkspacesByHostScope(workspaces, state).map((w) => w.workspaceId),
      ["ws-local-1", "ws-local-2"],
    );
  });

  it("filters to a single remote host and respects its selected workspace subset", () => {
    const workspaces = sampleWorkspaces();
    const hostOnly: HostScopeFilterState = {
      selectedHost: "remote-peer:us-vps",
      perHost: {},
    };
    assert.deepEqual(
      filterWorkspacesByHostScope(workspaces, hostOnly).map((w) => w.workspaceId),
      ["ws-us-1", "ws-us-2"],
    );

    const subset: HostScopeFilterState = {
      selectedHost: "remote-peer:us-vps",
      perHost: {
        "remote-peer:us-vps": { mode: "selected", workspaceIds: ["ws-us-2"] },
      },
    };
    assert.deepEqual(
      filterWorkspacesByHostScope(workspaces, subset).map((w) => w.workspaceId),
      ["ws-us-2"],
    );
  });

  it("applies per-host workspace subsets while selectedHost is all", () => {
    const workspaces = sampleWorkspaces();
    const state: HostScopeFilterState = {
      selectedHost: "all",
      perHost: {
        local: { mode: "selected", workspaceIds: ["ws-local-1"] },
        "remote-peer:us-vps": { mode: "selected", workspaceIds: ["ws-us-1"] },
      },
    };
    assert.equal(isHostScopeFiltered(state, workspaces), true);
    assert.deepEqual(
      filterWorkspacesByHostScope(workspaces, state).map((w) => w.workspaceId),
      ["ws-local-1", "ws-us-1", "ws-jp-1"],
    );
  });

  it("returns empty list when all workspaces on the selected host are unchecked", () => {
    const workspaces = sampleWorkspaces();
    const state: HostScopeFilterState = {
      selectedHost: "remote-peer:us-vps",
      perHost: {
        "remote-peer:us-vps": { mode: "selected", workspaceIds: [] },
      },
    };
    assert.deepEqual(filterWorkspacesByHostScope(workspaces, state), []);
  });
});

describe("filterSessionsByHostScope", () => {
  const allSessions = [
    { id: "s-local-1" },
    { id: "s-local-2" },
    { id: "s-local-3" },
    { id: "s-us-1", remote: { hostId: "remote-peer:us-vps" } },
    { id: "s-us-2", remote: { hostId: "remote-peer:us-vps" } },
    { id: "s-jp-1", remote: { hostId: "remote-peer:jp-box" } },
    { id: "s-ungrouped-local" },
    { id: "s-ungrouped-remote", remote: { hostId: "remote-peer:us-vps" } },
  ];

  it("returns all sessions unchanged when unfiltered", () => {
    const workspaces = sampleWorkspaces();
    const visibleIds = new Set(workspaces.map((w) => w.workspaceId));
    assert.deepEqual(
      filterSessionsByHostScope(
        allSessions,
        visibleIds,
        workspaces,
        DEFAULT_HOST_SCOPE_FILTER_STATE,
      ),
      allSessions,
    );
  });

  it("keeps ungrouped local sessions when local is included in all mode", () => {
    const workspaces = sampleWorkspaces();
    const state: HostScopeFilterState = { selectedHost: "local", perHost: {} };
    const visible = filterWorkspacesByHostScope(workspaces, state);
    const result = filterSessionsByHostScope(
      allSessions,
      new Set(visible.map((w) => w.workspaceId)),
      workspaces,
      state,
    );
    assert.deepEqual(
      result.map((s) => s.id),
      ["s-local-1", "s-local-2", "s-local-3", "s-ungrouped-local"],
    );
  });

  it("excludes ungrouped local sessions when local is in selected-workspaces mode", () => {
    const workspaces = sampleWorkspaces();
    const state: HostScopeFilterState = {
      selectedHost: "local",
      perHost: {
        local: { mode: "selected", workspaceIds: ["ws-local-1"] },
      },
    };
    const visible = filterWorkspacesByHostScope(workspaces, state);
    const result = filterSessionsByHostScope(
      allSessions,
      new Set(visible.map((w) => w.workspaceId)),
      workspaces,
      state,
    );
    assert.deepEqual(
      result.map((s) => s.id),
      ["s-local-1", "s-local-2"],
    );
  });

  it("excludes ungrouped local sessions when filtering to a remote host", () => {
    const workspaces = sampleWorkspaces();
    const state: HostScopeFilterState = {
      selectedHost: "remote-peer:us-vps",
      perHost: {
        "remote-peer:us-vps": { mode: "selected", workspaceIds: ["ws-us-1"] },
      },
    };
    const visible = filterWorkspacesByHostScope(workspaces, state);
    const result = filterSessionsByHostScope(
      allSessions.map((s) => s.id),
      visible.map((w) => w.workspaceId),
      workspaces,
      state,
    );
    assert.deepEqual(result, ["s-us-1"]);
  });
});

describe("reconcileHostScopeFilter", () => {
  it("falls back to all when the selected remote host disappears while preserving perHost config", () => {
    const workspacesWithoutJp = sampleWorkspaces().filter(
      (w) => w.remote?.hostId !== "remote-peer:jp-box",
    );
    const saved: HostScopeFilterState = {
      selectedHost: "remote-peer:jp-box",
      perHost: {
        "remote-peer:jp-box": { mode: "selected", workspaceIds: ["ws-jp-1"] },
      },
    };

    const reconciled = reconcileHostScopeFilter(saved, workspacesWithoutJp);
    assert.equal(reconciled.selectedHost, "all");
    assert.deepEqual(reconciled.perHost, saved.perHost);
    // Disappeared host's saved subset must not mark the effective view as filtered.
    assert.equal(isHostScopeFiltered(saved, workspacesWithoutJp), false);
    assert.equal(
      filterWorkspacesByHostScope(workspacesWithoutJp, saved).length,
      workspacesWithoutJp.length,
    );
  });

  it("keeps selectedHost when the host still exists", () => {
    const workspaces = sampleWorkspaces();
    const state: HostScopeFilterState = { selectedHost: "remote-peer:us-vps", perHost: {} };
    assert.strictEqual(reconcileHostScopeFilter(state, workspaces), state);
  });
});

describe("pruneUnavailableHostScopeFilter", () => {
  it("resets disappeared remote selectedHost to all and drops its stale perHost entry", () => {
    const workspacesWithoutJp = sampleWorkspaces().filter(
      (w) => w.remote?.hostId !== "remote-peer:jp-box",
    );
    const saved: HostScopeFilterState = {
      selectedHost: "remote-peer:jp-box",
      perHost: {
        "remote-peer:jp-box": { mode: "selected", workspaceIds: ["ws-jp-1"] },
        "remote-peer:us-vps": { mode: "selected", workspaceIds: ["ws-us-1", "ws-us-deleted"] },
      },
    };

    const pruned = pruneUnavailableHostScopeFilter(saved, workspacesWithoutJp);
    assert.deepEqual(pruned, {
      selectedHost: "all",
      perHost: {
        "remote-peer:us-vps": { mode: "selected", workspaceIds: ["ws-us-1"] },
      },
    });
  });

  it("keeps the same reference when selectedHost and workspaceIds are still valid", () => {
    const workspaces = sampleWorkspaces();
    const saved: HostScopeFilterState = {
      selectedHost: "remote-peer:us-vps",
      perHost: {
        "remote-peer:us-vps": { mode: "selected", workspaceIds: ["ws-us-1"] },
      },
    };
    assert.strictEqual(pruneUnavailableHostScopeFilter(saved, workspaces), saved);
  });

  it("preserves local selectedHost even when the loaded workspace list is empty", () => {
    const saved: HostScopeFilterState = {
      selectedHost: "local",
      perHost: {
        local: { mode: "selected", workspaceIds: ["ws-local-stale"] },
        "remote-peer:jp-box": { mode: "selected", workspaceIds: ["ws-jp-1"] },
      },
    };
    assert.deepEqual(pruneUnavailableHostScopeFilter(saved, []), {
      selectedHost: "local",
      perHost: {
        local: { mode: "selected", workspaceIds: [] },
      },
    });
  });

  it("preserves perHost workspace presets for newly added hosts not yet synced into workspaces", () => {
    const workspaces = sampleWorkspaces();
    const saved: HostScopeFilterState = {
      selectedHost: "all",
      perHost: {
        "remote-peer:new-box": {
          mode: "selected",
          workspaceIds: ["remote-workspace:new-a", "remote-workspace:new-b"],
        },
        "remote-peer:gone-box": {
          mode: "selected",
          workspaceIds: ["remote-workspace:gone-1"],
        },
      },
    };

    const pruned = pruneUnavailableHostScopeFilter(saved, workspaces, {
      preserveHostKeys: new Set(["remote-peer:new-box"]),
    });
    assert.deepEqual(pruned, {
      selectedHost: "all",
      perHost: {
        "remote-peer:new-box": {
          mode: "selected",
          workspaceIds: ["remote-workspace:new-a", "remote-workspace:new-b"],
        },
      },
    });
  });

  it("preserves perHost workspaceIds while a remote host is still connecting", () => {
    const workspaces = [
      ...sampleWorkspaces(),
      makeWorkspace({
        id: "remote-workspace:placeholder",
        title: "New Box",
        path: "",
        remote: { hostId: "remote-peer:new-box", displayName: "New Box", state: "connecting" },
      }),
    ];
    const saved: HostScopeFilterState = {
      selectedHost: "all",
      perHost: {
        "remote-peer:new-box": {
          mode: "selected",
          workspaceIds: ["remote-workspace:new-a", "remote-workspace:new-b"],
        },
      },
    };
    assert.strictEqual(pruneUnavailableHostScopeFilter(saved, workspaces), saved);
  });
});

describe("persistence & state mutation helpers", () => {
  it("parses valid storage payloads and falls back safely on corrupt data", () => {
    assert.deepEqual(parseHostScopeFilter(null), resetHostScopeFilter());
    assert.deepEqual(parseHostScopeFilter("{not-valid-json"), resetHostScopeFilter());
    assert.deepEqual(parseHostScopeFilter("[]"), resetHostScopeFilter());

    const raw = JSON.stringify({
      selectedHost: "remote-peer:us-vps",
      perHost: {
        "remote-peer:us-vps": { mode: "selected", workspaceIds: ["ws-1", "ws-1", 42] },
        bad: { mode: "unknown", workspaceIds: ["x"] },
      },
    });
    assert.deepEqual(parseHostScopeFilter(raw), {
      selectedHost: "remote-peer:us-vps",
      perHost: {
        "remote-peer:us-vps": { mode: "selected", workspaceIds: ["ws-1"] },
      },
    });
  });

  it("loads and saves through storage safely even if storage throws", () => {
    const store = new Map<string, string>();
    const memoryStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const state: HostScopeFilterState = {
      selectedHost: "local",
      perHost: { local: { mode: "selected", workspaceIds: ["ws-local-1"] } },
    };
    saveHostScopeFilter(state, memoryStorage);
    assert.ok(store.has(HOST_SCOPE_FILTER_STORAGE_KEY));
    assert.deepEqual(loadHostScopeFilter(memoryStorage), state);

    const brokenStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    assert.doesNotThrow(() => saveHostScopeFilter(state, brokenStorage));
    assert.deepEqual(loadHostScopeFilter(brokenStorage), resetHostScopeFilter());
  });

  it("updates per-host mode, toggles selections, and counts visible selected workspaces", () => {
    const workspaces = sampleWorkspaces();
    const usHost = deriveAvailableHosts(workspaces).find((h) => h.key === "remote-peer:us-vps");
    assert.ok(usHost);

    let state = DEFAULT_HOST_SCOPE_FILTER_STATE;
    state = setHostWorkspaceScopeMode(state, usHost.key, "selected", ["ws-us-1", "ws-us-2"]);
    assert.equal(countSelectedWorkspacesForHost(usHost, state.perHost[usHost.key]), 2);

    state = toggleHostWorkspaceSelection(state, usHost.key, "ws-us-1", ["ws-us-1", "ws-us-2"]);
    assert.deepEqual(state.perHost[usHost.key]?.workspaceIds, ["ws-us-2"]);
    assert.equal(countSelectedWorkspacesForHost(usHost, state.perHost[usHost.key]), 1);

    state = setHostSelectedWorkspaceIds(state, usHost.key, []);
    assert.equal(countSelectedWorkspacesForHost(usHost, state.perHost[usHost.key]), 0);
  });

  it("widens host scope and workspace subset when revealing a cross-host search result", () => {
    const workspaces = sampleWorkspaces();
    const target = workspaces.find((w) => w.workspaceId === "ws-us-2");
    assert.ok(target);

    const narrowed: HostScopeFilterState = {
      selectedHost: "local",
      perHost: {
        "remote-peer:us-vps": { mode: "selected", workspaceIds: ["ws-us-1"] },
      },
    };
    const widened = ensureWorkspaceVisibleInHostScope(narrowed, target, workspaces);
    assert.equal(widened.selectedHost, "all");
    assert.deepEqual(widened.perHost["remote-peer:us-vps"]?.workspaceIds, ["ws-us-1", "ws-us-2"]);

    // Already visible workspace returns the same reference.
    assert.strictEqual(ensureWorkspaceVisibleInHostScope(widened, target, workspaces), widened);
  });
});

describe("host scope filter with delegation thread trees", () => {
  const peerHost = {
    hostId: "remote-peer:us-vps",
    displayName: "美VPS",
    state: "connected",
    color: "purple",
  };
  const rowState: SessionRowState = {
    pinnedSessionIds: [],
    archivedSessionIds: [],
    archivedFilter: "default",
  };

  function makeSummary(input: {
    id: string;
    hostId?: string;
    parent?: string | null;
    running?: boolean;
    updatedAt?: number;
  }): SessionSummary {
    const sid = SessionId(input.id);
    return {
      id: sid,
      title: input.id,
      displayTitle: input.id,
      running: input.running ?? false,
      blank: false,
      retainedBy: {},
      updatedAt: input.updatedAt ?? 100,
      projectionValues: {
        threadTreeParent: input.parent ?? null,
        threadReference: { hostId: input.hostId ?? "local", threadId: input.id },
        ...(input.hostId ? { remoteHost: { ...peerHost, hostId: input.hostId } } : {}),
      },
    };
  }

  function buildScopedView(
    list: SessionListState,
    rawWorkspaces: WorkspaceView[],
    filterState: HostScopeFilterState,
  ) {
    const order = threadTreeOrderSource(list, rowState);
    const orderedWorkspaces = rawWorkspaces.map((workspace) => ({
      ...workspace,
      sessionIds: workspaceTreeMembers(workspace.sessionIds, order).memberIds,
    }));
    const scopedWorkspaces = filterWorkspacesByHostScope(orderedWorkspaces, filterState);
    const visibleWorkspaceIdSet = new Set<string>(scopedWorkspaces.map((w) => w.workspaceId));
    const allowedIds = new Set(
      filterSessionsByHostScope(
        list.ids.map((id) => ({
          id,
          remote: list.byId[id]?.projectionValues?.remoteHost ?? undefined,
        })),
        visibleWorkspaceIdSet,
        orderedWorkspaces,
        filterState,
        order.rootOf,
      ).map((entry) => entry.id),
    );
    const scopedList: SessionListState = {
      ...list,
      ids: list.ids.filter((id) => allowedIds.has(id)),
    };
    return { order, orderedWorkspaces, scopedWorkspaces, scopedList };
  }

  it("retains remote peer delegated children and running counts under single-host and workspace-subset filters", () => {
    const rows = [
      makeSummary({ id: "local-root", updatedAt: 10 }),
      makeSummary({ id: "local-child", parent: "local-root", running: true, updatedAt: 20 }),
      makeSummary({ id: "peer-parent", hostId: peerHost.hostId, updatedAt: 30 }),
      makeSummary({
        id: "peer-child-same",
        hostId: peerHost.hostId,
        parent: "peer-parent",
        running: true,
        updatedAt: 40,
      }),
      makeSummary({
        id: "peer-child-worktree",
        hostId: peerHost.hostId,
        parent: "peer-parent",
        running: false,
        updatedAt: 50,
      }),
      makeSummary({ id: "peer-other-parent", hostId: peerHost.hostId, updatedAt: 15 }),
      makeSummary({
        id: "peer-other-child",
        hostId: peerHost.hostId,
        parent: "peer-other-parent",
        running: true,
        updatedAt: 25,
      }),
    ];
    const list: SessionListState = {
      ids: rows.map((r) => r.id),
      byId: Object.fromEntries(rows.map((r) => [r.id, r])),
      phase: "ready",
      projectionsBySession: {},
    };
    const workspaces = [
      makeWorkspace({ id: "ws-local", sessionIds: ["local-root", "local-child"] }),
      makeWorkspace({
        id: "ws-peer-main",
        sessionIds: ["peer-parent", "peer-child-same"],
        remote: peerHost,
      }),
      makeWorkspace({
        id: "ws-peer-fallback",
        sessionIds: ["peer-child-worktree"],
        remote: peerHost,
      }),
      makeWorkspace({
        id: "ws-peer-other",
        sessionIds: ["peer-other-parent", "peer-other-child"],
        remote: peerHost,
      }),
    ];

    // 1. Filtering to a single remote peer host keeps delegated children and running activity.
    const singleHost = buildScopedView(list, workspaces, {
      selectedHost: peerHost.hostId,
      perHost: {},
    });
    const singleHostGroups = deriveGroups(
      singleHost.scopedList,
      singleHost.scopedWorkspaces,
      rowState,
      new Map(),
      { expandedGroups: ["ws-peer-main", ""] },
    );
    const mainGroup = singleHostGroups.find((g) => g.key === "ws-peer-main");
    const parentNode = mainGroup?.sessions.find((s) => s.id === "peer-parent");
    assert.ok(parentNode, "remote parent must appear in its workspace group");
    assert.equal(parentNode.tree?.descendantCount, 2);
    assert.equal(parentNode.tree?.activity.running, 1);
    assert.deepEqual([...(parentNode.tree?.descendantIds ?? [])].sort(), [
      "peer-child-same",
      "peer-child-worktree",
    ]);

    // 2. Selecting a subset of workspaces on the remote peer while selectedHost="all" keeps
    //    delegated children (including worktree children) of selected roots and hides unselected trees.
    const subsetFilter: HostScopeFilterState = {
      selectedHost: "all",
      perHost: {
        [peerHost.hostId]: { mode: "selected", workspaceIds: ["ws-peer-main"] },
      },
    };
    const subset = buildScopedView(list, workspaces, subsetFilter);
    const flatRoots = deriveFlat(
      subset.scopedList,
      subset.scopedList.ids.filter((id) => subset.order.rootIds.has(id)),
      rowState,
      new Map(),
    );
    const subsetParent = flatRoots.find((n) => n.id === "peer-parent");
    assert.ok(subsetParent);
    assert.equal(subsetParent.tree?.descendantCount, 2);
    assert.equal(subsetParent.tree?.activity.running, 1);
    assert.equal(
      flatRoots.some((n) => n.id === "peer-other-parent" || n.id === "peer-other-child"),
      false,
    );

    // 3. Selecting only the child's workspace (linkedRoot) retains both the linked root and its descendants.
    const linked = buildScopedView(list, workspaces, {
      selectedHost: peerHost.hostId,
      perHost: {
        [peerHost.hostId]: { mode: "selected", workspaceIds: ["ws-peer-fallback"] },
      },
    });
    const linkedGroups = deriveGroups(
      linked.scopedList,
      linked.scopedWorkspaces,
      rowState,
      new Map(),
      { expandedGroups: ["ws-peer-fallback"] },
    );
    const linkedParent = linkedGroups
      .find((g) => g.key === "ws-peer-fallback")
      ?.sessions.find((s) => s.id === "peer-parent");
    assert.ok(linkedParent, "linked root must appear in child's workspace");
    assert.equal(linkedParent.tree?.descendantCount, 2);
    assert.equal(linkedParent.tree?.activity.running, 1);

    // 4. Local workspace subset filter also preserves local delegated children.
    const localSubset = buildScopedView(list, workspaces, {
      selectedHost: "local",
      perHost: {
        local: { mode: "selected", workspaceIds: ["ws-local"] },
      },
    });
    const localGroups = deriveGroups(
      localSubset.scopedList,
      localSubset.scopedWorkspaces,
      rowState,
      new Map(),
      { expandedGroups: ["ws-local"] },
    );
    const localRoot = localGroups
      .find((g) => g.key === "ws-local")
      ?.sessions.find((s) => s.id === "local-root");
    assert.ok(localRoot);
    assert.equal(localRoot.tree?.descendantCount, 1);
    assert.equal(localRoot.tree?.activity.running, 1);
  });
});
