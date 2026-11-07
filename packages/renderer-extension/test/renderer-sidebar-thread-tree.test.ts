import {
  hostThreadIdSchema,
  type HostThreadId,
  type ThreadRelationListParams,
  type ThreadRelationListResult,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RendererModelClient } from "../src/renderer-model-client.js";
import { RendererMethodUnavailableError } from "../src/renderer-request-sender.js";
import {
  installRendererSidebarThreadTree,
  layoutSidebarThreadTree,
  planSidebarThreadForest,
  sidebarThreadDescendantKeys,
  SIDEBAR_THREAD_TREE_INDENT_PX,
  SIDEBAR_THREAD_TREE_TOGGLE_STYLE,
  type SidebarThreadTreeDom,
  type SidebarThreadTreeItem,
  type SidebarThreadTreeLayout,
  type SidebarThreadTreeList,
  type SidebarThreadTreeMirror,
} from "../src/renderer-sidebar-thread-tree.js";

const id = (value: string): HostThreadId => hostThreadIdSchema.parse(value);

class FakeItem implements SidebarThreadTreeItem {
  layout: SidebarThreadTreeLayout | null = null;
  applies = 0;

  constructor(
    public threadId: string | null,
    public hostId = "local",
  ) {}

  thread(): { hostId: string; threadId: HostThreadId } | null {
    return this.threadId === null ? null : { hostId: this.hostId, threadId: id(this.threadId) };
  }

  apply(layout: SidebarThreadTreeLayout | null): void {
    this.layout = layout;
    this.applies += 1;
  }
}

class FakeList implements SidebarThreadTreeList {
  mirrors: readonly SidebarThreadTreeMirror[] = [];

  constructor(public mounted: FakeItem[]) {}

  items(): readonly SidebarThreadTreeItem[] {
    return this.mounted;
  }

  mirror(mirrors: readonly SidebarThreadTreeMirror[]): void {
    this.mirrors = mirrors;
  }
}

const forkKey = JSON.stringify(["local", "fork"]);

function mirrorSummary(list: FakeList): unknown[] {
  return list.mirrors.map(({ key, source, layout }) => [
    key,
    (source as FakeItem).threadId,
    layout.order,
    layout.depth,
    layout.hidden,
    layout.toggle
      ? { collapsed: layout.toggle.collapsed, children: layout.toggle.childCount }
      : null,
  ]);
}

class FakeDom implements SidebarThreadTreeDom {
  readonly listeners = new Set<() => void>();
  cleared = false;

  constructor(public mounted: FakeList[]) {}

  lists(): readonly SidebarThreadTreeList[] {
    return this.mounted;
  }

  observe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  clear(): void {
    this.cleared = true;
    for (const list of this.mounted) {
      list.mirror([]);
      for (const item of list.mounted) item.apply(null);
    }
  }

  change(): void {
    for (const listener of this.listeners) listener();
  }
}

function clientWith(options: {
  relations?: Record<string, { parent: string; relation?: "delegation" | "fork" }>;
  external?: readonly string[];
  forks?: Record<string, string>;
  listThreadRelations?: (input: ThreadRelationListParams) => Promise<ThreadRelationListResult>;
  readNativeThreadForkSource?: (threadId: HostThreadId) => Promise<HostThreadId | null>;
}): RendererModelClient {
  const listThreadRelations =
    options.listThreadRelations ??
    (async ({ threadIds }: ThreadRelationListParams): Promise<ThreadRelationListResult> => ({
      threads: threadIds.map((threadId) => {
        const relation = options.relations?.[threadId];
        const external = options.external?.includes(threadId) === true || relation !== undefined;
        return {
          threadId,
          owner: external ? ("external" as const) : ("codex" as const),
          parent: relation
            ? { threadId: id(relation.parent), relation: relation.relation ?? "delegation" }
            : null,
        };
      }),
    }));
  const readNativeThreadForkSource =
    options.readNativeThreadForkSource ??
    (async (threadId: HostThreadId) => {
      const parent = options.forks?.[threadId];
      return parent === undefined ? null : id(parent);
    });
  return {
    forkThread: vi.fn(),
    inspectHarness: vi.fn(),
    inspectThread: vi.fn(),
    inspectHarnessCommands: vi.fn(),
    inspectThreadCommands: vi.fn(),
    executeThreadCommand: vi.fn(),
    inspectThreadUsage: vi.fn(),
    listThreadOwnership: vi.fn(),
    listThreadRelations: vi.fn(listThreadRelations),
    readNativeThreadForkSource: vi.fn(readNativeThreadForkSource),
    selectThreadModel: vi.fn(),
    selectThreadThinking: vi.fn(),
    selectThreadPermissionMode: vi.fn(),
    checkUpdate: vi.fn(),
    startUpdate: vi.fn(),
    readUpdateStatus: vi.fn(),
    listCodexAccounts: vi.fn(),
    refreshCodexAccounts: vi.fn(),
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function summary(items: readonly FakeItem[]): unknown[] {
  return items.map((item) =>
    item.layout === null
      ? [item.threadId, null]
      : [
          item.threadId,
          item.layout.order,
          item.layout.depth,
          item.layout.hidden,
          item.layout.toggle
            ? { collapsed: item.layout.toggle.collapsed, children: item.layout.toggle.childCount }
            : null,
        ],
  );
}

describe("layoutSidebarThreadTree", () => {
  it("places children depth-first under their parent in native sibling order", () => {
    const plans = layoutSidebarThreadTree([
      { key: "child-b", parentKey: "parent" },
      { key: "other", parentKey: null },
      { key: "parent", parentKey: null },
      { key: "grandchild", parentKey: "child-a" },
      { key: "child-a", parentKey: "parent" },
    ]);

    expect(plans?.map(({ order, depth }) => [order, depth])).toEqual([
      [2, 1],
      [0, 0],
      [1, 0],
      [4, 2],
      [3, 1],
    ]);
    expect(plans?.[2]?.childCount).toBe(2);
  });

  it("returns null when no entry in the list has a parent in that list", () => {
    expect(
      layoutSidebarThreadTree([
        { key: "a", parentKey: null },
        { key: "b", parentKey: "elsewhere" },
        { key: null, parentKey: null },
      ]),
    ).toBeNull();
  });

  it("breaks cycles and keeps self parents and duplicate keys at the top level", () => {
    const plans = layoutSidebarThreadTree([
      { key: "a", parentKey: "b" },
      { key: "b", parentKey: "a" },
      { key: "self", parentKey: "self" },
      { key: "root", parentKey: null },
      { key: "child", parentKey: "root" },
      { key: "child", parentKey: "root" },
    ]);

    expect(plans?.map(({ order, depth }) => [order, depth])).toEqual([
      [0, 0],
      [1, 1],
      [2, 0],
      [3, 0],
      [4, 1],
      [5, 0],
    ]);
  });

  it("hides every descendant of a collapsed parent", () => {
    const plans = layoutSidebarThreadTree(
      [
        { key: "root", parentKey: null },
        { key: "child", parentKey: "root" },
        { key: "grandchild", parentKey: "child" },
      ],
      new Set(["root"]),
    );

    expect(plans?.map(({ hidden, collapsed }) => [hidden, collapsed])).toEqual([
      [false, true],
      [true, false],
      [true, false],
    ]);
  });
});

describe("sidebarThreadDescendantKeys", () => {
  it("keeps listed descendants at any depth, through unlisted parents, in list order", () => {
    const parents: Record<string, string> = {
      child: "root",
      grandchild: "archived-middle",
      "archived-middle": "root",
      unrelated: "other",
      loop: "loop-b",
      "loop-b": "loop",
    };
    expect(
      sidebarThreadDescendantKeys(
        "root",
        ["grandchild", "root", "unrelated", "child", "loop", "child"],
        (key) => parents[key] ?? null,
      ),
    ).toEqual(["grandchild", "child"]);
  });
});

describe("Renderer sidebar Thread tree", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("nests Delegation children and native Forks under parents in the same list", async () => {
    const items = [
      new FakeItem("delegated-child"),
      new FakeItem("native-fork"),
      new FakeItem("parent"),
      new FakeItem(null),
    ];
    const dom = new FakeDom([new FakeList(items)]);
    const client = clientWith({
      relations: { "delegated-child": { parent: "parent" } },
      forks: { "native-fork": "parent" },
    });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });

    await settle();

    expect(client.listThreadRelations).toHaveBeenCalledTimes(1);
    expect(client.listThreadRelations).toHaveBeenCalledWith({
      threadIds: ["delegated-child", "native-fork", "parent"],
    });
    // Only Codex-owned Threads without a Host relation read native metadata.
    expect(client.readNativeThreadForkSource).toHaveBeenCalledTimes(2);
    expect(client.readNativeThreadForkSource).not.toHaveBeenCalledWith("delegated-child");
    expect(summary(items)).toEqual([
      ["delegated-child", 1, 1, false, null],
      ["native-fork", 2, 1, false, null],
      ["parent", 0, 0, false, { collapsed: false, children: 2 }],
      [null, 3, 0, false, null],
    ]);
    control.dispose();
  });

  it("collapses and expands children through the parent toggle", async () => {
    const items = [new FakeItem("parent"), new FakeItem("child")];
    const dom = new FakeDom([new FakeList(items)]);
    const client = clientWith({ relations: { child: { parent: "parent" } } });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await settle();

    items[0]?.layout?.toggle?.onToggle();
    await settle();
    expect(summary(items)).toEqual([
      ["parent", 0, 0, false, { collapsed: true, children: 1 }],
      ["child", 1, 1, true, null],
    ]);

    items[0]?.layout?.toggle?.onToggle();
    await settle();
    expect(items[1]?.layout?.hidden).toBe(false);
    control.dispose();
  });

  it("re-applies the layout after the native list re-renders", async () => {
    const list = new FakeList([new FakeItem("parent"), new FakeItem("child")]);
    const dom = new FakeDom([list]);
    const client = clientWith({ relations: { child: { parent: "parent" } } });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await settle();

    // React replaced both list items; cached relations apply without a new request.
    list.mounted = [new FakeItem("child"), new FakeItem("parent")];
    dom.change();
    await settle();

    expect(summary(list.mounted)).toEqual([
      ["child", 1, 1, false, null],
      ["parent", 0, 0, false, { collapsed: false, children: 1 }],
    ]);
    expect(client.listThreadRelations).toHaveBeenCalledTimes(1);
    control.dispose();
  });

  it("mirrors the Fork of a pinned Thread under its parent and hides it in Recents", async () => {
    const pinned = new FakeList([new FakeItem("pinned-a"), new FakeItem("parent")]);
    const recents = new FakeList([new FakeItem("recent-a"), new FakeItem("fork")]);
    const dom = new FakeDom([pinned, recents]);
    const client = clientWith({ forks: { fork: "parent" } });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await settle();

    expect(summary(pinned.mounted)).toEqual([
      ["pinned-a", 0, 0, false, null],
      ["parent", 1, 0, false, { collapsed: false, children: 1 }],
    ]);
    expect(mirrorSummary(pinned)).toEqual([[forkKey, "fork", 2, 1, false, null]]);
    expect(summary(recents.mounted)).toEqual([
      ["recent-a", 0, 0, false, null],
      ["fork", 0, 0, true, null],
    ]);
    expect(recents.mirrors).toEqual([]);
    control.dispose();
  });

  it("nests a Fork that appears after its pinned parent was already laid out", async () => {
    const pinned = new FakeList([new FakeItem("parent")]);
    const recents = new FakeList([new FakeItem("recent-a")]);
    const dom = new FakeDom([pinned, recents]);
    const client = clientWith({ relations: { fork: { parent: "parent", relation: "fork" } } });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await settle();
    expect(pinned.mirrors).toEqual([]);

    recents.mounted.unshift(new FakeItem("fork"));
    dom.change();
    await settle();

    expect(mirrorSummary(pinned)).toEqual([[forkKey, "fork", 1, 1, false, null]]);
    expect(summary(recents.mounted)).toEqual([
      ["fork", 0, 0, true, null],
      ["recent-a", 0, 0, false, null],
    ]);
    control.dispose();
  });

  it("collapses a mirrored child with its pinned parent", async () => {
    const pinned = new FakeList([new FakeItem("parent")]);
    const recents = new FakeList([new FakeItem("fork")]);
    const dom = new FakeDom([pinned, recents]);
    const client = clientWith({ forks: { fork: "parent" } });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await settle();

    pinned.mounted[0]?.layout?.toggle?.onToggle();
    await settle();

    expect(summary(pinned.mounted)).toEqual([
      ["parent", 0, 0, false, { collapsed: true, children: 1 }],
    ]);
    expect(mirrorSummary(pinned)).toEqual([[forkKey, "fork", 1, 1, true, null]]);
    expect(summary(recents.mounted)).toEqual([["fork", 0, 0, true, null]]);
    control.dispose();
  });

  it("returns a mirrored child to its own list when the parent leaves the sidebar", async () => {
    const pinned = new FakeList([new FakeItem("parent")]);
    const recents = new FakeList([new FakeItem("fork")]);
    const dom = new FakeDom([pinned, recents]);
    const client = clientWith({ forks: { fork: "parent" } });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await settle();
    expect(pinned.mirrors).toHaveLength(1);

    pinned.mounted = [];
    dom.change();
    await settle();

    expect(pinned.mirrors).toEqual([]);
    expect(recents.mounted[0]?.layout).toBeNull();
    control.dispose();
  });

  it("removes mirrors on dispose", async () => {
    const pinned = new FakeList([new FakeItem("parent")]);
    const recents = new FakeList([new FakeItem("fork")]);
    const dom = new FakeDom([pinned, recents]);
    const client = clientWith({ relations: { fork: { parent: "parent", relation: "fork" } } });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await settle();
    expect(pinned.mirrors).toHaveLength(1);

    control.dispose();

    expect(dom.cleared).toBe(true);
    expect(pinned.mirrors).toEqual([]);
    expect(recents.mounted[0]?.layout).toBeNull();
  });

  it("keys relations by Host so equal Thread ids on different Hosts stay apart", async () => {
    const items = [new FakeItem("parent", "local"), new FakeItem("child", "remote")];
    const dom = new FakeDom([new FakeList(items)]);
    const clients = new Map([
      ["local", clientWith({})],
      ["remote", clientWith({ relations: { child: { parent: "parent" } } })],
    ]);
    const control = installRendererSidebarThreadTree({
      getClient: (hostId) => clients.get(hostId) ?? null,
      dom,
    });
    await settle();

    expect(clients.get("local")?.listThreadRelations).toHaveBeenCalledWith({
      threadIds: ["parent"],
    });
    expect(items.map((item) => item.layout)).toEqual([null, null]);
    control.dispose();
  });

  it("falls back to native Fork metadata when the Host lacks the relation method", async () => {
    const items = [new FakeItem("parent"), new FakeItem("fork")];
    const dom = new FakeDom([new FakeList(items)]);
    const client = clientWith({
      listThreadRelations: async () => {
        throw new RendererMethodUnavailableError(
          "codexhost/thread/relation/list",
          new Error("Method not found"),
        );
      },
      forks: { fork: "parent" },
    });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await settle();

    expect(summary(items)).toEqual([
      ["parent", 0, 0, false, { collapsed: false, children: 1 }],
      ["fork", 1, 1, false, null],
    ]);
    control.dispose();
  });

  it("retries a Delegation recorded after its child row appeared", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    );
    const items = [new FakeItem("parent"), new FakeItem("child")];
    const dom = new FakeDom([new FakeList(items)]);
    let recorded = false;
    const client = clientWith({
      listThreadRelations: async ({ threadIds }) => ({
        threads: threadIds.map((threadId) => ({
          threadId,
          owner: "external" as const,
          parent:
            recorded && threadId === "child"
              ? { threadId: id("parent"), relation: "delegation" as const }
              : null,
        })),
      }),
    });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await vi.advanceTimersByTimeAsync(10);
    expect(items[1]?.layout).toBeNull();

    recorded = true;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(items[1]?.layout?.depth).toBe(1);
    control.dispose();
  });

  it("restores every list item on dispose and ignores late responses", async () => {
    let resolve: ((result: ThreadRelationListResult) => void) | undefined;
    const items = [new FakeItem("parent"), new FakeItem("child")];
    const dom = new FakeDom([new FakeList(items)]);
    const client = clientWith({
      listThreadRelations: () => new Promise((done) => (resolve = done)),
    });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await settle();

    control.dispose();
    resolve?.({
      threads: [
        { threadId: id("parent"), owner: "external", parent: null },
        {
          threadId: id("child"),
          owner: "external",
          parent: { threadId: id("parent"), relation: "delegation" },
        },
      ],
    });
    await settle();

    expect(dom.cleared).toBe(true);
    expect(items.map((item) => item.layout)).toEqual([null, null]);
    expect(dom.listeners.size).toBe(0);
  });

  it("lists live descendants per Host and reports listed Hosts after a scan", async () => {
    const items = [
      new FakeItem("grandchild"),
      new FakeItem("child"),
      new FakeItem("root"),
      new FakeItem("sibling"),
      new FakeItem("child", "remote"),
    ];
    const list = new FakeList(items);
    const dom = new FakeDom([list]);
    const client = clientWith({
      relations: { child: { parent: "root" }, grandchild: { parent: "child" } },
      forks: { sibling: "elsewhere" },
    });
    const remote = clientWith({});
    const hosts: string[][] = [];
    const tree = installRendererSidebarThreadTree({
      getClient: (hostId) => (hostId === "local" ? client : remote),
      dom,
      onHosts: (ids) => hosts.push([...ids].sort()),
    });
    await settle();

    expect(tree.liveDescendants("local", id("root"))).toEqual(["grandchild", "child"]);
    expect(tree.liveDescendants("remote", id("root"))).toEqual([]);
    expect(hosts.at(-1)).toEqual(["local", "remote"]);

    // An archived intermediate parent leaves its row; the grandchild still counts.
    list.mounted = items.filter((item) => item.threadId !== "child");
    expect(tree.liveDescendants("local", id("root"))).toEqual(["grandchild"]);

    tree.dispose();
    expect(tree.liveDescendants("local", id("root"))).toEqual([]);
  });
});

describe("planSidebarThreadForest", () => {
  const entry = (key: string, parentKey: string | null = null) => ({ key, parentKey });

  it("keeps lists native when nothing nests", () => {
    expect(planSidebarThreadForest([[entry("a")], [entry("b")]])).toEqual([
      { items: null, mirrors: [] },
      { items: null, mirrors: [] },
    ]);
  });

  it("moves a child and its subtree under a parent in another list", () => {
    const [pinned, recents] = planSidebarThreadForest([
      [entry("parent"), entry("other")],
      [entry("grandchild", "child"), entry("recent"), entry("child", "parent")],
    ]);

    expect(
      pinned?.items?.map(({ order, depth, hidden, mirrored }) => [order, depth, hidden, mirrored]),
    ).toEqual([
      [0, 0, false, false],
      [3, 0, false, false],
    ]);
    expect(
      pinned?.mirrors.map(({ list, index, plan }) => [list, index, plan.order, plan.depth]),
    ).toEqual([
      [1, 0, 2, 2],
      [1, 2, 1, 1],
    ]);
    expect(recents?.items?.map(({ order, hidden, mirrored }) => [order, hidden, mirrored])).toEqual(
      [
        [0, true, true],
        [0, false, false],
        [0, true, true],
      ],
    );
    expect(recents?.mirrors).toEqual([]);
  });

  it("prefers a parent in the same list", () => {
    const [first, second] = planSidebarThreadForest([
      [entry("parent")],
      [entry("parent"), entry("child", "parent")],
    ]);

    expect(first).toEqual({ items: null, mirrors: [] });
    expect(second?.mirrors).toEqual([]);
    expect(second?.items?.map(({ depth, mirrored }) => [depth, mirrored])).toEqual([
      [0, false],
      [1, false],
    ]);
  });

  it("does not move a Thread that Desktop shows in more than one list", () => {
    expect(
      planSidebarThreadForest([
        [entry("parent")],
        [entry("child", "parent")],
        [entry("child", "parent")],
      ]),
    ).toEqual([
      { items: null, mirrors: [] },
      { items: null, mirrors: [] },
      { items: null, mirrors: [] },
    ]);
  });

  it("keeps a cross-list cycle in place", () => {
    expect(planSidebarThreadForest([[entry("a", "b")], [entry("b", "a")]])).toEqual([
      { items: null, mirrors: [] },
      { items: null, mirrors: [] },
    ]);
  });
});

describe("sidebar Thread tree toggle style", () => {
  it("keeps the toggle out of the row's inline layout", () => {
    // An in-flow toggle shifted a parent's icon right of its siblings' icons.
    expect(SIDEBAR_THREAD_TREE_TOGGLE_STYLE.position).toBe("absolute");
    const width = Number.parseFloat(SIDEBAR_THREAD_TREE_TOGGLE_STYLE.width);
    const margin = Number.parseFloat(SIDEBAR_THREAD_TREE_TOGGLE_STYLE.marginInlineStart);
    expect(margin).toBeLessThan(-width);
    // The toggle stays within one indent level left of the icon, so it never
    // overlaps the parent's own icon or reaches past the row's leading gutter.
    expect(-margin).toBeLessThanOrEqual(SIDEBAR_THREAD_TREE_INDENT_PX + 4);
  });
});
