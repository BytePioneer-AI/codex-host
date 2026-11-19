// @vitest-environment jsdom
import type { ThreadTreeNode, ThreadTreeNodesParams } from "@codexhost/shared-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { RendererModelClient } from "../src/renderer-model-client.js";
import { RendererMethodUnavailableError } from "../src/renderer-request-sender.js";
import {
  SIDEBAR_THREAD_TREE_EXPANDED_KEY,
  installRendererSidebarThreadTree,
} from "../src/renderer-sidebar-thread-tree.js";

const ROW = "data-app-action-sidebar-thread-row";
const ID = "data-app-action-sidebar-thread-id";
const HOST = "data-app-action-sidebar-thread-host-id";
const ACTIVE = "data-app-action-sidebar-thread-active";
const NODE = "data-codexhost-sidebar-tree-node";
const TOGGLE = "data-codexhost-sidebar-tree-toggle";
const SUMMARY = "data-codexhost-sidebar-tree-summary";
const EXPAND = "data-codexhost-sidebar-tree-expand";
const VIRTUAL = "data-codexhost-sidebar-tree-virtual";
const ANCHOR = "data-codexhost-sidebar-tree-anchor";
const OWNED = [
  TOGGLE,
  SUMMARY,
  "data-codexhost-sidebar-tree-children",
  VIRTUAL,
  ANCHOR,
  "data-codexhost-sidebar-tree-root",
  "data-codexhost-sidebar-tree-hidden",
]
  .map((name) => `[${name}]`)
  .join(", ");

/**
 * A sidebar row as Desktop mounts it: listitem > group > row, the row's React identity, and the
 * Agent icon codexhost puts first in the title trigger.
 */
function mountRow(list: Element, threadId: string, title: string, hostId = "local"): HTMLElement {
  const item = document.createElement("div");
  item.setAttribute("role", "listitem");
  item.innerHTML = `<div role="group"><div ${ROW}="" ${ID}="${hostId}:${threadId}" ${HOST}="${hostId}" data-app-action-sidebar-thread-title="${title}" ${ACTIVE}="false" role="button"><div><div></div><div data-thread-title-trigger="true" style="display: flex; align-items: center"><span data-codexhost-sidebar-agent-icon="codex"></span><span data-thread-title="true">${title}</span></div></div></div></div>`;
  const row = item.querySelector<HTMLElement>(`[${ROW}]`);
  if (!row) throw new Error("Missing synthetic row");
  Object.defineProperty(row, "__reactFiber$test", {
    enumerable: true,
    value: {
      memoizedProps: {
        conversationId: threadId,
        dataAttributes: { [ROW]: "", [ID]: `${hostId}:${threadId}`, [HOST]: hostId },
      },
      return: null,
    },
  });
  list.append(item);
  return row;
}

function mountList(collapsed = false): HTMLElement {
  const list = document.createElement("div");
  list.setAttribute("role", "list");
  if (collapsed) list.dataset.collapsed = "true";
  document.querySelector("[data-app-action-sidebar-scroll]")?.append(list);
  return list;
}

interface Delegated extends Partial<Omit<ThreadTreeNode, "threadId">> {
  parent: string;
  /** The Host no longer has the Thread. */
  gone?: boolean;
}

function host(tree: Record<string, Delegated>) {
  const requests: ThreadTreeNodesParams[] = [];
  const readThreadTree = vi.fn(async () => ({
    parents: Object.fromEntries(Object.entries(tree).map(([id, node]) => [id, node.parent])),
  }));
  const listThreadTreeNodes = vi.fn(async (input: ThreadTreeNodesParams) => {
    requests.push(input);
    return {
      threads: input.threadIds.flatMap((threadId): ThreadTreeNode[] => {
        const node = tree[threadId];
        if (node?.gone) return [];
        const harnessId = node?.harnessId ?? ("codex" as ThreadTreeNode["harnessId"]);
        // Official Threads are only described when asked for.
        const full = harnessId !== "codex" || input.includeOfficial === true;
        return [
          {
            threadId,
            harnessId,
            status: node?.status ?? "idle",
            ...(full && node?.title ? { title: node.title } : {}),
            ...(full ? { archived: node?.archived ?? false } : {}),
            ...(node ? { delegatedAt: node.delegatedAt ?? "2026-01-01T00:00:00.000Z" } : {}),
          },
        ];
      }),
    };
  });
  const client = { readThreadTree, listThreadTreeNodes } as unknown as RendererModelClient;
  return { client, readThreadTree, listThreadTreeNodes, requests };
}

const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
};
const routed: string[] = [];
const disposers: (() => void)[] = [];

function install(client: RendererModelClient | null, getClient = () => client) {
  const control = installRendererSidebarThreadTree({
    getClient,
    getLocale: () => "en",
    openThread: async (threadId) => void routed.push(threadId),
    isRowListVisible: (row) =>
      row.closest('[role="list"]')?.getAttribute("data-collapsed") !== "true",
    storage,
  });
  disposers.push(() => control.dispose());
  return control;
}

/** Lets pending requests resolve and the scheduled frame render. */
const settle = () => vi.advanceTimersByTimeAsync(40);
const nodeTitles = () =>
  [...document.querySelectorAll(`[${NODE}]`)].map(
    (node) =>
      `${node.querySelector(".cxh-tree-title")?.textContent}${node.getAttribute("aria-current") ? "*" : ""}`,
  );
const itemOf = (row: HTMLElement) => row.closest<HTMLElement>('[role="listitem"]');
const toggleOf = (row: HTMLElement) => row.querySelector<HTMLElement>(`[${TOGGLE}]`);
const summaryOf = (scope: Element | null) =>
  scope?.querySelector(`[${EXPAND}]`)?.textContent ?? undefined;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame"],
  });
  document.body.innerHTML = "<aside><div data-app-action-sidebar-scroll></div></aside>";
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  stored.clear();
  routed.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("folds delegated Threads under the root's row, whose icon and title stay where they are", async () => {
  const list = mountList();
  const parent = mountRow(list, "parent", "Orchestrator");
  const mounted = mountRow(list, "mounted", "Review protocol");
  const unrelated = mountRow(list, "unrelated", "Something else");
  const fake = host({
    mounted: { parent: "parent", status: "running", delegatedAt: "2026-01-03T00:00:00.000Z" },
    offscreen: { parent: "parent", title: "Write tests", delegatedAt: "2026-01-02T00:00:00.000Z" },
    archived: { parent: "parent", title: "Old task", archived: true },
    gone: { parent: "parent", gone: true },
  });
  install(fake.client);
  await settle();

  expect(fake.readThreadTree).toHaveBeenCalledTimes(1);
  // One full read describes the root and every Thread below it.
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]?.includeOfficial).toBe(true);
  expect([...(fake.requests[0]?.threadIds ?? [])].sort()).toEqual([
    "archived",
    "gone",
    "mounted",
    "offscreen",
    "parent",
  ]);
  // Collapsed by default: the toggle lies over the Agent icon, and the summary line under the row.
  const icon = parent.querySelector("[data-codexhost-sidebar-agent-icon]");
  expect(icon?.previousElementSibling).toBe(toggleOf(parent));
  expect(parent.querySelector("[data-thread-title-trigger]")?.lastElementChild?.textContent).toBe(
    "Orchestrator",
  );
  expect(toggleOf(parent)?.getAttribute("aria-expanded")).toBe("false");
  expect(toggleOf(parent)?.getAttribute("aria-label")).toBe("Expand 2 child sessions");
  expect(summaryOf(itemOf(parent))).toBe("2 child sessions · 1 running");
  expect(itemOf(parent)?.getAttribute("data-codexhost-sidebar-tree-root")).toBe("collapsed");
  expect(nodeTitles()).toEqual([]);
  expect(itemOf(mounted)?.style.display).toBe("none");
  expect(itemOf(unrelated)?.style.display).toBe("");
  expect(toggleOf(unrelated)).toBeNull();

  toggleOf(parent)?.click();
  // A toggle lays the tree out at once, so it can be animated from where it was.
  expect(nodeTitles()).toEqual(["Review protocol", "Write tests"]);
  expect(toggleOf(parent)?.getAttribute("aria-expanded")).toBe("true");
  expect(summaryOf(itemOf(parent))).toBeUndefined();
  expect(itemOf(parent)?.getAttribute("data-codexhost-sidebar-tree-root")).toBe("expanded");
  expect(JSON.parse(stored.get(SIDEBAR_THREAD_TREE_EXPANDED_KEY) ?? "[]")).toEqual(["parent"]);
  // The children hang from guides in the root's own listitem, below Desktop's row.
  const children = itemOf(parent)?.lastElementChild;
  expect(children?.hasAttribute("data-codexhost-sidebar-tree-children")).toBe(true);
  expect(children?.hasAttribute("data-guide")).toBe(true);
});

it("draws the tree where its topmost member stands when the root row is lower or elsewhere", async () => {
  const recents = mountList();
  const worker = mountRow(recents, "worker", "Worker");
  const lead = mountRow(recents, "lead", "Lead");
  const project = mountList();
  const leadInProject = mountRow(project, "lead", "Lead");
  install(
    host({
      worker: { parent: "lead", title: "Worker", status: "question" },
      helper: { parent: "worker", title: "Helper" },
    }).client,
  );
  await settle();

  // In Recents the worker is newer than its lead: the lead's tree takes the worker's place.
  const anchor = itemOf(worker);
  expect(anchor?.hasAttribute(ANCHOR)).toBe(true);
  expect(anchor?.firstElementChild?.getAttribute(VIRTUAL)).toBe("lead");
  expect(anchor?.querySelector(`[${NODE}="lead"] .cxh-tree-title`)?.textContent).toBe("Lead");
  expect(summaryOf(anchor)).toBe("2 child sessions · 1 needs approval");
  expect(itemOf(lead)?.style.display).toBe("none");
  // The project lists the lead first, so it keeps its own row there.
  expect(toggleOf(leadInProject)).not.toBeNull();
  expect(itemOf(leadInProject)?.hasAttribute(ANCHOR)).toBe(false);

  // Children of children unfold the same way, one level further in. Expansion belongs to the
  // Thread, so the project's copy of the tree follows.
  anchor?.querySelector<HTMLElement>(`[${TOGGLE}="lead"]`)?.click();
  expect(nodeTitles()).toEqual(["Lead", "Worker", "Worker"]);
  anchor?.querySelector<HTMLElement>(`[${TOGGLE}="worker"]`)?.click();
  expect(nodeTitles()).toEqual(["Lead", "Worker", "Helper", "Worker", "Helper"]);
  const helper = anchor?.querySelector(`[${NODE}="helper"]`);
  expect(
    helper?.closest<HTMLElement>(".cxh-tree-branch")?.style.getPropertyValue("--cxh-indent"),
  ).toBe("48px");
  expect(helper?.closest(".cxh-tree-children")?.hasAttribute("data-guide")).toBe(true);
});

it("expands from the summary, and pressing a row only opens it", async () => {
  const list = mountList();
  const parent = mountRow(list, "parent", "Orchestrator");
  install(host({ child: { parent: "parent", title: "Child" } }).client);
  await settle();

  itemOf(parent)?.querySelector<HTMLElement>(`[${EXPAND}]`)?.click();
  expect(nodeTitles()).toEqual(["Child"]);
  // Desktop renames the open Thread on a double-click of its title, which starts with a press.
  parent.setAttribute(ACTIVE, "true");
  await settle();
  parent.click();
  parent.querySelector<HTMLElement>("[data-thread-title]")?.click();
  expect(nodeTitles()).toEqual(["Child"]);
  // Desktop's next and previous Thread commands step through the rows codexhost draws too.
  expect(document.querySelector(`[${NODE}="child"]`)?.hasAttribute("data-sidebar-cycle-item")).toBe(
    true,
  );
  expect(document.querySelector(`[${NODE}="child"]`)?.getAttribute("role")).toBe("treeitem");
});

it("keeps keyboard focus on a summary that the status poll redraws", async () => {
  const list = mountList();
  const parent = mountRow(list, "parent", "Orchestrator");
  const tree: Record<string, Delegated> = { child: { parent: "parent", title: "Child" } };
  install(host(tree).client);
  await settle();
  itemOf(parent)?.querySelector<HTMLElement>(`[${EXPAND}]`)?.focus();
  expect(document.activeElement?.getAttribute(EXPAND)).toBe("parent");

  tree.child = { ...tree.child, parent: "parent", status: "running" };
  await vi.advanceTimersByTimeAsync(5_000);
  await settle();
  expect(summaryOf(itemOf(parent))).toBe("1 child sessions · 1 running");
  expect(document.activeElement?.getAttribute(EXPAND)).toBe("parent");
});

it("nests every level under its own parent and stops indenting at the third", async () => {
  const list = mountList();
  mountRow(list, "root", "Root");
  const chain = ["a", "b", "c", "d", "e"];
  stored.set(SIDEBAR_THREAD_TREE_EXPANDED_KEY, JSON.stringify(["root", ...chain]));
  install(
    host(
      Object.fromEntries(
        chain.map((id, index) => [
          id,
          { parent: index === 0 ? "root" : chain[index - 1], title: id },
        ]),
      ) as Record<string, Delegated>,
    ).client,
  );
  await settle();

  expect(nodeTitles()).toEqual(chain);
  const branchOf = (id: string) =>
    document.querySelector(`[${NODE}="${id}"]`)?.closest<HTMLElement>(".cxh-tree-branch");
  for (const [index, id] of chain.entries()) {
    const branch = branchOf(id);
    expect(branch?.style.getPropertyValue("--cxh-indent")).toBe(`${Math.min(index + 1, 3) * 24}px`);
    expect(document.querySelector(`[${NODE}="${id}"]`)?.getAttribute("aria-level")).toBe(
      String(index + 2),
    );
    // Each level hangs from the previous one's own group of children.
    if (index > 0)
      expect(branch?.parentElement?.closest(".cxh-tree-branch")).toBe(
        branchOf(chain[index - 1] ?? ""),
      );
  }
  // Guides stop with the indentation, and no empty group is left behind.
  const groups = [...document.querySelectorAll(".cxh-tree-children")];
  expect(groups.map((group) => group.hasAttribute("data-guide"))).toEqual([
    true,
    true,
    true,
    false,
    false,
  ]);
  expect(groups.filter((group) => group.childElementCount === 0)).toEqual([]);
});

it("opens a mounted child through its own row and any other child through Desktop's router", async () => {
  const list = mountList();
  const parent = mountRow(list, "parent", "Orchestrator");
  const mounted = mountRow(list, "mounted", "Mounted child");
  // Child rows live inside the parent's listitem: nothing from them may reach Desktop there.
  const reachedDesktop = vi.fn();
  for (const type of ["click", "pointerdown", "contextmenu", "dragstart"])
    itemOf(parent)?.addEventListener(type, reachedDesktop);
  const nativeOpen = vi.fn();
  mounted.addEventListener("click", nativeOpen);
  stored.set(SIDEBAR_THREAD_TREE_EXPANDED_KEY, JSON.stringify(["parent"]));
  install(
    host({ mounted: { parent: "parent" }, offscreen: { parent: "parent", title: "Offscreen" } })
      .client,
  );
  await settle();

  document.querySelector<HTMLElement>(`[${NODE}="mounted"]`)?.click();
  expect(nativeOpen).toHaveBeenCalledTimes(1);
  expect(routed).toEqual([]);
  document
    .querySelector<HTMLElement>(`[${NODE}="offscreen"]`)
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(routed).toEqual(["offscreen"]);
  const offscreen = document.querySelector<HTMLElement>(`[${NODE}="offscreen"]`);
  for (const type of ["pointerdown", "contextmenu", "dragstart"])
    offscreen?.dispatchEvent(new Event(type, { bubbles: true }));
  // The end of a gesture passes, so a drag that started on a Desktop row can end over a child.
  const released = vi.fn();
  document.addEventListener("pointerup", released);
  offscreen?.dispatchEvent(new Event("pointerup", { bubbles: true }));
  document.removeEventListener("pointerup", released);
  expect(released).toHaveBeenCalledTimes(1);
  const toggle = toggleOf(parent);
  if (!toggle) throw new Error("Missing toggle");
  toggle.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  toggle.click();
  expect(reachedDesktop).not.toHaveBeenCalled();
});

it("follows live state with state-only reads and reads the tree again when rows change", async () => {
  const list = mountList();
  const parent = mountRow(list, "parent", "Orchestrator");
  const tree: Record<string, Delegated> = { child: { parent: "parent", title: "Child" } };
  const fake = host(tree);
  install(fake.client);
  await settle();
  expect(summaryOf(itemOf(parent))).toBe("1 child sessions");

  tree.child = { ...tree.child, parent: "parent", status: "question", title: "Renamed elsewhere" };
  await vi.advanceTimersByTimeAsync(5_000);
  await settle();
  expect(summaryOf(itemOf(parent))).toBe("1 child sessions · 1 needs approval");
  expect(fake.requests.at(-1)).toEqual({ threadIds: ["parent", "child"] });
  expect(fake.readThreadTree).toHaveBeenCalledTimes(1);

  // A new row is the usual sign of a new delegation.
  tree.second = { parent: "parent", title: "Second", status: "running" };
  mountRow(list, "second", "Second");
  await vi.advanceTimersByTimeAsync(500);
  await settle();
  expect(fake.readThreadTree).toHaveBeenCalledTimes(2);
  expect(toggleOf(parent)?.getAttribute("aria-label")).toBe("Expand 2 child sessions");
});

it("renders again after Desktop replaces a row's content", async () => {
  const list = mountList();
  const parent = mountRow(list, "parent", "Orchestrator");
  stored.set(SIDEBAR_THREAD_TREE_EXPANDED_KEY, JSON.stringify(["parent"]));
  install(host({ child: { parent: "parent", title: "Child" } }).client);
  await settle();
  expect(nodeTitles()).toEqual(["Child"]);

  // React re-creating the row drops everything that was added inside it.
  const group = itemOf(parent)?.firstElementChild;
  toggleOf(parent)?.remove();
  itemOf(parent)?.querySelector("[data-codexhost-sidebar-tree-children]")?.remove();
  if (group) itemOf(parent)?.append(group);
  await settle();
  expect(toggleOf(parent)?.getAttribute("aria-expanded")).toBe("true");
  expect(nodeTitles()).toEqual(["Child"]);
  expect(itemOf(parent)?.firstElementChild).toBe(group);
});

it("expands the ancestors of the open Thread and marks it", async () => {
  const list = mountList();
  mountRow(list, "parent", "Orchestrator");
  const fake = host({
    child: { parent: "parent", title: "Child" },
    grandchild: { parent: "child", title: "Grandchild" },
  });
  install(fake.client);
  await settle();
  expect(nodeTitles()).toEqual([]);

  const composer = document.createElement("div");
  composer.setAttribute("data-above-composer-conversation-id", "grandchild");
  document.body.append(composer);
  await settle();
  expect(nodeTitles()).toEqual(["Child", "Grandchild*"]);
});

it("leaves rows of a collapsed list to Desktop until the list is shown", async () => {
  const collapsedProject = mountList(true);
  const parent = mountRow(collapsedProject, "parent", "Orchestrator");
  const child = mountRow(collapsedProject, "child", "Child");
  install(host({ child: { parent: "parent" } }).client);
  await settle();
  expect(itemOf(child)?.style.display).toBe("");
  expect(toggleOf(parent)).toBeNull();

  // Expanding the project lays the rows out; the child then moves under its parent.
  collapsedProject.removeAttribute("data-collapsed");
  collapsedProject.append(document.createElement("span"));
  await settle();
  expect(itemOf(child)?.style.display).toBe("none");
  expect(summaryOf(itemOf(parent))).toBe("1 child sessions");
});

it("leaves rows of other Hosts and of Hosts without the tree untouched, and restores on dispose", async () => {
  const list = mountList();
  mountRow(list, "parent", "Remote orchestrator", "remote-host");
  mountRow(list, "child", "Remote child", "remote-host");
  const remoteOnly = install(host({ child: { parent: "parent" } }).client);
  await settle();
  expect(document.querySelectorAll(OWNED)).toHaveLength(0);
  remoteOnly.dispose();

  const localParent = mountRow(list, "local-parent", "Orchestrator");
  const localChild = mountRow(list, "local-child", "Child");
  const older = host({ "local-child": { parent: "local-parent" } });
  older.listThreadTreeNodes.mockRejectedValue(
    new RendererMethodUnavailableError("codexhost/thread/tree/nodes", { code: -32601 }),
  );
  install(older.client);
  await settle();
  await vi.advanceTimersByTimeAsync(11_000);
  expect(document.querySelectorAll(OWNED)).toHaveLength(0);
  // An unavailable method is not asked for again on this connection.
  expect(older.listThreadTreeNodes).toHaveBeenCalledTimes(1);

  const before = document.body.innerHTML;
  const current = install(host({ "local-child": { parent: "local-parent" } }).client);
  await settle();
  expect(toggleOf(localParent)).not.toBeNull();
  expect(itemOf(localChild)?.style.display).toBe("none");
  current.dispose();
  expect(document.querySelectorAll(OWNED)).toHaveLength(0);
  expect(document.body.innerHTML).toBe(before);
  expect(document.querySelector("style[data-codexhost-sidebar-tree-style]")).toBeNull();
});

it("reads the tree again when the Host client is replaced", async () => {
  mountRow(mountList(), "parent", "Orchestrator");
  const first = host({ child: { parent: "parent", title: "Child" } });
  const second = host({ child: { parent: "parent", title: "Child" } });
  let current: RendererModelClient | null = null;
  install(null, () => current);
  await settle();
  expect(first.readThreadTree).not.toHaveBeenCalled();

  current = first.client;
  await vi.advanceTimersByTimeAsync(5_000);
  await settle();
  expect(first.readThreadTree).toHaveBeenCalledTimes(1);
  current = second.client;
  await vi.advanceTimersByTimeAsync(5_000);
  await settle();
  expect(second.readThreadTree).toHaveBeenCalledTimes(1);
});

it("hides nothing for a tree whose place is a row it cannot be attached to", async () => {
  const list = mountList();
  const parent = mountRow(list, "parent", "Orchestrator");
  const child = mountRow(list, "child", "Child");
  // A Desktop update that drops the title trigger must leave every row reachable.
  parent.querySelector("[data-thread-title-trigger]")?.removeAttribute("data-thread-title-trigger");
  install(host({ child: { parent: "parent" } }).client);
  await settle();
  expect(itemOf(child)?.style.display).toBe("");
  expect(document.querySelectorAll(OWNED)).toHaveLength(0);
});

it("opens through the router once Desktop unmounts the child's own row", async () => {
  const list = mountList();
  mountRow(list, "parent", "Orchestrator");
  const child = mountRow(list, "child", "Child");
  stored.set(SIDEBAR_THREAD_TREE_EXPANDED_KEY, JSON.stringify(["parent"]));
  install(host({ child: { parent: "parent", title: "Child" } }).client);
  await settle();
  // For example pushed past the rows the project shows.
  itemOf(child)?.remove();
  await settle();
  document.querySelector<HTMLElement>(`[${NODE}="child"]`)?.click();
  expect(routed).toEqual(["child"]);
});

it("expands the ancestors of a Thread that was open before the tree was read", async () => {
  const list = mountList();
  const parent = mountRow(list, "parent", "Orchestrator");
  mountRow(list, "child", "Child");
  const composer = document.createElement("div");
  composer.setAttribute("data-above-composer-conversation-id", "child");
  document.body.append(composer);
  const fake = host({ child: { parent: "parent" } });
  const tree = Promise.withResolvers<{ parents: Record<string, string> }>();
  fake.readThreadTree.mockReturnValueOnce(tree.promise);
  install(fake.client);
  // The sidebar renders while the tree is still on its way.
  mountRow(list, "unrelated", "Something else");
  await settle();
  expect(toggleOf(parent)).toBeNull();
  tree.resolve({ parents: { child: "parent" } });
  await settle();
  await settle();
  expect(toggleOf(parent)?.getAttribute("aria-expanded")).toBe("true");
  expect(nodeTitles()).toEqual(["Child*"]);
});

it("gives the sidebar back when the Host stops serving the tree", async () => {
  const list = mountList();
  const parent = mountRow(list, "parent", "Orchestrator");
  const child = mountRow(list, "child", "Child");
  const fake = host({ child: { parent: "parent" } });
  let current: RendererModelClient | null = fake.client;
  install(null, () => current);
  await settle();
  expect(itemOf(child)?.style.display).toBe("none");

  // Replaced by an older Host without the method.
  const older = host({ child: { parent: "parent" } });
  older.readThreadTree.mockRejectedValue(
    new RendererMethodUnavailableError("codexhost/thread/tree/read", { code: -32601 }),
  );
  current = older.client;
  await vi.advanceTimersByTimeAsync(5_000);
  await settle();
  expect(itemOf(child)?.style.display).toBe("");
  expect(toggleOf(parent)).toBeNull();

  // And again when the connection is gone altogether.
  current = fake.client;
  await vi.advanceTimersByTimeAsync(5_000);
  await settle();
  expect(itemOf(child)?.style.display).toBe("none");
  current = null;
  list.append(document.createElement("span"));
  await settle();
  expect(itemOf(child)?.style.display).toBe("");
  expect(document.querySelectorAll(OWNED)).toHaveLength(0);
});
