// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  harnessIdSchema,
  threadTreeSnapshotSchema,
  type DesktopExtensionApiV1,
  type DesktopSidebarRow,
  type ThreadTreeNode,
  type ThreadTreeSnapshot,
} from "@codexhost/shared-contracts";
import { activate } from "../src/sidebar-tree.js";

const PI = harnessIdSchema.parse("pi");
const CODEX = harnessIdSchema.parse("codex");

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  document.body.replaceChildren();
  document.documentElement.lang = "";
});

function createHarness() {
  const abort = new AbortController();
  const teardowns = new Set<() => void>();
  const mounted = new Set<Element>();
  const marks = new Map<Element, Set<string>>();
  let onRows: ((rows: readonly DesktopSidebarRow[]) => void) | undefined;
  let onTree: ((snapshot: ThreadTreeSnapshot) => void) | undefined;
  const openThread = vi.fn(async () => undefined);

  const api: DesktopExtensionApiV1 = {
    id: "sidebar-thread-tree",
    apiVersion: 1,
    signal: abort.signal,
    sidebar: {
      observeRows(cb) {
        onRows = cb;
        return () => {
          onRows = undefined;
        };
      },
    },
    threads: {
      watchTree(cb) {
        onTree = cb;
        return () => {
          onTree = undefined;
        };
      },
    },
    navigate: { openThread },
    harnesses: {
      describe(harnessId) {
        if (harnessId === "pi") return { name: "Pi", icon: "data:image/svg+xml,<svg/>" };
        if (harnessId === "codex") return { name: "Codex" };
        return undefined;
      },
    },
    dom: {
      mount(node, parent, position = "append") {
        mounted.add(node);
        parent[position](node);
      },
      mark(target, name) {
        const attr = `data-cx-${api.id}-${name}`;
        target.setAttribute(attr, "");
        let set = marks.get(target);
        if (!set) marks.set(target, (set = new Set()));
        set.add(attr);
      },
      unmark(target, name) {
        const attr = `data-cx-${api.id}-${name}`;
        target.removeAttribute(attr);
        marks.get(target)?.delete(attr);
      },
    },
    track(teardown) {
      teardowns.add(teardown);
    },
  };

  const dispose = () => {
    abort.abort();
    for (const fn of teardowns) fn();
    teardowns.clear();
    for (const node of mounted) node.remove();
    mounted.clear();
    for (const [el, attrs] of marks) {
      for (const attr of attrs) el.removeAttribute(attr);
    }
    marks.clear();
  };
  cleanups.push(dispose);

  activate(api);

  return {
    api,
    openThread,
    dispose,
    setRows(rows: readonly DesktopSidebarRow[]) {
      onRows?.(rows);
    },
    setTree(tree: {
      revision: number;
      truncated: boolean;
      parents: Record<string, string>;
      nodes: Record<string, ThreadTreeNode>;
    }) {
      onTree?.(threadTreeSnapshotSchema.parse(tree));
    },
  };
}

function makeListRow(
  list: HTMLElement,
  threadId: string,
  titleText: string,
): { item: HTMLElement; row: DesktopSidebarRow; icon: HTMLElement } {
  const item = document.createElement("div");
  item.setAttribute("role", "listitem");

  const rowElement = document.createElement("div");
  rowElement.setAttribute("role", "button");

  const trigger = document.createElement("div");
  trigger.setAttribute("data-thread-title-trigger", "");

  const icon = document.createElement("span");
  icon.setAttribute("data-codexhost-sidebar-agent-icon", "pi");
  const img = document.createElement("img");
  img.src = "data:image/png;base64,AA==";
  icon.append(img);

  const title = document.createElement("span");
  title.setAttribute("data-thread-title", "");
  title.textContent = titleText;

  trigger.append(icon, title);
  rowElement.append(trigger);
  item.append(rowElement);
  list.append(item);

  return {
    item,
    icon,
    row: {
      element: rowElement,
      hostId: "local",
      isLocal: true,
      threadId,
      draftId: null,
      isConnected: () => rowElement.isConnected,
    },
  };
}

function makeNode(
  harnessId: ThreadTreeNode["harnessId"],
  status: ThreadTreeNode["status"],
  title: string,
): ThreadTreeNode {
  return { harnessId, status, title, archived: false };
}

describe("sidebar-thread-tree DOM behavior", () => {
  it("shows localized summary only while collapsed, removes summary on expand, and renders no status for idle rows", () => {
    document.documentElement.lang = "zh-CN";
    const harness = createHarness();
    const list = document.createElement("div");
    document.body.append(list);

    const parent = makeListRow(list, "parent", "梳理侧栏会话交互");
    const childWait = makeListRow(list, "child-wait", "确认规则");
    const childRun = makeListRow(list, "child-run", "核对状态");
    const childIdle = makeListRow(list, "child-idle", "整理术语");

    harness.setRows([parent.row, childWait.row, childRun.row, childIdle.row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: {
        "child-wait": "parent",
        "child-run": "parent",
        "child-idle": "parent",
      },
      nodes: {
        parent: makeNode(CODEX, "idle", "梳理侧栏会话交互"),
        "child-wait": makeNode(PI, "waiting", "确认规则"),
        "child-run": makeNode(CODEX, "running", "核对状态"),
        "child-idle": makeNode(PI, "idle", "整理术语"),
      },
    });

    // Native children are hidden strictly via host-managed markers, never inline style.
    expect(childWait.item.hasAttribute("data-cx-sidebar-thread-tree-hidden")).toBe(true);
    expect(childWait.item.getAttribute("style")).toBeNull();

    // Native root retains its row and gets chevron toggle on its Agent icon.
    const iconToggle = parent.icon.querySelector<HTMLButtonElement>(".cx-tree-icon-toggle");
    expect(iconToggle).not.toBeNull();
    expect(parent.icon.hasAttribute("data-cx-sidebar-thread-tree-icon-collapsed")).toBe(true);

    // Collapsed state renders the localized summary line and no children yet.
    const summary = parent.item.querySelector<HTMLButtonElement>(".cx-tree-summary");
    expect(summary?.textContent).toBe("3 个子会话 · 1 运行中 · 1 待批准");
    expect(parent.item.querySelector(".cx-tree-children")).toBeNull();

    // Clicking the icon toggle expands without bubbling to the native row.
    const rowClicks: string[] = [];
    parent.row.element.addEventListener("click", () => rowClicks.push("click"));
    iconToggle!.click();
    expect(rowClicks).toEqual([]);

    // Expanded state removes the summary bar completely and renders child rows directly.
    expect(parent.item.querySelector(".cx-tree-summary")).toBeNull();
    expect(parent.icon.hasAttribute("data-cx-sidebar-thread-tree-icon-expanded")).toBe(true);

    const waitRow = parent.item.querySelector('[data-thread="child-wait"]');
    const runRow = parent.item.querySelector('[data-thread="child-run"]');
    const idleRow = parent.item.querySelector('[data-thread="child-idle"]');
    expect(waitRow?.querySelector('.cx-tree-status[data-state="waiting"]')).not.toBeNull();
    expect(runRow?.querySelector('.cx-tree-status[data-state="running"]')).not.toBeNull();
    expect(idleRow?.querySelector(".cx-tree-status")).toBeNull();
  });

  it("renders virtual root with icon-slot toggle and hides the native row via api.dom.mark", () => {
    document.documentElement.lang = "en";
    const harness = createHarness();
    const list = document.createElement("div");
    document.body.append(list);

    // Child appears before parent in the list -> virtual root.
    const child = makeListRow(list, "child-1", "Child task");
    const parent = makeListRow(list, "parent", "Parent task");

    harness.setRows([child.row, parent.row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: { "child-1": "parent" },
      nodes: {
        parent: makeNode(PI, "idle", "Parent task"),
        "child-1": makeNode(PI, "running", "Child task"),
      },
    });

    expect(child.row.element.hasAttribute("data-cx-sidebar-thread-tree-replaced")).toBe(true);
    expect(child.row.element.getAttribute("style")).toBeNull();
    expect(parent.item.hasAttribute("data-cx-sidebar-thread-tree-hidden")).toBe(true);

    const virtualToggle = child.item.querySelector<HTMLButtonElement>(".cx-tree-row-toggle");
    expect(virtualToggle).not.toBeNull();
    expect(child.item.querySelector(".cx-tree-summary")?.textContent).toBe("1 child · 1 running");

    virtualToggle!.click();
    expect(child.item.querySelector(".cx-tree-summary")).toBeNull();
    expect(child.item.querySelector('[data-thread="child-1"]')).not.toBeNull();
  });

  it("re-mounts the native root chevron toggle when the Agent icon is replaced in place", async () => {
    const harness = createHarness();
    const list = document.createElement("div");
    document.body.append(list);

    const parent = makeListRow(list, "parent", "Parent");
    const child = makeListRow(list, "child-1", "Child");

    harness.setRows([parent.row, child.row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: { "child-1": "parent" },
      nodes: {
        parent: makeNode(PI, "idle", "Parent"),
        "child-1": makeNode(PI, "idle", "Child"),
      },
    });

    expect(parent.icon.querySelector(".cx-tree-icon-toggle")).not.toBeNull();

    const replacement = document.createElement("span");
    replacement.setAttribute("data-codexhost-sidebar-agent-icon", "codex");
    parent.icon.replaceWith(replacement);

    await Promise.resolve();
    await Promise.resolve();

    expect(replacement.querySelector(".cx-tree-icon-toggle")).not.toBeNull();
    expect(replacement.hasAttribute("data-cx-sidebar-thread-tree-icon-anchor")).toBe(true);
    expect(parent.icon.hasAttribute("data-cx-sidebar-thread-tree-icon-anchor")).toBe(false);
  });
});
