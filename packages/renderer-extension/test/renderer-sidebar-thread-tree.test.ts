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
  type SidebarThreadTreeDom,
  type SidebarThreadTreeItem,
  type SidebarThreadTreeLayout,
  type SidebarThreadTreeList,
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
  constructor(public mounted: FakeItem[]) {}

  items(): readonly SidebarThreadTreeItem[] {
    return this.mounted;
  }
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
    for (const list of this.mounted) for (const item of list.mounted) item.apply(null);
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

  it("does not nest a child whose parent is in another list", async () => {
    const first = new FakeList([new FakeItem("parent")]);
    const second = new FakeList([new FakeItem("child")]);
    const dom = new FakeDom([first, second]);
    const client = clientWith({ relations: { child: { parent: "parent" } } });
    const control = installRendererSidebarThreadTree({ getClient: () => client, dom });
    await settle();

    expect(first.mounted[0]?.layout).toBeNull();
    expect(second.mounted[0]?.layout).toBeNull();
    control.dispose();
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
});
